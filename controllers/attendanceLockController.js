/*
  attendanceLockController.js — closing a month's attendance.

  Mounted at /api/admin/attendance/locks. Admin only: locking decides what
  people are paid, and reopening undoes that decision.

  The readiness check is the point of this screen. Locking a month with
  approvals still outstanding is worse than not locking at all, because an
  out-of-premises day that nobody approved counts as neither worked nor
  rejected — utils/attendanceCounting.js holds it back from days and hours —
  so the person is quietly underpaid and the figure looks settled. Every
  blocker below is something that would change the month's worked totals if it
  were resolved after payroll had run.
*/
const AttendanceMonthLock = require("../models/AttendanceMonthLock");
const Attendance = require("../models/Attendance");
const ManagerAttendance = require("../models/ManagerAttendance");
const CorrectionRequest = require("../models/CorrectionRequest");
const ManagerCorrectionRequest = require("../models/ManagerCorrectionRequest");
const Leave = require("../models/Leave");
const ManagerLeave = require("../models/ManagerLeave");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const { isCountedTowardHours } = require("../utils/attendanceCounting");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const pad2 = (n) => String(n).padStart(2, "0");

const monthBounds = (month) => {
    const [y, m] = month.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    return { start: `${y}-${pad2(m)}-01`, end: `${y}-${pad2(m)}-${pad2(lastDay)}` };
};

const currentMonth = () => {
    const now = new Date();
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
};

const actorFromReq = (req) => {
    if (req.admin) {
        return {
            userType: "Admin",
            userId: req.admin._id,
            name: req.admin.name || req.admin.email,
        };
    }
    if (req.manager) {
        return {
            userType: "Manager",
            userId: req.manager._id,
            name: req.manager.name || req.manager.email,
        };
    }
    return undefined;
};

/**
 * Everything unresolved in this month that would move somebody's worked days
 * or hours if it were decided later.
 */
const readinessFor = async (month) => {
    const { start, end } = monthBounds(month);
    const inMonth = { $gte: start, $lte: end };

    // A pending out-of-premises day counts as neither worked nor rejected, so
    // it is pay currently being withheld pending a decision.
    const pendingPremises = {
        approvalStatus: "pending",
        locationWithinBoundary: false,
        "checkIn.time": { $ne: null },
        date: inMonth,
    };

    // A leave request overlapping the month; approving it writes 'leave' rows
    // into days currently counted as absent.
    const overlapsMonth = { startDate: { $lte: end }, endDate: { $gte: start } };

    const [
        empPremises, mgrPremises,
        empCorrections, mgrCorrections,
        empLeaves, mgrLeaves,
        employees, managers,
        records,
    ] = await Promise.all([
        Attendance.countDocuments(pendingPremises),
        ManagerAttendance.countDocuments(pendingPremises),
        CorrectionRequest.countDocuments({ status: "pending", date: inMonth }),
        ManagerCorrectionRequest.countDocuments({ status: "pending", date: inMonth }),
        Leave.countDocuments({ status: "pending", ...overlapsMonth }),
        ManagerLeave.countDocuments({ status: "pending", ...overlapsMonth }),
        Employee.countDocuments({}),
        Manager.countDocuments({}),
        Attendance.find({ date: inMonth })
            .select("status workingHours approvalStatus locationWithinBoundary")
            .lean(),
    ]);

    const blockers = [
        {
            key: "premisesApprovals",
            label: "Out-of-premises check-ins awaiting a decision",
            count: empPremises + mgrPremises,
            why: "These days count as neither worked nor rejected, so the people involved would be paid short.",
            where: "Attendance → Out-of-Premises",
        },
        {
            key: "corrections",
            label: "Attendance corrections awaiting a decision",
            count: empCorrections + mgrCorrections,
            why: "Approving one after the lock would change hours payroll had already used.",
            where: "Attendance → Corrections",
        },
        {
            key: "leaves",
            label: "Leave requests awaiting a decision",
            count: empLeaves + mgrLeaves,
            why: "Approving one writes leave days into this month, turning days currently counted as absent into leave.",
            where: "Leaves",
        },
    ].filter((b) => b.count > 0);

    const workedHours = records.reduce(
        (sum, r) => sum + (isCountedTowardHours(r) ? r.workingHours || 0 : 0),
        0
    );

    return {
        month,
        blockers,
        ready: blockers.length === 0,
        snapshot: {
            employees,
            managers,
            attendanceRecords: records.length,
            workedHours: Math.round(workedHours * 100) / 100,
            takenAt: new Date(),
        },
    };
};

