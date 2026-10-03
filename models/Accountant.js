/*
  Accountant — the payroll preparer.

  A login of its own rather than a flag on Admin, so the separation of duties
  is structural: the accountant prepares and calculates a payroll run, the
  admin approves and locks it. Neither can do the other's half, which is the
  whole point of maker–checker on the most sensitive numbers in the system.

  Mirrors Admin deliberately — same password handling, same passwordChangedAt
  session invalidation — so there is one way passwords work in this codebase
  rather than four.
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
