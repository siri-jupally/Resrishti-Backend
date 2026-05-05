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

const attendancePolicySchema = new mongoose.Schema(
    {
        officeLocations: [officeLocationSchema],
        holidays: [holidaySchema],
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
