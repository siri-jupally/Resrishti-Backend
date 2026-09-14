/*
  WorkModeRequest model

  Purpose:
  - An employee's request to work WFH or remote on a given date range.
  - Must be approved BEFORE the employee can check in with that work mode, when
    the policy requires approval (requireApprovalForWfh / requireApprovalForRemote).

  Why this exists:
  - `wfhEnabled` and `maxWfhDaysPerMonth` were stored on AttendancePolicy but
    never enforced, so anyone could mark themselves WFH or remote every day.
    Approving up front means the attendance record is never created without
    a supervisor having agreed to it first.

  Shape deliberately mirrors models/Leave.js — same status enum, same
  manager-reviews / admin-overrides fields — so the review UI and controller
  logic stay consistent with the leave flow staff already know.
*/
const mongoose = require("mongoose");

const workModeRequestSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
        },
        // "WFO" is intentionally absent — working from the office is the default
        // and never needs requesting.
        workMode: {
            type: String,
            enum: ["WFH", "remote"],
            required: true,
        },
        startDate: { type: String, required: true }, // YYYY-MM-DD
        endDate: { type: String, required: true },   // YYYY-MM-DD
        reason: { type: String, required: true },
        status: {
            type: String,
            enum: ["pending", "approved", "rejected", "cancelled"],
            default: "pending",
        },
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Manager",
        },
        reviewedAt: { type: Date },
        reviewRemarks: { type: String },
        adminOverride: { type: Boolean, default: false },
        adminReviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
        },
        adminRemarks: { type: String },
    },
    { timestamps: true }
);

// The check-in guard asks "is there an approved request covering this date for
// this employee in this mode?" on every remote check-in, so that lookup is the
// one worth indexing.
workModeRequestSchema.index({ employee: 1, status: 1, startDate: 1, endDate: 1 });
workModeRequestSchema.index({ employee: 1, createdAt: -1 });
workModeRequestSchema.index({ status: 1 });

module.exports = mongoose.model("WorkModeRequest", workModeRequestSchema);
