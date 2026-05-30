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

    // Job fields (set by admin at creation, read-only for manager)
    jobRole: { type: String },
    department: { type: String },
    joiningDate: { type: String },
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
});

managerSchema.methods.comparePassword = async function (candidatePassword) {
  const cleaned = String(candidatePassword ?? "").trim();
  if (!cleaned || !this.password) return false;
  return await bcrypt.compare(cleaned, this.password);
};

module.exports = mongoose.model("Manager", managerSchema);
