const Manager = require("../models/Manager");
const Employee = require("../models/Employee");
const Leave = require("../models/Leave");
const ManagerLeave = require("../models/ManagerLeave");
const Attendance = require("../models/Attendance");
const Admin = require("../models/Admin");
const { sendPush, notifyIfEnabled } = require("../utils/push");

// ==================== MANAGER CRUD ====================

// POST /api/admin/managers
const createManager = async (req, res) => {
    try {
        const { name, email, password, jobRole, department, joiningDate, canSupervise, canCoordinate } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required" });
        }

        const existing = await Manager.findOne({ email: email.toLowerCase().trim() });
        if (existing) {
            return res.status(400).json({ message: "Manager with this email already exists" });
        }

        const manager = await Manager.create({
            name, email, password,
            jobRole: jobRole || undefined,
            department: department || undefined,
            joiningDate: joiningDate || undefined,
            canSupervise: canSupervise === true,
            canCoordinate: canCoordinate === true,
        });
        res.status(201).json({
            _id: manager._id,
            name: manager.name,
            email: manager.email,
            role: manager.role,
            jobRole: manager.jobRole,
            department: manager.department,
            joiningDate: manager.joiningDate,
            canSupervise: manager.canSupervise,
            canCoordinate: manager.canCoordinate,
            createdAt: manager.createdAt,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/managers
const listManagers = async (req, res) => {
    try {
        const managers = await Manager.find().select("-password").sort({ createdAt: -1 });

        // Attach employee count for each manager
        const managerIds = managers.map((m) => m._id);
        const counts = await Employee.aggregate([
            { $match: { manager: { $in: managerIds } } },
            { $group: { _id: "$manager", count: { $sum: 1 } } },
        ]);
        const countMap = {};
        counts.forEach((c) => { countMap[String(c._id)] = c.count; });

        const result = managers.map((m) => ({
            ...m.toObject(),
            employeeCount: countMap[String(m._id)] || 0,
        }));

        res.json(result);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/admin/managers/:id
const updateManager = async (req, res) => {
    try {
        const manager = await Manager.findById(req.params.id);
        if (!manager) {
            return res.status(404).json({ message: "Manager not found" });
        }

        const { name, email, password, jobRole, department, joiningDate, canSupervise, canCoordinate } = req.body;
        if (name !== undefined) manager.name = name;
        if (email !== undefined) manager.email = email;
        if (password) manager.password = password;
        if (jobRole !== undefined) manager.jobRole = jobRole;
        if (department !== undefined) manager.department = department;
        if (joiningDate !== undefined) manager.joiningDate = joiningDate;
        if (typeof canSupervise === "boolean") manager.canSupervise = canSupervise;
        if (typeof canCoordinate === "boolean") manager.canCoordinate = canCoordinate;

        await manager.save();
        res.json({
            _id: manager._id,
            name: manager.name,
            email: manager.email,
            role: manager.role,
            canSupervise: manager.canSupervise,
            canCoordinate: manager.canCoordinate,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// DELETE /api/admin/managers/:id
const deleteManager = async (req, res) => {
    try {
        const manager = await Manager.findById(req.params.id);
        if (!manager) {
            return res.status(404).json({ message: "Manager not found" });
        }

        // Check if manager has employees
        const empCount = await Employee.countDocuments({ manager: manager._id });
        if (empCount > 0) {
            return res.status(400).json({
                message: `Cannot delete manager with ${empCount} assigned employee(s). Reassign them first.`,
            });
        }

        await manager.deleteOne();
        res.json({ message: "Manager deleted", id: req.params.id });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ==================== EMPLOYEE MANAGEMENT ====================

// GET /api/admin/employees
const listAllEmployees = async (req, res) => {
    try {
        const employees = await Employee.find()
            .select("-password")
            .populate("manager", "name email")
            .sort({ createdAt: -1 });
        res.json(employees);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/employees/:id/reassign
const reassignEmployee = async (req, res) => {
    try {
        const { managerId } = req.body;
        if (!managerId) {
            return res.status(400).json({ message: "managerId is required" });
        }

        const manager = await Manager.findById(managerId);
        if (!manager) {
            return res.status(404).json({ message: "Target manager not found" });
        }

        const employee = await Employee.findById(req.params.id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        employee.manager = managerId;
        await employee.save();

        const updated = await Employee.findById(employee._id)
            .select("-password")
            .populate("manager", "name email");

        res.json(updated);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ==================== LEAVE OVERSIGHT ====================

// GET /api/admin/leaves
const getAllLeaveRequests = async (req, res) => {
    try {
        const filter = {};
        if (req.query.status) filter.status = req.query.status;

        const leaves = await Leave.find(filter)
            .populate("employee", "name email manager")
            .populate("reviewedBy", "name email")
            .sort({ createdAt: -1 });

        // Enrich with manager info for each leave
        const employeeIds = [...new Set(leaves.filter((l) => l.employee?._id).map((l) => String(l.employee._id)))];
        const employees = await Employee.find({ _id: { $in: employeeIds } })
            .select("manager")
            .populate("manager", "name email");
        const empManagerMap = {};
        employees.forEach((e) => { empManagerMap[String(e._id)] = e.manager; });

        const enriched = leaves.map((l) => ({
            ...l.toObject(),
            managerInfo: empManagerMap[String(l.employee?._id)] || null,
        }));

        res.json(enriched);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/leaves/:id  (Admin override)
const adminReviewLeave = async (req, res) => {
    try {
        const { status, reviewRemarks } = req.body;
        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }

        const leave = await Leave.findById(req.params.id).populate(
            "employee",
            "name email pushSubscription manager"
        );
        if (!leave) {
            return res.status(404).json({ message: "Leave request not found" });
        }

        const previousStatus = leave.status;
        leave.status = status;
        leave.adminOverride = true;
        leave.adminReviewedBy = req.admin._id;
        if (reviewRemarks) leave.adminRemarks = reviewRemarks;
        if (!leave.reviewedBy) leave.reviewedBy = null;
        await leave.save();

        // If approved, create attendance records with 'leave' status for each day
        if (status === "approved") {
            const start = new Date(leave.startDate);
            const end = new Date(leave.endDate);
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dateStr = d.toISOString().split("T")[0];
                await Attendance.findOneAndUpdate(
                    { employee: leave.employee._id, date: dateStr },
                    {
                        employee: leave.employee._id,
                        date: dateStr,
                        status: "leave",
                        approvalStatus: "approved",
                        workMode: "WFO",
                    },
                    { upsert: true, new: true }
                );
            }
        }

        // If overriding from approved to rejected, remove leave attendance records
        if (status === "rejected" && previousStatus === "approved") {
            const start = new Date(leave.startDate);
            const end = new Date(leave.endDate);
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dateStr = d.toISOString().split("T")[0];
                await Attendance.deleteOne({
                    employee: leave.employee._id,
                    date: dateStr,
                    status: "leave",
                });
            }
        }

        // Notify employee
        if (leave.employee.pushSubscription) {
            try {
                await notifyIfEnabled("attendance", leave.employee.pushSubscription, {
                    title: `Leave ${status === "approved" ? "Approved" : "Rejected"} by Admin`,
                    body: `Your ${leave.type} leave (${leave.startDate} to ${leave.endDate}) has been ${status} by admin${reviewRemarks ? ": " + reviewRemarks : ""}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/employee/dashboard?tab=attendance" },
                });
            } catch (pushErr) {
                console.error("Push error:", pushErr);
            }
        }

        res.json(leave);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ==================== ORG OVERVIEW ====================

// GET /api/admin/org/overview
const getOrgOverview = async (req, res) => {
    try {
        const [managers, employees, leaveStats, managerLeaveStats] = await Promise.all([
            Manager.find().select("-password"),
            Employee.find().select("-password").populate("manager", "name email"),
            Leave.aggregate([
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),
            ManagerLeave.aggregate([
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),
        ]);

        const leaveCounts = { pending: 0, approved: 0, rejected: 0 };
        leaveStats.forEach((s) => { leaveCounts[s._id] = (leaveCounts[s._id] || 0) + s.count; });
        managerLeaveStats.forEach((s) => { leaveCounts[s._id] = (leaveCounts[s._id] || 0) + s.count; });

        res.json({
            totalManagers: managers.length,
            totalEmployees: employees.length,
            leaveCounts,
            managers: managers.map((m) => ({
                _id: m._id,
                name: m.name,
                email: m.email,
                employees: employees
                    .filter((e) => String(e.manager?._id) === String(m._id))
                    .map((e) => ({ _id: e._id, name: e.name, email: e.email })),
            })),
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = {
    createManager,
    listManagers,
    updateManager,
    deleteManager,
    listAllEmployees,
    reassignEmployee,
    getAllLeaveRequests,
    adminReviewLeave,
    getOrgOverview,
};
