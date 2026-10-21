const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const { sendEmail } = require("../utils/emailService");
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


/*
  Bank account changes, applied to an Employee or a Manager.

  The employee owns their salary account, which means they can also change it —
  and changing an account shortly before payday is the classic salary-redirect
  fraud. So every change keeps the previous account's last four digits in
  `bankHistory`, stamps `bankUpdatedAt` (a payroll run reads that to flag an
  account which moved after the run was generated), and emails the person, so a
  change they did not make does not go unnoticed.

  Returns true when something actually changed, so the caller only emails then.
*/
const BANK_FIELDS = ["accountHolderName", "accountNumber", "ifsc", "bankName", "branch"];

const applyBankChange = (user, incoming, actorName) => {
    if (!incoming || typeof incoming !== "object") return false;

    const next = {};
    for (const f of BANK_FIELDS) {
        if (incoming[f] !== undefined) next[f] = String(incoming[f] || "").trim();
    }
    if (Object.keys(next).length === 0) return false;

    const before = user.bank ? (user.bank.toObject ? user.bank.toObject() : user.bank) : {};
    const merged = { ...before, ...next };

    if (BANK_FIELDS.every((f) => (merged[f] || "") === (before[f] || ""))) return false;

    // Only the account identity matters for the audit trail — a corrected
    // spelling of the bank's name is not a redirect.
    const identityChanged =
        (merged.accountNumber || "") !== (before.accountNumber || "") ||
        (merged.ifsc || "") !== (before.ifsc || "");

    if (identityChanged && before.accountNumber) {
        user.bankHistory = user.bankHistory || [];
        user.bankHistory.push({
            accountNumberLast4: String(before.accountNumber).slice(-4),
            ifsc: before.ifsc,
            bankName: before.bankName,
            changedAt: new Date(),
            changedByName: actorName,
        });
    }

    user.bank = merged;
    user.bankUpdatedAt = new Date();
    return true;
};

/** Tell the person their salary account changed. Best-effort. */
const notifyBankChange = async (user) => {
    try {
        await sendEmail({
            to: user.email,
            subject: "Your salary account was updated",
            html: `<p>Hello ${user.name || ""},</p>
                   <p>The bank account your salary is paid into was just changed on your
                   ReSrishti profile. Payments will now go to the account ending
                   <strong>${String(user.bank?.accountNumber || "").slice(-4)}</strong>.</p>
                   <p>If you did not make this change, tell your administrator straight away.</p>`,
        });
    } catch (err) {
        // A failed notification must never fail the profile save.
        console.error("Bank-change email failed:", err.message);
    }
};

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

        // Bank details are deliberately not in PROFILE_FIELDS: they need the
        // change history and the notification, so they go through here.
        const bankChanged = applyBankChange(employee, req.body.bank, employee.name);

        employee.isProfileComplete = computeProfileComplete(employee);
        await employee.save();
        if (bankChanged) await notifyBankChange(employee);

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

        // Bank details are deliberately not in PROFILE_FIELDS: they need the
        // change history and the notification, so they go through here.
        const bankChanged = applyBankChange(manager, req.body.bank, manager.name);

        manager.isProfileComplete = computeProfileComplete(manager);
        await manager.save();
        if (bankChanged) await notifyBankChange(manager);

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
        // A manager has no business with their team's salary accounts — that
        // is between the employee, the accountant and payroll. Excluded here
        // rather than masked, so it cannot leak through a later field addition.
        const employee = await Employee.findOne({
            _id: req.params.id,
            manager: req.manager._id,
        })
            .select("-password -bank -bankHistory -bankUpdatedAt")
            .populate("manager", "name email");
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

        // An admin can correct a bank account too — for somebody who cannot get
        // into the app, say. The history records who did it either way.
        const bankChanged = applyBankChange(employee, req.body.bank, "Administrator");

        employee.isProfileComplete = computeProfileComplete(employee);
        await employee.save();
        if (bankChanged) await notifyBankChange(employee);

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

        // An admin can correct a bank account too — for somebody who cannot get
        // into the app, say. The history records who did it either way.
        const bankChanged = applyBankChange(manager, req.body.bank, "Administrator");

        manager.isProfileComplete = computeProfileComplete(manager);
        await manager.save();
        if (bankChanged) await notifyBankChange(manager);

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
