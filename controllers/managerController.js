/*
  Manager controller

  Purpose:
  - Handles manager authentication and manager actions:
      - loginManager: POST /api/manager/login
      - createEmployee: POST /api/manager/employees
      - listEmployees: GET /api/manager/employees
      - createTask: POST /api/manager/tasks (sends email notification)
      - listTasks: GET /api/manager/tasks

  Emailing:
  - Uses nodemailer. If SMTP env vars (SMTP_HOST/SMTP_USER/SMTP_PASS) are present,
    it will use them. Otherwise an Ethereal test account is created for local preview.

  Important env vars:
  - JWT_SECRET: used for token generation and verification.
  - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, FROM_EMAIL (optional)

  Security/notes:
  - Tokens are generated with 30d expiry. In production consider shorter lifetimes
    and refresh-token flows or HTTP-only cookies.
*/
const Manager = require("../models/Manager");
const Employee = require("../models/Employee");
const Task = require("../models/Task");
const jwt = require("jsonwebtoken");

const { sendEmail } = require("../utils/emailService");
const multer = require("multer");
const { uploadTaskAttachment } = require("../utils/s3");
const bcrypt = require("bcryptjs"); // Ensure bcrypt is available for password hashing
const { getIo } = require("../socketHandler");
const { sendPush, notifyIfEnabled } = require("../utils/push");

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });

const generateTaskId = () => {
  // Simple, stable, low-collision ID without extra DB collections.
  // Example: TASK-20260118-6F4C2A
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Math.random().toString(16).slice(2, 8).toUpperCase();
  return `TASK-${ymd}-${rand}`;
};

const parseOptionalDate = (value) => {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d;
};

// in-memory storage so we can upload to S3 directly
const upload = multer({ storage: multer.memoryStorage() });

