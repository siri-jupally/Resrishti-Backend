/**
 * The pay calculation engine (Payroll, Phase 2).
 *
 * Pure arithmetic, no database — which is the point: the edge cases are where
 * wrong pay comes from, and they are cheap to enumerate when nothing has to be
 * set up first.
 *
 * The cases that matter:
 *   · absence has no attendance record, so the month must be laid out first
 *   · paid and unpaid leave look identical on an attendance row
 *   · a day awaiting an out-of-premises decision is neither worked nor rejected
 *   · a mid-month joiner was not absent before they joined
 *   · overtime is a day worked on a weekly-off, granted person by person
 */
const {
    buildMonthCalendar, summariseCalendar, datesInMonth,
} = require("../utils/payrollCalendar");
const { computeLine, classifyDay } = require("../utils/payrollEngine");

// A plain month: weekends off, one holiday, nothing unusual.
// March 2026 starts on a Sunday and has 31 days.
const POLICY = {
    weeklyOffDays: [0, 6],
    holidays: [{ date: "2026-03-25", name: "Founders Day", type: "company" }],
    weekendExceptions: [],
};

const SETTINGS = {
    perDayRateBasis: "fixed30",
    halfDayWeight: 0.5,
    overtime: {
        enabled: true,
        countWeeklyOff: true,
        countHoliday: false,
        mode: "multiplier",
        value: 2,
    },
};

const MONTH = "2026-03";
const calendar = buildMonthCalendar(MONTH, POLICY);
const calendarSummary = summariseCalendar(calendar);

const workingDates = calendar.filter((d) => d.kind === "working").map((d) => d.date);
const weeklyOffDates = calendar.filter((d) => d.kind === "weeklyOff").map((d) => d.date);

const present = (date, extra = {}) => ({
    date, status: "present", workingHours: 8, approvalStatus: "auto-approved", ...extra,
});
const leaveRow = (date) => ({ date, status: "leave", approvalStatus: "approved" });

const monthlyProfile = (overrides = {}) => ({
    payModel: "monthly",
    employmentType: "permanent",
    overtimeEligible: false,
    ...overrides,
});

const dailyProfile = (overrides = {}) => ({
    payModel: "daily",
    employmentType: "daily-wage",
    overtimeEligible: false,
    ...overrides,
});

const CASUAL = { payWeeklyOff: false, payHoliday: false, payApprovedLeave: false };
const REGULAR = { payWeeklyOff: true, payHoliday: true, payApprovedLeave: true };

const run = ({ profile, rate, policy, records, leaveDates = new Map(), settings = SETTINGS }) =>
    computeLine({
        profile, rate, policy, settings, calendar, calendarSummary, records, leaveDates,
    });

// ───────────────────────────── the calendar ──────────────────────────────

describe("laying out the month", () => {
    test("every day of the month is accounted for", () => {
        expect(calendar).toHaveLength(31);
        expect(datesInMonth(MONTH)).toHaveLength(31);
    });

    test("weekends are weekly-offs", () => {
        expect(calendar.find((d) => d.date === "2026-03-01").kind).toBe("weeklyOff"); // Sunday
        expect(calendar.find((d) => d.date === "2026-03-02").kind).toBe("working");   // Monday
    });

    test("a declared holiday beats a working day", () => {
        expect(calendar.find((d) => d.date === "2026-03-25").kind).toBe("holiday");
    });

    test("a weekend exception can make a Saturday a working day", () => {
        const withException = buildMonthCalendar(MONTH, {
            ...POLICY,
            weekendExceptions: [{ date: "2026-03-07", type: "working" }],
        });
        expect(withException.find((d) => d.date === "2026-03-07").kind).toBe("working");
    });

    test("and can take a weekday off", () => {
        const withException = buildMonthCalendar(MONTH, {
            ...POLICY,
            weekendExceptions: [{ date: "2026-03-04", type: "off" }],
        });
        expect(withException.find((d) => d.date === "2026-03-04").kind).toBe("weeklyOff");
    });

    test("the counts add up to the month", () => {
        const { calendarDays, workingDays, weeklyOffs, holidays } = calendarSummary;
        expect(workingDays + weeklyOffs + holidays).toBe(calendarDays);
        expect(calendarDays).toBe(31);
    });
});

