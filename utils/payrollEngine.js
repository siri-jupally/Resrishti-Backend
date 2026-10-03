/*
  utils/payrollEngine.js — working out one person's pay for one month.

  Two paths, chosen by pay model:

    monthly   deduction-based. Start from the salary and take off the days that
              were not paid. Weekends, holidays and approved paid leave are paid
              by default; unpaid absence is what costs.

    daily     earnings-based. Start from nothing and add up the days that were
              paid. Which non-working days count is the person's paid-day policy.

  The arithmetic is simple. What is not simple, and where wrong pay comes from,
  is deciding what each day *was* — and attendance only records the days
  somebody turned up. Absence has no record, paid leave and unpaid leave look
  identical on an attendance row, and a day awaiting an out-of-premises decision
  counts as neither worked nor rejected. Each of those is handled explicitly
  below, and anything the engine cannot answer confidently becomes an exception
  on the line rather than a number somebody might pay.

  Nothing here reads the database. It is given everything it needs, so it can be
  tested exhaustively without fixtures.
*/
const { isCountedTowardHours } = require("./attendanceCounting");

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Attendance statuses that mean the person worked.
const WORKED = new Set(["present", "half-day"]);

/**
 * What a single day was, for one person.
 *
 * `record`    their attendance row for that day, if any
 * `day`       the calendar entry: working / weeklyOff / holiday
 * `leaveType` the type of approved leave covering that date, if any
 *
 * Returns a classification the two pay paths both read:
 *   worked | leavePaid | leaveUnpaid | weeklyOff | holiday | absent | unapproved
 */
const classifyDay = ({ record, day, leaveType, halfDayWeight }) => {
    // A day worked is a day worked, even on a Sunday — that is what makes it
    // overtime rather than an ordinary day.
    if (record && WORKED.has(record.status)) {
        // Held back pending an out-of-premises decision: neither worked nor
        // rejected. Paying it would pre-empt the decision; not flagging it
        // would hide that somebody is about to be paid short.
        if (!isCountedTowardHours(record)) {
            return { kind: "unapproved", weight: 0, onNonWorkingDay: day.kind !== "working" };
        }
        const weight = record.status === "half-day" ? halfDayWeight : 1;
        return { kind: "worked", weight, onNonWorkingDay: day.kind !== "working" };
    }

    // Leave is recorded on the attendance row as simply "leave"; whether it is
    // paid depends on its type, which lives on the leave request itself.
    if (record && record.status === "leave") {
        return {
            kind: leaveType === "unpaid" ? "leaveUnpaid" : "leavePaid",
            weight: 1,
            leaveType: leaveType || "unknown",
        };
    }

    if (day.kind === "holiday") return { kind: "holiday", weight: 1 };
    if (day.kind === "weeklyOff") return { kind: "weeklyOff", weight: 1 };

    // A working day with nothing recorded. Nobody wrote "absent" — absence is
    // the absence of a record.
    return { kind: "absent", weight: 1 };
};

/**
 * Work out one person's month.
 *
 * @param {Object} input
 *   profile        their payroll profile (plain object)
 *   rate           the rate in force for this month (amount + effectiveFrom)
 *   policy         their paid-day policy
 *   settings       organisation payroll settings
 *   calendar       the month laid out (utils/payrollCalendar.js)
 *   calendarSummary counts of working days, weekly-offs and holidays
 *   records        their attendance rows for the month
 *   leaveDates     Map of date -> leave type, for approved leave
 * @returns {Object} the computed line, including its own exceptions
 */
