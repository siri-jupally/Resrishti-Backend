/*
  Attendance Controller (Employee-facing)

  Purpose:
  - Handles employee attendance operations:
    - checkIn: POST /api/employee/attendance/checkin
    - checkOut: POST /api/employee/attendance/checkout
    - getToday: GET /api/employee/attendance/today
    - getCalendar: GET /api/employee/attendance/calendar
    - submitCorrection: POST /api/employee/attendance/correction
    - getCorrections: GET /api/employee/attendance/corrections
    - getLeaves: GET /api/employee/leaves
    - applyLeave: POST /api/employee/leaves

  Notes:
  - Geo-boundary validation uses Haversine formula.
  - Working hours are auto-calculated on checkout.
*/
const Attendance = require("../models/Attendance");
const AttendancePolicy = require("../models/AttendancePolicy");
const CorrectionRequest = require("../models/CorrectionRequest");
const Leave = require("../models/Leave");
const Manager = require("../models/Manager");
const { sendPush } = require("../utils/push");

// Haversine distance in meters between two lat/lng points
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000; // Earth's radius in meters
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Get today's date as YYYY-MM-DD string
function getTodayStr() {
    const now = new Date();
    return now.toISOString().split("T")[0];
}

// Parse HH:MM time string to { hours, minutes }
function parseTime(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    return { hours: h, minutes: m };
}

// POST /api/employee/attendance/checkin
const checkIn = async (req, res) => {
    try {
        const { lat, lng, address, workMode, wfhTaskSummary } = req.body;
        const employeeId = req.employee._id;
        const today = getTodayStr();

        // Check if already checked in today
        const existing = await Attendance.findOne({ employee: employeeId, date: today });
        if (existing && existing.checkIn && existing.checkIn.time) {
            return res.status(400).json({ message: "Already checked in today" });
        }

        // Fetch policy for boundary validation
        const policy = await AttendancePolicy.findOne();
        let locationWithinBoundary = null;
        let isLateCheckIn = false;

        if (lat !== undefined && lng !== undefined) {
            // Check against office locations (for WFO) or home location (for WFH)
            const effectiveWorkMode = workMode || req.employee.defaultWorkMode || "WFO";

            if (effectiveWorkMode === "WFO" && policy && policy.officeLocations.length > 0) {
                locationWithinBoundary = policy.officeLocations.some((loc) => {
                    const dist = haversineDistance(lat, lng, loc.lat, loc.lng);
                    return dist <= loc.radiusMeters;
                });
            } else if (effectiveWorkMode === "WFH" && req.employee.homeLocation) {
                const homeLat = req.employee.homeLocation.lat;
                const homeLng = req.employee.homeLocation.lng;
                if (homeLat && homeLng) {
                    const dist = haversineDistance(lat, lng, homeLat, homeLng);
                    locationWithinBoundary = dist <= 500; // 500m radius for home
                }
            } else if (effectiveWorkMode === "remote") {
                locationWithinBoundary = true; // Remote always accepted
            }
        }

        // Check for late check-in
        if (policy && policy.checkInStartTime) {
            const now = new Date();
            const { hours, minutes } = parseTime(policy.checkInStartTime);
            const threshold = new Date(now);
            threshold.setHours(hours, minutes + (policy.lateThresholdMinutes || 15), 0, 0);
            if (now > threshold) {
                isLateCheckIn = true;
            }
        }

        const effectiveWorkMode = workMode || req.employee.defaultWorkMode || "WFO";

        if (existing) {
            // Record exists (maybe created by leave system) — update it
            existing.checkIn = {
                time: new Date(),
                location: lat !== undefined ? { lat, lng, address } : undefined,
            };
            existing.workMode = effectiveWorkMode;
            existing.status = "present";
            existing.approvalStatus = locationWithinBoundary === false ? "pending" : "auto-approved";
            existing.isLateCheckIn = isLateCheckIn;
            existing.locationWithinBoundary = locationWithinBoundary;
            if (wfhTaskSummary) existing.wfhTaskSummary = wfhTaskSummary;
            await existing.save();
            return res.status(200).json(existing);
        }

        const attendance = await Attendance.create({
            employee: employeeId,
            date: today,
            checkIn: {
                time: new Date(),
                location: lat !== undefined ? { lat, lng, address } : undefined,
            },
            workMode: effectiveWorkMode,
            status: "present",
            approvalStatus: locationWithinBoundary === false ? "pending" : "auto-approved",
            isLateCheckIn,
            locationWithinBoundary,
            wfhTaskSummary: wfhTaskSummary || undefined,
        });

        // Notify manager if out of boundary
        if (locationWithinBoundary === false) {
            try {
                const manager = await Manager.findById(req.employee.manager).select("pushSubscription");
                if (manager && manager.pushSubscription) {
                    await sendPush(manager.pushSubscription, {
                        title: "⚠️ Out-of-Boundary Check-in",
                        body: `${req.employee.name} checked in from outside the designated area`,
                        icon: "/android-chrome-512x512.png",
                        data: { url: "/manager/dashboard?tab=attendance" },
                    });
                }
            } catch (pushErr) {
                console.error("Push error (attendance):", pushErr);
            }
        }

        res.status(201).json(attendance);
    } catch (err) {
        console.error("CheckIn error:", err);
        res.status(500).json({ message: err.message });
    }
};

