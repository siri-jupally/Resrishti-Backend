/*
  Pure date-maths for recurring pickup schedules. 2026-01-05 is a Monday
  (2026-01-01 is a Thursday), which anchors the weekday cases below.
*/
const {
    validateCadence, nextOccurrenceOnOrAfter, nextOccurrenceAfter, describeCadence,
} = require("../utils/recurrence");

const D = (y, m, d) => new Date(y, m - 1, d);               // local date, 1-based month
const ymd = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

describe("validateCadence", () => {
    it("accepts each valid cadence", () => {
        expect(validateCadence({ type: "weekly", weekday: 1 })).toBeNull();
        expect(validateCadence({ type: "biweekly", weekday: 6 })).toBeNull();
        expect(validateCadence({ type: "monthly", dayOfMonth: 15 })).toBeNull();
        expect(validateCadence({ type: "everyNDays", intervalDays: 10 })).toBeNull();
    });
    it("rejects bad input", () => {
        expect(validateCadence(null)).toMatch(/required/);
        expect(validateCadence({ type: "yearly" })).toMatch(/type/);
        expect(validateCadence({ type: "weekly", weekday: 7 })).toMatch(/weekday/);
        expect(validateCadence({ type: "monthly", dayOfMonth: 0 })).toMatch(/dayOfMonth/);
        expect(validateCadence({ type: "everyNDays", intervalDays: 0 })).toMatch(/intervalDays/);
    });
});

describe("nextOccurrenceOnOrAfter — weekly / biweekly", () => {
    const anchor = D(2026, 1, 5); // Monday
    it("weekly is inclusive and steps by 7", () => {
        expect(ymd(nextOccurrenceOnOrAfter({ type: "weekly", weekday: 1 }, anchor, D(2026, 1, 5)))).toBe("2026-01-05");
        expect(ymd(nextOccurrenceOnOrAfter({ type: "weekly", weekday: 1 }, anchor, D(2026, 1, 6)))).toBe("2026-01-12");
        expect(ymd(nextOccurrenceOnOrAfter({ type: "weekly", weekday: 1 }, anchor, D(2026, 1, 12)))).toBe("2026-01-12");
    });
    it("weekly snaps forward to the chosen weekday", () => {
        // first Wednesday on/after Mon Jan 5 is Jan 7
        expect(ymd(nextOccurrenceOnOrAfter({ type: "weekly", weekday: 3 }, anchor, D(2026, 1, 5)))).toBe("2026-01-07");
    });
    it("biweekly skips the off-week (anchored to startDate)", () => {
        const c = { type: "biweekly", weekday: 1 };
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 1, 6)))).toBe("2026-01-19");
        // Jan 12 is a Monday but NOT on the biweekly cadence (Jan 5, 19, Feb 2…)
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 1, 12)))).toBe("2026-01-19");
    });
});

describe("nextOccurrenceOnOrAfter — monthly (clamps to month length)", () => {
    it("picks this month then rolls to next", () => {
        const c = { type: "monthly", dayOfMonth: 15 };
        const anchor = D(2026, 1, 10);
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 1, 10)))).toBe("2026-01-15");
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 1, 16)))).toBe("2026-02-15");
    });
    it("a 31st clamps to the last day of a short month", () => {
        const c = { type: "monthly", dayOfMonth: 31 };
        const anchor = D(2026, 1, 1);
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 1, 1)))).toBe("2026-01-31");
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 2, 1)))).toBe("2026-02-28"); // 2026 not a leap year
    });
});

describe("nextOccurrenceOnOrAfter — everyNDays (anchored)", () => {
    const c = { type: "everyNDays", intervalDays: 10 };
    const anchor = D(2026, 1, 1);
    it("lands on anchor + k*N", () => {
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 1, 1)))).toBe("2026-01-01");
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 1, 2)))).toBe("2026-01-11");
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 1, 11)))).toBe("2026-01-11");
        expect(ymd(nextOccurrenceOnOrAfter(c, anchor, D(2026, 1, 12)))).toBe("2026-01-21");
    });
});

describe("nextOccurrenceAfter advances past a generated date", () => {
    it("weekly", () => {
        const anchor = D(2026, 1, 5);
        expect(ymd(nextOccurrenceAfter({ type: "weekly", weekday: 1 }, anchor, D(2026, 1, 5)))).toBe("2026-01-12");
    });
    it("everyNDays", () => {
        expect(ymd(nextOccurrenceAfter({ type: "everyNDays", intervalDays: 10 }, D(2026, 1, 1), D(2026, 1, 11)))).toBe("2026-01-21");
    });
});

describe("a 'from' before the anchor never produces a pre-anchor date", () => {
    it("clamps to the anchor's series", () => {
        const anchor = D(2026, 6, 1);
        const occ = nextOccurrenceOnOrAfter({ type: "weekly", weekday: 1 }, anchor, D(2026, 1, 1));
        expect(occ.getTime()).toBeGreaterThanOrEqual(anchor.getTime());
        expect(occ.getDay()).toBe(1);
    });
});

describe("describeCadence", () => {
    it("reads naturally", () => {
        expect(describeCadence({ type: "weekly", weekday: 1 })).toBe("Every week on Monday");
        expect(describeCadence({ type: "biweekly", weekday: 5 })).toBe("Every 2 weeks on Friday");
        expect(describeCadence({ type: "monthly", dayOfMonth: 15 })).toBe("Monthly on the 15th");
        expect(describeCadence({ type: "monthly", dayOfMonth: 1 })).toBe("Monthly on the 1st");
        expect(describeCadence({ type: "everyNDays", intervalDays: 3 })).toBe("Every 3 days");
    });
});
