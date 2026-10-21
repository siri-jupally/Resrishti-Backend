/*
  attendanceLockSettlements.js — the two things an admin signs off before a
  month is closed.

  attendanceLockIssues.js answers "what is still undecided", and an undecided
  day is simply wrong, so it blocks a close. This file is about the opposite
  case: records that are already decided and correct, but that quietly turn
  attendance into money.

    extra pay   a day worked on a weekly-off or a holiday becomes overtime.
                Nobody approved that payment; it appeared because somebody
                checked in on a Sunday.

    leave       a leave day is paid or unpaid depending on the type on the
                request. A sick day costs the company; an unpaid day costs the
                employee. Either way it is decided before payroll sees it.

  So the month review lists both, per person, with totals, and asks the admin
  to confirm them. The confirmation is kept on the month (AttendanceMonthLock
  .reviews) with who gave it and how many days they were looking at, so a day
  added afterwards shows up as a changed count rather than hiding behind an old
  tick.

  Extra pay also gets an adjustment, because it is the one figure here created
  with nobody's agreement: an admin can take a single day out of extra pay. The
  attendance record is not altered — `extraPayExcluded` only stops the overtime
  premium (utils/payrollEngine.js). Leave has no adjustment here on purpose:
  changing whether a leave day is paid means changing the leave itself, which
  belongs on the Leaves screen where the request and its reason are.

  Routes (admin only, mounted under /api/admin/attendance/locks):
    GET    /:month/settlements
    POST   /:month/confirm                  { kind, note?, confirmed? }
    PATCH  /:month/extra-pay/:type/:id      { excluded, note? }
*/
const Attendance = require("../models/Attendance");
const ManagerAttendance = require("../models/ManagerAttendance");
const Leave = require("../models/Leave");
const ManagerLeave = require("../models/ManagerLeave");
const AttendanceMonthLock = require("../models/AttendanceMonthLock");
const AttendancePolicy = require("../models/AttendancePolicy");
const PayrollSettings = require("../models/PayrollSettings");
const PayrollProfile = require("../models/PayrollProfile");
const { buildMonthCalendar } = require("../utils/payrollCalendar");
const { isCountedTowardHours } = require("../utils/attendanceCounting");
const { monthBounds } = require("./attendanceLockController");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const KINDS = ["extraPay", "leave"];

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

const actorFromReq = (req) =>
    req.admin
        ? { userType: "Admin", userId: req.admin._id, name: req.admin.name || req.admin.email }
        : undefined;

