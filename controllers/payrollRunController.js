/*
  payrollRunController.js — calculating and governing a month's payroll.

  draft ──calculate──▶ review ──approve──▶ approved ──lock──▶ locked
                         ▲                                      │
                         └──────────── reopen (admin) ──────────┘

  Two rules shape everything here:

  1. A run only ever calculates on a LOCKED attendance month. Without that,
     leave approved late or a correction accepted afterwards shifts the
     aggregates under a payroll that has already been computed, and the first
     anybody knows is a dispute. This is the module's hard dependency and it is
     checked before any figure is produced.

  2. Anybody the engine cannot compute confidently is pulled OUT of the run into
     a visible exceptions list. Somebody with no payroll profile, or no rate in
     force for that month, is not paid zero — they are named, and the run says
     it is incomplete until they are dealt with.

  Mounted at /api/payroll/runs.
*/
const mongoose = require("mongoose");

const PayrollRun = require("../models/PayrollRun");
const PayrollLine = require("../models/PayrollLine");
const PayrollProfile = require("../models/PayrollProfile");
const PayrollAudit = require("../models/PayrollAudit");
const PaidDayPolicy = require("../models/PaidDayPolicy");
const AttendancePolicy = require("../models/AttendancePolicy");
const Attendance = require("../models/Attendance");
const ManagerAttendance = require("../models/ManagerAttendance");
const Leave = require("../models/Leave");
const ManagerLeave = require("../models/ManagerLeave");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");

const { getSettings } = require("../utils/payrollDefaults");
const { isMonthLocked } = require("../utils/attendanceLock");
const { buildMonthCalendar, summariseCalendar, datesInMonth } = require("../utils/payrollCalendar");
const { computeLine, round2 } = require("../utils/payrollEngine");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const actorFromReq = (req) => {
    if (req.admin) {
        return { userType: "Admin", userId: req.admin._id, name: req.admin.name || req.admin.email };
    }
    if (req.accountant) {
        return {
            userType: "Accountant",
            userId: req.accountant._id,
            name: req.accountant.name || req.accountant.email,
        };
    }
    return { userType: "System", name: "system" };
};

const audit = async ({ action, run, line, month, req, detail, reason }) => {
    try {
        await PayrollAudit.create({
            action,
            run: run?._id || run,
            line: line?._id || line,
            month: month || run?.month,
            actor: actorFromReq(req),
            detail,
            reason,
        });
    } catch (err) {
        // An audit failure must not swallow the action it was recording, but it
        // is loud, because a gap in the log is a gap in the control.
        console.error("payroll audit write failed:", err.message);
    }
};

const monthBounds = (month) => {
    const dates = datesInMonth(month);
    return { start: dates[0], end: dates[dates.length - 1] };
};

/**
 * Which dates in the month each person was on approved leave, and of what type.
 *
 * Attendance records leave as simply "leave" with no type, so paid and unpaid
 * leave are indistinguishable on the row itself. The type lives on the request,
 * which is why this cross-reference exists at all.
 */
const buildLeaveMap = async (month) => {
    const { start, end } = monthBounds(month);
    const overlaps = {
        status: "approved",
        startDate: { $lte: end },
        endDate: { $gte: start },
    };
    const [employeeLeaves, managerLeaves] = await Promise.all([
        Leave.find(overlaps).select("employee type startDate endDate").lean(),
        ManagerLeave.find(overlaps).select("manager type startDate endDate").lean(),
    ]);

    const byPerson = new Map();
    const add = (personId, leave) => {
        const key = String(personId);
        const dates = byPerson.get(key) || new Map();
        for (const date of datesInMonth(month)) {
            if (date >= leave.startDate && date <= leave.endDate) dates.set(date, leave.type);
        }
        byPerson.set(key, dates);
    };
    employeeLeaves.forEach((l) => add(l.employee, l));
    managerLeaves.forEach((l) => add(l.manager, l));
    return byPerson;
};

