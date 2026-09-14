/*
  workModeRequestController — WFH / remote work requests.

  Employees ask to work WFH or remote on a date range; their manager approves or
  rejects; admins can override either way. Only an approved request lets the
  employee check in with that work mode (enforced in utils/workModeGuard.js).

  Endpoints:
    Employee  POST   /api/employee/work-mode-requests        createRequest
              GET    /api/employee/work-mode-requests        getMyRequests
              PATCH  /api/employee/work-mode-requests/:id/cancel  cancelRequest
    Manager   GET    /api/manager/work-mode-requests         getTeamRequests
              PATCH  /api/manager/work-mode-requests/:id     reviewRequest
    Admin     GET    /api/admin/work-mode-requests           getAllRequests
              PATCH  /api/admin/work-mode-requests/:id       adminReviewRequest

  Mirrors the leave flow in attendanceController / attendanceManagerController
  so both the API shape and the review UI stay consistent.
*/
const WorkModeRequest = require("../models/WorkModeRequest");
const AttendancePolicy = require("../models/AttendancePolicy");
const Attendance = require("../models/Attendance");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const { notifyIfEnabled } = require("../utils/push");
const { MODE_CONFIG, countUsedDaysThisMonth } = require("../utils/workModeGuard");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Every YYYY-MM-DD from start to end inclusive. */
const datesInRange = (startDate, endDate) => {
    const out = [];
    const [sy, sm, sd] = startDate.split("-").map(Number);
    const [ey, em, ed] = endDate.split("-").map(Number);
    const cur = new Date(sy, sm - 1, sd);
    const last = new Date(ey, em - 1, ed);
    while (cur <= last) {
        const pad = (n) => String(n).padStart(2, "0");
        out.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}-${pad(cur.getDate())}`);
        cur.setDate(cur.getDate() + 1);
    }
    return out;
};

// ==================== EMPLOYEE ====================

// POST /api/employee/work-mode-requests
const createRequest = async (req, res) => {
    try {
        const { workMode, startDate, endDate, reason } = req.body;

        if (!MODE_CONFIG[workMode]) {
            return res.status(400).json({ message: "workMode must be 'WFH' or 'remote'" });
        }
        if (!DATE_RE.test(startDate || "") || !DATE_RE.test(endDate || "")) {
            return res.status(400).json({ message: "startDate and endDate must be YYYY-MM-DD" });
        }
        if (endDate < startDate) {
            return res.status(400).json({ message: "endDate cannot be before startDate" });
        }
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ message: "A reason is required" });
        }

        const policy = await AttendancePolicy.findOne();
        const config = MODE_CONFIG[workMode];

        // Refuse up front if the mode is switched off — otherwise the employee
        // waits for an approval that could never let them check in anyway.
        if (policy && policy[config.enabledField] === false) {
            return res.status(403).json({
                message: `${config.label} is currently disabled by your organization.`,
            });
        }

        // Overlapping request for the same mode? Approving two would make the
        // day counts ambiguous, and it is almost always a double submission.
        const clash = await WorkModeRequest.findOne({
            employee: req.employee._id,
            workMode,
            status: { $in: ["pending", "approved"] },
            startDate: { $lte: endDate },
            endDate: { $gte: startDate },
        });
        if (clash) {
            return res.status(409).json({
                message: `You already have a ${clash.status} ${config.label.toLowerCase()} request covering ${clash.startDate} to ${clash.endDate}.`,
            });
        }

        // Warn-and-refuse if the request alone would exceed the monthly quota.
        // Checked per month so a range spanning a month boundary is judged
        // against each month's own allowance.
        const limit = policy?.[config.limitField] ?? config.defaultLimit;
        if (limit > 0) {
            const byMonth = {};
            for (const d of datesInRange(startDate, endDate)) {
                const key = d.slice(0, 7);
                byMonth[key] = (byMonth[key] || 0) + 1;
            }
            for (const [month, requested] of Object.entries(byMonth)) {
                const used = await countUsedDaysThisMonth(
                    Attendance,
                    req.employee._id,
                    workMode,
                    `${month}-01`
                );
                if (used + requested > limit) {
                    return res.status(400).json({
                        message: `This request needs ${requested} ${config.label.toLowerCase()} day(s) in ${month}, but only ${Math.max(0, limit - used)} of your ${limit} remain.`,
                    });
                }
            }
        }

        const request = await WorkModeRequest.create({
            employee: req.employee._id,
            workMode,
            startDate,
            endDate,
            reason: String(reason).trim(),
        });

        // Tell the manager there is something to review.
        try {
            const manager = await Manager.findById(req.employee.manager).select("pushSubscription");
            if (manager?.pushSubscription) {
                await notifyIfEnabled("attendance", manager.pushSubscription, {
                    title: `${config.label} request`,
                    body: `${req.employee.name} requested ${config.label.toLowerCase()} from ${startDate} to ${endDate}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/manager/dashboard?tab=attendance" },
                });
            }
        } catch (pushErr) {
            console.error("Work-mode request push error:", pushErr.message);
        }

        return res.status(201).json(request);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/employee/work-mode-requests?status=
