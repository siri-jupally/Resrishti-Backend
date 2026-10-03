/*
  PayrollRun — one month's payroll, and the process it goes through.

  draft ──calculate──▶ review ──approve──▶ approved ──lock──▶ locked
                         ▲                                      │
                         └──────────── reopen (admin) ──────────┘

  The lifecycle is the difference between a calculation and a payroll. Without
  it there are numbers but no accountability, nothing stopping a month being
  paid twice, and no record of who agreed to what.

  One run per month is enforced by a unique index rather than by checking first:
  two people pressing Calculate at the same moment is exactly the race that
  produces two runs and a double payment.

  A run only ever calculates on a locked attendance month — see
  utils/attendanceLock.js. That is the module's hard dependency.
*/
const mongoose = require("mongoose");

const actorSchema = new mongoose.Schema(
    {
        userType: { type: String, enum: ["Admin", "Accountant", "System"] },
        userId: mongoose.Schema.Types.ObjectId,
        name: String,
    },
    { _id: false }
);

const payrollRunSchema = new mongoose.Schema(
    {
        month: {
            type: String,
            required: true,
            unique: true,
            match: [/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM"],
        },

        status: {
            type: String,
            enum: ["draft", "review", "approved", "locked"],
            default: "draft",
        },

        // What the figures were worked out from. Kept on the run so a
        // recalculation months later can be compared against what was actually
        // paid, even if the settings have changed since.
        settingsSnapshot: {
            perDayRateBasis: String,
            halfDayWeight: Number,
            overtime: mongoose.Schema.Types.Mixed,
            approvalDepth: String,
            _id: false,
        },

        // Totals across every line, recomputed on each calculation.
        totals: {
            people: { type: Number, default: 0 },
            gross: { type: Number, default: 0 },
            deductions: { type: Number, default: 0 },
            adjustments: { type: Number, default: 0 },
            net: { type: Number, default: 0 },
            overtimePay: { type: Number, default: 0 },
            _id: false,
        },

        // People who could not be calculated and why. They are held out of the
        // run rather than paid a guessed figure.
        exceptions: [
            {
                personType: String,
                personId: mongoose.Schema.Types.ObjectId,
                name: String,
                code: String,
                message: String,
                _id: false,
            },
        ],

        calculatedAt: Date,
        calculatedBy: actorSchema,
        approvedAt: Date,
        approvedBy: actorSchema,
        lockedAt: Date,
        lockedBy: actorSchema,
        reopenedAt: Date,
        reopenedBy: actorSchema,
        reopenReason: String,

        notes: String,
    },
    { timestamps: true }
);

payrollRunSchema.index({ status: 1, month: -1 });

module.exports = mongoose.model("PayrollRun", payrollRunSchema);
