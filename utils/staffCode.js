/*
  Staff code helpers

  A staff code is the human-readable, immutable identifier for a member of
  staff: e.g. empNo 7 is shown as "RES-0007".

  Two facts drive the design:
  - The NUMBER (empNo) is what gets enrolled on the biometric attendance device
    as the User ID. So it must be a plain integer, short, and unique across
    Employees AND Managers (one shared sequence — see models/Counter.js).
  - The FORMATTED string ("RES-0007") is for humans: UI, payslips, ID cards.

  empNo is assigned once at creation (and backfilled for existing staff by
  scripts/backfillEmpNo.js) and then never changes — it lives on the device and
  on historical records.
*/
const Counter = require("../models/Counter");

const PREFIX = "RES";
const PAD = 4; // RES-0001 .. RES-9999, then naturally widens to RES-10000

// The single shared sequence key in the generic Counter collection. Staff
// numbers must be unique across Employees AND Managers, so both draw from this
// one key (the Counter model is deliberately generic and reused — it already
// backs cert/payslip/report numbering under other keys).
const STAFF_SEQ_KEY = "staffNo";

/*
  Atomically reserve the next staff number from the shared sequence.
  Counter.nextValue is a single findOneAndUpdate with $inc + upsert, safe under
  concurrent creates: each caller gets a distinct number (1 on the first call).
*/
async function nextStaffNo() {
    return await Counter.nextValue(STAFF_SEQ_KEY);
}

// 7 -> "RES-0007". Returns "" for a missing number so callers can render safely.
function formatEmpCode(empNo) {
    if (empNo === null || empNo === undefined || Number.isNaN(Number(empNo))) return "";
    return `${PREFIX}-${String(empNo).padStart(PAD, "0")}`;
}

// "RES-0012", "res 12", "0012", 12 -> 12. null if nothing numeric is present.
// Used later when a biometric punch arrives carrying the device User ID.
function parseEmpCode(input) {
    if (input === null || input === undefined) return null;
    const digits = String(input).replace(/\D/g, "");
    if (!digits) return null;
    const n = parseInt(digits, 10);
    return Number.isNaN(n) ? null : n;
}

module.exports = { nextStaffNo, formatEmpCode, parseEmpCode, PREFIX, PAD, STAFF_SEQ_KEY };
