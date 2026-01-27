/*
  Employee controller

  Purpose:
  - Handles employee authentication and employee actions:
      - loginEmployee: POST /api/employee/login
      - listTasksForEmployee: GET /api/employee/tasks
      - updateTaskByEmployee: PATCH /api/employee/tasks/:id

  Notes:
  - Employees are linked to managers via the `manager` field on the Employee model.
  - When employees update tasks, comments and status are stored and `employeeEdited`
    is set to true so managers can see updates separately.

  Important env vars:
  - JWT_SECRET: used for token generation and verification.
*/
const Employee = require("../models/Employee");
const Task = require("../models/Task");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { uploadTaskAttachment } = require("../utils/s3");

const generateToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });

const upload = multer({ storage: multer.memoryStorage() });

// POST /api/employee/login
const loginEmployee = async (req, res) => {
  const { email, password } = req.body;
  try {
    const employee = await Employee.findOne({ email });
    if (employee && (await employee.comparePassword(password))) {
      return res.json({
        _id: employee._id,
        email: employee.email,
        token: generateToken(employee._id),
      });
    }
    res.status(400).json({ message: "Invalid credentials" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// GET /api/employee/tasks
const listTasksForEmployee = async (req, res) => {
  try {
    const tasks = await Task.find({ employee: req.employee._id }).populate(
      "manager",
      "email name"
    );
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// PATCH /api/employee/tasks/:id
const updateTaskByEmployee = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: "Task not found" });
    if (String(task.employee) !== String(req.employee._id))
      return res
        .status(403)
        .json({ message: "Not authorized to update this task" });

    const { status, comment } = req.body;
    if (status) task.status = status;
    if (comment) {
      task.messages.push({
        text: String(comment).trim(),
        by: "employee",
        time: new Date(),
      });
    }
    task.employeeEdited = true;
    await task.save();
    res.json(task);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/employee/tasks/:id/messages
const postMessageToTaskAsEmployee = async (req, res) => {
  const { text } = req.body;
  const trimmed = String(text || "").trim();
  if (!trimmed)
    return res.status(400).json({ message: "Message text is required" });

  try {
    const task = await Task.findById(req.params.id).populate(
      "manager",
      "email name"
    );
    if (!task) return res.status(404).json({ message: "Task not found" });
    if (String(task.employee) !== String(req.employee._id))
      return res.status(403).json({ message: "Not authorized" });

    task.messages.push({
      text: trimmed,
      by: "employee",
      time: new Date(),
    });
    task.employeeEdited = true;

    await task.save();
    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/employee/tasks/:id/messages/upload  (multipart/form-data: file, text)
const uploadAttachmentAndPostMessageAsEmployee = [
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file)
        return res.status(400).json({ message: "file is required" });

      const task = await Task.findById(req.params.id);
      if (!task) return res.status(404).json({ message: "Task not found" });
      if (String(task.employee) !== String(req.employee._id))
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
        by: "employee",
        time: new Date(),
        fileName: uploadRes.fileName,
        s3Key: uploadRes.key,
        s3Bucket: uploadRes.bucket,
      });
      task.employeeEdited = true;

      await task.save();
      res.status(201).json(task);
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
];

module.exports = {
  loginEmployee,
  listTasksForEmployee,
  updateTaskByEmployee,
  postMessageToTaskAsEmployee,
  uploadAttachmentAndPostMessageAsEmployee,
};
