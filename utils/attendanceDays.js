/*
  Attendance day helpers

  Centralizes weekend / working-day logic so every view (calendar, team daily
  view, summaries, reports) agrees on what counts as a weekly-off day.

  weeklyOffDays uses JS getDay() numbering: 0 = Sunday ... 6 = Saturday.
*/

const DEFAULT_WEEKLY_OFF = [0, 6]; // Sun, Sat

// Day of week (0..6) for a "YYYY-MM-DD" string, computed in local time so it
// doesn't shift across the UTC boundary the way `new Date("YYYY-MM-DD")` would.
function dayOfWeekFromYmd(dateStr) {
    const [y, m, d] = String(dateStr).split("-").map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d).getDay();
}

// Resolve the configured weekly-off days from a policy (falls back to Sat/Sun).
function getWeeklyOffDays(policy) {
    return policy && Array.isArray(policy.weeklyOffDays) && policy.weeklyOffDays.length >= 0
        ? policy.weeklyOffDays
        : DEFAULT_WEEKLY_OFF;
}

// Is the given YYYY-MM-DD a weekly-off (non-working) day per policy?
// A per-date exception (type "off" / "working") overrides the weekly default.
function isWeekOff(dateStr, policy) {
    const exceptions = policy && Array.isArray(policy.weekendExceptions) ? policy.weekendExceptions : [];
    const exception = exceptions.find((e) => e.date === dateStr);
    if (exception) return exception.type === "off";

    const dow = dayOfWeekFromYmd(dateStr);
    return dow !== null && getWeeklyOffDays(policy).includes(dow);
}

module.exports = { DEFAULT_WEEKLY_OFF, dayOfWeekFromYmd, getWeeklyOffDays, isWeekOff };