const computeLine = ({
    profile,
    rate,
    policy,
    settings,
    calendar,
    calendarSummary,
    records = [],
    leaveDates = new Map(),
}) => {
    const exceptions = [];
    const halfDayWeight = settings?.halfDayWeight ?? 0.5;
    const recordByDate = new Map(records.map((r) => [r.date, r]));

    // Days the person was actually on payroll — a mid-month joiner was not
    // absent before they joined.
    const days = calendar.filter((day) => {
        if (profile.payrollStartDate && day.date < profile.payrollStartDate) return false;
        if (profile.payrollEndDate && day.date > profile.payrollEndDate) return false;
        return true;
    });
    const isPartialMonth = days.length !== calendar.length;

    const tally = {
        worked: 0,
        halfDays: 0,
        leavePaid: 0,
        leaveUnpaid: 0,
        weeklyOffs: 0,
        holidays: 0,
        absent: 0,
        unapproved: 0,
        overtimeDays: 0,
    };

    for (const day of days) {
        const record = recordByDate.get(day.date);
        const result = classifyDay({
            record,
            day,
            leaveType: leaveDates.get(day.date),
            halfDayWeight,
        });

        switch (result.kind) {
            case "worked":
                tally.worked += result.weight;
                if (result.weight < 1) tally.halfDays += 1;
                // Overtime is a day worked when the person was not due in.
                if (
                    profile.overtimeEligible &&
                    settings?.overtime?.enabled &&
                    ((day.kind === "weeklyOff" && settings.overtime.countWeeklyOff) ||
                        (day.kind === "holiday" && settings.overtime.countHoliday))
                ) {
                    tally.overtimeDays += result.weight;
                }
                break;
            case "leavePaid":
                tally.leavePaid += 1;
                break;
            case "leaveUnpaid":
                tally.leaveUnpaid += 1;
                break;
            case "weeklyOff":
                tally.weeklyOffs += 1;
                break;
            case "holiday":
                tally.holidays += 1;
                break;
            case "unapproved":
                tally.unapproved += 1;
                break;
            default:
                tally.absent += 1;
        }
    }

    if (tally.unapproved > 0) {
        exceptions.push({
            code: "unapprovedDays",
            message: `${tally.unapproved} day(s) worked away from the office were never approved or rejected, so they are unpaid here.`,
        });
    }
    if (isPartialMonth) {
        exceptions.push({
            code: "partialMonth",
            message: `On payroll for ${days.length} of the month's ${calendar.length} days.`,
        });
    }
    if (leaveDates.size > 0) {
        const unknown = [...leaveDates.values()].filter((t) => !t).length;
        if (unknown > 0) {
            exceptions.push({
                code: "unknownLeaveType",
                message: `${unknown} leave day(s) could not be matched to a leave request, so they are treated as paid.`,
            });
        }
    }

    // ---- overtime ---------------------------------------------------------
    // A day worked on a weekly-off. Its value depends on what a normal day is
    // worth, which differs between the two paths, so it is computed after the
    // day rate is known.
    const overtimeTerms = profile.overtimeOverride?.mode
        ? profile.overtimeOverride
        : settings?.overtime;

    let gross = 0;
    let lopDays = 0;
    let payableDays = 0;
    let perDayRate = 0;
    let overtimePay = 0;
    let basePay = 0;

    if (profile.payModel === "monthly") {
        // Start from the salary; take off what was not paid.
        const divisor =
            settings?.perDayRateBasis === "calendarDays"
                ? calendarSummary.calendarDays || 30
                : settings?.perDayRateBasis === "workingDays"
                ? calendarSummary.workingDays || calendarSummary.calendarDays || 30
                : 30;
        perDayRate = round2(rate.amount / divisor);

        // Absence, unpaid leave, and days held back for approval all cost.
        lopDays = tally.absent + tally.leaveUnpaid + tally.unapproved;

        // A half-day worked is a half-day not worked.
        const halfDayShortfall = tally.halfDays * (1 - halfDayWeight);
        lopDays = round2(lopDays + halfDayShortfall);

        // Days outside their payroll dates are not absence, but they are not
        // paid either — the salary covers a whole month.
        const notOnPayroll = calendar.length - days.length;
        if (notOnPayroll > 0) lopDays = round2(lopDays + notOnPayroll);

        basePay = round2(rate.amount - perDayRate * lopDays);
        payableDays = round2(days.length - lopDays);
    } else {
        // Start from nothing; add up what was paid.
        perDayRate = round2(rate.amount);
        payableDays = tally.worked;
        if (policy?.payWeeklyOff) payableDays += tally.weeklyOffs;
        if (policy?.payHoliday) payableDays += tally.holidays;
        if (policy?.payApprovedLeave) payableDays += tally.leavePaid;
        payableDays = round2(payableDays);

        basePay = round2(perDayRate * payableDays);
        // What they did not earn, for the payslip to show alongside.
        lopDays = round2(tally.absent + tally.leaveUnpaid + tally.unapproved);
    }

    if (tally.overtimeDays > 0 && overtimeTerms) {
        overtimePay =
            overtimeTerms.mode === "flat"
                ? round2(overtimeTerms.value * tally.overtimeDays)
                : round2(perDayRate * overtimeTerms.value * tally.overtimeDays);

        // On the monthly path a weekly-off is already paid inside the salary,
        // so overtime is the extra on top rather than the whole day again.
        if (profile.payModel === "monthly" && overtimeTerms.mode === "multiplier") {
            overtimePay = round2(
                perDayRate * Math.max(0, overtimeTerms.value - 1) * tally.overtimeDays
            );
        }
    }

    gross = round2(basePay + overtimePay);

    return {
        payModel: profile.payModel,
        rateAmount: rate.amount,
        rateEffectiveFrom: rate.effectiveFrom,
        perDayRate,
        daysOnPayroll: days.length,
        days: tally,
        lopDays,
        payableDays,
        basePay,
        overtimeDays: round2(tally.overtimeDays),
        overtimePay,
        gross,
        deductions: 0,
        adjustments: 0,
        net: gross,
        exceptions,
    };
};

module.exports = { classifyDay, computeLine, round2, WORKED };
