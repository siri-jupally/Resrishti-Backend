/*
  AttendancePolicy model

  Purpose:
  - Stores organization-wide attendance configuration.
  - Includes office locations with geo-boundaries, holidays, and attendance rules.
  - Only one document exists per organization (singleton pattern).
*/
const mongoose = require("mongoose");

const officeLocationSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        lat: { type: Number, required: true },
        lng: { type: Number, required: true },
        radiusMeters: { type: Number, default: 200 },
    },
    { _id: true }
);

const holidaySchema = new mongoose.Schema(
    {
        date: { type: String, required: true }, // YYYY-MM-DD
        name: { type: String, required: true },
        type: {
            type: String,
            enum: ["public", "company"],
            default: "public",
        },
    },
    { _id: true }
);

// Per-date override of the normal weekly pattern. "off" forces a normally-working
// day to be a week-off; "working" forces a normally-off day (e.g. a Saturday) to count
// as a working day. Lets the org handle irregular/alternating weekends.
const weekendExceptionSchema = new mongoose.Schema(
    {
        date: { type: String, required: true }, // YYYY-MM-DD
        type: {
            type: String,
            enum: ["working", "off"],
            required: true,
        },
        note: { type: String },
    },
    { _id: true }
);

const attendancePolicySchema = new mongoose.Schema(
    {
        officeLocations: [officeLocationSchema],
        holidays: [holidaySchema],
        // Weekly-off days using JS getDay() numbering: 0 = Sunday ... 6 = Saturday.
        // These days are treated as non-working (like holidays) for attendance
        // calculation; the remaining days are working days. Default: Sat & Sun off.
        weeklyOffDays: { type: [Number], default: [0, 6] },
        // Per-date overrides of the weekly pattern (irregular / alternating weekends).
        weekendExceptions: [weekendExceptionSchema],
        workingHoursPerDay: { type: Number, default: 8 },
        graceMinutes: { type: Number, default: 15 },
        halfDayThresholdHours: { type: Number, default: 4 },
        lateThresholdMinutes: { type: Number, default: 15 },
        checkInStartTime: { type: String, default: "09:00" },
        checkInEndTime: { type: String, default: "11:00" },
        checkOutMinTime: { type: String, default: "17:00" },
        wfhEnabled: { type: Boolean, default: true },
        maxWfhDaysPerMonth: { type: Number, default: 8 },
        allowMultipleCheckIns: { type: Boolean, default: false },
        leaveQuotas: {
            casual: { type: Number, default: 12 },
            sick: { type: Number, default: 12 },
            earned: { type: Number, default: 15 },
            maternity: { type: Number, default: 180 },
            paternity: { type: Number, default: 15 },
            unpaid: { type: Number, default: 365 },
        },
    },
    { timestamps: true }
);

module.exports = mongoose.model("AttendancePolicy", attendancePolicySchema);
