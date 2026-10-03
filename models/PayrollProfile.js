/*
  PayrollProfile — the payroll layer on a person.

  Held in its own collection rather than as fields on Employee and Manager, for
  three reasons:
    · payroll covers both, and duplicating a dozen fields across two models is
      how the two drift apart
    · pay is the most sensitive data in the system, and a separate collection
      is far easier to gate than a subset of fields on a record everyone reads
    · a person can exist for months before anyone tags them for payroll, and an
      untagged person should be visibly missing, not silently defaulted

  Rates are effective-dated. A raise in June must not change what March paid,
  so `rates` is a history and the engine asks for the rate in force on a date
  rather than reading a single mutable number. Correcting a past rate is done
  by adding an entry dated then, which leaves the original visible.

  The empty slots — bank, PF / ESI / UAN, grade — are here now so that turning
  on disbursement or statutory later is configuration and data entry, not a
  migration.
*/
const mongoose = require("mongoose");

// One rate, in force from a date until the next entry supersedes it.
const rateSchema = new mongoose.Schema(
    {
        // YYYY-MM-DD. The rate applies to every day on or after this date.
        effectiveFrom: {
            type: String,
            required: true,
            match: [/^\d{4}-\d{2}-\d{2}$/, "effectiveFrom must be YYYY-MM-DD"],
        },
        // Monthly salary for a monthly profile; the day rate for a daily one.
        amount: { type: Number, required: true, min: 0 },
        // Why it changed — "annual increment", "corrected, was entered wrong".
        reason: { type: String, trim: true, maxlength: 200 },
        setAt: { type: Date, default: Date.now },
        setByName: String,
    },
    { _id: true }
);

const payrollProfileSchema = new mongoose.Schema(
    {
        // Employees and managers are separate collections but the same payroll.
        personType: {
            type: String,
            enum: ["Employee", "Manager"],
            required: true,
        },
        personId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            refPath: "personType",
        },

        employmentType: {
            type: String,
            enum: ["permanent", "contract", "daily-wage"],
            required: true,
        },

        // Which of the two calculation paths this person goes down. Kept
        // separate from employmentType on purpose: a contract worker may be on
        // a monthly figure, and a permanent one may be paid daily.
        payModel: {
            type: String,
            enum: ["monthly", "daily"],
            required: true,
        },

        rates: {
            type: [rateSchema],
            validate: {
                validator: (v) => Array.isArray(v) && v.length > 0,
                message: "A payroll profile needs at least one pay rate",
            },
        },

        paidDayPolicy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "PaidDayPolicy",
        },

        // Overtime here is a day worked on a weekly-off.
        //
        // Who earns it is decided person by person, not by pay model or
        // employment type: two people doing the same job on the same terms may
        // have different arrangements, and deriving it from the work would make
        // the exceptions invisible. Off unless somebody says otherwise.
        overtimeEligible: { type: Boolean, default: false },

        // What they earn for it. Left unset, they get the organisation-wide
        // rate; set, this is theirs.
        overtimeOverride: {
            // "multiplier" pays dayRate × value; "flat" pays value per day.
            mode: { type: String, enum: ["multiplier", "flat"] },
            value: { type: Number, min: 0 },
            _id: false,
        },

        // Somebody who has left. Their history stays; they drop out of new runs.
        isActive: { type: Boolean, default: true },
        // A late joiner or leaver within a month is prorated by the engine.
        payrollStartDate: { type: String },
        payrollEndDate: { type: String },

        // ---- filled in later, from the frontend, once the app is live ------
        bank: {
            accountHolderName: { type: String, trim: true },
            accountNumber: { type: String, trim: true },
            ifsc: { type: String, trim: true, uppercase: true },
            bankName: { type: String, trim: true },
            branch: { type: String, trim: true },
            _id: false,
        },

        // ---- scaffolded for a later statutory phase ------------------------
        statutory: {
            pfNumber: String,
            uan: String,
            esiNumber: String,
            panNumber: String,
            _id: false,
        },
        grade: { type: String, trim: true },

        notes: { type: String, trim: true, maxlength: 500 },
        updatedByName: String,
    },
    { timestamps: true }
);

// One payroll profile per person.
payrollProfileSchema.index({ personType: 1, personId: 1 }, { unique: true });
payrollProfileSchema.index({ isActive: 1, payModel: 1 });

/**
 * The rate in force on a given date — the latest entry dated on or before it.
 *
 * Returns null when the person had no rate yet on that date, which the engine
 * treats as "not ready" rather than guessing at zero: paying somebody nothing
 * is a worse error than refusing to pay them until a human looks.
 */
payrollProfileSchema.methods.rateOn = function rateOn(date) {
    const applicable = (this.rates || [])
        .filter((r) => r.effectiveFrom <= date)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    return applicable.length > 0 ? applicable[applicable.length - 1] : null;
};

module.exports = mongoose.model("PayrollProfile", payrollProfileSchema);
