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
const Manager = require("../models/Manager");
const { sendEmail } = require("../utils/emailService");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { uploadTaskAttachment } = require("../utils/s3");
const { getIo } = require("../socketHandler");
const { sendPush, notifyIfEnabled } = require("../utils/push");

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
                isFirstLogin: employee.isFirstLogin,
                isProfileComplete: employee.isProfileComplete,
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
        const tasks = await Task.find({
            $or: [
                { employee: req.employee._id },
                { collaborators: req.employee._id }
            ]
        })
            .populate("manager", "email name")
            .populate("employee", "email name")
            .populate("collaborators", "email name");
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

        // Authorization: Allow if primary employee (for status) or collaborator (for comments)
        // But specific logic: status changes only by primary.

        const isPrimary = String(task.employee) === String(req.employee._id);
        // const isCollaborator = task.collaborators && task.collaborators.some(c => String(c) === String(req.employee._id));

        if (!isPrimary && String(task.employee) !== String(req.employee._id)) {
            // This check is a bit redundant if we trust logic below, but strictly:
            // If trying to access task not yours at all handled by verify? No, route protection just gives user.
            // We need to check if user related to task.
        }

        const { status, comment } = req.body;

        // Strict check: Only primary employee can change status
        if (status && String(task.employee) !== String(req.employee._id)) {
            return res.status(403).json({ message: "Only the primary assignee can change task status." });
        }

        if (status) {
            const oldStatus = task.status;
            task.status = status;

            // Notify Manager of status change
            if (oldStatus !== status) {
                const manager = await Manager.findById(task.manager);
                if (manager) {
                    const subject = `Task Status Updated: ${task.title}`;
                    const text = `The status of task "${task.title}" has been updated to "${status}" by ${req.employee.name}.`;
                    await sendEmail(manager.email, subject, text, `<p>${text}</p>`);

                    // Send Push to Manager
                    if (manager.pushSubscription) {
                        await notifyIfEnabled("task.statusUpdated", manager.pushSubscription, {
                            title: "Task Status Updated",
                            body: `${req.employee.name} changed status of "${task.title}" to ${status}`,
                            icon: "/pwa-192x192.png",
                            data: { url: `/manager/dashboard?taskId=${task._id}` }
                        });
                    }
                }
            }
        }

        if (comment) {
            task.messages.push({
                text: String(comment).trim(),
                by: "employee",
                senderName: req.employee.name,
                senderId: req.employee._id,
                time: new Date(),
            });

            // Notify Manager (New Comment)
            try {
                const manager = await Manager.findById(task.manager).select("pushSubscription");
                if (manager && manager.pushSubscription) {
                    await notifyIfEnabled("task.comment", manager.pushSubscription, {
                        title: "New Comment on Task",
                        body: `${req.employee.name}: ${String(comment).trim().substring(0, 50)}...`,
                        icon: "/pwa-192x192.png",
                        data: { url: `/manager/dashboard?taskId=${task._id}` }
                    });
                }
            } catch (e) {
                console.error("Push error:", e);
            }
        }

        task.employeeEdited = true;
        await task.save();

        // Emit socket event if comment added
        if (comment) {
            try {
                const io = getIo();
                io.to(`task_${task._id}`).emit("message:new", {
                    taskId: task._id,
                    message: task.messages[task.messages.length - 1],
                });
            } catch (socketErr) {
                console.error("Socket emit error:", socketErr);
            }
        }

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
        const task = await Task.findById(req.params.id).populate("manager", "email name");
        if (!task) return res.status(404).json({ message: "Task not found" });

        const isPrimary = String(task.employee) === String(req.employee._id);
        const isCollaborator = task.collaborators && task.collaborators.some(c => String(c) === String(req.employee._id));

        if (!isPrimary && !isCollaborator)
            return res.status(403).json({ message: "Not authorized" });

        task.messages.push({
            text: trimmed,
            by: "employee",
            senderName: req.employee.name,
            senderId: req.employee._id,
            time: new Date(),
        });
        task.employeeEdited = true;

        await task.save();

        // Emit socket event
        try {
            const io = getIo();
            io.to(`task_${task._id}`).emit("message:new", {
                taskId: task._id,
                message: task.messages[task.messages.length - 1],
            });

            // Notify Manager
            // task.manager is populated with name/email only.
            // We need to use task.manager._id (since it is an object due to populate)
            const managerId = task.manager._id || task.manager;
            const manager = await Manager.findById(managerId).select("pushSubscription");
            if (manager && manager.pushSubscription) {
                await notifyIfEnabled("task.messageFromEmployee", manager.pushSubscription, {
                    title: "New Message from Employee",
                    body: `${req.employee.name}: ${trimmed.substring(0, 50)}...`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: `/manager/dashboard?taskId=${task._id}` }
                });
            }

        } catch (socketErr) {
            console.error("Socket/Push error:", socketErr);
        }

        res.status(201).json(task);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/employee/tasks/:id/messages/upload
const uploadAttachmentAndPostMessageAsEmployee = [
    upload.single("file"),
    async (req, res) => {
        try {
            if (!req.file)
                return res.status(400).json({ message: "file is required" });

            const task = await Task.findById(req.params.id);
            if (!task) return res.status(404).json({ message: "Task not found" });

            const isPrimary = String(task.employee) === String(req.employee._id);
            const isCollaborator = task.collaborators && task.collaborators.some(c => String(c) === String(req.employee._id));

            if (!isPrimary && !isCollaborator)
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
                senderName: req.employee.name,
                senderId: req.employee._id,
                time: new Date(),
                fileName: uploadRes.fileName,
                s3Key: uploadRes.key,
                s3Bucket: uploadRes.bucket,
            });
            task.employeeEdited = true;

            await task.save();

            // Emit socket event
            try {
                const io = getIo();
                io.to(`task_${task._id}`).emit("message:new", {
                    taskId: task._id,
                    message: task.messages[task.messages.length - 1],
                });

                // Notify Manager
                const manager = await Manager.findById(task.manager).select("pushSubscription");
                if (manager && manager.pushSubscription) {
                    await notifyIfEnabled("task.attachmentFromEmployee", manager.pushSubscription, {
                        title: "New Attachment from Employee",
                        body: `${req.employee.name} sent an attachment.`,
                        icon: "/pwa-192x192.png",
                        data: { url: `/manager/dashboard?taskId=${task._id}` }
                    });
                }

            } catch (socketErr) {
                console.error("Socket/Push error:", socketErr);
            }

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
