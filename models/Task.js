/*
  Task model

  Purpose:
  - Stores tasks assigned by Managers to Employees.
  - Supports a threaded conversation (`messages[]`) where both manager and employee
    can post text and optional file references.

  Schema changes (2026-01):
  - Replaced `comments[]` with `messages[]`.
  - Added `taskID` (stable human-friendly identifier), and `deadline`.
  - Messages can optionally reference an uploaded file (stored in S3 under a task prefix).

  Notes:
  - `employeeEdited` is kept to preserve the existing “employee updates” concept.
*/
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    text: { type: String },
    by: { type: String, enum: ["manager", "employee"], required: true },
    time: { type: Date, default: Date.now },

    // Optional attachment metadata (actual bytes live in S3)
    fileName: { type: String },
    s3Key: { type: String },
    s3Bucket: { type: String },
  },
  { _id: false }
);

const taskSchema = new mongoose.Schema(
  {
    // App-level task identifier. Stored as string so you can use formats like TASK-000123.
    taskID: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true },
    description: { type: String },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    status: {
      type: String,
      enum: ["open", "in-progress", "completed"],
      default: "open",
    },
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
      required: true,
    },
    manager: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Manager",
      required: true,
    },
    deadline: { type: Date },

    // Thread of messages between manager and employee
    messages: [messageSchema],
    employeeEdited: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Ensure we can efficiently query/filter by manager/employee/status/priority/deadline.
taskSchema.index({ manager: 1, createdAt: -1 });
taskSchema.index({ employee: 1, createdAt: -1 });
taskSchema.index({ manager: 1, status: 1, priority: 1 });
taskSchema.index({ employee: 1, status: 1, priority: 1 });
taskSchema.index({ deadline: 1 });

module.exports = mongoose.model("Task", taskSchema);