// POST /api/payroll/runs/:month/calculate
const calculateRun = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }

        // The hard dependency. Everything below assumes the month cannot move.
        if (!(await isMonthLocked(month))) {
            return res.status(409).json({
                message:
                    `Attendance for ${month} is not closed yet. Payroll can only be worked out on a closed month — otherwise a leave approved tomorrow changes what you paid today.`,
                needsAttendanceLock: true,
            });
        }

        const existing = await PayrollRun.findOne({ month });
        if (existing && ["approved", "locked"].includes(existing.status)) {
            return res.status(409).json({
                message: `${month} has already been ${existing.status}. Reopen it first if it genuinely needs recalculating.`,
            });
        }

        const [settings, attendancePolicy, profiles, policies] = await Promise.all([
            getSettings(),
            AttendancePolicy.findOne().lean(),
            PayrollProfile.find({}).lean(),
            PaidDayPolicy.find({}).lean(),
        ]);

        const calendar = buildMonthCalendar(month, attendancePolicy);
        const calendarSummary = summariseCalendar(calendar);
        const { start, end } = monthBounds(month);
        const policyById = new Map(policies.map((p) => [String(p._id), p]));
        const leaveMap = await buildLeaveMap(month);

        const [employees, managers, empRecords, mgrRecords] = await Promise.all([
            Employee.find({}).select("name email department jobRole").lean(),
            Manager.find({}).select("name email department jobRole").lean(),
            Attendance.find({ date: { $gte: start, $lte: end } })
                .select("employee date status workingHours approvalStatus locationWithinBoundary")
                .lean(),
            ManagerAttendance.find({ date: { $gte: start, $lte: end } })
                .select("manager date status workingHours approvalStatus locationWithinBoundary")
                .lean(),
        ]);

        const recordsByPerson = new Map();
        const push = (personId, record) => {
            const key = String(personId);
            const list = recordsByPerson.get(key) || [];
            list.push(record);
            recordsByPerson.set(key, list);
        };
        empRecords.forEach((r) => push(r.employee, r));
        mgrRecords.forEach((r) => push(r.manager, r));

        const peopleById = new Map([
            ...employees.map((e) => [`Employee:${String(e._id)}`, e]),
            ...managers.map((m) => [`Manager:${String(m._id)}`, m]),
        ]);
        const profileByPerson = new Map(
            profiles.map((p) => [`${p.personType}:${String(p.personId)}`, p])
        );

        // ---- everybody who should be paid, and everybody who cannot be -----
        const exceptions = [];
        const computed = [];

        for (const [key, person] of peopleById.entries()) {
            const [personType, personId] = key.split(":");
            const profile = profileByPerson.get(key);
            const name = person.name || person.email;

            if (!profile) {
                exceptions.push({
                    personType, personId, name,
                    code: "noProfile",
                    message: "Not on payroll yet — add a pay profile before this month can include them.",
                });
                continue;
            }
            if (profile.isActive === false) continue;   // left; not an exception
            if (profile.payrollStartDate && profile.payrollStartDate > end) continue;
            if (profile.payrollEndDate && profile.payrollEndDate < start) continue;

            // The rate in force at the end of the month they are being paid for.
            const applicable = (profile.rates || [])
                .filter((r) => r.effectiveFrom <= end)
                .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
            const rate = applicable[applicable.length - 1];
            if (!rate) {
                exceptions.push({
                    personType, personId, name,
                    code: "noRate",
                    message: `No pay rate was in force during ${month}. Set one effective from a date in or before that month.`,
                });
                continue;
            }

            const records = recordsByPerson.get(String(personId)) || [];
            if (records.length === 0) {
                exceptions.push({
                    personType, personId, name,
                    code: "noAttendance",
                    message: "No attendance at all this month. Check whether they were working before paying them.",
                });
                continue;
            }

            const line = computeLine({
                profile,
                rate,
                policy: policyById.get(String(profile.paidDayPolicy)),
                settings,
                calendar,
                calendarSummary,
                records,
                leaveDates: leaveMap.get(String(personId)) || new Map(),
            });

            computed.push({
                personType,
                personId,
                person,
                profile,
                policyName: policyById.get(String(profile.paidDayPolicy))?.name,
                line,
            });
        }

        // ---- write the run, replacing any earlier draft --------------------
        const actor = actorFromReq(req);
        const now = new Date();

        const run =
            existing ||
            new PayrollRun({ month });
        run.status = "review";
        run.calculatedAt = now;
        run.calculatedBy = actor;
        run.settingsSnapshot = {
            perDayRateBasis: settings.perDayRateBasis,
            halfDayWeight: settings.halfDayWeight,
            overtime: settings.overtime,
            approvalDepth: settings.approvalDepth,
        };
        run.exceptions = exceptions;
        await run.save();

        // Last month's nets, so a person whose pay moved sharply can be flagged
        // before anybody approves it.
        const previousMonth = (() => {
            const [y, m] = month.split("-").map(Number);
            const d = new Date(y, m - 2, 1);
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        })();
        const previousLines = await PayrollLine.find({ month: previousMonth }).select("personId net").lean();
        const previousNetById = new Map(previousLines.map((l) => [String(l.personId), l.net]));

        await PayrollLine.deleteMany({ run: run._id });

        const docs = computed.map(({ personType, personId, person, profile, policyName, line }) => {
            const previousNet = previousNetById.get(String(personId));
            const variancePercent =
                previousNet && previousNet > 0
                    ? round2(((line.net - previousNet) / previousNet) * 100)
                    : null;
            return {
                run: run._id,
                month,
                personType,
                personId,
                personName: person.name || person.email,
                personEmail: person.email,
                department: person.department,
                jobRole: person.jobRole,
                employmentType: profile.employmentType,
                paidDayPolicyName: policyName,
                previousNet: previousNet ?? null,
                variancePercent,
                ...line,
            };
        });
        if (docs.length > 0) await PayrollLine.insertMany(docs);

        const totals = docs.reduce(
            (acc, d) => {
                acc.people += 1;
                acc.gross = round2(acc.gross + d.gross);
                acc.deductions = round2(acc.deductions + (d.deductions || 0));
                acc.adjustments = round2(acc.adjustments + (d.adjustments || 0));
                acc.net = round2(acc.net + d.net);
                acc.overtimePay = round2(acc.overtimePay + (d.overtimePay || 0));
                return acc;
            },
            { people: 0, gross: 0, deductions: 0, adjustments: 0, net: 0, overtimePay: 0 }
        );
        run.totals = totals;
        await run.save();

        await audit({
            action: "run.calculated",
            run,
            month,
            req,
            detail: { people: totals.people, net: totals.net, exceptions: exceptions.length },
        });

        return res.json({ run, lineCount: docs.length, exceptions });
    } catch (err) {
        console.error("calculateRun error:", err);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/payroll/runs
const listRuns = async (req, res) => {
    try {
        const runs = await PayrollRun.find({}).sort({ month: -1 }).limit(36).lean();
        return res.json({ items: runs, total: runs.length });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/payroll/runs/:month
const getRun = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const run = await PayrollRun.findOne({ month }).lean();
        if (!run) {
            return res.json({
                month,
                run: null,
                attendanceLocked: await isMonthLocked(month),
                lines: [],
            });
        }
        const lines = await PayrollLine.find({ run: run._id })
            .sort({ personName: 1 })
            .lean();
        return res.json({
            month,
            run,
            attendanceLocked: await isMonthLocked(month),
            lines,
            flagged: lines.filter(
                (l) =>
                    l.exceptions?.length > 0 ||
                    (l.variancePercent !== null &&
                        Math.abs(l.variancePercent || 0) >= (run.settingsSnapshot?.varianceThreshold || 20))
            ).length,
        });
    } catch (err) {
        console.error("getRun error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/runs/:month/approve
const approveRun = async (req, res) => {
    try {
        const { month } = req.params;
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (run.status !== "review") {
            return res.status(409).json({
                message: `This run is ${run.status}, so there is nothing to approve.`,
            });
        }

        const settings = await getSettings();
        // Under maker–checker the person approving must not be the person who
        // prepared it. Approving your own work is not a second pair of eyes.
        if (settings.approvalDepth === "makerChecker" && run.calculatedBy?.userId) {
            const actor = actorFromReq(req);
            if (String(run.calculatedBy.userId) === String(actor.userId)) {
                return res.status(403).json({
                    message:
                        "You calculated this run, so somebody else has to approve it. That is what maker–checker is for.",
                });
            }
        }

        run.status = "approved";
        run.approvedAt = new Date();
        run.approvedBy = actorFromReq(req);
        if (req.body?.notes) run.notes = String(req.body.notes).trim();
        await run.save();

        await audit({ action: "run.approved", run, month, req, detail: { net: run.totals.net } });
        return res.json(run);
    } catch (err) {
        console.error("approveRun error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/runs/:month/lock
const lockRun = async (req, res) => {
    try {
        const { month } = req.params;
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (run.status !== "approved") {
            return res.status(409).json({
                message: "Only an approved run can be locked.",
            });
        }
        run.status = "locked";
        run.lockedAt = new Date();
        run.lockedBy = actorFromReq(req);
        await run.save();

        await audit({ action: "run.locked", run, month, req, detail: { net: run.totals.net } });
        return res.json(run);
    } catch (err) {
        console.error("lockRun error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/runs/:month/reopen   { reason }
const reopenRun = async (req, res) => {
    try {
        const { month } = req.params;
        const reason = String(req.body?.reason || "").trim();
        if (reason.length < 5) {
            return res.status(400).json({ message: "A reason is required to reopen a payroll run." });
        }
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (!["approved", "locked"].includes(run.status)) {
            return res.status(409).json({ message: "This run is already open." });
        }

        run.status = "review";
        run.reopenedAt = new Date();
        run.reopenedBy = actorFromReq(req);
        run.reopenReason = reason;
        await run.save();

        await audit({ action: "run.reopened", run, month, req, reason });
        return res.json(run);
    } catch (err) {
        console.error("reopenRun error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/runs/:month/lines/:lineId/adjust  { category, amount, reason }
//
// Capped and categorised rather than free-form, so an adjustment is a decision
// somebody can be asked about later.
const adjustLine = async (req, res) => {
    try {
        const { month, lineId } = req.params;
        if (!mongoose.Types.ObjectId.isValid(lineId)) {
            return res.status(400).json({ message: "Invalid line id" });
        }
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (run.status !== "review") {
            return res.status(409).json({
                message: `A ${run.status} run cannot be adjusted. Reopen it first.`,
            });
        }

        const settings = await getSettings();
        const amount = Number(req.body?.amount);
        const category = String(req.body?.category || "").trim();
        const reason = String(req.body?.reason || "").trim();

        if (!Number.isFinite(amount) || amount === 0) {
            return res.status(400).json({ message: "amount must be a non-zero number" });
        }
        if (Math.abs(amount) > settings.maxAdjustmentAmount) {
            return res.status(400).json({
                message: `An adjustment cannot exceed ${settings.maxAdjustmentAmount}. Raise the cap in payroll settings if this is genuinely needed.`,
            });
        }
        if (!settings.adjustmentCategories.includes(category)) {
            return res.status(400).json({
                message: `category must be one of: ${settings.adjustmentCategories.join(", ")}`,
            });
        }
        if (reason.length < 5) {
            return res.status(400).json({ message: "Say why — an adjustment without a reason is untraceable." });
        }

        const line = await PayrollLine.findOne({ _id: lineId, run: run._id });
        if (!line) return res.status(404).json({ message: "Line not found in this run" });

        line.adjustmentEntries.push({
            category, amount, reason, byName: actorFromReq(req).name,
        });
        line.adjustments = round2((line.adjustments || 0) + amount);
        line.net = round2(line.gross - (line.deductions || 0) + line.adjustments);
        await line.save();

        // Keep the run's totals honest with its lines.
        const lines = await PayrollLine.find({ run: run._id }).select("net adjustments").lean();
        run.totals.adjustments = round2(lines.reduce((s, l) => s + (l.adjustments || 0), 0));
        run.totals.net = round2(lines.reduce((s, l) => s + l.net, 0));
        await run.save();

        await audit({
            action: "line.adjusted",
            run, line, month, req, reason,
            detail: { category, amount, person: line.personName, newNet: line.net },
        });

        return res.json(line);
    } catch (err) {
        console.error("adjustLine error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/payroll/runs/:month/audit
const getRunAudit = async (req, res) => {
    try {
        const { month } = req.params;
        const entries = await PayrollAudit.find({ month })
            .sort({ createdAt: -1 })
            .limit(500)
            .lean();
        return res.json({ items: entries, total: entries.length });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    calculateRun,
    listRuns,
    getRun,
    approveRun,
    lockRun,
    reopenRun,
    adjustLine,
    getRunAudit,
    // Exported for tests.
    buildLeaveMap,
};