// GET /api/admin/attendance/locks?year=2026
//
// One row per month of the year with its lock state and whether it is ready to
// close, so a whole year reads at a glance.
const listLocks = async (req, res) => {
    try {
        const year = parseInt(req.query.year, 10) || new Date().getFullYear();
        const months = Array.from({ length: 12 }, (_, i) => `${year}-${pad2(i + 1)}`);

        const locks = await AttendanceMonthLock.find({ month: { $in: months } }).lean();
        const byMonth = new Map(locks.map((l) => [l.month, l]));
        const thisMonth = currentMonth();

        const items = [];
        for (const month of months) {
            const lock = byMonth.get(month);
            const status = lock?.status || "open";
            const inFuture = month > thisMonth;
            // Readiness only means something for a month that has happened.
            const readiness =
                !inFuture && status === "open" ? await readinessFor(month) : null;
            items.push({
                month,
                status,
                isCurrentMonth: month === thisMonth,
                inFuture,
                lockedAt: lock?.lockedAt || null,
                lockedBy: lock?.lockedBy || null,
                lockNote: lock?.lockNote || null,
                reopenedAt: lock?.reopenedAt || null,
                reopenReason: lock?.reopenReason || null,
                blockers: readiness?.blockers || [],
                ready: readiness ? readiness.ready : null,
            });
        }

        return res.json({ year, items });
    } catch (err) {
        console.error("listLocks error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/attendance/locks/:month
const getLock = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const lock = await AttendanceMonthLock.findOne({ month }).lean();
        const readiness = await readinessFor(month);
        return res.json({
            month,
            status: lock?.status || "open",
            lockedAt: lock?.lockedAt || null,
            lockedBy: lock?.lockedBy || null,
            lockNote: lock?.lockNote || null,
            reopenedAt: lock?.reopenedAt || null,
            reopenedBy: lock?.reopenedBy || null,
            reopenReason: lock?.reopenReason || null,
            history: lock?.history || [],
            snapshot: lock?.snapshot || null,
            blockers: readiness.blockers,
            ready: readiness.ready,
            liveSnapshot: readiness.snapshot,
        });
    } catch (err) {
        console.error("getLock error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/admin/attendance/locks/:month/lock   body: { note?, force? }
//
// `force` exists because an admin may genuinely decide to close a month with
// something outstanding — but it is never the default, and what was
// outstanding is written into the history so the decision stays visible.
const lockMonth = async (req, res) => {
    try {
        if (!req.admin) {
            return res.status(403).json({ message: "Only an admin can lock a month" });
        }
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        if (month > currentMonth()) {
            return res.status(400).json({
                message: "A month that has not happened yet cannot be locked.",
            });
        }

        const existing = await AttendanceMonthLock.findOne({ month });
        if (existing && existing.status === "locked") {
            return res.status(409).json({ message: `${month} is already locked.` });
        }

        const readiness = await readinessFor(month);
        const force = req.body?.force === true || req.body?.force === "true";
        if (!readiness.ready && !force) {
            return res.status(409).json({
                message:
                    "This month still has approvals outstanding. Resolve them, or lock anyway if you have decided to leave them.",
                blockers: readiness.blockers,
            });
        }

        const actor = actorFromReq(req);
        const now = new Date();
        const note = String(req.body?.note || "").trim();
        const outstanding = readiness.blockers
            .map((b) => `${b.count} ${b.label.toLowerCase()}`)
            .join("; ");

        const lock = existing || new AttendanceMonthLock({ month });
        lock.status = "locked";
        lock.lockedAt = now;
        lock.lockedBy = actor;
        lock.lockNote = note || undefined;
        lock.snapshot = readiness.snapshot;
        lock.history = lock.history || [];
        lock.history.push({
            action: "locked",
            at: now,
            by: actor,
            reason: outstanding
                ? `Locked with outstanding items: ${outstanding}${note ? ` — ${note}` : ""}`
                : note || "Locked with nothing outstanding",
        });
        await lock.save();

        return res.json(lock);
    } catch (err) {
        console.error("lockMonth error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/admin/attendance/locks/:month/reopen   body: { reason }
const reopenMonth = async (req, res) => {
    try {
        if (!req.admin) {
            return res.status(403).json({ message: "Only an admin can reopen a month" });
        }
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const reason = String(req.body?.reason || "").trim();
        if (reason.length < 5) {
            return res.status(400).json({
                message: "A reason is required to reopen a locked month.",
            });
        }

        const lock = await AttendanceMonthLock.findOne({ month });
        if (!lock || lock.status !== "locked") {
            return res.status(409).json({ message: `${month} is not locked.` });
        }

        const actor = actorFromReq(req);
        const now = new Date();
        lock.status = "open";
        lock.reopenedAt = now;
        lock.reopenedBy = actor;
        lock.reopenReason = reason;
        lock.history = lock.history || [];
        lock.history.push({ action: "reopened", at: now, by: actor, reason });
        await lock.save();

        return res.json(lock);
    } catch (err) {
        console.error("reopenMonth error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    listLocks,
    getLock,
    lockMonth,
    reopenMonth,
    // Exported for payroll, which must refuse to run on an open month.
    readinessFor,
    monthBounds,
    currentMonth,
};
