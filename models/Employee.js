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
    pushSubscription: { type: Object }, // Store the VAPID subscription object
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
