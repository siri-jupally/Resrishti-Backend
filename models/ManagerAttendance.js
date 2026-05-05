const mongoose = require("mongoose");

const locationSchema = new mongoose.Schema(
    {
        lat: { type: Number },
        lng: { type: Number },
        address: { type: String },
    },
    { _id: false }
);

const managerAttendanceSchema = new mongoose.Schema(
    {
        manager: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Manager",
            required: true,
        },
        date: {
            type: String, // YYYY-MM-DD
            required: true,
        },
        checkIn: {
            time: { type: Date },
            location: locationSchema,
        },
        checkOut: {
            time: { type: Date },
            location: locationSchema,
        },
        // Multiple check-in/out pairs (used when policy.allowMultipleCheckIns is true).
        // Mirrors checkIn/checkOut for the first/last entry so existing reports keep working.
        sessions: [
            {
                checkIn: {
                    time: { type: Date },
                    location: locationSchema,
                },
                checkOut: {
                    time: { type: Date },
                    location: locationSchema,
                },
                _id: false,
            },
        ],
        workMode: {
            type: String,
            enum: ["WFO", "WFH", "remote"],
            default: "WFO",
        },
        workingHours: {
            type: Number,
            default: 0,
        },
        status: {
            type: String,
            enum: ["present", "absent", "half-day", "leave", "holiday", "weekend"],
            default: "present",
        },
        approvalStatus: {
            type: String,
            enum: ["pending", "approved", "rejected", "auto-approved"],
            default: "pending",
        },
        adminRemarks: { type: String },
        wfhTaskSummary: { type: String },
        isLateCheckIn: { type: Boolean, default: false },
        isEarlyCheckOut: { type: Boolean, default: false },
        locationWithinBoundary: { type: Boolean },
    },
    { timestamps: true }
);

managerAttendanceSchema.index({ manager: 1, date: 1 }, { unique: true });
managerAttendanceSchema.index({ date: 1 });
managerAttendanceSchema.index({ manager: 1, status: 1 });

module.exports = mongoose.model("ManagerAttendance", managerAttendanceSchema);
