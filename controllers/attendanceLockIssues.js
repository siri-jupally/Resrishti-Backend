/*
  attendanceLockIssues.js — every unresolved record standing between a month
  and being closed, named.

  The readiness check in attendanceLockController answers "how many?", which is
  enough to decide whether to close a month but useless for actually clearing
  it. This answers "which ones, whose, and where do I go to settle it" — the
  month report.

  Each issue carries a `resolveAt` telling the UI which screen settles it.
  Employee corrections are the exception: only the employee's own manager can
  review those, so instead of a dead link the issue names the manager to chase.

  GET /api/admin/attendance/locks/:month/issues
*/
const Attendance = require("../models/Attendance");
const ManagerAttendance = require("../models/ManagerAttendance");
const CorrectionRequest = require("../models/CorrectionRequest");
const ManagerCorrectionRequest = require("../models/ManagerCorrectionRequest");
const Leave = require("../models/Leave");
const ManagerLeave = require("../models/ManagerLeave");
const { monthBounds } = require("./attendanceLockController");
const { notifyIfEnabled } = require("../utils/push");
const { sendEmail } = require("../utils/emailService");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const hoursLabel = (h) => (h ? `${Math.round(h * 10) / 10} h` : "—");

const getMonthIssues = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const { start, end } = monthBounds(month);
        const inMonth = { $gte: start, $lte: end };
        const overlapsMonth = { startDate: { $lte: end }, endDate: { $gte: start } };

        // A day awaiting an out-of-premises decision counts as neither worked
        // nor rejected, so these are hours currently being withheld.
        const pendingPremises = {
            approvalStatus: "pending",
            locationWithinBoundary: false,
            "checkIn.time": { $ne: null },
            date: inMonth,
        };

        const [
            empPremises, mgrPremises,
            empCorrections, mgrCorrections,
            empLeaves, mgrLeaves,
        ] = await Promise.all([
            Attendance.find(pendingPremises)
                .populate({ path: "employee", select: "name email manager", populate: { path: "manager", select: "name email" } })
                .sort({ date: 1 })
                .lean(),
            ManagerAttendance.find(pendingPremises)
                .populate("manager", "name email")
                .sort({ date: 1 })
                .lean(),
            CorrectionRequest.find({ status: "pending", date: inMonth })
                .populate({ path: "employee", select: "name email manager", populate: { path: "manager", select: "name email" } })
                .sort({ date: 1 })
                .lean(),
            ManagerCorrectionRequest.find({ status: "pending", date: inMonth })
                .populate("manager", "name email")
                .sort({ date: 1 })
                .lean(),
            Leave.find({ status: "pending", ...overlapsMonth })
                .populate({ path: "employee", select: "name email manager", populate: { path: "manager", select: "name email" } })
                .sort({ startDate: 1 })
                .lean(),
            ManagerLeave.find({ status: "pending", ...overlapsMonth })
                .populate("manager", "name email")
                .sort({ startDate: 1 })
                .lean(),
        ]);

        const personOf = (doc) => {
            const person = doc.employee || doc.manager;
            return {
                name: person?.name || person?.email || "Unknown",
                email: person?.email || null,
                kind: doc.employee ? "Employee" : "Manager",
                // Who to chase when an admin cannot settle it themselves.
                manager: doc.employee?.manager?.name || doc.employee?.manager?.email || null,
            };
        };

        const groups = [
            {
                key: "premisesEmployee",
                title: "Employee check-ins pending a location decision",
                why: "Until somebody decides, these days count as neither worked nor rejected — the person is paid short. Some have no location captured at all (not confirmed off-site).",
                resolveAt: { tab: "attendance", sub: "premises", label: "Emp. Attendance → Out-of-Premises" },
                items: empPremises.map((row) => ({
                    id: String(row._id),
                    person: personOf(row),
                    date: row.date,
                    locationMissing: !!row.locationMissing,
                    detail: `${row.workMode || "WFO"} · ${hoursLabel(row.workingHours)}${row.locationMissing ? " · no location captured" : " · outside office"}`,
                    note: row.wfhTaskSummary || null,
                })),
            },
            {
                key: "premisesManager",
                title: "Manager check-ins pending a location decision",
                why: "Same as above, for managers — their hours are held back until decided. Some have no location captured at all.",
                resolveAt: { tab: "managerAttendance", sub: "premises", label: "Mgr. Attendance → Out-of-Premises" },
                items: mgrPremises.map((row) => ({
                    id: String(row._id),
                    person: personOf(row),
                    date: row.date,
                    locationMissing: !!row.locationMissing,
                    detail: `${row.workMode || "WFO"} · ${hoursLabel(row.workingHours)}${row.locationMissing ? " · no location captured" : " · outside office"}`,
                    note: row.wfhTaskSummary || null,
                })),
            },
            {
                key: "correctionsEmployee",
                title: "Employee attendance corrections",
                why: "Approving one after the month closes would change hours payroll had already used.",
                // Only the employee's own manager may review these, so there is
                // no admin screen to send anybody to.
                resolveAt: null,
                chaseManager: true,
                items: empCorrections.map((row) => ({
                    id: String(row._id),
                    person: personOf(row),
                    date: row.date,
                    detail: (row.correctionType || "incorrect-data").replace(/-/g, " "),
                    note: row.reason || null,
                })),
            },
            {
                key: "correctionsManager",
                title: "Manager attendance corrections",
                why: "Approving one after the month closes would change hours payroll had already used.",
                resolveAt: { tab: "managerAttendance", sub: "corrections", label: "Mgr. Attendance → Corrections" },
                items: mgrCorrections.map((row) => ({
                    id: String(row._id),
                    person: personOf(row),
                    date: row.date,
                    detail: (row.correctionType || "incorrect-data").replace(/-/g, " "),
                    note: row.reason || null,
                })),
            },
            {
                key: "leavesEmployee",
                title: "Employee leave awaiting a decision",
                why: "Approving one writes leave days into this month, turning days now counted as absent into leave.",
                resolveAt: { tab: "leaves", sub: null, label: "Leaves" },
                items: empLeaves.map((row) => ({
                    id: String(row._id),
                    person: personOf(row),
                    date: row.startDate === row.endDate ? row.startDate : `${row.startDate} → ${row.endDate}`,
                    detail: `${row.type} leave`,
                    note: row.reason || null,
                })),
            },
            {
                key: "leavesManager",
                title: "Manager leave awaiting a decision",
                why: "Approving one writes leave days into this month for that manager.",
                resolveAt: { tab: "managerAttendance", sub: "leaves", label: "Mgr. Attendance → Manager Leaves" },
                items: mgrLeaves.map((row) => ({
                    id: String(row._id),
                    person: personOf(row),
                    date: row.startDate === row.endDate ? row.startDate : `${row.startDate} → ${row.endDate}`,
                    detail: `${row.type} leave`,
                    note: row.reason || null,
                })),
            },
        ].filter((group) => group.items.length > 0);

        const total = groups.reduce((sum, g) => sum + g.items.length, 0);

        // Who appears more than once — chasing one person about three things is
        // one conversation, not three.
        const byPerson = new Map();
        for (const group of groups) {
            for (const item of group.items) {
                const key = `${item.person.kind}:${item.person.email || item.person.name}`;
                const entry = byPerson.get(key) || { ...item.person, count: 0 };
                entry.count += 1;
                byPerson.set(key, entry);
            }
        }

        return res.json({
            month,
            total,
            groups,
            people: [...byPerson.values()].sort((a, b) => b.count - a.count),
        });
    } catch (err) {
        console.error("getMonthIssues error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/admin/attendance/locks/:month/notify-corrections
//
// Employee corrections can only be reviewed by each employee's OWN manager, so
// before a month closes the admin needs those managers to act. Rather than
// leaving the admin to chase names off the month report, this pings every
// manager who has a pending employee correction this month — push + email (#4).
const notifyCorrectionManagers = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const { start, end } = monthBounds(month);
        const inMonth = { $gte: start, $lte: end };

        const pending = await CorrectionRequest.find({ status: "pending", date: inMonth })
            .populate({
                path: "employee",
                select: "name manager",
                populate: { path: "manager", select: "name email pushSubscription" },
            })
            .lean();

        if (pending.length === 0) {
            return res.json({
                notified: 0, managers: 0, corrections: 0,
                message: "No pending employee corrections for this month.",
            });
        }

        // One notification per manager, however many corrections they own.
        const byManager = new Map();
        for (const c of pending) {
            const mgr = c.employee?.manager;
            if (!mgr?._id) continue;
            const key = String(mgr._id);
            if (!byManager.has(key)) byManager.set(key, { manager: mgr, count: 0 });
            byManager.get(key).count += 1;
        }

        const monthLabel = new Date(`${month}-01T00:00:00`).toLocaleString("en-US", {
            month: "long", year: "numeric",
        });

        let notified = 0;
        for (const { manager, count } of byManager.values()) {
            const body = `${count} attendance correction${count === 1 ? "" : "s"} for ${monthLabel} need your review before payroll can run.`;
            try {
                if (manager.pushSubscription) {
                    await notifyIfEnabled("attendance", manager.pushSubscription, {
                        title: "Corrections need your review",
                        body,
                        icon: "/android-chrome-512x512.png",
                        data: { url: "/manager/dashboard?tab=attendance" },
                    });
                }
            } catch (e) { console.error("correction-notify push failed:", e.message); }
            try {
                if (manager.email) {
                    await sendEmail(
                        manager.email,
                        `Attendance corrections awaiting your review — ${monthLabel}`,
                        undefined,
                        `<p>Hello ${manager.name || ""},</p><p>${body}</p>
                         <p>Please review them in your dashboard so this month's payroll can be run.</p>`
                    );
                }
            } catch (e) { console.error("correction-notify email failed:", e.message); }
            notified += 1;
        }

        return res.json({
            notified,
            managers: byManager.size,
            corrections: pending.length,
            message: `Notified ${notified} manager${notified === 1 ? "" : "s"} about ${pending.length} pending correction${pending.length === 1 ? "" : "s"}.`,
        });
    } catch (err) {
        console.error("notifyCorrectionManagers error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = { getMonthIssues, notifyCorrectionManagers };
