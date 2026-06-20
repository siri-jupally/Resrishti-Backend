#!/usr/bin/env node
/*
  Recalculates attendance.status for every Attendance + ManagerAttendance record
  using the corrected threshold (policy.halfDayThresholdHours, default 4).

  Pre-fix bug: the checkOut handler used `policy.workingHoursPerDay / 2`. If
  the admin set workingHoursPerDay = 24, the threshold became 12 and any day
  shorter than 12 hours got flagged as half-day. This script flips them back.

  Safe to run multiple times. Skips records with status in {leave, holiday,
  weekend} (those aren't derived from working hours).
*/
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
    await mongoose.connect(process.env.MONGO_URI);
    const Attendance = require("../models/Attendance");
    const ManagerAttendance = require("../models/ManagerAttendance");
    const AttendancePolicy = require("../models/AttendancePolicy");

    const policy = await AttendancePolicy.findOne();
    const threshold = policy?.halfDayThresholdHours || 4;
    console.log(`Using threshold: ${threshold} hours`);

    const recompute = async (Model, label) => {
        const cursor = Model.find({ status: { $in: ["present", "half-day"] } }).cursor();
        let updated = 0;
        for await (const rec of cursor) {
            const hours = Number(rec.workingHours || 0);
            const desired = hours < threshold ? "half-day" : "present";
            if (rec.status !== desired) {
                rec.status = desired;
                await rec.save();
                updated += 1;
            }
        }
        console.log(`${label}: updated ${updated} record(s)`);
    };

    await recompute(Attendance, "Attendance");
    await recompute(ManagerAttendance, "ManagerAttendance");

    await mongoose.disconnect();
    console.log("Done.");
})().catch((err) => {
    console.error("Recompute failed:", err);
    process.exit(1);
});