const getMyRequests = async (req, res) => {
    try {
        const filter = { employee: req.employee._id };
        if (req.query.status) filter.status = req.query.status;
        const requests = await WorkModeRequest.find(filter)
            .populate("reviewedBy", "name")
            .sort({ createdAt: -1 })
            .limit(100);
        return res.json(requests);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/employee/work-mode-requests/:id/cancel
const cancelRequest = async (req, res) => {
    try {
        const request = await WorkModeRequest.findOne({
            _id: req.params.id,
            employee: req.employee._id,
        });
        if (!request) {
            return res.status(404).json({ message: "Request not found" });
        }
        // Only a request nobody has acted on yet. Cancelling an approved one
        // would silently revoke days the employee may already have worked.
        if (request.status !== "pending") {
            return res.status(409).json({
                message: `Only a pending request can be cancelled (this one is ${request.status}).`,
            });
        }
        request.status = "cancelled";
        await request.save();
        return res.json(request);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== REVIEW (shared) ====================

/**
 * Apply a decision and notify the employee. Shared by the manager and admin
 * paths so the two can never drift apart.
 */
const applyDecision = async ({ request, status, remarks, reviewer, isAdmin }) => {
    request.status = status;
    request.reviewedAt = new Date();
    if (isAdmin) {
        request.adminOverride = true;
        request.adminReviewedBy = reviewer._id;
        if (remarks) request.adminRemarks = remarks;
    } else {
        request.reviewedBy = reviewer._id;
        if (remarks) request.reviewRemarks = remarks;
    }
    await request.save();

    const config = MODE_CONFIG[request.workMode];
    const employee = await Employee.findById(request.employee).select("pushSubscription");
    if (employee?.pushSubscription) {
        try {
            await notifyIfEnabled("attendance", employee.pushSubscription, {
                title: `${config.label} ${status}`,
                body: `Your ${config.label.toLowerCase()} request for ${request.startDate} to ${request.endDate} was ${status}.`,
                icon: "/android-chrome-512x512.png",
                data: { url: "/employee/dashboard?tab=attendance" },
            });
        } catch (pushErr) {
            console.error("Work-mode decision push error:", pushErr.message);
        }
    }
    return request;
};

const validateDecision = (status) =>
    ["approved", "rejected"].includes(status)
        ? null
        : "Status must be 'approved' or 'rejected'";

// ==================== MANAGER ====================

// GET /api/manager/work-mode-requests?status=pending
const getTeamRequests = async (req, res) => {
    try {
        const employees = await Employee.find({ manager: req.manager._id }).select("_id");
        const employeeIds = employees.map((e) => e._id);

        const filter = { employee: { $in: employeeIds } };
        if (req.query.status) filter.status = req.query.status;

        const requests = await WorkModeRequest.find(filter)
            .populate("employee", "name email")
            .populate("reviewedBy", "name")
            .sort({ createdAt: -1 })
            .limit(200);
        return res.json(requests);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/manager/work-mode-requests/:id
const reviewRequest = async (req, res) => {
    try {
        const { status, reviewRemarks } = req.body;
        const invalid = validateDecision(status);
        if (invalid) return res.status(400).json({ message: invalid });

        const request = await WorkModeRequest.findById(req.params.id).populate(
            "employee",
            "name manager"
        );
        if (!request) return res.status(404).json({ message: "Request not found" });

        // A manager may only decide on their own team.
        if (String(request.employee.manager) !== String(req.manager._id)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        if (request.status !== "pending") {
            return res.status(409).json({
                message: `This request has already been ${request.status}.`,
            });
        }

        await applyDecision({
            request,
            status,
            remarks: reviewRemarks,
            reviewer: req.manager,
            isAdmin: false,
        });
        return res.json(request);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== ADMIN ====================

// GET /api/admin/work-mode-requests?status=&employeeId=
const getAllRequests = async (req, res) => {
    try {
        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        if (req.query.employeeId) filter.employee = req.query.employeeId;

        const requests = await WorkModeRequest.find(filter)
            .populate("employee", "name email")
            .populate("reviewedBy", "name")
            .populate("adminReviewedBy", "name")
            .sort({ createdAt: -1 })
            .limit(300);
        return res.json(requests);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/work-mode-requests/:id
//
// Unlike the manager path this may act on an already-decided request: that is
// the point of an override. The original manager decision is preserved in
// reviewedBy / reviewRemarks alongside the admin's.
const adminReviewRequest = async (req, res) => {
    try {
        const { status, adminRemarks } = req.body;
        const invalid = validateDecision(status);
        if (invalid) return res.status(400).json({ message: invalid });

        const request = await WorkModeRequest.findById(req.params.id);
        if (!request) return res.status(404).json({ message: "Request not found" });

        await applyDecision({
            request,
            status,
            remarks: adminRemarks,
            reviewer: req.admin,
            isAdmin: true,
        });
        return res.json(request);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    createRequest,
    getMyRequests,
    cancelRequest,
    getTeamRequests,
    reviewRequest,
    getAllRequests,
    adminReviewRequest,
};
