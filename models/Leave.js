/*
  Leave model

  Purpose:
  - Stores employee leave requests with type, date range, and approval status.
  - Integrates with Attendance to mark leave days automatically upon approval.
*/
const mongoose = require("mongoose");

const leaveSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
        },
        type: {
            type: String,
            enum: ["casual", "sick", "earned", "unpaid"],
            required: true,
        },
        startDate: { type: String, required: true }, // YYYY-MM-DD
        endDate: { type: String, required: true },   // YYYY-MM-DD
        reason: { type: String, required: true },
        status: {
            type: String,
            enum: ["pending", "approved", "rejected"],
            default: "pending",
        },
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Manager",
        },
        reviewRemarks: { type: String },
    },
    { timestamps: true }
);

leaveSchema.index({ employee: 1, status: 1 });
leaveSchema.index({ employee: 1, startDate: 1 });
leaveSchema.index({ status: 1 });

module.exports = mongoose.model("Leave", leaveSchema);
