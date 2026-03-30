const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Save profile uploads locally under uploads/profiles and uploads/id-proofs
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const folder = file.fieldname === "profilePhoto" ? "uploads/profiles" : "uploads/id-proofs";
        fs.mkdirSync(folder, { recursive: true });
        cb(null, folder);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        cb(null, uniqueName);
    },
});
const upload = multer({ storage });

const PROFILE_FIELDS = [
    "name", "dateOfBirth", "gender", "phone", "personalEmail",
    "emergencyContactName", "emergencyContactPhone", "currentAddress",
    "idProofType", "idProofNumber",
];

function computeProfileComplete(user) {
    const required = ["name", "dateOfBirth", "gender", "phone", "currentAddress"];
    return required.every((f) => user[f] && String(user[f]).trim() !== "");
}

// ==================== EMPLOYEE PROFILE ====================

// POST /api/employee/profile/change-password
const employeeChangePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: "Both currentPassword and newPassword are required" });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ message: "New password must be at least 6 characters" });
        }

        const employee = await Employee.findById(req.employee._id);
        const isMatch = await employee.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(400).json({ message: "Current password is incorrect" });
        }

        employee.password = newPassword;
        employee.isFirstLogin = false;
        await employee.save();

        res.json({ message: "Password changed successfully" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/employee/profile
const getEmployeeProfile = async (req, res) => {
    try {
        const employee = await Employee.findById(req.employee._id)
            .select("-password")
            .populate("manager", "name email");
        res.json(employee);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/employee/profile
const updateEmployeeProfile = async (req, res) => {
    try {
        const employee = await Employee.findById(req.employee._id);
        if (!employee) return res.status(404).json({ message: "Not found" });

        // Only allow updating personal fields (not job fields)
        PROFILE_FIELDS.forEach((f) => {
            if (req.body[f] !== undefined) employee[f] = req.body[f];
        });

        // Handle file uploads (saved locally via multer diskStorage)
        if (req.files) {
            if (req.files.profilePhoto && req.files.profilePhoto[0]) {
                employee.profilePhoto = req.files.profilePhoto[0].path.replace(/\\/g, "/");
            }
            if (req.files.idProofDocument && req.files.idProofDocument[0]) {
                employee.idProofDocument = req.files.idProofDocument[0].path.replace(/\\/g, "/");
            }
        }

        employee.isProfileComplete = computeProfileComplete(employee);
        await employee.save();

        const updated = await Employee.findById(employee._id)
            .select("-password")
            .populate("manager", "name email");
        res.json(updated);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ==================== MANAGER PROFILE ====================

// POST /api/manager/profile/change-password
const managerChangePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: "Both currentPassword and newPassword are required" });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ message: "New password must be at least 6 characters" });
        }

        const manager = await Manager.findById(req.manager._id);
        const isMatch = await manager.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(400).json({ message: "Current password is incorrect" });
        }

        manager.password = newPassword;
        manager.isFirstLogin = false;
        await manager.save();

        res.json({ message: "Password changed successfully" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/profile
const getManagerProfile = async (req, res) => {
    try {
        const manager = await Manager.findById(req.manager._id).select("-password");
        res.json(manager);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/manager/profile
const updateManagerProfile = async (req, res) => {
    try {
        const manager = await Manager.findById(req.manager._id);
        if (!manager) return res.status(404).json({ message: "Not found" });

        PROFILE_FIELDS.forEach((f) => {
            if (req.body[f] !== undefined) manager[f] = req.body[f];
        });

        if (req.files) {
            if (req.files.profilePhoto && req.files.profilePhoto[0]) {
                manager.profilePhoto = req.files.profilePhoto[0].path.replace(/\\/g, "/");
            }
            if (req.files.idProofDocument && req.files.idProofDocument[0]) {
                manager.idProofDocument = req.files.idProofDocument[0].path.replace(/\\/g, "/");
            }
        }

        manager.isProfileComplete = computeProfileComplete(manager);
        await manager.save();

        const updated = await Manager.findById(manager._id).select("-password");
        res.json(updated);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ==================== MANAGER VIEWING EMPLOYEE PROFILES ====================

// GET /api/manager/employees/:id/profile
const getEmployeeProfileByManager = async (req, res) => {
    try {
        const employee = await Employee.findOne({
            _id: req.params.id,
            manager: req.manager._id,
        }).select("-password").populate("manager", "name email");
        if (!employee) return res.status(404).json({ message: "Employee not found" });
        res.json(employee);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/manager/employees/:id/profile (manager can edit job fields)
const updateEmployeeProfileByManager = async (req, res) => {
    try {
        const employee = await Employee.findOne({
            _id: req.params.id,
            manager: req.manager._id,
        });
        if (!employee) return res.status(404).json({ message: "Employee not found" });

        const { jobRole, department, joiningDate } = req.body;
        if (jobRole !== undefined) employee.jobRole = jobRole;
        if (department !== undefined) employee.department = department;
        if (joiningDate !== undefined) employee.joiningDate = joiningDate;
        await employee.save();

        const updated = await Employee.findById(employee._id)
            .select("-password").populate("manager", "name email");
        res.json(updated);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// ==================== ADMIN VIEWING/EDITING ANY PROFILE ====================

// GET /api/admin/employees/:id/profile
const getEmployeeProfileByAdmin = async (req, res) => {
    try {
        const employee = await Employee.findById(req.params.id)
            .select("-password").populate("manager", "name email");
        if (!employee) return res.status(404).json({ message: "Employee not found" });
        res.json(employee);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/employees/:id/profile
const updateEmployeeProfileByAdmin = async (req, res) => {
    try {
        const employee = await Employee.findById(req.params.id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });

        const allFields = [...PROFILE_FIELDS, "jobRole", "department", "joiningDate"];
        allFields.forEach((f) => {
            if (req.body[f] !== undefined) employee[f] = req.body[f];
        });

        employee.isProfileComplete = computeProfileComplete(employee);
        await employee.save();

        const updated = await Employee.findById(employee._id)
            .select("-password").populate("manager", "name email");
        res.json(updated);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/managers/:id/profile
const getManagerProfileByAdmin = async (req, res) => {
    try {
        const manager = await Manager.findById(req.params.id).select("-password");
        if (!manager) return res.status(404).json({ message: "Manager not found" });
        res.json(manager);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/managers/:id/profile
const updateManagerProfileByAdmin = async (req, res) => {
    try {
        const manager = await Manager.findById(req.params.id);
        if (!manager) return res.status(404).json({ message: "Manager not found" });

        const allFields = [...PROFILE_FIELDS, "jobRole", "department", "joiningDate"];
        allFields.forEach((f) => {
            if (req.body[f] !== undefined) manager[f] = req.body[f];
        });

        manager.isProfileComplete = computeProfileComplete(manager);
        await manager.save();

        const updated = await Manager.findById(manager._id).select("-password");
        res.json(updated);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = {
    upload,
    employeeChangePassword,
    getEmployeeProfile,
    updateEmployeeProfile,
    managerChangePassword,
    getManagerProfile,
    updateManagerProfile,
    getEmployeeProfileByManager,
    updateEmployeeProfileByManager,
    getEmployeeProfileByAdmin,
    updateEmployeeProfileByAdmin,
    getManagerProfileByAdmin,
    updateManagerProfileByAdmin,
};
