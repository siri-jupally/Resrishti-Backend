const mongoose = require("mongoose");

const managerCorrectionRequestSchema = new mongoose.Schema(
    {
        manager: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Manager",
            required: true,
        },
        // Optional: absent days have no ManagerAttendance record yet, so a correction
        // can be filed against a bare date. The record is created/linked on approval.
        attendance: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "ManagerAttendance",
        },
        date: { type: String, required: true }, // YYYY-MM-DD
        correctionType: {
            type: String,
            enum: ["missing-checkin", "missing-checkout", "absence", "incorrect-data"],
            default: "incorrect-data",
        },
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
            ref: "Admin",
        },
        reviewRemarks: { type: String },
    },
    { timestamps: true }
);

managerCorrectionRequestSchema.index({ manager: 1, status: 1 });
managerCorrectionRequestSchema.index({ status: 1 });

module.exports = mongoose.model("ManagerCorrectionRequest", managerCorrectionRequestSchema);
