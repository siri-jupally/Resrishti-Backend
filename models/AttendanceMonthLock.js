/*
  AttendanceMonthLock — closes a month's attendance so pay can be computed on
  figures that cannot move afterwards.

  Why this exists:
  Attendance for a past month was editable indefinitely. Leave approved late
  upserts rows into months gone by, corrections rewrite check-in times, and an
  out-of-premises day sits `pending` — excluded from worked days and hours —
  until somebody approves it. Any of those landing after pay is calculated
  makes the payslip wrong, and a wrong payslip is the one payroll failure that
  cannot be quietly fixed.

  One document per month, created the first time that month is looked at or
  locked. `status` is the whole contract: `open` means attendance may still be
  edited; `locked` means every write path refuses (see utils/attendanceLock.js).

  Reopening is deliberately possible but loud — admin only, reason required,
  and kept in `history` forever, because the reason a month reopened is
  exactly what an auditor asks about.
*/
const mongoose = require("mongoose");

const actorSchema = new mongoose.Schema(
    {
        userType: { type: String, enum: ["Admin", "Manager"] },
        userId: mongoose.Schema.Types.ObjectId,
        name: String,
    },
    { _id: false }
);

const historySchema = new mongoose.Schema(
    {
        action: { type: String, enum: ["locked", "reopened"], required: true },
        at: { type: Date, default: Date.now },
        by: actorSchema,
        reason: String,
    },
    { _id: false }
);

const attendanceMonthLockSchema = new mongoose.Schema(
    {
        // "YYYY-MM". The month is the unit of payroll, so it is the unit here.
        month: {
            type: String,
            required: true,
            unique: true,
            match: [/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"],
        },
        status: {
            type: String,
            enum: ["open", "locked"],
            default: "open",
        },

        lockedAt: Date,
        lockedBy: actorSchema,
        lockNote: String,

        reopenedAt: Date,
        reopenedBy: actorSchema,
        reopenReason: String,

        // What the month looked like at the moment it was locked. Payroll can
        // be re-run later and checked against this without recounting.
        snapshot: {
            employees: Number,
            managers: Number,
            attendanceRecords: Number,
            workedHours: Number,
            takenAt: Date,
            _id: false,
        },

        history: [historySchema],
    },
    { timestamps: true }
);

attendanceMonthLockSchema.index({ status: 1, month: -1 });

module.exports = mongoose.model("AttendanceMonthLock", attendanceMonthLockSchema);
