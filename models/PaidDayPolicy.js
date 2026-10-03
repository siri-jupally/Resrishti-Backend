/*
  PaidDayPolicy — which non-working days a person is still paid for.

  The difference between a casual labourer and a regular one is not a different
  calculation, it is a different answer to "do they get paid for the Sunday?".
  Naming that answer and attaching it to people keeps the engine free of
  special cases, and lets the office add a third arrangement later without a
  code change.

  Two are seeded (see utils/payrollDefaults.js):
    "Casual — work only"          nothing but days actually worked
    "Regular — weekly-off paid"   weekly-offs and holidays paid

  Salaried staff are paid for everything by default, so their policy only
  matters when the office wants to say otherwise.
*/
const mongoose = require("mongoose");

const paidDayPolicySchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 60 },
        description: { type: String, trim: true, maxlength: 300 },

        // Is a weekly-off (see AttendancePolicy.weeklyOffDays) a paid day?
        payWeeklyOff: { type: Boolean, default: false },
        // Is a declared holiday a paid day?
        payHoliday: { type: Boolean, default: false },
        // Is approved paid leave (casual / sick / earned) a paid day? Unpaid
        // leave is never paid, whatever this says — that is what it means.
        payApprovedLeave: { type: Boolean, default: true },

        // Which pay models may use this policy. A monthly-salaried person on a
        // "work only" policy is legitimate but unusual, so the list is explicit.
        appliesTo: {
            type: [{ type: String, enum: ["monthly", "daily"] }],
            default: ["daily"],
        },

        // Seeded policies cannot be deleted — people are attached to them and
        // historical pay refers to them.
        isSeeded: { type: Boolean, default: false },
        isActive: { type: Boolean, default: true },
        sortOrder: { type: Number, default: 100 },

        updatedByName: String,
    },
    { timestamps: true }
);

paidDayPolicySchema.index({ name: 1 }, { unique: true });
paidDayPolicySchema.index({ isActive: 1, sortOrder: 1 });

module.exports = mongoose.model("PaidDayPolicy", paidDayPolicySchema);
