/*
  Manager model

  Purpose:
  - Defines the Manager user schema for the application.
  - Stores basic manager info (name, email, password) and timestamps.

  Key behavior:
  - Passwords are hashed with bcrypt before save.
  - Provides a comparePassword method to validate credentials.

  Usage:
  - Imported by authentication and controller code as `require('./models/Manager')`.

  Security/notes:
  - Uses bcrypt for hashing; do not store plain-text passwords.
  - Ensure the database (MONGO_URI) and JWT_SECRET are kept secret in production.
*/
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const managerSchema = new mongoose.Schema(
  {
    name: { type: String },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },
    // See models/Employee.js — rejects JWTs older than the last password change
    // so a reset ends every other session.
    passwordChangedAt: { type: Date },
    pushSubscription: { type: Object },
    role: { type: String, default: "manager" },

    // Profile fields
    isFirstLogin: { type: Boolean, default: true },
    isProfileComplete: { type: Boolean, default: false },
    profilePhoto: { type: String },
    dateOfBirth: { type: String },
    gender: { type: String, enum: ["male", "female", "other", ""] },
    phone: { type: String },
    personalEmail: { type: String },
    emergencyContactName: { type: String },
    emergencyContactPhone: { type: String },
    currentAddress: { type: String },
    idProofType: { type: String, enum: ["aadhaar", "pan", "passport", ""] },
    idProofNumber: { type: String },
    idProofDocument: { type: String },

    /*
      Bank account for salary. The person's own, not payroll's.

      It lives here rather than on the PayrollProfile because the employee is
      the one who knows the account number, and typing it themselves is both
      better data and one less thing an accountant handles. Payroll reads it;
      it does not own it.

      Deliberately NOT part of isProfileComplete — a new joiner rarely has
      these details on their first morning, and blocking setup over it would
      stop them using the app at all. A missing account shows as a standing
      reminder on their dashboard and as a warning on the payroll run instead.

      Changing an account is the classic salary-redirect fraud, so every change
      is kept in bankHistory and the employee is emailed. `bankUpdatedAt` lets
      a run flag an account that moved after it was generated.
    */
    bank: {
        accountHolderName: { type: String, trim: true },
        accountNumber: { type: String, trim: true },
        ifsc: { type: String, trim: true, uppercase: true },
        bankName: { type: String, trim: true },
        branch: { type: String, trim: true },
        _id: false,
    },
    bankUpdatedAt: { type: Date },
    bankHistory: [
        {
            // Only the last four digits of what it was — enough to see that it
            // changed and to recognise the old account, without keeping a
            // second full copy of it around.
            accountNumberLast4: String,
            ifsc: String,
            bankName: String,
            changedAt: { type: Date, default: Date.now },
            changedByName: String,
            _id: false,
        },
    ],

    // Job fields (set by admin at creation, read-only for manager)
    jobRole: { type: String },
    // Admin-assigned job role and optional individual exception. Same meaning
    // as on models/Employee.js — see utils/workModePermissions.js.
    jobRoleId: { type: mongoose.Schema.Types.ObjectId, ref: "JobRole" },
    workModesOverride: {
      type: [{ type: String, enum: ["WFO", "WFH", "remote"] }],
      default: undefined,
    },
    department: { type: String },
    joiningDate: { type: String },

    // Client-Management module — job tags (not roles).
    canSupervise: { type: Boolean, default: false },
    canCoordinate: { type: Boolean, default: false },

    // Payroll module — see the same three fields on Employee. A manager can
    // be assigned as the payroll accountant too, because in this organisation
    // a manager is an employee who happens to manage people.
    //
    // Note for whoever unifies the two models: this is one of the places the
    // duplication shows. The tag, the assignment stamp and the gate in
    // middleware/authPayroll.js all exist twice for no reason other than that
    // Employee and Manager are separate collections.
    canPreparePayroll: { type: Boolean, default: false },
    payrollAssignedAt: { type: Date },
    payrollAssignedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

// See Employee.js — trim symmetrically on hash + compare so whitespace baked
// in during admin-form copy-paste / autofill doesn't lock the user out later.
managerSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const cleaned = String(this.password ?? "").trim();
  if (!cleaned) throw new Error("Password cannot be empty or whitespace-only");
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(cleaned, salt);

  // One second in the past — see models/Employee.js for why.
  this.passwordChangedAt = new Date(Date.now() - 1000);
});

managerSchema.methods.comparePassword = async function (candidatePassword) {
  const cleaned = String(candidatePassword ?? "").trim();
  if (!cleaned || !this.password) return false;
  return await bcrypt.compare(cleaned, this.password);
};

module.exports = mongoose.model("Manager", managerSchema);
