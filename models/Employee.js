/*
  Employee model

  Purpose:
  - Defines the Employee user schema used by managers to assign tasks.
  - Fields include name, email, password and a reference to the manager (_manager_).

  Key behavior:
  - Passwords are hashed with bcrypt before save.
  - Provides comparePassword for credential checks.

  Usage:
  - Imported by controllers and middleware to authenticate employees and to link tasks.

  Security/notes:
  - Do not expose the password field in responses (controllers use .select('-password')).
*/
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const employeeSchema = new mongoose.Schema(
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
    // When the password was last set. Read by middleware/authEmployee to reject
    // JWTs minted BEFORE this moment, which is what makes a password reset log
    // the employee out everywhere instead of leaving old sessions alive for the
    // remainder of their 30-day token life. Stamped by the pre-save hook below.
    passwordChangedAt: { type: Date },
    manager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Manager",
      required: true,
    },
    pushSubscription: { type: Object },
    homeLocation: {
      lat: { type: Number },
      lng: { type: Number },
    },
    defaultWorkMode: {
      type: String,
      enum: ["WFO", "WFH", "remote"],
      default: "WFO",
    },
    // Admin-assigned job role from the fixed JobRole list. Decides which
    // attendance modes this employee may use — see utils/workModePermissions.js.
    jobRoleId: { type: mongoose.Schema.Types.ObjectId, ref: "JobRole" },
    // Individual exception to the role. Empty / unset = follow the role.
    workModesOverride: {
      type: [{ type: String, enum: ["WFO", "WFH", "remote"] }],
      default: undefined,
    },

    // Profile fields
    isFirstLogin: { type: Boolean, default: true },
    isProfileComplete: { type: Boolean, default: false },
    profilePhoto: { type: String }, // S3 key or URL
    dateOfBirth: { type: String },
    gender: { type: String, enum: ["male", "female", "other", ""] },
    phone: { type: String },
    personalEmail: { type: String },
    emergencyContactName: { type: String },
    emergencyContactPhone: { type: String },
    currentAddress: { type: String },
    idProofType: { type: String, enum: ["aadhaar", "pan", "passport", ""] },
    idProofNumber: { type: String },
    idProofDocument: { type: String }, // S3 key or URL

    // Job fields (set by manager at creation, read-only for employee)
    jobRole: { type: String },
    department: { type: String },
    joiningDate: { type: String },

    // Client-Management module — job tags (not roles).
    // canSupervise: can be assigned as the on-site supervisor for a pickup.
    // canCoordinate: can triage incoming client pickup requests (typically Admin/Manager only).
    canSupervise: { type: Boolean, default: false },
    canCoordinate: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Always trim the password before hashing and comparing. Without this, a single
// stray trailing space / newline (introduced by copy-paste in the admin form,
// autofill, or mobile autocorrect) gets baked into the hash and the user is
// then locked out when they type the "clean" version. Symmetric trim on both
// hash and compare keeps the comparison stable regardless of where the value
// originated.
employeeSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const cleaned = String(this.password ?? "").trim();
  if (!cleaned) throw new Error("Password cannot be empty or whitespace-only");
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(cleaned, salt);

  // Stamped one second in the PAST on purpose. A JWT's `iat` has whole-second
  // precision, so a token minted in the same second as this save would compare
  // as "issued before the password changed" and be rejected the instant it was
  // handed out. Same reasoning as the Client model.
  this.passwordChangedAt = new Date(Date.now() - 1000);
});

employeeSchema.methods.comparePassword = async function (candidatePassword) {
  const cleaned = String(candidatePassword ?? "").trim();
  if (!cleaned || !this.password) return false;
  return await bcrypt.compare(cleaned, this.password);
};

module.exports = mongoose.model("Employee", employeeSchema);
