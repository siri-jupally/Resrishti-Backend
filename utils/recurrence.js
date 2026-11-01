/*
  utils/recurrence.js — pure date maths for client recurring-pickup schedules.

  No I/O, no "now" baked in: the caller passes the reference dates. Dates are
  treated as DATE-ONLY (normalised to local midnight), because a pickup happens
  on a calendar day, not at an instant — this keeps the series stable across DST
  and avoids off-by-one when a stored timestamp drifts by a few hours.

  Cadences:
    weekly      — every week on `weekday` (0=Sun..6=Sat)
    biweekly    — every 2 weeks on `weekday`, anchored to startDate
    monthly     — every month on `dayOfMonth` (1..31, clamped to month length)
    everyNDays  — every `intervalDays` days, anchored to startDate

  The series is always aligned to `startDate` (the anchor) so pausing/resuming
  or a late job run never shifts the rhythm.
*/

const atMidnight = (d) => {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
};
const addDays = (d, n) => {
    const x = atMidnight(d);
    x.setDate(x.getDate() + n);
    return x;
};
const daysBetween = (a, b) =>
    Math.round((atMidnight(b).getTime() - atMidnight(a).getTime()) / 86400000);

// A real date for day-of-month, clamped to the month's length (Feb 30 -> 28/29,
// a 31st in a 30-day month -> 30).
const dateForDayOfMonth = (year, monthIndex, dom) => {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate();
    return atMidnight(new Date(year, monthIndex, Math.min(dom, lastDay)));
};

const CADENCE_TYPES = ["weekly", "biweekly", "monthly", "everyNDays"];

/**
 * Validate a cadence object. Returns an error string, or null when valid.
 */
function validateCadence(cadence) {
    if (!cadence || typeof cadence !== "object") return "cadence is required";
    if (!CADENCE_TYPES.includes(cadence.type)) {
        return `cadence.type must be one of: ${CADENCE_TYPES.join(", ")}`;
    }
    if (cadence.type === "weekly" || cadence.type === "biweekly") {
        if (!Number.isInteger(cadence.weekday) || cadence.weekday < 0 || cadence.weekday > 6) {
            return "cadence.weekday must be an integer 0 (Sun) to 6 (Sat)";
        }
    }
    if (cadence.type === "monthly") {
        if (!Number.isInteger(cadence.dayOfMonth) || cadence.dayOfMonth < 1 || cadence.dayOfMonth > 31) {
            return "cadence.dayOfMonth must be an integer 1 to 31";
        }
    }
    if (cadence.type === "everyNDays") {
        if (!Number.isInteger(cadence.intervalDays) || cadence.intervalDays < 1 || cadence.intervalDays > 365) {
            return "cadence.intervalDays must be an integer 1 to 365";
        }
    }
    return null;
}

/**
 * The next occurrence date ON OR AFTER `from`, for a schedule anchored at
 * `anchor` (its startDate). Returns a Date at local midnight, or null when the
 * cadence is invalid.
 */
function nextOccurrenceOnOrAfter(cadence, anchor, from) {
    if (validateCadence(cadence)) return null;
    const a = atMidnight(anchor);
    const f = atMidnight(from);
    const start = f < a ? a : f; // never before the anchor

    switch (cadence.type) {
        case "weekly":
        case "biweekly": {
            const step = cadence.type === "weekly" ? 7 : 14;
            // First occurrence = first date >= anchor landing on `weekday`.
            const shift = (cadence.weekday - a.getDay() + 7) % 7;
            const first = addDays(a, shift);
            if (start <= first) return first;
            const k = Math.ceil(daysBetween(first, start) / step);
            return addDays(first, k * step);
        }
        case "monthly": {
            let cand = dateForDayOfMonth(start.getFullYear(), start.getMonth(), cadence.dayOfMonth);
            if (cand < start) {
                cand = dateForDayOfMonth(start.getFullYear(), start.getMonth() + 1, cadence.dayOfMonth);
            }
            return cand;
        }
        case "everyNDays": {
            if (start <= a) return a;
            const k = Math.ceil(daysBetween(a, start) / cadence.intervalDays);
            return addDays(a, k * cadence.intervalDays);
        }
        default:
            return null;
    }
}

/**
 * The next occurrence strictly AFTER `afterDate` — used to advance a schedule
 * once a pickup has been generated for `afterDate`.
 */
function nextOccurrenceAfter(cadence, anchor, afterDate) {
    return nextOccurrenceOnOrAfter(cadence, anchor, addDays(afterDate, 1));
}

/**
 * A short human description of a cadence, e.g. "Every week on Monday".
 */
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (n) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
function describeCadence(cadence) {
    if (validateCadence(cadence)) return "";
    switch (cadence.type) {
        case "weekly": return `Every week on ${WEEKDAYS[cadence.weekday]}`;
        case "biweekly": return `Every 2 weeks on ${WEEKDAYS[cadence.weekday]}`;
        case "monthly": return `Monthly on the ${ordinal(cadence.dayOfMonth)}`;
        case "everyNDays": return cadence.intervalDays === 1 ? "Every day" : `Every ${cadence.intervalDays} days`;
        default: return "";
    }
}

module.exports = {
    CADENCE_TYPES,
    validateCadence,
    nextOccurrenceOnOrAfter,
    nextOccurrenceAfter,
    describeCadence,
    // exported for tests / reuse
    atMidnight,
    addDays,
    daysBetween,
};