// ─────────────────────── classifying a single day ────────────────────────

describe("what a day was", () => {
    const workingDay = { date: "2026-03-02", kind: "working" };

    test("a worked day is worked", () => {
        const result = classifyDay({ record: present("2026-03-02"), day: workingDay, halfDayWeight: 0.5 });
        expect(result.kind).toBe("worked");
        expect(result.weight).toBe(1);
    });

    test("a half-day carries its weight", () => {
        const result = classifyDay({
            record: { ...present("2026-03-02"), status: "half-day" },
            day: workingDay,
            halfDayWeight: 0.5,
        });
        expect(result.weight).toBe(0.5);
    });

    test("no record on a working day is absence", () => {
        expect(classifyDay({ record: null, day: workingDay, halfDayWeight: 0.5 }).kind).toBe("absent");
    });

    test("no record on a weekly-off is not absence", () => {
        const result = classifyDay({
            record: null, day: { date: "2026-03-01", kind: "weeklyOff" }, halfDayWeight: 0.5,
        });
        expect(result.kind).toBe("weeklyOff");
    });

    test("leave is paid or unpaid according to its type, not the attendance row", () => {
        const paid = classifyDay({
            record: leaveRow("2026-03-02"), day: workingDay, leaveType: "casual", halfDayWeight: 0.5,
        });
        const unpaid = classifyDay({
            record: leaveRow("2026-03-02"), day: workingDay, leaveType: "unpaid", halfDayWeight: 0.5,
        });
        expect(paid.kind).toBe("leavePaid");
        expect(unpaid.kind).toBe("leaveUnpaid");
    });

    test("a day awaiting an out-of-premises decision is neither worked nor absent", () => {
        const result = classifyDay({
            record: present("2026-03-02", { approvalStatus: "pending", locationWithinBoundary: false }),
            day: workingDay,
            halfDayWeight: 0.5,
        });
        expect(result.kind).toBe("unapproved");
        expect(result.weight).toBe(0);
    });

    test("a rejected day does not count as worked", () => {
        const result = classifyDay({
            record: present("2026-03-02", { approvalStatus: "rejected" }),
            day: workingDay,
            halfDayWeight: 0.5,
        });
        expect(result.kind).toBe("unapproved");
    });
});

// ──────────────────────────── the monthly path ───────────────────────────

