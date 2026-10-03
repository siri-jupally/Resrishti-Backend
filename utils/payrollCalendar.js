/*
  utils/payrollCalendar.js — what every day of a month is, before anybody's
  attendance is looked at.

  This exists because attendance records only appear when somebody checks in or
  is marked on leave. A day somebody simply did not turn up has no row at all —
  absence is the absence of data. So payroll cannot iterate over attendance and
  add up; it has to lay out the month first, from the organisation's own
  calendar, and then ask what each person did on each day.

  Getting this wrong is how people get paid for days that did not exist, or
  docked for Sundays. It is deliberately separate from the engine so it can be
  tested on its own.
*/

const pad2 = (n) => String(n).padStart(2, "0");

/** Every date in a month, as YYYY-MM-DD. */
const datesInMonth = (month) => {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(y, m, 0).getDate();
    const out = [];
    for (let d = 1; d <= last; d += 1) out.push(`${y}-${pad2(m)}-${pad2(d)}`);
    return out;
};

/** 0 = Sunday … 6 = Saturday, read from the date string rather than a timezone. */
const weekdayOf = (date) => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(y, m - 1, d).getDay();
};

/**
 * Lay out a month from the organisation's attendance policy.
 *
 * Returns one entry per date:
 *   kind      "working" | "weeklyOff" | "holiday"
 *   holiday   the holiday's name, when there is one
 *
 * A weekend exception overrides the weekly-off pattern in both directions: a
 * Saturday declared "working" is a working day, and a Wednesday declared "off"
 * is not. Holidays win over both, because a holiday that falls on a working day
 * is what people actually mean by a holiday.
 */
const buildMonthCalendar = (month, policy) => {
    const weeklyOffDays = policy?.weeklyOffDays?.length ? policy.weeklyOffDays : [0, 6];

    const holidayByDate = new Map(
        (policy?.holidays || []).map((h) => [h.date, h.name || "Holiday"])
    );
    const exceptionByDate = new Map(
        (policy?.weekendExceptions || []).map((e) => [e.date, e.type])
    );

    return datesInMonth(month).map((date) => {
        const holiday = holidayByDate.get(date);
        if (holiday) return { date, kind: "holiday", holiday };

        const exception = exceptionByDate.get(date);
        if (exception === "working") return { date, kind: "working" };
        if (exception === "off") return { date, kind: "weeklyOff" };

        return {
            date,
            kind: weeklyOffDays.includes(weekdayOf(date)) ? "weeklyOff" : "working",
        };
    });
};

/** How many of each kind the month holds. */
const summariseCalendar = (calendar) =>
    calendar.reduce(
        (acc, day) => {
            if (day.kind === "working") acc.workingDays += 1;
            else if (day.kind === "weeklyOff") acc.weeklyOffs += 1;
            else acc.holidays += 1;
            acc.calendarDays += 1;
            return acc;
        },
        { calendarDays: 0, workingDays: 0, weeklyOffs: 0, holidays: 0 }
    );

/**
 * The days of the month a person is actually on payroll for.
 *
 * Somebody who joined on the 16th is not absent for the first fortnight — they
 * were not there to be absent. Same for a leaver. Without this, a mid-month
 * joiner's first payslip would deduct a full half-month of unpaid absence.
 */
const daysOnPayroll = (calendar, { payrollStartDate, payrollEndDate } = {}) =>
    calendar.filter((day) => {
        if (payrollStartDate && day.date < payrollStartDate) return false;
        if (payrollEndDate && day.date > payrollEndDate) return false;
        return true;
    });

/**
 * The divisor for "one day's pay" on a monthly salary.
 *
 *   fixed30       always 30 — the same deduction every month, and the easiest
 *                 for somebody to check against their own payslip
 *   calendarDays  28, 30 or 31
 *   workingDays   excludes weekly-offs and holidays, so a missed day costs most
 *
 * Never returns zero: a month with no working days configured would otherwise
 * divide by zero and produce Infinity as somebody's deduction.
 */
const perDayDivisor = (basis, calendarSummary) => {
    if (basis === "calendarDays") return calendarSummary.calendarDays || 30;
    if (basis === "workingDays") return calendarSummary.workingDays || calendarSummary.calendarDays || 30;
    return 30;
};

module.exports = {
    datesInMonth,
    weekdayOf,
    buildMonthCalendar,
    summariseCalendar,
    daysOnPayroll,
    perDayDivisor,
};