/** How many days of a leave request fall inside the month. */
const daysInMonth = (leave, start, end) => {
    const from = leave.startDate > start ? leave.startDate : start;
    const to = leave.endDate < end ? leave.endDate : end;
    if (from > to) return 0;
    const ms = new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`);
    return Math.round(ms / 86400000) + 1;
};

/**
 * Everything in the month that becomes money without anybody having said yes.
 *
 * Returns the two sections and their confirmation state. Pure read — called
 * both by the review screen and by the readiness check that gates the close.
 */
const settlementsFor = async (month) => {
    const { start, end } = monthBounds(month);
    const inMonth = { $gte: start, $lte: end };
    const overlapsMonth = { startDate: { $lte: end }, endDate: { $gte: start } };

    const [policy, settings, profiles, lock] = await Promise.all([
        AttendancePolicy.findOne().lean(),
        PayrollSettings.findOne().lean(),
        PayrollProfile.find({}).select("personType personId overtimeEligible isActive").lean(),
        AttendanceMonthLock.findOne({ month }).lean(),
    ]);

    // Which days of this month were not working days, from the organisation's
    // own calendar — attendance rows cannot tell you that by themselves.
    const calendar = buildMonthCalendar(month, policy);
    const nonWorking = new Map(
        calendar
            .filter((d) => d.kind !== "working")
            .map((d) => [d.date, { kind: d.kind, holiday: d.holiday || null }])
    );

    const overtime = settings?.overtime || {};
    const eligibleBy = new Map(
        profiles.map((p) => [
            `${p.personType}:${p.personId}`,
            Boolean(p.overtimeEligible) && p.isActive !== false,
        ])
    );

    const [empAtt, mgrAtt, empLeaves, mgrLeaves] = await Promise.all([
        // Only days somebody actually worked can be extra pay, and only days
        // that count — one still awaiting an out-of-premises decision is a
        // blocker, not a payment.
        Attendance.find({ date: inMonth, status: { $in: ["present", "half-day"] } })
            .populate("employee", "name email")
            .sort({ date: 1 })
            .lean(),
        ManagerAttendance.find({ date: inMonth, status: { $in: ["present", "half-day"] } })
            .populate("manager", "name email")
            .sort({ date: 1 })
            .lean(),
        Leave.find({ status: "approved", ...overlapsMonth })
            .populate("employee", "name email")
            .sort({ startDate: 1 })
            .lean(),
        ManagerLeave.find({ status: "approved", ...overlapsMonth })
            .populate("manager", "name email")
            .sort({ startDate: 1 })
            .lean(),
    ]);

    // ---- extra pay --------------------------------------------------------
    const extraPeople = new Map();
    let extraDays = 0;
    let extraExcluded = 0;

    const addExtraDay = (row, personType) => {
        const person = row.employee || row.manager;
        if (!person?._id) return;
        const nw = nonWorking.get(row.date);
        if (!nw) return;
        if (!isCountedTowardHours(row)) return;

        const key = `${personType}:${person._id}`;
        const eligible = eligibleBy.get(key) === true;
        const countedByRules =
            Boolean(overtime.enabled) &&
            (nw.kind === "weeklyOff"
                ? Boolean(overtime.countWeeklyOff)
                : Boolean(overtime.countHoliday));

        const entry = extraPeople.get(key) || {
            personType,
            personId: String(person._id),
            name: person.name || person.email || "Unknown",
            email: person.email || null,
            days: [],
        };
        entry.days.push({
            id: String(row._id),
            date: row.date,
            kind: nw.kind,
            holiday: nw.holiday,
            hours: round1(row.workingHours),
            halfDay: row.status === "half-day",
            excluded: Boolean(row.extraPayExcluded),
            note: row.extraPayNote || null,
            decidedByName: row.extraPayDecidedByName || null,
            // Whether this day will actually earn the premium, so the admin is
            // not asked to confirm pay that the rules never create.
            willBePaid: !row.extraPayExcluded && eligible && countedByRules,
            // And why not, when it will not.
            whyNot: row.extraPayExcluded
                ? "taken out of extra pay"
                : !countedByRules
                    ? "payroll rules do not pay extra for this kind of day"
                    : !eligible
                        ? "not eligible for overtime on their pay profile"
                        : null,
        });
        extraDays += 1;
        if (row.extraPayExcluded) extraExcluded += 1;
        extraPeople.set(key, entry);
    };

    empAtt.forEach((row) => addExtraDay(row, "Employee"));
    mgrAtt.forEach((row) => addExtraDay(row, "Manager"));

    const extraPayPeople = [...extraPeople.values()]
        .map((p) => ({ ...p, payableDays: p.days.filter((d) => d.willBePaid).length }))
        .sort((a, b) => b.days.length - a.days.length || a.name.localeCompare(b.name));

    const payableDays = extraPayPeople.reduce((sum, p) => sum + p.payableDays, 0);

    // ---- leave ------------------------------------------------------------
    const leavePeople = new Map();
    let paidDays = 0;
    let unpaidDays = 0;

    const addLeave = (row, personType) => {
        const person = row.employee || row.manager;
        if (!person?._id) return;
        const days = daysInMonth(row, start, end);
        if (days <= 0) return;

        const paid = row.type !== "unpaid";
        const key = `${personType}:${person._id}`;
        const entry = leavePeople.get(key) || {
            personType,
            personId: String(person._id),
            name: person.name || person.email || "Unknown",
            email: person.email || null,
            paidDays: 0,
            unpaidDays: 0,
            items: [],
        };
        entry.items.push({
            id: String(row._id),
            type: row.type,
            paid,
            startDate: row.startDate,
            endDate: row.endDate,
            days,
            reason: row.reason || null,
        });
        if (paid) {
            entry.paidDays += days;
            paidDays += days;
        } else {
            entry.unpaidDays += days;
            unpaidDays += days;
        }
        leavePeople.set(key, entry);
    };

    empLeaves.forEach((row) => addLeave(row, "Employee"));
    mgrLeaves.forEach((row) => addLeave(row, "Manager"));

    const leaveList = [...leavePeople.values()].sort(
        (a, b) =>
            b.paidDays + b.unpaidDays - (a.paidDays + a.unpaidDays) ||
            a.name.localeCompare(b.name)
    );

    const confirmation = (kind, days) => {
        const stored = lock?.reviews?.[kind];
        if (!stored?.confirmedAt) return null;
        return {
            confirmedAt: stored.confirmedAt,
            by: stored.by || null,
            note: stored.note || null,
            daysConfirmed: stored.daysConfirmed ?? null,
            // A tick on four days does not cover a fifth that arrived after.
            stale:
                typeof stored.daysConfirmed === "number" && stored.daysConfirmed !== days,
        };
    };

    return {
        month,
        locked: lock?.status === "locked",
        extraPay: {
            totalDays: extraDays,
            payableDays,
            excludedDays: extraExcluded,
            people: extraPayPeople,
            overtimePaysFor: {
                enabled: Boolean(overtime.enabled),
                weeklyOff: Boolean(overtime.countWeeklyOff),
                holiday: Boolean(overtime.countHoliday),
            },
            confirmation: confirmation("extraPay", extraDays),
        },
        leave: {
            totalDays: paidDays + unpaidDays,
            paidDays,
            unpaidDays,
            people: leaveList,
            confirmation: confirmation("leave", paidDays + unpaidDays),
        },
    };
};

/**
 * The confirmations still owed on a month, as blocker rows.
 *
 * Shaped like the ones in attendanceLockController so the close screen can
 * list them together. A month with no extra-pay days and no leave owes
 * nothing, so nothing is returned.
 */
const confirmationsOutstanding = async (month) => {
    const s = await settlementsFor(month);
    const out = [];
    if (s.extraPay.totalDays > 0 && !s.extraPay.confirmation) {
        out.push({
            key: "extraPayUnconfirmed",
            label: "Extra-pay days awaiting your confirmation",
            count: s.extraPay.totalDays,
            why: `${s.extraPay.payableDays} day(s) will be paid as overtime, and nobody has agreed to that yet.`,
            where: "Attendance → Close Month",
        });
    }
    if (s.leave.totalDays > 0 && !s.leave.confirmation) {
        out.push({
            key: "leaveUnconfirmed",
            label: "Leave days awaiting your confirmation",
            count: s.leave.totalDays,
            why: `${s.leave.paidDays} paid and ${s.leave.unpaidDays} unpaid leave day(s) go into this month's pay.`,
            where: "Attendance → Close Month",
        });
    }
    return out;
};

