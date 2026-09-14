/*
  workAccessController — who may use which attendance mode, and approving
  out-of-premises check-ins.

  Job roles (admin; managers read-only):
    GET    /api/admin/job-roles?includeInactive=true   listJobRoles
    GET    /api/manager/job-roles                      listJobRoles
    POST   /api/admin/job-roles                        createJobRole
    PATCH  /api/admin/job-roles/:id                    updateJobRole
    DELETE /api/admin/job-roles/:id                    deleteJobRole

  Per-person access (admin):
    GET    /api/admin/work-access?kind=employee|manager  listWorkAccess
    PATCH  /api/admin/employees/:id/work-access          updateWorkAccess("employee")
    PATCH  /api/admin/managers/:id/work-access           updateWorkAccess("manager")
      body: { jobRoleId?: id|null, workModesOverride?: string[]|null }

  Out-of-premises approvals:
    GET    /api/admin/attendance/pending            getPendingEmployeeAttendance
    PATCH  /api/admin/attendance/:id/approve        adminApproveEmployeeAttendance
    GET    /api/admin/manager-attendance/pending    getPendingManagerAttendance
    GET    /api/manager/attendance/pending          getPendingTeamAttendance
  (Managers approve their team via the existing PATCH /api/manager/attendance/:id/approve;
   admins approve managers via the existing PATCH /api/admin/manager-attendance/:id/approve.)

  A pending day does not count toward worked days or hours until approved —
  see utils/attendanceCounting.js.
*/
const mongoose = require("mongoose");
const JobRole = require("../models/JobRole");
const { WORK_MODES } = require("../models/JobRole");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Attendance = require("../models/Attendance");
const ManagerAttendance = require("../models/ManagerAttendance");
const { resolveAllowedWorkModes } = require("../utils/workModePermissions");
const { notifyIfEnabled } = require("../utils/push");

const KINDS = {
    employee: { Model: Employee },
    manager: { Model: Manager },
};

const APPLIES_TO = ["employee", "manager", "both"];

const cleanModes = (modes) =>
    Array.isArray(modes) ? [...new Set(modes.filter((m) => WORK_MODES.includes(m)))] : [];

const isValidId = (id) => mongoose.Types.ObjectId.isValid(id);

// ==================== SHARED HELPERS ====================

/**
 * Validate and apply a job role to a person document. Does not save.
 *
 * `jobRoleId` undefined leaves the role alone; null or "" clears it.
 * Also used by adminOrgController when creating / editing managers.
 *
 * @returns {Promise<string|null>} an error message, or null on success
 */
const applyJobRole = async (person, kind, jobRoleId) => {
    if (jobRoleId === undefined) return null;
    if (jobRoleId === null || jobRoleId === "") {
        person.set("jobRoleId", undefined);
        return null;
    }
    if (!isValidId(jobRoleId)) return "Invalid job role";

    const role = await JobRole.findById(jobRoleId);
    if (!role) return "Job role not found";

    const alreadyHeld = person.jobRoleId && String(person.jobRoleId) === String(role._id);
    if (!role.isActive && !alreadyHeld) {
        return `"${role.name}" has been retired and can't be newly assigned`;
    }
    if (role.appliesTo !== "both" && role.appliesTo !== kind) {
        return `"${role.name}" can only be given to ${role.appliesTo}s`;
    }

    person.jobRoleId = role._id;
    // The free-text label is what profiles display; keep it in step with the role.
    person.jobRole = role.name;
    return null;
};

/**
 * Employees carry a pre-selected `defaultWorkMode`. If access is narrowed so
 * that default is no longer allowed, move it to something that is — otherwise
 * the check-in screen would open on an option the server refuses.
 */
const reconcileDefaultMode = (person, modes) => {
    if (!person.schema.path("defaultWorkMode")) return; // managers have none
    if (!modes.includes(person.defaultWorkMode)) person.defaultWorkMode = modes[0];
};

