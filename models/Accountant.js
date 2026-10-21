/*
  Accountant — DEPRECATED. The payroll preparer, when that was a login.

  An accountant is now an employee an admin has assigned: `canPreparePayroll`
  on Employee, reached with their ordinary employee credentials. One set of
  credentials per person, and one account to revoke when they move on.

  Nothing authenticates against this model any more and nothing creates a row
  in it. It is kept only so the existing rows can still be read — by
  scripts/migrate-accountants-to-employees.js, which assigns the tag to the
  matching employees, and by anyone looking up a name that appears on an old
  run. Delete it, and the collection, once every environment has migrated.

  Maker–checker did not live in the separate login and is unaffected:
  approving is still admin-only, and approveRun still refuses an approver who
  prepared the run.
*/
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const accountantSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true },
        email: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },
        password: { type: String, required: true },

        // See models/Employee.js — rejects JWTs older than the last password
        // change so a reset ends every other session.
        passwordChangedAt: { type: Date },
        pushSubscription: { type: Object },

        phone: { type: String, trim: true },

        // An accountant who has left keeps their history on past runs but can
        // no longer sign in or prepare anything.
        isActive: { type: Boolean, default: true },

        // Who created this login, for the audit trail.
        createdByName: String,
    },
    { timestamps: true }
);

// Trim symmetrically on hash and compare, so whitespace pasted into a form
// does not lock somebody out later. Same rule as Admin and Employee.
accountantSchema.pre("save", async function () {
    if (!this.isModified("password")) return;
    const cleaned = String(this.password ?? "").trim();
    if (!cleaned) throw new Error("Password cannot be empty or whitespace-only");
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(cleaned, salt);
    // One second in the past — a JWT's `iat` is whole seconds, so a token
    // minted in the same second would otherwise be rejected as too old.
    this.passwordChangedAt = new Date(Date.now() - 1000);
});

accountantSchema.methods.comparePassword = async function (candidate) {
    const cleaned = String(candidate ?? "").trim();
    if (!cleaned || !this.password) return false;
    return bcrypt.compare(cleaned, this.password);
};

module.exports = mongoose.model("Accountant", accountantSchema);
