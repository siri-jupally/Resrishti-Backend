/*
  CorrectionRequest model

  Purpose:
  - Stores employee requests to correct attendance records.
  - Links to original Attendance record and tracks review status.
*/
const mongoose = require("mongoose");

const correctionRequestSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
        },
        attendance: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Attendance",
            required: true,
        },
        date: { type: String, required: true }, // YYYY-MM-DD
        requestedCheckIn: { type: Date },
        requestedCheckOut: { type: Date },
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

correctionRequestSchema.index({ employee: 1, status: 1 });
correctionRequestSchema.index({ status: 1 });

module.exports = mongoose.model("CorrectionRequest", correctionRequestSchema);
