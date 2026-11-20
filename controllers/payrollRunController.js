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

const { actorFromReq } = require("../utils/payrollActor");

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

/*
  Atomically move a run from one status to another. The whole lifecycle is
  read-modify-write with no DB transaction, so two privileged writers acting on
  the same month could otherwise lose each other's updates and reach impossible
  states (e.g. a stale "approved" written back over a fresh recalculation, or an
  approved run with pending lines). This gate makes the change conditional on the
  status we read still being current: if it changed underneath us, modifiedCount
  is 0 and the caller must reload rather than overwrite. Returns the updated run,
  or null if the precondition no longer holds.
*/
const casStatus = (id, from, set) =>
    PayrollRun.findOneAndUpdate({ _id: id, status: from }, { $set: set }, { new: true });

const STALE_RUN = {
    message: "This run changed while you were working on it — reload and try again.",
    code: "runChanged",
};

// POST /api/payroll/runs/:month/calculate
const calculateRun = async (req, res) => {
    // Lease bookkeeping for the finally: release ONLY the lease this call took, so
    // a refused second generate never clears the lease the first one is holding.
    let leaseHeld = false;
    let leaseRunId = null;
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
        // Only a draft may be recalculated. Once it is with an approver — or
        // approved, paid or closed — the figures are something somebody has
        // acted on, so recalculating has to start by sending it back.
        if (existing && existing.status !== "draft") {
            return res.status(409).json({
                message: `${month} is ${existing.status}. Send it back to draft before recalculating.`,
                runStatus: existing.status,
            });
        }

        // #6: serialize re-generation of an existing draft. Two "Generate" presses
        // on the same month otherwise interleave the delete-and-rebuild below into
        // duplicate-key errors or a half-built line set. Claim an exclusive lease
        // (released in the finally); a first-ever calc is serialized instead by the
        // month unique index.
        let run = null;
        if (existing) {
            run = await PayrollRun.findOneAndUpdate(
                { _id: existing._id, status: "draft", calculating: { $ne: true } },
                { $set: { calculating: true } },
                { new: true }
            );
            if (!run) {
                return res.status(409).json({
                    message: `A calculation for ${month} is already running, or it is no longer a draft. Try again in a moment.`,
                    code: "calculating",
                });
            }
            leaseHeld = true;
            leaseRunId = run._id;
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
            // Test and archived accounts are never paid — excluded at the source,
            // so they appear neither as paid lines nor as exceptions.
            Employee.find({ isTestAccount: { $ne: true }, archived: { $ne: true } }).select("name email department jobRole").lean(),
            Manager.find({ isTestAccount: { $ne: true }, archived: { $ne: true } }).select("name email department jobRole").lean(),
            Attendance.find({ date: { $gte: start, $lte: end } })
                .select("employee date status workingHours approvalStatus locationWithinBoundary extraPayExcluded")
                .lean(),
            ManagerAttendance.find({ date: { $gte: start, $lte: end } })
                .select("manager date status workingHours approvalStatus locationWithinBoundary extraPayExcluded")
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

            // A daily-wage profile with no paid-day policy would silently pay
            // work-only (weekly-offs and holidays dropped), quietly underpaying
            // a "regular" daily worker. Surface it instead of guessing.
            if (
                profile.payModel === "daily" &&
                !policyById.get(String(profile.paidDayPolicy))
            ) {
                exceptions.push({
                    personType, personId, name,
                    code: "noPaidDayPolicy",
                    message:
                        "This daily-wage profile has no paid-day policy, so weekly-offs and holidays would go unpaid. Attach a policy before including them.",
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

        run = run || new PayrollRun({ month });
        // Draft. Generating is not submitting: the preparer reviews and fixes
        // first, which is also what makes "correct and recalculate without
        // starting over" possible.
        run.status = "draft";
        run.calculatedAt = now;
        // A fresh calculation supersedes any earlier rejection.
        run.rejectedAt = undefined;
        run.rejectedBy = undefined;
        run.rejectionReason = undefined;
        run.submittedAt = undefined;
        run.submittedBy = undefined;
        run.calculatedBy = actor;
        run.settingsSnapshot = {
            perDayRateBasis: settings.perDayRateBasis,
            halfDayWeight: settings.halfDayWeight,
            overtime: settings.overtime,
            approvalDepth: settings.approvalDepth,
            // Snapshot the threshold used to flag sharp pay moves, so getRun's
            // "flagged" count reflects the configured value, not a hard-coded 20.
            varianceThreshold: settings.variancePercentThreshold,
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

        // Preserve the disbursement evidence across a recalculation. A run can be
        // reopened after it was paid (reopenRun sends paid/closed back to draft),
        // and the rebuild below deletes and re-inserts every line. Without
        // carrying these two sub-documents forward, that rebuild would
        // permanently erase each person's payment record (UTR / bank snapshot /
        // paidAt / attempts) and their released payslip (key + releasedAt),
        // orphaning the stored payslip file and destroying the only per-person
        // proof that money left the building. Matched by (personType, personId).
        const priorLines = await PayrollLine.find({ run: run._id })
            .select("personType personId payment payslip net")
            .lean();
        const priorByPerson = new Map(
            priorLines.map((l) => [`${l.personType}:${String(l.personId)}`, l])
        );
        const isDisbursed = (l) => l.payment && l.payment.status && l.payment.status !== "pending";
        const carriedPayments = priorLines.filter(isDisbursed).length;
        const computedKeys = new Set(computed.map((c) => `${c.personType}:${String(c.personId)}`));

        // #5: never delete a line that carries disbursement evidence (a payment
        // not pending) for somebody who is no longer in the run — that would
        // erase the only proof money left. Keep it as a "paid but now excluded"
        // record. Everyone else's prior line is rebuilt below.
        const keepIds = priorLines
            .filter((l) => isDisbursed(l) && !computedKeys.has(`${l.personType}:${String(l.personId)}`))
            .map((l) => l._id);
        await PayrollLine.deleteMany(
            keepIds.length ? { run: run._id, _id: { $nin: keepIds } } : { run: run._id }
        );

        const staleFigures = [];
        const docs = computed.map(({ personType, personId, person, profile, policyName, line }) => {
            const previousNet = previousNetById.get(String(personId));
            const variancePercent =
                previousNet && previousNet > 0
                    ? round2(((line.net - previousNet) / previousNet) * 100)
                    : null;
            const prior = priorByPerson.get(`${personType}:${String(personId)}`);

            const doc = {
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

            // Carry disbursement evidence across the recalc.
            if (prior?.payment) doc.payment = prior.payment;

            // #3: if this line was already paid / its payslip released and the
            // recomputed net no longer matches, the released payslip is stale.
            // Clear it (so the next release re-renders the correct figure) and
            // flag the delta — never silently leave a payslip that disagrees with
            // the line it is supposed to be.
            if (prior?.payslip?.key) {
                const paidAmt = prior.payment?.amount;
                const changed =
                    (typeof paidAmt === "number" && Math.abs(paidAmt - line.net) > 0.001) ||
                    (typeof prior.net === "number" && Math.abs(prior.net - line.net) > 0.001);
                if (changed) {
                    doc.figureChangedAfterPayment = true;
                    staleFigures.push({ personType, personId, name: doc.personName, wasPaid: paidAmt ?? prior.net, nowNet: line.net });
                    // payslip deliberately NOT carried -> re-renders on next release
                } else {
                    doc.payslip = prior.payslip;
                }
            }
            return doc;
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
        run.calculating = false; // release the generation lease on success
        await run.save();
        leaseHeld = false; // released cleanly by the save above

        await audit({
            action: "run.calculated",
            run,
            month,
            req,
            detail: {
                people: totals.people,
                net: totals.net,
                exceptions: exceptions.length,
                ...(carriedPayments > 0 ? { carriedPayments } : {}),
                ...(staleFigures.length > 0 ? { staleFigures: staleFigures.length } : {}),
            },
        });

        return res.json({ run, lineCount: docs.length, exceptions, staleFigures });
    } catch (err) {
        console.error("calculateRun error:", err);
        return res.status(500).json({ message: err.message });
    } finally {
        // Release ONLY the lease this call acquired (an error after claiming it).
        // A call that was refused the lease never set leaseHeld, so it cannot
        // clear the lease the in-progress calculation is holding.
        if (leaseHeld && leaseRunId) {
            try {
                await PayrollRun.updateOne({ _id: leaseRunId }, { $set: { calculating: false } });
            } catch { /* best effort */ }
        }
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
        // Validation travels with the run so the dashboard can show one next
        // action and the reasons it is or is not available, without a second
        // round trip per screen.
        const settings = await getSettings();
        const [blockers, warnings] = await Promise.all([
            blockersFor(run),
            warningsFor(run, settings),
        ]);
        return res.json({
            month,
            run,
            attendanceLocked: await isMonthLocked(month),
            blockers,
            warnings,
            canSubmit: run.status === "draft" && blockers.length === 0,
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

/*
  Which of these lines belong to somebody with no salary account on file.

  Reads the Employee/Manager record, not the payroll profile: the bank account
  is the person's own (see models/Employee.js), and payroll is only a consumer
  of it. One query per collection rather than per line.
*/
const peopleWithoutBank = async (lines) => {
    const byType = { Employee: [], Manager: [] };
    for (const l of lines) {
        if (byType[l.personType]) byType[l.personType].push(l.personId);
    }
    const [employees, managers] = await Promise.all([
        byType.Employee.length
            ? Employee.find({ _id: { $in: byType.Employee } }).select("name bank").lean()
            : [],
        byType.Manager.length
            ? Manager.find({ _id: { $in: byType.Manager } }).select("name bank").lean()
            : [],
    ]);
    const hasBank = new Map(
        [...employees, ...managers].map((p) => [String(p._id), Boolean(p.bank?.accountNumber)])
    );
    return lines
        .filter((l) => !hasBank.get(String(l.personId)))
        .map((l) => ({ personType: l.personType, personId: l.personId, name: l.personName }));
};

/*
  What stops a run being submitted, and what merely deserves a look.

  The distinction is the whole point of §4's "errors are warnings or blockers,
  not statuses": a month with three people excluded is a month somebody should
  glance at, not a month in a special state. Only things that would make the
  payroll wrong are blockers.

  Blockers  — a run with no lines at all, and any line that would pay a
              negative amount. Neither can be approved into something sensible.
  Warnings  — people the engine held out (no profile, no attendance), pay that
              moved sharply against last month, and anyone with no bank account
              on file. All of those can be approved; the last one simply cannot
              be paid until it is fixed, which the disbursement step says again.
*/
const blockersFor = async (run) => {
    const lines = await PayrollLine.find({ run: run._id })
        .select("personName net")
        .lean();
    const out = [];

    if (lines.length === 0) {
        out.push({
            code: "noLines",
            message: "Nothing was calculated for this month — there is nobody to pay.",
        });
    }

    const negative = lines.filter((l) => Number(l.net) < 0);
    if (negative.length > 0) {
        out.push({
            code: "negativeNet",
            message: `${negative.length} ${negative.length === 1 ? "person has" : "people have"} a negative net. Add a correcting adjustment before submitting.`,
            people: negative.map((l) => ({ name: l.personName, net: l.net })),
        });
    }

    return out;
};

/**
 * Non-blocking things worth seeing before approving. Separate from blockersFor
 * so the dashboard can show both without either deciding the other.
 */
const warningsFor = async (run, settings) => {
    const lines = await PayrollLine.find({ run: run._id })
        .select("personName personType personId net variancePercent")
        .lean();
    const out = [];

    if ((run.exceptions || []).length > 0) {
        out.push({
            code: "excluded",
            message: `${run.exceptions.length} ${run.exceptions.length === 1 ? "person was" : "people were"} left out of this run.`,
            people: run.exceptions.map((e) => ({ name: e.name, reason: e.message })),
        });
    }

    const threshold = settings?.variancePercentThreshold ?? 20;
    const swung = lines.filter(
        (l) => Number.isFinite(l.variancePercent) && Math.abs(l.variancePercent) >= threshold
    );
    if (swung.length > 0) {
        out.push({
            code: "variance",
            message: `${swung.length} ${swung.length === 1 ? "person's" : "people's"} pay moved by ${threshold}% or more against last month.`,
            people: swung.map((l) => ({ name: l.personName, variancePercent: l.variancePercent })),
        });
    }

    const noBank = await peopleWithoutBank(lines);
    if (noBank.length > 0) {
        out.push({
            code: "noBankDetails",
            // They enter it themselves, on their own profile - payroll cannot
            // fill it in for them. Payroll Setup carries a one-press reminder.
            message: `${noBank.length} ${noBank.length === 1 ? "person has" : "people have"} not added a salary account to their profile, so they cannot be paid yet. Ask them from Payroll Setup.`,
            people: noBank.map((n) => ({ name: n.name })),
        });
    }

    return out;
};

// POST /api/payroll/runs/:month/submit   { notes? }
//
// Draft → pending-approval. Blocking problems are refused here rather than at
// approval, so the preparer is the one who sees them.
const submitRun = async (req, res) => {
    try {
        const { month } = req.params;
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (!PayrollRun.canTransition(run.status, "pending-approval")) {
            return res.status(409).json({
                message: `This run is ${run.status}, so there is nothing to submit.`,
                runStatus: run.status,
            });
        }

        const blockers = await blockersFor(run);
        if (blockers.length > 0) {
            return res.status(409).json({
                message: "Resolve these before submitting for approval.",
                blockers,
            });
        }

        const actor = actorFromReq(req);
        const updated = await casStatus(run._id, run.status, {
            status: "pending-approval",
            submittedAt: new Date(),
            submittedBy: actor,
            ...(req.body?.notes ? { notes: String(req.body.notes).trim() } : {}),
        });
        if (!updated) return res.status(409).json(STALE_RUN);

        await audit({ action: "run.submitted", run: updated, month, req, detail: { net: updated.totals.net } });
        return res.json(updated);
    } catch (err) {
        console.error("submitRun error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/runs/:month/approve   { notes? }
const approveRun = async (req, res) => {
    try {
        const { month } = req.params;
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (!PayrollRun.canTransition(run.status, "approved")) {
            return res.status(409).json({
                message: `This run is ${run.status}, so there is nothing to approve.`,
                runStatus: run.status,
            });
        }

        const settings = await getSettings();
        // Under maker–checker the person approving must not be the person who
        // prepared it. Approving your own work is not a second pair of eyes.
        // (The primary #12 control is protectAccountant on the generate routes:
        // once an accountant is assigned an admin cannot prepare at all, so an
        // admin approving is always a second pair of eyes. This stays gated on
        // the setting so single-approver and the no-accountant bootstrap — where
        // one admin legitimately does everything — are not deadlocked.)
        if (settings.approvalDepth === "makerChecker") {
            const actor = actorFromReq(req);
            // The approver must not be EITHER person who prepared the run — the
            // one who calculated the figures or the one who submitted them.
            // Checking only the submitter let admin A calculate, admin B submit,
            // and admin A approve their own figures.
            const preparers = [run.calculatedBy?.userId, run.submittedBy?.userId]
                .filter(Boolean)
                .map(String);
            if (preparers.includes(String(actor.userId))) {
                return res.status(403).json({
                    message:
                        "You prepared this run, so somebody else has to approve it. That is what maker–checker is for.",
                    sameActor: true,
                });
            }
        }

        const updated = await casStatus(run._id, run.status, {
            status: "approved",
            approvedAt: new Date(),
            approvedBy: actorFromReq(req),
            ...(req.body?.notes ? { notes: String(req.body.notes).trim() } : {}),
        });
        if (!updated) return res.status(409).json(STALE_RUN);

        await audit({ action: "run.approved", run: updated, month, req, detail: { net: updated.totals.net } });
        return res.json(updated);
    } catch (err) {
        console.error("approveRun error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/runs/:month/reject   { reason }
//
// Pending-approval → draft. The reason is required: a run comes back for a
// stated purpose, and whoever picks it up needs to know what it was.
const rejectRun = async (req, res) => {
    try {
        const { month } = req.params;
        const reason = String(req.body?.reason || "").trim();
        if (reason.length < 5) {
            return res.status(400).json({
                message: "Say what needs correcting — a rejection without a reason just loses a day.",
            });
        }
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (!PayrollRun.canTransition(run.status, "draft")) {
            return res.status(409).json({
                message: `This run is ${run.status}, so there is nothing to reject.`,
                runStatus: run.status,
            });
        }

        const updated = await casStatus(run._id, run.status, {
            status: "draft",
            rejectedAt: new Date(),
            rejectedBy: actorFromReq(req),
            rejectionReason: reason,
        });
        if (!updated) return res.status(409).json(STALE_RUN);

        await audit({ action: "run.rejected", run: updated, month, req, reason });
        return res.json(updated);
    } catch (err) {
        console.error("rejectRun error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/runs/:month/close
//
// Paid → closed. The end of the cycle: nothing further happens to this month
// unless an admin reopens it with a reason.
const closeRun = async (req, res) => {
    try {
        const { month } = req.params;
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (!PayrollRun.canTransition(run.status, "closed")) {
            return res.status(409).json({
                message:
                    run.status === "approved"
                        ? "Record the payments first — a month is closed once people have been paid."
                        : `This run is ${run.status}, so it cannot be closed.`,
                runStatus: run.status,
            });
        }
        const updated = await casStatus(run._id, run.status, {
            status: "closed",
            closedAt: new Date(),
            closedBy: actorFromReq(req),
        });
        if (!updated) return res.status(409).json(STALE_RUN);

        await audit({ action: "run.closed", run: updated, month, req, detail: { net: updated.totals.net } });
        return res.json(updated);
    } catch (err) {
        console.error("closeRun error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/runs/:month/reopen   { reason }
//
// The authorised way back into a month that was approved, paid or closed.
// Deliberately not a transition in ALLOWED_TRANSITIONS: it is an override, and
// it keeps its own reason and timestamps so it reads as one in the audit.
const reopenRun = async (req, res) => {
    try {
        const { month } = req.params;
        const reason = String(req.body?.reason || "").trim();
        if (reason.length < 5) {
            return res.status(400).json({ message: "A reason is required to reopen a payroll run." });
        }
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (!["approved", "paid", "closed"].includes(run.status)) {
            return res.status(409).json({ message: "This run is already open." });
        }

        // Reopening a run where money has already gone out is how a double
        // payment happens: the figures get rebuilt while a disbursed line reads
        // "pending" again. Refuse unless the caller explicitly forces it.
        const forced = req.body?.force === true || String(req.body?.force) === "true";
        const paidCount = await PayrollLine.countDocuments({ run: run._id, "payment.status": "paid" });
        if (paidCount > 0 && !forced) {
            return res.status(409).json({
                message: `${paidCount} ${paidCount === 1 ? "person has" : "people have"} already been paid this month. Reopening a run after money has gone out risks double payment — resend with force:true only if you are certain.`,
                code: "paidLinesExist",
                paidCount,
            });
        }

        const updated = await casStatus(run._id, run.status, {
            status: "draft",
            reopenedAt: new Date(),
            reopenedBy: actorFromReq(req),
            reopenReason: reason,
        });
        if (!updated) return res.status(409).json(STALE_RUN);

        await audit({ action: "run.reopened", run: updated, month, req, reason: forced ? `${reason} [forced over ${paidCount} paid]` : reason });
        return res.json(updated);
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
        if (run.status !== "draft") {
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

        /*
          Nobody adjusts their own pay.

          This could not happen while the accountant was a login of its own:
          they were not an employee, so they had no line in the run. Now that
          an accountant is an assigned employee, they do — and a bonus to
          yourself with no second pair of eyes before approval is exactly the
          thing maker-checker exists to prevent. An admin can still adjust it;
          the accountant has to ask.
        */
        const self = req.payrollEmployee
            ? { personType: "Employee", personId: req.payrollEmployee._id }
            : req.payrollManager
                ? { personType: "Manager", personId: req.payrollManager._id }
                : null;
        if (
            self &&
            line.personType === self.personType &&
            String(line.personId) === String(self.personId)
        ) {
            return res.status(403).json({
                message:
                    "You cannot adjust your own pay. Ask an admin to make this adjustment.",
            });
        }

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
    submitRun,
    approveRun,
    rejectRun,
    closeRun,
    reopenRun,
    adjustLine,
    getRunAudit,
    // Exported for tests.
    buildLeaveMap,
    blockersFor,
    warningsFor,
    peopleWithoutBank,
};
