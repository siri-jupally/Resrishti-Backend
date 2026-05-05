/*
  Attendance model

  Purpose:
  - Stores daily attendance records per employee.
  - Tracks check-in/out timestamps, location, work mode, and working hours.
  - Supports approval workflow for managers.

  Key behavior:
  - Compound unique index on { employee, date } ensures one record per employee per day.
  - workingHours is auto-calculated when check-out occurs.
*/
const mongoose = require("mongoose");

const locationSchema = new mongoose.Schema(
    {
        lat: { type: Number },
        lng: { type: Number },
        address: { type: String },
    },
    { _id: false }
);

const attendanceSchema = new mongoose.Schema(
    {
        employee: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
        },
        date: {
            type: String, // YYYY-MM-DD format for easy querying
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
            type: Number, // in decimal hours e.g. 8.5
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
        managerRemarks: { type: String },
        wfhTaskSummary: { type: String },
        isLateCheckIn: { type: Boolean, default: false },
        isEarlyCheckOut: { type: Boolean, default: false },
        locationWithinBoundary: { type: Boolean },
    },
    { timestamps: true }
);

// One attendance record per employee per date
attendanceSchema.index({ employee: 1, date: 1 }, { unique: true });
attendanceSchema.index({ date: 1 });
attendanceSchema.index({ employee: 1, status: 1 });

module.exports = mongoose.model("Attendance", attendanceSchema);