// POST /api/employee/attendance/checkout
const checkOut = async (req, res) => {
    try {
        const { lat, lng, address, wfhTaskSummary } = req.body;
        const employeeId = req.employee._id;
        const today = getTodayStr();

        const attendance = await Attendance.findOne({ employee: employeeId, date: today });
        if (!attendance || !attendance.checkIn || !attendance.checkIn.time) {
            return res.status(400).json({ message: "No check-in found for today" });
        }
        if (attendance.checkOut && attendance.checkOut.time) {
            return res.status(400).json({ message: "Already checked out today" });
        }

        const now = new Date();
        attendance.checkOut = {
            time: now,
            location: lat !== undefined ? { lat, lng, address } : undefined,
        };

        // Calculate working hours
        const checkInTime = new Date(attendance.checkIn.time);
        const diffMs = now - checkInTime;
        attendance.workingHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;

        // Check for early checkout
        const policy = await AttendancePolicy.findOne();
        if (policy && policy.checkOutMinTime) {
            const { hours, minutes } = parseTime(policy.checkOutMinTime);
            const minCheckout = new Date(now);
            minCheckout.setHours(hours, minutes, 0, 0);
            if (now < minCheckout) {
                attendance.isEarlyCheckOut = true;
            }
        }

        // Determine half-day status
        if (policy && attendance.workingHours < policy.workingHoursPerDay / 2) {
            attendance.status = "half-day";
        }

        if (wfhTaskSummary) {
            attendance.wfhTaskSummary = wfhTaskSummary;
        }

        await attendance.save();
        res.json(attendance);
    } catch (err) {
        console.error("CheckOut error:", err);
        res.status(500).json({ message: err.message });
    }
};