describe("a salaried person", () => {
    const rate = { amount: 30000, effectiveFrom: "2026-01-01" };

    test("a full month pays the full salary", () => {
        const records = workingDates.map((d) => present(d));
        const line = run({ profile: monthlyProfile(), rate, policy: REGULAR, records });
        expect(line.net).toBe(30000);
        expect(line.lopDays).toBe(0);
    });

    test("weekends and holidays are paid without being worked", () => {
        const records = workingDates.map((d) => present(d));
        const line = run({ profile: monthlyProfile(), rate, policy: REGULAR, records });
        // Nobody worked the 10 weekend days or the holiday, and nothing was docked.
        expect(line.days.weeklyOffs + line.days.holidays).toBeGreaterThan(0);
        expect(line.net).toBe(30000);
    });

    test("an unpaid absence costs one day at salary ÷ 30", () => {
        const records = workingDates.slice(1).map((d) => present(d)); // missed one working day
        const line = run({ profile: monthlyProfile(), rate, policy: REGULAR, records });
        expect(line.perDayRate).toBe(1000);
        expect(line.lopDays).toBe(1);
        expect(line.net).toBe(29000);
    });

    test("a half-day costs half a day", () => {
        const records = workingDates.map((d, i) =>
            i === 0 ? { ...present(d), status: "half-day" } : present(d)
        );
        const line = run({ profile: monthlyProfile(), rate, policy: REGULAR, records });
        expect(line.lopDays).toBe(0.5);
        expect(line.net).toBe(29500);
    });

    test("paid leave costs nothing", () => {
        const [first, ...rest] = workingDates;
        const line = run({
            profile: monthlyProfile(), rate, policy: REGULAR,
            records: [leaveRow(first), ...rest.map((d) => present(d))],
            leaveDates: new Map([[first, "casual"]]),
        });
        expect(line.days.leavePaid).toBe(1);
        expect(line.net).toBe(30000);
    });

    test("unpaid leave costs a day", () => {
        const [first, ...rest] = workingDates;
        const line = run({
            profile: monthlyProfile(), rate, policy: REGULAR,
            records: [leaveRow(first), ...rest.map((d) => present(d))],
            leaveDates: new Map([[first, "unpaid"]]),
        });
        expect(line.days.leaveUnpaid).toBe(1);
        expect(line.net).toBe(29000);
    });

    test("a day nobody approved is unpaid, and says so", () => {
        const [first, ...rest] = workingDates;
        const line = run({
            profile: monthlyProfile(), rate, policy: REGULAR,
            records: [
                present(first, { approvalStatus: "pending", locationWithinBoundary: false }),
                ...rest.map((d) => present(d)),
            ],
        });
        expect(line.net).toBe(29000);
        expect(line.exceptions.map((e) => e.code)).toContain("unapprovedDays");
    });

    test("the per-day basis changes what a day costs", () => {
        const records = workingDates.slice(1).map((d) => present(d));
        const byCalendar = run({
            profile: monthlyProfile(), rate, policy: REGULAR, records,
            settings: { ...SETTINGS, perDayRateBasis: "calendarDays" },
        });
        const byWorking = run({
            profile: monthlyProfile(), rate, policy: REGULAR, records,
            settings: { ...SETTINGS, perDayRateBasis: "workingDays" },
        });
        expect(byCalendar.perDayRate).toBe(967.74);   // 30000 / 31
        expect(byWorking.perDayRate).toBeGreaterThan(byCalendar.perDayRate);
    });

    test("a mid-month joiner is not absent for the days before they joined", () => {
        const joined = "2026-03-16";
        const worked = workingDates.filter((d) => d >= joined);
        const line = run({
            profile: monthlyProfile({ payrollStartDate: joined }),
            rate, policy: REGULAR,
            records: worked.map((d) => present(d)),
        });
        // They are paid for their part of the month, not docked for all of it.
        expect(line.net).toBeGreaterThan(0);
        expect(line.net).toBeLessThan(30000);
        expect(line.exceptions.map((e) => e.code)).toContain("partialMonth");
    });

    test("a month with no attendance docks every working day, not the weekends", () => {
        const line = run({ profile: monthlyProfile(), rate, policy: REGULAR, records: [] });
        // 21 working days missed at 1000 a day. The weekends and the holiday
        // stay paid, because for salaried staff they always are — which is why
        // this figure is not zero and should never be read as a full month off.
        expect(line.lopDays).toBe(21);
        expect(line.net).toBe(9000);
        // In a real run nobody reaches this: somebody with no attendance at all
        // is pulled out into the exceptions list rather than paid a figure
        // nobody has looked at. See payrollRunController, code "noAttendance".
    });
});

// ───────────────────────────── the daily path ────────────────────────────

describe("a daily-wage person", () => {
    const rate = { amount: 600, effectiveFrom: "2026-01-01" };

    test("casual terms pay only for days worked", () => {
        const records = workingDates.map((d) => present(d));
        const line = run({ profile: dailyProfile(), rate, policy: CASUAL, records });
        expect(line.payableDays).toBe(workingDates.length);
        expect(line.net).toBe(600 * workingDates.length);
    });

    test("regular terms also pay the weekly-offs and the holiday", () => {
        const records = workingDates.map((d) => present(d));
        const line = run({ profile: dailyProfile(), rate, policy: REGULAR, records });
        expect(line.payableDays).toBe(31);
        expect(line.net).toBe(600 * 31);
    });

    test("a day not worked simply is not paid", () => {
        const records = workingDates.slice(1).map((d) => present(d));
        const line = run({ profile: dailyProfile(), rate, policy: CASUAL, records });
        expect(line.payableDays).toBe(workingDates.length - 1);
        expect(line.net).toBe(600 * (workingDates.length - 1));
    });

    test("a half-day pays half", () => {
        const records = workingDates.map((d, i) =>
            i === 0 ? { ...present(d), status: "half-day" } : present(d)
        );
        const line = run({ profile: dailyProfile(), rate, policy: CASUAL, records });
        expect(line.payableDays).toBe(workingDates.length - 0.5);
    });

    test("paid leave counts only where the policy says so", () => {
        const [first, ...rest] = workingDates;
        const records = [leaveRow(first), ...rest.map((d) => present(d))];
        const leaveDates = new Map([[first, "casual"]]);
        const casual = run({ profile: dailyProfile(), rate, policy: CASUAL, records, leaveDates });
        const regular = run({ profile: dailyProfile(), rate, policy: REGULAR, records, leaveDates });
        expect(casual.payableDays).toBe(workingDates.length - 1);
        expect(regular.payableDays).toBeGreaterThan(casual.payableDays);
    });
});

