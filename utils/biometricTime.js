/*
  ZKTeco terminals send local wall-clock time with NO timezone, e.g.
  "2026-11-17 08:54:12". The device is configured to IST, so we read it as IST:

  - date   — taken straight from the string. This is the IST calendar date,
             which is exactly what attendance/payroll keys on. (Deriving it via
             toISOString() like the app does would shift early-morning punches to
             the previous UTC day; reading the string avoids that bug.)
  - instant — the correct absolute moment, as a JS Date, by pinning +05:30.

  IST has no daylight saving, so a fixed offset is exact year-round.
*/
const IST_OFFSET = "+05:30";

function parseDeviceTime(raw) {
    const s = String(raw || "").trim();
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return null;
    const date = m[1];
    const hh = m[2];
    const mm = m[3];
    const ss = m[4] || "00";
    const instant = new Date(`${date}T${hh}:${mm}:${ss}${IST_OFFSET}`);
    if (Number.isNaN(instant.getTime())) return null;
    return { date, instant, hh: Number(hh), mm: Number(mm), minutes: Number(hh) * 60 + Number(mm) };
}

module.exports = { parseDeviceTime, IST_OFFSET };