// GET /api/admin/attendance/locks/:month/settlements
const getSettlements = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        return res.json(await settlementsFor(month));
    } catch (err) {
        console.error("getSettlements error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/admin/attendance/locks/:month/confirm
// body: { kind: "extraPay" | "leave", note?, confirmed? }
//
// `confirmed: false` takes a confirmation back, which an admin needs when they
// have ticked a month and then found something wrong with it.
const confirmSettlement = async (req, res) => {
    try {
        if (!req.admin) {
            return res
                .status(403)
                .json({ message: "Only an admin can confirm a month's figures" });
        }
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const kind = String(req.body?.kind || "");
        if (!KINDS.includes(kind)) {
            return res.status(400).json({ message: `kind must be one of: ${KINDS.join(", ")}` });
        }

        const existing = await AttendanceMonthLock.findOne({ month });
        if (existing?.status === "locked") {
            return res.status(409).json({
                message: `${month} is already closed. Reopen it to change anything.`,
            });
        }

        const lock = existing || new AttendanceMonthLock({ month });
        lock.reviews = lock.reviews || {};

        if (req.body?.confirmed === false) {
            lock.reviews[kind] = undefined;
        } else {
            const settlements = await settlementsFor(month);
            const days = settlements[kind].totalDays;
            if (days === 0) {
                return res.status(409).json({
                    message: "There is nothing of that kind in this month to confirm.",
                });
            }
            lock.reviews[kind] = {
                confirmedAt: new Date(),
                by: actorFromReq(req),
                note: String(req.body?.note || "").trim() || undefined,
                daysConfirmed: days,
            };
        }

        lock.markModified("reviews");
        await lock.save();
        return res.json(await settlementsFor(month));
    } catch (err) {
        console.error("confirmSettlement error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/attendance/locks/:month/extra-pay/:type/:id
// body: { excluded: boolean, note? }
//
// The adjustment. Takes one day out of extra pay, or puts it back. The
// attendance record itself is untouched — the day was worked and stays worked.
const adjustExtraPay = async (req, res) => {
    try {
        if (!req.admin) {
            return res.status(403).json({ message: "Only an admin can adjust extra pay" });
        }
        const { month, type, id } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const model =
            String(type).toLowerCase() === "manager" ? ManagerAttendance : Attendance;
        const row = await model.findById(id);
        if (!row) {
            return res.status(404).json({ message: "That attendance day was not found" });
        }
        if (!String(row.date).startsWith(`${month}-`)) {
            return res.status(400).json({ message: "That day is not in this month" });
        }

        const excluded = req.body?.excluded === true || req.body?.excluded === "true";
        row.extraPayExcluded = excluded;
        row.extraPayNote = String(req.body?.note || "").trim() || undefined;
        row.extraPayDecidedByName = req.admin.name || req.admin.email;
        row.extraPayDecidedAt = new Date();

        // A locked month refuses this save (utils/attendanceLock.js), which is
        // exactly right — the figure is settled.
        await row.save();

        // Changing a day invalidates a confirmation given over the old figures.
        const lock = await AttendanceMonthLock.findOne({ month });
        if (lock?.reviews?.extraPay?.confirmedAt) {
            lock.reviews.extraPay = undefined;
            lock.markModified("reviews");
            await lock.save();
        }

        return res.json(await settlementsFor(month));
    } catch (err) {
        console.error("adjustExtraPay error:", err.message);
        const locked = /locked/i.test(err.message || "");
        return res.status(locked ? 409 : 500).json({ message: err.message });
    }
};

module.exports = {
    getSettlements,
    confirmSettlement,
    adjustExtraPay,
    settlementsFor,
    confirmationsOutstanding,
};
