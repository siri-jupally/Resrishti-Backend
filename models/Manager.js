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
    pushSubscription: { type: Object }, // Store the VAPID subscription object
  },
  { timestamps: true }
);

managerSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

managerSchema.methods.comparePassword = async function (candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model("Manager", managerSchema);
