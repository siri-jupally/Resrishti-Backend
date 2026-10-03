/*
  PayrollAudit — a record of every payroll action, who took it and when.

  Built in from the start rather than added later, for the reason the spec
  gives: it is nearly free as a by-product of the lifecycle and painful to
  retrofit, because the events you want are the ones that already happened.

  It is append-only by convention: nothing in the codebase updates or deletes
  an entry. A correction is another entry.
*/
const mongoose = require("mongoose");

const payrollAuditSchema = new mongoose.Schema(
    {
        // What happened, in past tense: "run.calculated", "line.adjusted",
        // "run.approved", "profile.rateAdded".
        action: { type: String, required: true, index: true },

        // What it happened to. Both optional — a settings change belongs to
        // neither a run nor a person.
        run: { type: mongoose.Schema.Types.ObjectId, ref: "PayrollRun", index: true },
        line: { type: mongoose.Schema.Types.ObjectId, ref: "PayrollLine" },
        month: { type: String, index: true },

        // Who. Denormalised name so the log stays readable after somebody
        // leaves and their account is gone.
        actor: {
            userType: { type: String, enum: ["Admin", "Accountant", "System"] },
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },

        // Free-form detail: before and after values, a reason, a count.
        detail: { type: mongoose.Schema.Types.Mixed },
        reason: String,
    },
    { timestamps: true }
);

payrollAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model("PayrollAudit", payrollAuditSchema);
