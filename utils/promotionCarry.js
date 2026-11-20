/*
  Carrying a staff person's records across collections on promotion.

  Promotion creates a NEW record in the target collection (new _id) and archives
  the original. Identity, password and the payroll PROFILE are carried in the
  controller; this module carries the ATTENDANCE history, which otherwise stays
  stranded under the old employee _id while the person's new manager identity
  reads the (empty) ManagerAttendance collection — so they'd show "absent"
  despite a full history (the data is never lost, just detached).

  Design choices:
  - Native driver (`collection.insertMany`), NOT Mongoose .create/.save. Two
    reasons: (1) a locked payroll month installs a save-guard that would refuse
    these writes (utils/attendanceLock) — a historical migration must not be
    blocked by it; (2) rows are copied verbatim, with no re-validation or
    schema defaults rewriting old data.
  - Idempotent: a {manager, date} that already exists is skipped, so re-running
    (or a device/app that already wrote a manager row for a day) never
    duplicates and never trips the unique {manager,date} index.
  - Non-destructive: the original employee rows are left in place. The archived
    employee is off every active roster, so nothing double-counts; and it keeps
    the migration trivially reversible (drop the copied manager rows).
*/
const Attendance = require("../models/Attendance");
const ManagerAttendance = require("../models/ManagerAttendance");

async function carryAttendanceEmployeeToManager(employeeId, managerId, { dryRun = false } = {}) {
    const src = await Attendance.find({ employee: employeeId }).sort({ date: 1 }).lean();
    const existing = await ManagerAttendance.find({ manager: managerId }).select("date").lean();
    const have = new Set(existing.map((d) => d.date));

    const toInsert = src
        .filter((r) => !have.has(r.date))
        .map((r) => {
            // Re-key employee -> manager; drop identifiers that must be fresh.
            const { _id, employee, __v, ...rest } = r;
            return { ...rest, manager: managerId };
        });

    const summary = {
        found: src.length,
        willInsert: toInsert.length,
        skippedExisting: src.length - toInsert.length,
        firstDate: src[0]?.date || null,
        lastDate: src.length ? src[src.length - 1].date : null,
    };

    if (!dryRun && toInsert.length) {
        // ordered:false — a stray duplicate on one date can't abort the rest.
        await ManagerAttendance.collection.insertMany(toInsert, { ordered: false });
    }
    return summary;
}

module.exports = { carryAttendanceEmployeeToManager };
