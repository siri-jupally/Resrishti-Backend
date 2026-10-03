/*
  PayrollLine — what one person is paid for one month, and how it was arrived at.

  Every input is snapshotted, not referenced: the rate used, the day counts, the
  policy that decided which non-working days were paid. A line recomputed a year
  later from live data would give a different answer, because rates change and
  policies change — and the question a payslip has to answer is "what did we pay
  you in March", not "what would March cost today".

  This is the same reason certificates snapshot their line items.
*/
const mongoose = require("mongoose");

const payrollLineSchema = new mongoose.Schema(
    {
        run: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "PayrollRun",
            required: true,
            index: true,
        },
        month: { type: String, required: true, index: true },

        personType: { type: String, enum: ["Employee", "Manager"], required: true },
        personId: { type: mongoose.Schema.Types.ObjectId, required: true },
        // Denormalised so a payslip stays readable after somebody leaves.
        personName: String,
        personEmail: String,
        department: String,
        jobRole: String,

        // ---- what it was worked out from ----------------------------------
        payModel: { type: String, enum: ["monthly", "daily"], required: true },
        employmentType: String,
        rateAmount: Number,
        rateEffectiveFrom: String,
        perDayRate: Number,
        paidDayPolicyName: String,

        // ---- the month, day by day ----------------------------------------
        daysOnPayroll: Number,
        days: {
            worked: Number,
            halfDays: Number,
            leavePaid: Number,
            leaveUnpaid: Number,
            weeklyOffs: Number,
            holidays: Number,
            absent: Number,
            unapproved: Number,
            overtimeDays: Number,
            _id: false,
        },
        lopDays: Number,
        payableDays: Number,

        // ---- the money -----------------------------------------------------
        basePay: Number,
        overtimeDays: Number,
        overtimePay: Number,
        gross: Number,
        deductions: { type: Number, default: 0 },
        adjustments: { type: Number, default: 0 },
        net: Number,

        // Manual changes made during review. Capped and categorised rather than
        // free-form, so "other" cannot become a habit.
        adjustmentEntries: [
            {
                category: String,
                amount: Number,
                reason: String,
                at: { type: Date, default: Date.now },
                byName: String,
                _id: false,
            },
        ],

        // Anything the engine could not answer confidently about this person.
        exceptions: [
            {
                code: String,
                message: String,
                _id: false,
            },
        ],

        // Net against the same person last month, for the variance flag.
        previousNet: Number,
        variancePercent: Number,

        // The rendered payslip. Held here rather than in a collection of its
        // own: a payslip is this line, printed, and two records would give the
        // same figure two places to live.
        payslip: {
            number: String,
            key: String,
            bucket: String,
            generatedAt: Date,
            // Until this is set the payslip is not the person's to see.
            releasedAt: Date,
            _id: false,
        },
    },
    { timestamps: true }
);

payrollLineSchema.index({ run: 1, personType: 1, personId: 1 }, { unique: true });
payrollLineSchema.index({ month: 1, personId: 1 });

module.exports = mongoose.model("PayrollLine", payrollLineSchema);