const describeAccess = async (person, kind) => {
    const { modes, source, roleName } = await resolveAllowedWorkModes(person);
    const roleRef = person.jobRoleId;
    return {
        _id: person._id,
        kind,
        name: person.name,
        email: person.email,
        jobRoleId: roleRef?._id || roleRef || null,
        jobRole: roleName,
        workModesOverride: cleanModes(person.workModesOverride),
        allowedWorkModes: modes,
        source, // "override" | "role" | "unassigned"
        manager: kind === "employee" && person.manager?.name
            ? { _id: person.manager._id, name: person.manager.name }
            : null,
    };
};

// ==================== JOB ROLES ====================

// GET /api/admin/job-roles  and  GET /api/manager/job-roles
const listJobRoles = async (req, res) => {
    try {
        // Only admins may see retired roles; they matter for cleanup, not for
        // anyone choosing a role.
        const includeInactive = !!req.admin && req.query.includeInactive === "true";
        const roles = await JobRole.find(includeInactive ? {} : { isActive: true })
            .sort({ name: 1 })
            .lean();

        const countBy = (Model) =>
            Model.aggregate([
                { $match: { jobRoleId: { $ne: null } } },
                { $group: { _id: "$jobRoleId", n: { $sum: 1 } } },
            ]);
        const [empCounts, mgrCounts] = await Promise.all([countBy(Employee), countBy(Manager)]);
        const toMap = (rows) => Object.fromEntries(rows.map((r) => [String(r._id), r.n]));
        const emp = toMap(empCounts);
        const mgr = toMap(mgrCounts);

        return res.json(
            roles.map((r) => ({
                ...r,
                employeeCount: emp[String(r._id)] || 0,
                managerCount: mgr[String(r._id)] || 0,
            }))
        );
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/admin/job-roles
const createJobRole = async (req, res) => {
    try {
        const { name, description, allowedWorkModes, appliesTo } = req.body || {};
        const trimmed = String(name || "").trim();
        if (!trimmed) return res.status(400).json({ message: "Role name is required" });

        const modes = cleanModes(allowedWorkModes);
        if (!modes.length) {
            return res.status(400).json({ message: "Choose at least one attendance mode for this role" });
        }
        if (appliesTo !== undefined && !APPLIES_TO.includes(appliesTo)) {
            return res.status(400).json({ message: "appliesTo must be employee, manager or both" });
        }

        const clash = await JobRole.findOne({ nameKey: trimmed.toLowerCase() }).lean();
        if (clash) {
            return res.status(409).json({ message: `A role called "${clash.name}" already exists` });
        }

        const role = await JobRole.create({
            name: trimmed,
            nameKey: trimmed.toLowerCase(),
            description: description ? String(description).trim() : undefined,
            allowedWorkModes: modes,
            appliesTo: appliesTo || "both",
        });
        return res.status(201).json(role);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/job-roles/:id
const updateJobRole = async (req, res) => {
    try {
        if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid job role" });
        const role = await JobRole.findById(req.params.id);
        if (!role) return res.status(404).json({ message: "Job role not found" });

        const { name, description, allowedWorkModes, appliesTo, isActive } = req.body || {};
        const previousName = role.name;

        if (name !== undefined) {
            const trimmed = String(name).trim();
            if (!trimmed) return res.status(400).json({ message: "Role name cannot be empty" });
            const clash = await JobRole.findOne({
                nameKey: trimmed.toLowerCase(),
                _id: { $ne: role._id },
            }).lean();
            if (clash) {
                return res.status(409).json({ message: `A role called "${clash.name}" already exists` });
            }
            role.name = trimmed;
        }
        if (description !== undefined) role.description = String(description).trim() || undefined;
        if (allowedWorkModes !== undefined) {
            const modes = cleanModes(allowedWorkModes);
            if (!modes.length) {
                return res.status(400).json({ message: "A role must allow at least one attendance mode" });
            }
            role.allowedWorkModes = modes;
        }
        if (appliesTo !== undefined) {
            if (!APPLIES_TO.includes(appliesTo)) {
                return res.status(400).json({ message: "appliesTo must be employee, manager or both" });
            }
            // Narrowing must not strand people who already hold the role.
            if (appliesTo !== "both") {
                const Other = appliesTo === "employee" ? Manager : Employee;
                const stranded = await Other.countDocuments({ jobRoleId: role._id });
                if (stranded) {
                    const who = appliesTo === "employee" ? "manager" : "employee";
                    return res.status(409).json({
                        message: `${stranded} ${who}${stranded === 1 ? "" : "s"} hold this role. Reassign them before limiting it to ${appliesTo}s.`,
                    });
                }
            }
            role.appliesTo = appliesTo;
        }
        if (typeof isActive === "boolean") role.isActive = isActive;

        await role.save();

        // People display the role's name; keep their label in step with a rename.
        if (role.name !== previousName) {
            await Promise.all([
                Employee.updateMany({ jobRoleId: role._id }, { jobRole: role.name }),
                Manager.updateMany({ jobRoleId: role._id }, { jobRole: role.name }),
            ]);
        }

        // Narrowing a role's modes can leave an employee's pre-selected default
        // outside what they may now use. Move those defaults along.
        if (allowedWorkModes !== undefined) {
            await Employee.updateMany(
                {
                    jobRoleId: role._id,
                    defaultWorkMode: { $nin: role.allowedWorkModes },
                    $or: [{ workModesOverride: { $exists: false } }, { workModesOverride: { $size: 0 } }],
                },
                { defaultWorkMode: role.allowedWorkModes[0] }
            );
        }

        return res.json(role);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// DELETE /api/admin/job-roles/:id
const deleteJobRole = async (req, res) => {
    try {
        if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid job role" });
        const role = await JobRole.findById(req.params.id);
        if (!role) return res.status(404).json({ message: "Job role not found" });

        // Deleting a held role would silently widen those people to "every mode"
        // (unassigned). Make the admin choose: reassign, or retire instead.
        const [emps, mgrs] = await Promise.all([
            Employee.countDocuments({ jobRoleId: role._id }),
            Manager.countDocuments({ jobRoleId: role._id }),
        ]);
        if (emps + mgrs > 0) {
            return res.status(409).json({
                message: `"${role.name}" is assigned to ${emps + mgrs} ${emps + mgrs === 1 ? "person" : "people"}. Reassign them, or retire the role instead.`,
            });
        }

        await role.deleteOne();
        return res.json({ ok: true });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== PER-PERSON ACCESS ====================

// GET /api/admin/work-access?kind=employee|manager
const listWorkAccess = async (req, res) => {
    try {
        const kind = req.query.kind;
        const [employees, managers] = await Promise.all([
            kind === "manager"
                ? []
                : Employee.find()
                    .select("name email manager jobRoleId workModesOverride")
                    .populate("jobRoleId", "name allowedWorkModes")
                    .populate("manager", "name")
                    .sort({ name: 1 }),
            kind === "employee"
                ? []
                : Manager.find()
                    .select("name email jobRoleId workModesOverride")
                    .populate("jobRoleId", "name allowedWorkModes")
                    .sort({ name: 1 }),
        ]);

        const people = [
            ...(await Promise.all(employees.map((e) => describeAccess(e, "employee")))),
            ...(await Promise.all(managers.map((m) => describeAccess(m, "manager")))),
        ];

        return res.json({
            people,
            unassigned: people.filter((p) => p.source === "unassigned").length,
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/{employees|managers}/:id/work-access
const updateWorkAccess = (kind) => async (req, res) => {
    try {
        const { Model } = KINDS[kind];
        if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid id" });

        const person = await Model.findById(req.params.id);
        if (!person) return res.status(404).json({ message: `${kind === "employee" ? "Employee" : "Manager"} not found` });

        const { jobRoleId, workModesOverride } = req.body || {};

        const roleError = await applyJobRole(person, kind, jobRoleId);
        if (roleError) return res.status(400).json({ message: roleError });

        if (workModesOverride !== undefined) {
            if (workModesOverride === null) {
                person.set("workModesOverride", undefined);
            } else if (!Array.isArray(workModesOverride)) {
                return res.status(400).json({ message: "workModesOverride must be a list of modes, or null" });
            } else {
                const modes = cleanModes(workModesOverride);
                // An empty override means "follow the role", not "allow nothing" —
                // nobody should be left unable to check in at all.
                person.set("workModesOverride", modes.length ? modes : undefined);
            }
        }

        const { modes } = await resolveAllowedWorkModes(person);
        reconcileDefaultMode(person, modes);
        await person.save();

        await person.populate("jobRoleId", "name allowedWorkModes");
        if (kind === "employee") await person.populate("manager", "name");
        return res.json(await describeAccess(person, kind));
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== OUT-OF-PREMISES APPROVALS ====================

// An out-of-premises check-in awaiting a decision. Kept identical to the rule in
// utils/attendanceCounting.js so the queue never lists a day that summaries are
// already counting, or omits one they are holding back. Rows that merely
// default to "pending" (no check-in, or no out-of-premises flag) are not approvals.
const PENDING_FILTER = {
    approvalStatus: "pending",
    locationWithinBoundary: false,
    "checkIn.time": { $ne: null },
};

// GET /api/admin/attendance/pending
const getPendingEmployeeAttendance = async (req, res) => {
    try {
        const records = await Attendance.find(PENDING_FILTER)
            .populate({
                path: "employee",
                select: "name email manager",
                populate: { path: "manager", select: "name" },
            })
            .sort({ date: -1 })
            .limit(300);
        return res.json(records);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/attendance/pending
const getPendingTeamAttendance = async (req, res) => {
    try {
        const team = await Employee.find({ manager: req.manager._id }).select("_id");
        const records = await Attendance.find({
            ...PENDING_FILTER,
            employee: { $in: team.map((e) => e._id) },
        })
            .populate("employee", "name email")
            .sort({ date: -1 })
            .limit(300);
        return res.json(records);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/manager-attendance/pending
const getPendingManagerAttendance = async (req, res) => {
    try {
        const records = await ManagerAttendance.find(PENDING_FILTER)
            .populate("manager", "name email")
            .sort({ date: -1 })
            .limit(300);
        return res.json(records);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/attendance/:id/approve   body: { status, remarks? }
//
// Admins may decide any employee's record — including one their manager has
// already decided, since that is what an admin override is for.
const adminApproveEmployeeAttendance = async (req, res) => {
    try {
        const { status, remarks } = req.body || {};
        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }
        if (!isValidId(req.params.id)) return res.status(400).json({ message: "Invalid attendance id" });

        const attendance = await Attendance.findById(req.params.id).populate("employee", "name pushSubscription");
        if (!attendance) return res.status(404).json({ message: "Attendance record not found" });

        attendance.approvalStatus = status;
        if (remarks) attendance.adminRemarks = String(remarks).trim();
        attendance.approvedBy = { userType: "Admin", userId: req.admin._id };
        attendance.approvedAt = new Date();
        await attendance.save();

        if (attendance.employee?.pushSubscription) {
            try {
                await notifyIfEnabled("attendance", attendance.employee.pushSubscription, {
                    title: `Attendance ${status === "approved" ? "Approved" : "Rejected"}`,
                    body: `Your attendance for ${attendance.date} has been ${status}${remarks ? ": " + remarks : ""}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/employee/dashboard?tab=attendance" },
                });
            } catch (pushErr) {
                console.error("Push error:", pushErr.message);
            }
        }

        return res.json(attendance);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    applyJobRole,
    listJobRoles,
    createJobRole,
    updateJobRole,
    deleteJobRole,
    listWorkAccess,
    updateWorkAccess,
    getPendingEmployeeAttendance,
    getPendingTeamAttendance,
    getPendingManagerAttendance,
    adminApproveEmployeeAttendance,
};
