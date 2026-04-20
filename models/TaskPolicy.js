/*
  TaskPolicy model

  Purpose:
  - Stores organization-wide task management configuration.
  - Only one document exists per organization (singleton pattern).
  - Controlled by Admin to grant/revoke task permissions for managers.
*/
const mongoose = require("mongoose");

const taskPolicySchema = new mongoose.Schema(
  {
    allowManagerTaskDeletion: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TaskPolicy", taskPolicySchema);
