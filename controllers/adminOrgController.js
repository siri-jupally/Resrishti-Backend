const Manager = require("../models/Manager");
const Employee = require("../models/Employee");
const { nextStaffNo } = require("../utils/staffCode");
const Leave = require("../models/Leave");
const ManagerLeave = require("../models/ManagerLeave");
const Attendance = require("../models/Attendance");
const Admin = require("../models/Admin");
const CorrectionRequest = require("../models/CorrectionRequest");
const LocationTrail = require("../models/LocationTrail");
const Task = require("../models/Task");
const PayrollProfile = require("../models/PayrollProfile");
const PayrollLine = require("../models/PayrollLine");
const { sendPush, notifyIfEnabled } = require("../utils/push");
const { applyJobRole } = require("./workAccessController");
const { lockBlocksRange } = require("../utils/attendanceLock");

// ==================== MANAGER CRUD ====================

// POST /api/admin/managers
const createManager = async (req, res) => {
    try {
        const { name, email, password, jobRole, jobRoleId, department, joiningDate, canSupervise, canCoordinate } = req.body;
        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required" });
        }

        const existing = await Manager.findOne({ email: email.toLowerCase().trim() });
        if (existing) {
            return res.status(400).json({ message: "Manager with this email already exists" });
        }

        // Reserve the next staff code from the shared sequence (unique across
        // Employees + Managers; also the biometric device User ID) — unless this
        // is a test account, which gets no code. See utils/staffCode.js.
        const isTest = req.body.isTestAccount === true;
        const empNo = isTest ? undefined : await nextStaffNo();
        const manager = new Manager({
            name, email, password, empNo, isTestAccount: isTest,
            jobRole: jobRole || undefined,
            department: department || undefined,
            joiningDate: joiningDate || undefined,
            canSupervise: canSupervise === true,
            canCoordinate: canCoordinate === true,
        });
        // A role from the fixed list sets the label and the attendance modes.
        const roleError = await applyJobRole(manager, "manager", jobRoleId);
        if (roleError) return res.status(400).json({ message: roleError });
        await manager.save();
        res.status(201).json({
            _id: manager._id,
            empNo: manager.empNo,
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
        // Archived managers have left (or were promoted away) — they belong in
        // the Staff screen's Archived view, not in the active roster here.
        const managers = await Manager.find({ archived: { $ne: true } })
            .select("-password").sort({ createdAt: -1 });

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

        const { name, email, password, jobRole, jobRoleId, department, joiningDate, canSupervise, canCoordinate } = req.body;
        if (name !== undefined) manager.name = name;
        if (email !== undefined) manager.email = email;
        if (password) manager.password = password;
        if (jobRole !== undefined) manager.jobRole = jobRole;
        if (department !== undefined) manager.department = department;
        if (joiningDate !== undefined) manager.joiningDate = joiningDate;
        if (typeof canSupervise === "boolean") manager.canSupervise = canSupervise;
        if (typeof canCoordinate === "boolean") manager.canCoordinate = canCoordinate;

        // Applied after the free-text jobRole so a chosen role's name wins.
        const roleError = await applyJobRole(manager, "manager", jobRoleId);
        if (roleError) return res.status(400).json({ message: roleError });

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
        const employees = await Employee.find({ archived: { $ne: true } })
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

// PATCH /api/admin/employees/:id/permissions
//
// Lets the Admin make an employee a pickup agent (`canSupervise`), i.e. someone
// who can be assigned to run a client pickup in the field.
//
// Until now only the employee's own Manager could set this, via
// managerController.updateEmployee. That left the Admin — who owns the client
// relationship and triages the requests — unable to staff a pickup without
// going through the manager. The flag itself already existed on the Employee
// model and is already read by the assign-supervisor pool in
// adminPickupController.supervisorCandidates, so this only opens the gate.
//
// canCoordinate is deliberately NOT settable here. Coordinating means triaging
// incoming client requests, which stays with Admins and Managers.
const updateEmployeePermissions = async (req, res) => {
    try {
        const { canSupervise } = req.body;

        if (typeof canSupervise !== "boolean") {
            return res
                .status(400)
                .json({ message: "canSupervise (boolean) is required" });
        }

        const employee = await Employee.findById(req.params.id);
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        employee.canSupervise = canSupervise;
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

        // An admin override writes the same 'leave' rows a manager approval
        // would, so it answers to the same lock.
        const leaveBlocked = await lockBlocksRange(
            leave.startDate, leave.endDate, "this leave"
        );
        if (leaveBlocked) return res.status(409).json(leaveBlocked.body);

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
            Manager.find({ archived: { $ne: true } }).select("-password"),
            Employee.find({ archived: { $ne: true } }).select("-password").populate("manager", "name email"),
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

// GET /api/admin/org/chart
// The company as a tree: directors (admins) at the top, then managers, then the
// employees who report to each. Active, non-test people only. An admin's display
// name falls back to a matching staff record (even archived) then the email, so
// a founder who is "just an admin" still reads as their name rather than a login.
const getOrgChart = async (req, res) => {
    try {
        const active = { archived: { $ne: true }, isTestAccount: { $ne: true } };
        const [admins, managers, employees] = await Promise.all([
            Admin.find().select("name email").lean(),
            Manager.find(active)
                .select("name email jobRole department empNo canPreparePayroll canSupervise canCoordinate")
                .sort({ name: 1 }).lean(),
            Employee.find(active)
                .select("name email jobRole department empNo manager")
                .sort({ name: 1 }).lean(),
        ]);

        // The founder's real name often lives on a manager/employee record, not
        // the bare admin login — borrow it (archived records included).
        const adminEmails = admins.map((a) => a.email);
        const [mNamed, eNamed] = await Promise.all([
            Manager.find({ email: { $in: adminEmails } }).select("name email").lean(),
            Employee.find({ email: { $in: adminEmails } }).select("name email").lean(),
        ]);
        const nameByEmail = new Map();
        for (const p of [...mNamed, ...eNamed]) if (p.name) nameByEmail.set(p.email, p.name);

        const tagOf = (p) => {
            const t = [];
            if (p.canPreparePayroll) t.push("Accountant");
            if (p.canSupervise) t.push("Pickup agent");
            if (p.canCoordinate) t.push("Coordinator");
            return t;
        };
        const slim = (p) => ({
            _id: p._id, name: p.name || p.email, email: p.email,
            jobRole: p.jobRole || null, department: p.department || null, empNo: p.empNo ?? null,
        });

        // Bucket each employee under their manager — but only if that manager is
        // an ACTIVE one. Someone reporting to an archived/removed manager is not
        // lost: they fall into "unassigned" so they still appear on the chart.
        const activeManagerIds = new Set(managers.map((m) => String(m._id)));
        const empByManager = new Map();
        const unassigned = [];
        for (const e of employees) {
            const mid = e.manager ? String(e.manager) : null;
            if (mid && activeManagerIds.has(mid)) {
                if (!empByManager.has(mid)) empByManager.set(mid, []);
                empByManager.get(mid).push(slim(e));
            } else {
                unassigned.push(slim(e));
            }
        }

        res.json({
            directors: admins.map((a) => ({
                _id: a._id,
                name: a.name || nameByEmail.get(a.email) || a.email,
                email: a.email,
            })),
            managers: managers.map((m) => ({
                ...slim(m),
                tags: tagOf(m),
                employees: empByManager.get(String(m._id)) || [],
            })),
            unassigned,
            counts: {
                directors: admins.length,
                managers: managers.length,
                employees: employees.length,
            },
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/me/pickup-agent
// PATCH /api/admin/me/pickup-agent   body: { canSupervise: boolean }
//
// Whether the signed-in admin can be assigned to run pickups themselves.
// The flag has always existed on the Admin model, and the assign-supervisor
// pool has always read it — but nothing could set it, so the admin's own
// "My Pickups" tab could never show anything. This is the switch.
const getMyPickupAgentFlag = async (req, res) => {
    try {
        const me = await Admin.findById(req.admin._id).select("canSupervise name email");
        if (!me) return res.status(404).json({ message: "Admin not found" });
        return res.json({
            canSupervise: me.canSupervise === true,
            name: me.name || me.email,
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

const updateMyPickupAgentFlag = async (req, res) => {
    try {
        const { canSupervise } = req.body;
        if (typeof canSupervise !== "boolean") {
            return res
                .status(400)
                .json({ message: "canSupervise (boolean) is required" });
        }

        const me = await Admin.findById(req.admin._id);
        if (!me) return res.status(404).json({ message: "Admin not found" });

        // Switching it off would leave any pickup already assigned to this
        // admin with a supervisor the pool no longer offers, so say so rather
        // than stranding the run.
        if (!canSupervise) {
            const Pickup = require("../models/Pickup");
            const live = await Pickup.countDocuments({
                "supervisor.userId": me._id,
                status: {
                    $in: ["accepted", "scheduled", "postponed", "en-route",
                        "at-client", "picked-up", "at-facility", "weighed"],
                },
            });
            if (live > 0) {
                return res.status(409).json({
                    message: `You still have ${live} pickup(s) in progress. Reassign them before stepping down as a pickup agent.`,
                });
            }
        }

        me.canSupervise = canSupervise;
        await me.save();
        return res.json({ canSupervise: me.canSupervise, name: me.name || me.email });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== STAFF LIFECYCLE (archive / hard delete) ====================

async function adminActorName(req) {
    const a = await Admin.findById(req.admin._id).select("name email").lean();
    return a?.name || a?.email || "Admin";
}

function archivePatch(archived, actorName) {
    return archived
        ? { archived: true, archivedAt: new Date(), archivedByName: actorName }
        : { archived: false, archivedAt: null, archivedByName: null };
}

// PATCH /api/admin/employees/:id/archive   body { archived: true|false }
// Soft delete: keeps all history, drops them out of active lists and new
// payroll runs. Reversible.
const archiveEmployee = async (req, res) => {
    try {
        const archived = req.body.archived !== false; // default true
        const update = archivePatch(archived, archived ? await adminActorName(req) : null);
        const employee = await Employee.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).select("-password");
        if (!employee) return res.status(404).json({ message: "Employee not found" });
        res.json({ message: archived ? "Employee archived" : "Employee restored", employee });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/managers/:id/archive   body { archived: true|false }
const archiveManager = async (req, res) => {
    try {
        const archived = req.body.archived !== false;
        const update = archivePatch(archived, archived ? await adminActorName(req) : null);
        const manager = await Manager.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).select("-password");
        if (!manager) return res.status(404).json({ message: "Manager not found" });
        res.json({ message: archived ? "Manager archived" : "Manager restored", manager });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// DELETE /api/admin/employees/:id
// Hard delete with cleanup. Refuses if the person has any payroll history —
// erasing someone who has been in a run would destroy a financial record, so
// archive them instead. Otherwise removes the person AND everything that
// references them, leaving no orphans.
const deleteEmployeeHard = async (req, res) => {
    try {
        const id = req.params.id;
        const employee = await Employee.findById(id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });

        const payrollLines = await PayrollLine.countDocuments({ personType: "Employee", personId: id });
        if (payrollLines > 0) {
            return res.status(409).json({
                code: "hasPayrollHistory",
                message: "This person has payroll history. Archive them instead of deleting, to keep the financial record intact.",
            });
        }

        const [att, lv, corr, loc, tsk] = await Promise.all([
            Attendance.deleteMany({ employee: id }),
            Leave.deleteMany({ employee: id }),
            CorrectionRequest.deleteMany({ employee: id }),
            LocationTrail.deleteMany({ employee: id }),
            Task.deleteMany({ employee: id }),
        ]);
        await Task.updateMany({ collaborators: id }, { $pull: { collaborators: id } });
        await PayrollProfile.deleteOne({ personType: "Employee", personId: id });
        await employee.deleteOne();

        res.json({
            message: "Employee and their records permanently deleted",
            removed: {
                attendance: att.deletedCount,
                leaves: lv.deletedCount,
                corrections: corr.deletedCount,
                locationTrails: loc.deletedCount,
                tasks: tsk.deletedCount,
            },
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

/*
  ============================ ROLE PROMOTION ============================

  Admin, Manager and Employee are three SEPARATE collections, not one record
  with a role flag — so promoting someone is not a toggle. We copy the person
  into the target collection, carrying their identity, profile, bank, and their
  immutable RES staff code (empNo), then archive the original. History is NOT
  migrated across collections (that would risk corrupting payroll's financial
  record) — it stays intact on the archived original and is linked from the new
  record. Because empNo carries and the archived original is skipped by every
  active-only query (biometric resolvePerson included), the staff code keeps
  resolving to the same person in their new role.

  The one trap: all three models hash the password in a pre-save hook. Copying
  the already-hashed string into a new record would double-hash it and lock the
  person out. carryPassword() saves once with a throwaway password (so schema
  defaults/validation still run) then overwrites the stored hash directly.
*/

// Fields every staff person carries between collections. Employee and Manager
// share these names exactly; Admin takes only the few it has.
const CARRIED_PERSON_FIELDS = [
    "name", "email", "empNo", "isTestAccount",
    "isFirstLogin", "isProfileComplete", "hasReviewed",
    "profilePhoto", "dateOfBirth", "gender", "phone", "personalEmail",
    "emergencyContactName", "emergencyContactPhone", "currentAddress",
    "idProofType", "idProofNumber", "idProofDocument",
    "jobRole", "jobRoleId", "department", "joiningDate",
    "canSupervise", "canCoordinate", "canPreparePayroll",
    "bank", "bankUpdatedAt", "bankHistory",
];

function pickCarried(src, keys = CARRIED_PERSON_FIELDS) {
    const out = {};
    for (const k of keys) if (src[k] !== undefined && src[k] !== null) out[k] = src[k];
    return out;
}

// Put an already-hashed password onto a freshly-saved record without the
// model's pre-save hook re-hashing it. The new record keeps the person's
// existing password, so they sign in with the same credentials.
async function carryPassword(Model, id, originalHash, originalChangedAt) {
    await Model.collection.updateOne(
        { _id: id },
        { $set: { password: originalHash, passwordChangedAt: originalChangedAt || new Date(Date.now() - 1000) } }
    );
}

// Copy the person's ACTIVE payroll setup (the salary/rate config, not the
// historical payslip lines) into their new role, so a promotion never silently
// drops them off payroll. Best-effort: no profile, nothing to carry.
async function carryPayrollProfile(fromType, fromId, toType, toId) {
    const src = await PayrollProfile.findOne({ personType: fromType, personId: fromId }).lean();
    if (!src) return false;
    // Don't duplicate if the target somehow already has one.
    const exists = await PayrollProfile.findOne({ personType: toType, personId: toId }).select("_id").lean();
    if (exists) return false;
    await PayrollProfile.create({
        personType: toType,
        personId: toId,
        employmentType: src.employmentType,
        payModel: src.payModel,
        rates: src.rates,
        paidDayPolicy: src.paidDayPolicy,
        overtimeOverride: src.overtimeOverride,
        isActive: src.isActive !== false,
    });
    // Retire the old profile so it can't be picked up again (the old record is
    // archived anyway, but this keeps the data honest).
    await PayrollProfile.updateOne({ personType: fromType, personId: fromId }, { $set: { isActive: false } });
    return true;
}

// POST /api/admin/employees/:id/promote-to-manager
// Promote an employee into a manager. They keep their login, RES code and
// profile; their old employee record is archived (history preserved). They
// start with no team — assign employees to them afterwards as usual.
const promoteEmployeeToManager = async (req, res) => {
    try {
        const id = req.params.id;
        const employee = await Employee.findById(id);
        if (!employee) return res.status(404).json({ message: "Employee not found" });
        if (employee.archived) {
            return res.status(409).json({ code: "archived", message: "This employee is archived. Restore them before promoting." });
        }
        // Email lives in both collections per portal, but a live manager with
        // this email already would mean two active logins — refuse.
        const clash = await Manager.findOne({ email: employee.email, archived: { $ne: true } }).select("_id").lean();
        if (clash) {
            return res.status(409).json({ code: "managerExists", message: "A manager with this email already exists." });
        }

        const actorName = await adminActorName(req);
        const carried = pickCarried(employee);

        // 1. Create the manager with a throwaway password (schema defaults run),
        //    then carry the real hash so the password is unchanged.
        const manager = new Manager({
            ...carried,
            password: `pending-${require("crypto").randomBytes(12).toString("hex")}`,
            promotedFromEmployee: employee._id,
            promotedAt: new Date(),
        });
        await manager.save();
        try {
            await carryPassword(Manager, manager._id, employee.password, employee.passwordChangedAt);
            await carryPayrollProfile("Employee", employee._id, "Manager", manager._id);

            // 2. Archive the original employee record — history kept, login closed.
            employee.archived = true;
            employee.archivedAt = new Date();
            employee.archivedByName = actorName;
            employee.archivedReason = "promoted";
            employee.promotedToManager = manager._id;
            await employee.save();
        } catch (inner) {
            // Roll back the half-made manager so we never leave two live logins.
            await Manager.deleteOne({ _id: manager._id });
            await PayrollProfile.deleteOne({ personType: "Manager", personId: manager._id });
            throw inner;
        }

        const out = manager.toObject();
        delete out.password;
        res.status(201).json({
            message: `${employee.name || employee.email} promoted to Manager. They sign in through the manager portal with the same password.`,
            manager: out,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/admin/managers/:id/promote-to-admin
// Promote a manager into an admin. Blocked while they still have a team —
// their reports would be orphaned, so reassign those first. The manager's
// staff code and attendance history stay on the archived manager record
// (admins are not in the attendance/biometric flow).
const promoteManagerToAdmin = async (req, res) => {
    try {
        const id = req.params.id;
        const manager = await Manager.findById(id);
        if (!manager) return res.status(404).json({ message: "Manager not found" });
        if (manager.archived) {
            return res.status(409).json({ code: "archived", message: "This manager is archived. Restore them before promoting." });
        }

        // Can't orphan a team.
        const reports = await Employee.find({ manager: id, archived: { $ne: true } }).select("name email").lean();
        if (reports.length > 0) {
            return res.status(409).json({
                code: "hasActiveReports",
                message: `${manager.name || manager.email} still manages ${reports.length} ${reports.length === 1 ? "person" : "people"}. Reassign them to another manager before promoting to admin.`,
                reports,
            });
        }

        const clash = await Admin.findOne({ email: manager.email }).select("_id").lean();
        if (clash) {
            return res.status(409).json({ code: "adminExists", message: "An admin with this email already exists." });
        }

        const actorName = await adminActorName(req);

        const admin = new Admin({
            name: manager.name,
            email: manager.email,
            password: `pending-${require("crypto").randomBytes(12).toString("hex")}`,
            canSupervise: Boolean(manager.canSupervise),
            canCoordinate: manager.canCoordinate !== false,
            promotedFromManager: manager._id,
            promotedAt: new Date(),
        });
        await admin.save();
        try {
            await carryPassword(Admin, admin._id, manager.password, manager.passwordChangedAt);

            manager.archived = true;
            manager.archivedAt = new Date();
            manager.archivedByName = actorName;
            manager.archivedReason = "promoted";
            manager.promotedToAdmin = admin._id;
            await manager.save();
        } catch (inner) {
            await Admin.deleteOne({ _id: admin._id });
            throw inner;
        }

        const out = admin.toObject();
        delete out.password;
        res.status(201).json({
            message: `${manager.name || manager.email} promoted to Admin. They sign in through the admin portal with the same password.`,
            admin: out,
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
    updateEmployeePermissions,
    archiveEmployee,
    archiveManager,
    deleteEmployeeHard,
    promoteEmployeeToManager,
    promoteManagerToAdmin,
    getAllLeaveRequests,
    adminReviewLeave,
    getOrgOverview,
    getOrgChart,
    getMyPickupAgentFlag,
    updateMyPickupAgentFlag,
};
