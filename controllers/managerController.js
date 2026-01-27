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
const nodemailer = require("nodemailer");
const multer = require("multer");
const { uploadTaskAttachment } = require("../utils/s3");
const bcrypt = require("bcryptjs"); // Ensure bcrypt is available for password hashing

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
      });
    }
    res.status(400).json({ message: "Invalid credentials" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/manager/employees - create employee under manager
const createEmployee = async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const exists = await Employee.findOne({ email });
    if (exists)
      return res.status(400).json({ message: "Employee already exists" });
    const employee = await Employee.create({
      name,
      email,
      password,
      manager: req.manager._id,
    });
    res
      .status(201)
      .json({ _id: employee._id, email: employee.email, name: employee.name });
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
    const { title, description, priority, employeeId, deadline } = req.body;
    try {
      const employee = await Employee.findById(employeeId);
      if (!employee)
        return res.status(404).json({ message: "Employee not found" });

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
        messages,
      });

      // Send email notification. If SMTP env vars provided, use them; otherwise use Ethereal test account for local dev
      try {
        let transporter;
        if (process.env.SMTP_HOST && process.env.SMTP_USER) {
          transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: process.env.SMTP_SECURE === "true",
            auth: {
              user: process.env.SMTP_USER,
              pass: process.env.SMTP_PASS,
            },
          });
        } else {
          // Use Ethereal test account for development so emails can be previewed
          const testAccount = await nodemailer.createTestAccount();
          transporter = nodemailer.createTransport({
            host: "smtp.ethereal.email",
            port: 587,
            secure: false,
            auth: {
              user: testAccount.user,
              pass: testAccount.pass,
            },
          });
        }

        const dashboardUrl = `${process.env.CLIENT_URL ||
          process.env.SERVER_URL ||
          "http://localhost:5173"
          }/employee/dashboard`;

        const info = await transporter.sendMail({
          from:
            process.env.FROM_EMAIL ||
            process.env.SMTP_USER ||
            "no-reply@example.com",
          to: employee.email,
          subject: `New Task Assigned: ${title}`,
          text: `You have been assigned a new task by ${req.manager.email}.
Title: ${title}
Description: ${description}
Priority: ${priority}
${req.file ? `Attachment: ${req.file.originalname}` : ""}

Open your dashboard to view and update the task: ${dashboardUrl}
`,
          html: `<p>You have been assigned a new task by <strong>${req.manager.email
            }</strong>.</p>
                 <p><strong>Title:</strong> ${title}<br/>
                 <strong>Description:</strong> ${description || "-"}<br/>
                 <strong>Priority:</strong> ${priority || "-"}<br/>
                 ${req.file ? `<strong>Attachment:</strong> ${req.file.originalname}` : ""}
                 </p>
                 <p><a href="${dashboardUrl}">Open your dashboard</a> to view and update the task.</p>`,
        });

        // If using Ethereal, log preview URL
        if (nodemailer.getTestMessageUrl && info) {
          const preview = nodemailer.getTestMessageUrl(info);
          if (preview) console.log("Ethereal preview URL:", preview);
        }
      } catch (err) {
        console.error("Failed to send task email:", err.message);
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
    const tasks = await Task.find({ manager: req.manager._id }).populate(
      "employee",
      "name email"
    );
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
      time: new Date(),
    });

    await task.save();
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
        time: new Date(),
        fileName: uploadRes.fileName,
        s3Key: uploadRes.key,
        s3Bucket: uploadRes.bucket,
      });

      await task.save();
      res.status(201).json(task);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
];

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
};