// POST /api/manager/login
const loginManager = async (req, res) => {
  const { email, password } = req.body;
  try {
    const manager = await Manager.findOne({ email });
    if (manager && (await manager.comparePassword(password))) {
      return res.json({
        _id: manager._id,
        email: manager.email,
        token: generateToken(manager._id),
        isFirstLogin: manager.isFirstLogin,
        isProfileComplete: manager.isProfileComplete,
      });
    }
    res.status(400).json({ message: "Invalid credentials" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/manager/employees - create employee under manager
const createEmployee = async (req, res) => {
  const { name, email, password, jobRole, department, joiningDate } = req.body;
  try {
    const exists = await Employee.findOne({ email });
    if (exists)
      return res.status(400).json({ message: "Employee already exists" });
    const employee = await Employee.create({
      name,
      email,
      password,
      manager: req.manager._id,
      jobRole: jobRole || undefined,
      department: department || undefined,
      joiningDate: joiningDate || undefined,
    });
    res
      .status(201)
      .json({ _id: employee._id, email: employee.email, name: employee.name, jobRole: employee.jobRole, department: employee.department, joiningDate: employee.joiningDate });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/manager/employees
const listEmployees = async (req, res) => {
  try {
    const employees = await Employee.find({ manager: req.manager._id }).select(
      "-password"
    );
    res.json(employees);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};



// DELETE /api/manager/employees/:id
const deleteEmployee = async (req, res) => {
  try {
    const employee = await Employee.findOneAndDelete({
      _id: req.params.id,
      manager: req.manager._id,
    });
    if (!employee) {
      return res.status(404).json({ message: "Employee not found or unauthorized" });
    }
    // Optional: Delete associated tasks or reassign them?
    // For now, we'll keep tasks but they will have a null employee reference if populated,
    // or we can clean them up. To remain simple, we leave tasks as is.
    res.json({ message: "Employee deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/manager/employees/:id
const updateEmployee = async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const employee = await Employee.findOne({
      _id: req.params.id,
      manager: req.manager._id,
    });

    if (!employee) {
      return res.status(404).json({ message: "Employee not found or unauthorized" });
    }

    if (name) employee.name = name;
    if (email) employee.email = email;
    if (password) {
      // In a real app, logic usually presumes the model hooks handle hashing,
      // but Employee model might rely on `pre('save')`. let's check or do it manually if needed.
      employee.password = password;
    }

    await employee.save();
    res.json({ _id: employee._id, email: employee.email, name: employee.name });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
const createTask = [
  upload.single("file"),
  async (req, res) => {
    const { title, description, priority, employeeId, deadline, collaboratorIds } = req.body;
    try {
      const employee = await Employee.findById(employeeId);
      if (!employee)
        return res.status(404).json({ message: "Employee not found" });

      // Parse collaborators if provided (can be string array or single string)
      let collaborators = [];
      if (collaboratorIds) {
        const ids = Array.isArray(collaboratorIds) ? collaboratorIds : [collaboratorIds];
        collaborators = await Employee.find({ _id: { $in: ids } });
      }

      // Retry on rare collisions.
      let taskID;
      for (let i = 0; i < 3; i += 1) {
        taskID = generateTaskId();
        // eslint-disable-next-line no-await-in-loop
        const exists = await Task.findOne({ taskID }).select("_id");
        if (!exists) break;
        taskID = undefined;
      }
      if (!taskID)
        return res.status(500).json({ message: "Failed to generate taskID" });

      const messages = [];

      // If a file is uploaded, add it as the first message
      if (req.file) {
        try {
          const uploadRes = await uploadTaskAttachment({
            taskId: taskID, // Use the generated taskID for S3 prefix
            buffer: req.file.buffer,
            originalName: req.file.originalname,
            contentType: req.file.mimetype,
          });

          messages.push({
            text: "Attached document during task creation.",
            by: "manager",
            senderName: "Manager",
            senderId: req.manager._id,
            time: new Date(),
            fileName: uploadRes.fileName,
            s3Key: uploadRes.key,
            s3Bucket: uploadRes.bucket,
          });
        } catch (uploadErr) {
          console.error("Failed to upload attachment during task creation:", uploadErr);
          // Optional: decide if we should fail the whole request or just proceed without file
          // For now, let's proceed but maybe warn in logs
        }
      }

      const task = await Task.create({
        taskID,
        title,
        description,
        priority,
        employee: employee._id,
        manager: req.manager._id,
        deadline: parseOptionalDate(deadline),
        collaborators: collaborators.map(c => c._id),
        messages,
      });

      // Send email notifications
      const dashboardUrl = `${process.env.CLIENT_URL || process.env.SERVER_URL || "http://localhost:5173"}/employee/dashboard`;

      const emailSubject = `New Task Assigned: ${title}`;
      const emailText = `You have been assigned a new task by ${req.manager.email}.
Title: ${title}
Description: ${description}
Priority: ${priority}
Role: ${collaborators.length > 0 ? "Collaborator/Primary" : "Assignee"}
${req.file ? `Attachment: ${req.file.originalname}` : ""}

Open your dashboard: ${dashboardUrl}`;

      const emailHtml = `<p>You have been assigned a new task by <strong>${req.manager.email}</strong>.</p>
             <p><strong>Title:</strong> ${title}<br/>
             <strong>Description:</strong> ${description || "-"}<br/>
             <strong>Priority:</strong> ${priority || "-"}<br/>
             ${req.file ? `<strong>Attachment:</strong> ${req.file.originalname}` : ""}
             </p>
             <p><a href="${dashboardUrl}">Open your dashboard</a> to view the task.</p>`;

      // Notify Primary
      await sendEmail(employee.email, emailSubject, emailText, emailHtml);

      // Notify Collaborators
      if (collaborators.length > 0) {
        // Send individually or bcc
        for (const col of collaborators) {
          await sendEmail(col.email, `[Collaborator] ${emailSubject}`, emailText, emailHtml);
        }
      }

      // Send Push Notification to Primary Assignee
      if (employee.pushSubscription) {
        const pushPayload = {
          title: "New Task Assigned",
          body: `You have a new task: ${title}`,
          icon: "/android-chrome-512x512.png", // Ensure this path is correct for your PWA
          data: {
            url: `/employee/dashboard?taskId=${task._id}` // Open dashboard with specific task
          }
        };
        await notifyIfEnabled("task.assigned", employee.pushSubscription, pushPayload);
      }

      res.status(201).json(task);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
];

// GET /api/manager/tasks
const listTasks = async (req, res) => {
  try {
    const tasks = await Task.find({ manager: req.manager._id })
      .populate("employee", "name email")
      .populate("collaborators", "name email");
    const assigned = tasks;
    const updates = tasks.filter((t) => t.employeeEdited === true);
    res.json({ assigned, updates });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/manager/tasks/:id/messages
const postMessageToTaskAsManager = async (req, res) => {
  const { text } = req.body;
  const trimmed = String(text || "").trim();
  if (!trimmed)
    return res.status(400).json({ message: "Message text is required" });

  try {
    const task = await Task.findById(req.params.id).populate(
      "employee",
      "name email"
    );
    if (!task) return res.status(404).json({ message: "Task not found" });
    if (String(task.manager) !== String(req.manager._id))
      return res.status(403).json({ message: "Not authorized" });

    task.messages.push({
      text: trimmed,
      by: "manager",
      senderName: "Manager",
      senderId: req.manager._id,
      time: new Date(),
    });

    await task.save();

    // Emit socket event
    try {
      const io = getIo();
      io.to(`task_${task._id}`).emit("message:new", {
        taskId: task._id,
        message: task.messages[task.messages.length - 1],
      });

      // Send Push Notification to Employee
      if (task.employee) {
        // We only populated 'name email' above, so we must fetch pushSubscription now.
        const empParams = await Employee.findById(task.employee._id).select("pushSubscription");
        if (empParams && empParams.pushSubscription) {
          await notifyIfEnabled("task.messageFromManager", empParams.pushSubscription, {
            title: "New Message from Manager",
            body: `${trimmed.substring(0, 50)}${trimmed.length > 50 ? "..." : ""}`,
            icon: "/android-chrome-512x512.png", // Corrected Icon
            data: { url: `/employee/dashboard?taskId=${task._id}` }
          });
        }
      }

    } catch (socketErr) {
      console.error("Socket/Push error:", socketErr);
    }

    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/manager/tasks/:id/messages/upload  (multipart/form-data: file, text)
const uploadAttachmentAndPostMessageAsManager = [
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ message: "file is required" });

      const task = await Task.findById(req.params.id);
      if (!task) return res.status(404).json({ message: "Task not found" });
      if (String(task.manager) !== String(req.manager._id))
        return res.status(403).json({ message: "Not authorized" });

      const uploadRes = await uploadTaskAttachment({
        taskId: task.taskID || task._id,
        buffer: req.file.buffer,
        originalName: req.file.originalname,
        contentType: req.file.mimetype,
      });

      const text = String(req.body?.text || "").trim();

      task.messages.push({
        text: text || undefined,
        by: "manager",
        senderName: "Manager",
        senderId: req.manager._id,
        time: new Date(),
        fileName: uploadRes.fileName,
        s3Key: uploadRes.key,
        s3Bucket: uploadRes.bucket,
      });

      await task.save();

      // Emit socket event
      try {
        const io = getIo();
        io.to(`task_${task._id}`).emit("message:new", {
          taskId: task._id,
          message: task.messages[task.messages.length - 1],
        });
      } catch (socketErr) {
        console.error("Socket emit error:", socketErr);
      }

      res.status(201).json(task);
    } catch (err) {
      console.error("Upload/Message Error:", err);
      res.status(500).json({ message: err.message, stack: err.stack });
    }
  },
];

// DELETE /api/manager/tasks/:id
const TaskPolicy = require("../models/TaskPolicy");

const deleteTask = async (req, res) => {
  try {
    // Check if admin has enabled task deletion for managers
    const policy = await TaskPolicy.findOne();
    if (!policy || !policy.allowManagerTaskDeletion) {
      return res.status(403).json({
        message: "Task deletion is not enabled. Please contact your admin.",
      });
    }

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Task not found" });
    if (String(task.manager) !== String(req.manager._id))
      return res.status(403).json({ message: "Not authorized" });

    await Task.findByIdAndDelete(req.params.id);
    res.json({ message: "Task deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = {
  loginManager,
  createEmployee,
  listEmployees,
  createTask,
  listTasks,
  postMessageToTaskAsManager,
  uploadAttachmentAndPostMessageAsManager,
  deleteEmployee,
  updateEmployee,
  deleteTask,
};
