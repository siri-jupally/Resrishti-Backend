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
  },
  { timestamps: true }
);

employeeSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

employeeSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("Employee", employeeSchema);