// GET /api/employee/attendance/today
const getToday = async (req, res) => {
    try {
        const today = getTodayStr();
        const attendance = await Attendance.findOne({
            employee: req.employee._id,
            date: today,
        });
        res.json(attendance || { date: today, status: null });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/employee/attendance/calendar?month=3&year=2026
const getCalendar = async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        const endMonth = month === 12 ? 1 : month + 1;
        const endYear = month === 12 ? year + 1 : year;
        const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

        const records = await Attendance.find({
            employee: req.employee._id,
            date: { $gte: startDate, $lt: endDate },
        }).sort({ date: 1 });

        // Also fetch holidays for this month
        const policy = await AttendancePolicy.findOne();
        const holidays = policy
            ? policy.holidays.filter((h) => h.date >= startDate && h.date < endDate)
            : [];

        // Fetch leaves for this month
        const leaves = await Leave.find({
            employee: req.employee._id,
            status: "approved",
            startDate: { $lte: endDate },
            endDate: { $gte: startDate },
        });

        res.json({ records, holidays, leaves });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/employee/attendance/correction
const submitCorrection = async (req, res) => {
    try {
        const { attendanceId, requestedCheckIn, requestedCheckOut, reason } = req.body;
        if (!attendanceId || !reason) {
            return res.status(400).json({ message: "attendanceId and reason are required" });
        }

        const attendance = await Attendance.findById(attendanceId);
        if (!attendance) {
            return res.status(404).json({ message: "Attendance record not found" });
        }
        if (String(attendance.employee) !== String(req.employee._id)) {
            return res.status(403).json({ message: "Not authorized" });
        }

        const correction = await CorrectionRequest.create({
            employee: req.employee._id,
            attendance: attendanceId,
            date: attendance.date,
            requestedCheckIn: requestedCheckIn ? new Date(requestedCheckIn) : undefined,
            requestedCheckOut: requestedCheckOut ? new Date(requestedCheckOut) : undefined,
            reason,
        });

        // Notify manager
        try {
            const manager = await Manager.findById(req.employee.manager).select("pushSubscription");
            if (manager && manager.pushSubscription) {
                await sendPush(manager.pushSubscription, {
                    title: "Attendance Correction Request",
                    body: `${req.employee.name} submitted a correction for ${attendance.date}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/manager/dashboard?tab=attendance&sub=corrections" },
                });
            }
        } catch (pushErr) {
            console.error("Push error:", pushErr);
        }

        res.status(201).json(correction);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/employee/attendance/corrections
const getCorrections = async (req, res) => {
    try {
        const corrections = await CorrectionRequest.find({
            employee: req.employee._id,
        })
            .populate("attendance")
            .sort({ createdAt: -1 });
        res.json(corrections);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/employee/leaves
const getLeaves = async (req, res) => {
    try {
        const leaves = await Leave.find({ employee: req.employee._id }).sort({ createdAt: -1 });

        // Calculate balances (simple: 12 casual, 12 sick, 15 earned per year)
        const year = new Date().getFullYear();
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year + 1}-01-01`;

        const approvedLeaves = await Leave.find({
            employee: req.employee._id,
            status: "approved",
            startDate: { $gte: yearStart, $lt: yearEnd },
        });

        const used = { casual: 0, sick: 0, earned: 0, unpaid: 0 };
        approvedLeaves.forEach((l) => {
            const start = new Date(l.startDate);
            const end = new Date(l.endDate);
            const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
            used[l.type] = (used[l.type] || 0) + days;
        });

        const balances = {
            casual: { total: 12, used: used.casual, remaining: 12 - used.casual },
            sick: { total: 12, used: used.sick, remaining: 12 - used.sick },
            earned: { total: 15, used: used.earned, remaining: 15 - used.earned },
            unpaid: { total: Infinity, used: used.unpaid, remaining: Infinity },
        };

        res.json({ leaves, balances });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/employee/leaves
const applyLeave = async (req, res) => {
    try {
        const { type, startDate, endDate, reason } = req.body;
        if (!type || !startDate || !endDate || !reason) {
            return res.status(400).json({ message: "type, startDate, endDate, and reason are required" });
        }

        const leave = await Leave.create({
            employee: req.employee._id,
            type,
            startDate,
            endDate,
            reason,
        });

        // Notify manager
        try {
            const manager = await Manager.findById(req.employee.manager).select("pushSubscription");
            if (manager && manager.pushSubscription) {
                await sendPush(manager.pushSubscription, {
                    title: "Leave Request",
                    body: `${req.employee.name} applied for ${type} leave (${startDate} to ${endDate})`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/manager/dashboard?tab=attendance&sub=leaves" },
                });
            }
        } catch (pushErr) {
            console.error("Push error:", pushErr);
        }

        res.status(201).json(leave);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/employee/attendance/policy
const getPolicy = async (req, res) => {
    try {
        const policy = await AttendancePolicy.findOne();
        res.json(policy || {});
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = {
    checkIn,
    checkOut,
    getToday,
    getCalendar,
    submitCorrection,
    getCorrections,
    getLeaves,
    applyLeave,
    getPolicy,
};
