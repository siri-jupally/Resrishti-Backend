/*
  utils/attendanceLock.js — the one place that answers "may this attendance
  date still be changed?"

  Every controller that writes an attendance record, or anything that turns
  into one (a leave approval, a correction, an approval decision, a holiday
  being declared), asks here first. Keeping the question in one module means a
  new write path is one line away from being covered, rather than quietly
  bypassing the lock.

  Usage in a handler:

      const blocked = await lockBlocks(date);
      if (blocked) return res.status(409).json(blocked.body);

  The refusal is a 409 with a message written for the person reading it, not
  for the developer: it names the month and says what to do about it.
*/
const AttendanceMonthLock = require("../models/AttendanceMonthLock");

/** "2026-09-14" -> "2026-09". Tolerates a Date as well as a YYYY-MM-DD string. */
const monthOf = (date) => {
    if (!date) return null;
    if (date instanceof Date) {
        if (Number.isNaN(date.getTime())) return null;
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    }
    const str = String(date);
    const match = str.match(/^(\d{4})-(\d{2})/);
    return match ? `${match[1]}-${match[2]}` : null;
};

/** Every month a date range touches, inclusive, oldest first. */
const monthsBetween = (startDate, endDate) => {
    const first = monthOf(startDate);
    const last = monthOf(endDate) || first;
    if (!first) return [];
    const out = [];
    let [y, m] = first.split("-").map(Number);
    const [ey, em] = last.split("-").map(Number);
    // A backwards range yields just its start rather than looping forever.
    if (ey < y || (ey === y && em < m)) return [first];
    while (y < ey || (y === ey && m <= em)) {
        out.push(`${y}-${String(m).padStart(2, "0")}`);
        m += 1;
        if (m > 12) { m = 1; y += 1; }
    }
    return out;
};

/** Which of these months are locked. */
const lockedMonthsAmong = async (months) => {
    if (!months || months.length === 0) return [];
    const rows = await AttendanceMonthLock.find({
        month: { $in: months },
        status: "locked",
    })
        .select("month")
        .lean();
    return rows.map((r) => r.month);
};

const isMonthLocked = async (month) =>
    Boolean(month) && (await lockedMonthsAmong([month])).length > 0;

const refusal = (months, what) => ({
    month: months[0],
    months,
    body: {
        message:
            months.length === 1
                ? `Attendance for ${months[0]} is locked, so ${what} cannot be changed. An admin can reopen the month if this is a genuine correction.`
                : `Attendance for ${months.join(" and ")} is locked, so ${what} cannot be changed. An admin can reopen those months if this is a genuine correction.`,
        lockedMonths: months,
    },
});

/**
 * Blocks a change to a single date.
 * @returns {null | {month, months, body}} null when the date is free to change.
 */
const lockBlocks = async (date, what = "this attendance") => {
    const month = monthOf(date);
    if (!month) return null;
    const locked = await lockedMonthsAmong([month]);
    return locked.length > 0 ? refusal(locked, what) : null;
};

/**
 * Blocks a change spanning a range — a leave request, for instance, which can
 * straddle a locked month and an open one. Any locked month in the span
 * refuses the whole thing: approving half a leave would be worse.
 */
const lockBlocksRange = async (startDate, endDate, what = "this attendance") => {
    const locked = await lockedMonthsAmong(monthsBetween(startDate, endDate));
    return locked.length > 0 ? refusal(locked, what) : null;
};

module.exports = {
    monthOf,
    monthsBetween,
    lockedMonthsAmong,
    isMonthLocked,
    lockBlocks,
    lockBlocksRange,
};

// ---------------------------------------------------------------------------
// Model-level backstop
// ---------------------------------------------------------------------------
/*
  Controllers ask lockBlocks() so they can answer with a readable 409. This
  hook is the guarantee underneath: it refuses the write at the schema, so a
  path nobody remembered — a script, a new endpoint, a future feature — cannot
  quietly edit a closed month. Fourteen write paths touch attendance today;
  relying on fourteen `if` statements staying correct forever is how locks rot.
*/
class AttendanceMonthLockedError extends Error {
    constructor(month) {
        super(
            `Attendance for ${month} is locked. An admin can reopen the month if this is a genuine correction.`
        );
        this.name = "AttendanceMonthLockedError";
        this.statusCode = 409;
        this.lockedMonth = month;
    }
}

const assertOpen = async (date) => {
    const month = monthOf(date);
    if (!month) return;
    if (await isMonthLocked(month)) throw new AttendanceMonthLockedError(month);
};

/** Pull a date out of an update filter or payload, whatever shape it arrived in. */
const dateFromQuery = function () {
    const filter = this.getFilter ? this.getFilter() : {};
    const update = this.getUpdate ? this.getUpdate() || {} : {};
    const set = update.$set || update;
    // A filter naming an exact date is the common case (upsert by employee+date).
    if (typeof filter.date === "string") return filter.date;
    if (typeof set.date === "string") return set.date;
    // A ranged filter — guard the earliest month it could touch.
    if (filter.date && typeof filter.date === "object") {
        return filter.date.$gte || filter.date.$gt || filter.date.$lte || filter.date.$lt || null;
    }
    return null;
};

const applyLockGuard = (schema) => {
    schema.pre("save", async function () {
        // Only guard the date the row is for; an unchanged row being re-saved
        // for an unrelated field is still a change to a closed month.
        await assertOpen(this.date);
    });

    for (const op of ["findOneAndUpdate", "updateOne", "updateMany", "deleteOne", "deleteMany", "findOneAndDelete"]) {
        schema.pre(op, async function () {
            await assertOpen(dateFromQuery.call(this));
        });
    }

    // Mongoose hands an insertMany hook (next, docs) when it is callback-style
    // and (docs, options) when it is promise-based. Taking a rest parameter and
    // picking out the array works under either, rather than depending on how
    // Mongoose classifies this function today.
    schema.pre("insertMany", async function (...args) {
        const docs = Array.isArray(args[0]) ? args[0] : args[1];
        for (const doc of docs || []) await assertOpen(doc?.date);
    });
};

module.exports.AttendanceMonthLockedError = AttendanceMonthLockedError;
module.exports.applyLockGuard = applyLockGuard;