// ────────────────────────────── overtime ─────────────────────────────────

describe("overtime", () => {
    const rate = { amount: 600, effectiveFrom: "2026-01-01" };
    const weekendWorked = [weeklyOffDates[0], weeklyOffDates[1]];

    test("nobody earns it unless they are marked as earning it", () => {
        const records = [...workingDates, ...weekendWorked].map((d) => present(d));
        const line = run({ profile: dailyProfile(), rate, policy: CASUAL, records });
        expect(line.overtimeDays).toBe(0);
        expect(line.overtimePay).toBe(0);
    });

    test("a marked person is paid the multiple for a weekly-off worked", () => {
        const records = [...workingDates, ...weekendWorked].map((d) => present(d));
        const line = run({
            profile: dailyProfile({ overtimeEligible: true }), rate, policy: CASUAL, records,
        });
        expect(line.overtimeDays).toBe(2);
        expect(line.overtimePay).toBe(600 * 2 * 2);   // rate × 2× × 2 days
    });

    test("a flat rate pays that amount per day instead", () => {
        const records = [...workingDates, ...weekendWorked].map((d) => present(d));
        const line = run({
            profile: dailyProfile({ overtimeEligible: true }), rate, policy: CASUAL, records,
            settings: { ...SETTINGS, overtime: { ...SETTINGS.overtime, mode: "flat", value: 900 } },
        });
        expect(line.overtimePay).toBe(1800);
    });

    test("a person's own terms beat the organisation's", () => {
        const records = [...workingDates, ...weekendWorked].map((d) => present(d));
        const line = run({
            profile: dailyProfile({
                overtimeEligible: true,
                overtimeOverride: { mode: "flat", value: 1000 },
            }),
            rate, policy: CASUAL, records,
        });
        expect(line.overtimePay).toBe(2000);
    });

    test("a salaried person earns only the extra, because the day is already in the salary", () => {
        const monthlyRate = { amount: 30000, effectiveFrom: "2026-01-01" };
        const records = [...workingDates, weeklyOffDates[0]].map((d) => present(d));
        const line = run({
            profile: monthlyProfile({ overtimeEligible: true }),
            rate: monthlyRate, policy: REGULAR, records,
        });
        // perDay 1000, multiplier 2 → one extra day's pay, not two.
        expect(line.overtimePay).toBe(1000);
        expect(line.net).toBe(31000);
    });

    test("a holiday worked earns it only when the setting says so", () => {
        const records = [...workingDates, "2026-03-25"].map((d) => present(d));
        const off = run({
            profile: dailyProfile({ overtimeEligible: true }), rate, policy: CASUAL, records,
        });
        const on = run({
            profile: dailyProfile({ overtimeEligible: true }), rate, policy: CASUAL, records,
            settings: { ...SETTINGS, overtime: { ...SETTINGS.overtime, countHoliday: true } },
        });
        expect(off.overtimeDays).toBe(0);
        expect(on.overtimeDays).toBe(1);
    });

    test("switching overtime off organisation-wide stops it for everybody", () => {
        const records = [...workingDates, ...weekendWorked].map((d) => present(d));
        const line = run({
            profile: dailyProfile({ overtimeEligible: true }), rate, policy: CASUAL, records,
            settings: { ...SETTINGS, overtime: { ...SETTINGS.overtime, enabled: false } },
        });
        expect(line.overtimePay).toBe(0);
    });
});
