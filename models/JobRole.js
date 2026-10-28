/*
  JobRole model — admin-managed, fixed list of job roles.

  Purpose:
  - Decides which attendance modes (Office / Remote / WFH) a person may use,
    based on what their job actually requires. A plant operator has no reason
    to check in remotely; a field supervisor might.
  - Replaces free-text job roles for this purpose. Free text splits one role
    into several ("Supervisor", "supervisor ", "Supervisor.") and nothing can
    be reliably attached to it.

  How it is applied:
  - Employee and Manager records point at a role via `jobRoleId`.
  - A person may carry `workModesOverride` for individual exceptions; when set
    it wins over the role. See utils/workModePermissions.js.
  - Being *allowed* a mode does not bypass the org-wide remote-work policy:
    WFH/remote still need an approved request and stay under the monthly limits
    (utils/workModeGuard.js). This decides whether the option exists at all.
*/
const mongoose = require("mongoose");

const WORK_MODES = ["WFO", "WFH", "remote"];

const jobRoleSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        // Lowercased copy used for uniqueness, so "Supervisor" and "supervisor"
        // cannot both exist.
        nameKey: { type: String, required: true, unique: true },
        description: { type: String, trim: true },
        allowedWorkModes: {
            type: [{ type: String, enum: WORK_MODES }],
            validate: {
                validator: (v) => Array.isArray(v) && v.length > 0,
                message: "A job role must allow at least one attendance mode",
            },
            default: ["WFO"],
        },
        // Which kind of account can be given this role.
        appliesTo: {
            type: String,
            enum: ["employee", "manager", "both"],
            default: "both",
        },
        // Retired roles stay on the people who hold them, but cannot be newly
        // assigned. Deleting outright would silently change those people's access.
        isActive: { type: Boolean, default: true },

        /*
          Optional payroll template. When set, tagging somebody who holds this
          role pre-fills their pay profile from here, and "add everyone in this
          role" can create profiles in bulk. The role is considered configured
          for payroll only when employmentType AND payModel are both set.

          Setting this is an approver action — it decides pay — so it is written
          from Payroll → Setup (protectApprover), not from the attendance role
          editor. Changing it only affects profiles created afterwards: existing
          profiles and payslips keep their own snapshot, so nobody's past pay
          moves because a role default changed.
        */
        payroll: {
            employmentType: { type: String, enum: ["permanent", "contract", "daily-wage"] },
            payModel: { type: String, enum: ["monthly", "daily"] },
            paidDayPolicy: { type: mongoose.Schema.Types.ObjectId, ref: "PaidDayPolicy" },
            overtimeEligible: { type: Boolean, default: false },
            // Optional. Blank / null → the rate is entered per person.
            defaultRate: { type: Number, min: 0 },
            setByName: { type: String, trim: true },
            updatedAt: { type: Date },
            _id: false,
        },
    },
    { timestamps: true }
);

jobRoleSchema.pre("validate", function () {
    if (this.name) this.nameKey = this.name.trim().toLowerCase();
    if (Array.isArray(this.allowedWorkModes)) {
        this.allowedWorkModes = [...new Set(this.allowedWorkModes)];
    }
});

module.exports = mongoose.model("JobRole", jobRoleSchema);
module.exports.WORK_MODES = WORK_MODES;
