/*
  PayrollRun — one month's payroll, and the process it goes through.

  draft ──submit──▶ pending-approval ──approve──▶ approved ──pay──▶ paid ──close──▶ closed
    ▲                      │
    └──── reject ──────────┘

  Five statuses, and no more. Earlier versions had a status for being under
  review and another for being locked; validation problems and payment failures
  were tempting to add as statuses too. They are not states of the payroll —
  they are facts about particular lines, so they live there instead:

    · a line that cannot be calculated is an entry in `exceptions`
    · a payment that failed is `payment.status` on the line

  which keeps "where is this month up to?" answerable with one word.

  The lifecycle is the difference between a calculation and a payroll. Without
  it there are numbers but no accountability, nothing stopping a month being
  paid twice, and no record of who agreed to what.

  One run per month is enforced by a unique index rather than by checking first:
  two people pressing Generate at the same moment is exactly the race that
  produces two runs and a double payment.

  A run only ever calculates on a locked attendance month — see
  utils/attendanceLock.js. That is the module's hard dependency.
*/
const mongoose = require("mongoose");

// The five, in order. Exported so the controllers and the transition guard
// agree with the schema rather than each holding their own copy.
const RUN_STATUSES = ["draft", "pending-approval", "approved", "paid", "closed"];

// Who may follow what. A run can also go backwards from pending-approval to
// draft, which is what rejection is.
const ALLOWED_TRANSITIONS = {
    draft: ["pending-approval"],
    "pending-approval": ["approved", "draft"],
    approved: ["paid"],
    paid: ["closed"],
    closed: [],
};

// "Accountant" is kept for runs prepared while the accountant was a login of
// its own. An assigned accountant is recorded as "Employee" — see
// utils/payrollActor.js.
const actorSchema = new mongoose.Schema(
    {
        userType: {
            type: String,
            enum: ["Admin", "Accountant", "Employee", "Manager", "System"],
        },
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
            enum: RUN_STATUSES,
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

        // How the money actually went out. Rolled up from the lines on each
        // payment action so the dashboard does not have to aggregate to answer
        // "how much of this is settled?".
        payment: {
            paidCount: { type: Number, default: 0 },
            failedCount: { type: Number, default: 0 },
            pendingCount: { type: Number, default: 0 },
            paidAmount: { type: Number, default: 0 },
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
        submittedAt: Date,
        submittedBy: actorSchema,
        approvedAt: Date,
        approvedBy: actorSchema,
        // Rejection sends the run back to draft; the reason is required, so
        // whoever picks it up knows what to fix.
        rejectedAt: Date,
        rejectedBy: actorSchema,
        rejectionReason: String,
        paidAt: Date,
        paidBy: actorSchema,
        closedAt: Date,
        closedBy: actorSchema,
        reopenedAt: Date,
        reopenedBy: actorSchema,
        reopenReason: String,

        notes: String,
    },
    { timestamps: true }
);

payrollRunSchema.index({ status: 1, month: -1 });

/**
 * Is this a legal next status for the run as it stands?
 * @param {string} from
 * @param {string} to
 */
payrollRunSchema.statics.canTransition = (from, to) =>
    Boolean(ALLOWED_TRANSITIONS[from]?.includes(to));

const PayrollRun = mongoose.model("PayrollRun", payrollRunSchema);

module.exports = PayrollRun;
module.exports.RUN_STATUSES = RUN_STATUSES;
module.exports.ALLOWED_TRANSITIONS = ALLOWED_TRANSITIONS;
