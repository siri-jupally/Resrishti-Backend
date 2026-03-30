/*
  Manager Self-Attendance Controller

  Mirrors the employee attendance controller exactly, but for managers.
  Admin takes the role that Manager plays for employees.

  Routes (mounted at /api/manager/self-attendance):
    - checkIn:          POST /checkin
    - checkOut:         POST /checkout
    - getToday:         GET  /today
    - getCalendar:      GET  /calendar
    - submitCorrection: POST /correction
    - getCorrections:   GET  /corrections
    - getLeaves:        GET  /leaves
    - applyLeave:       POST /leaves
    - getPolicy:        GET  /policy
*/
const ManagerAttendance = require("../models/ManagerAttendance");
const ManagerLeave = require("../models/ManagerLeave");
const ManagerCorrectionRequest = require("../models/ManagerCorrectionRequest");
const AttendancePolicy = require("../models/AttendancePolicy");
const Admin = require("../models/Admin");
const { sendPush } = require("../utils/push");

// Haversine distance in meters
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getTodayStr() {
    return new Date().toISOString().split("T")[0];
}

function parseTime(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    return { hours: h, minutes: m };
}

// Notify all admins via push
async function notifyAdmins(payload) {
    try {
        const admins = await Admin.find().select("pushSubscription");
        for (const admin of admins) {
            if (admin.pushSubscription) {
                await sendPush(admin.pushSubscription, payload);
            }
        }
    } catch (err) {
        console.error("Admin push error:", err);
    }
}

// POST /api/manager/self-attendance/checkin
const checkIn = async (req, res) => {
    try {
        const { lat, lng, address, workMode, wfhTaskSummary } = req.body;
        const managerId = req.manager._id;
        const today = getTodayStr();

        const existing = await ManagerAttendance.findOne({ manager: managerId, date: today });
        if (existing && existing.checkIn && existing.checkIn.time) {
            return res.status(400).json({ message: "Already checked in today" });
        }

        const policy = await AttendancePolicy.findOne();
        let locationWithinBoundary = null;
        let isLateCheckIn = false;

        if (lat !== undefined && lng !== undefined) {
            const effectiveWorkMode = workMode || "WFO";

            if (effectiveWorkMode === "WFO" && policy && policy.officeLocations.length > 0) {
                locationWithinBoundary = policy.officeLocations.some((loc) => {
                    const dist = haversineDistance(lat, lng, loc.lat, loc.lng);
                    return dist <= loc.radiusMeters;
                });
            } else if (effectiveWorkMode === "remote") {
                locationWithinBoundary = true;
            } else {
                // WFH - no home location on manager model, accept it
                locationWithinBoundary = true;
            }
        }

        if (policy && policy.checkInStartTime) {
            const now = new Date();
            const { hours, minutes } = parseTime(policy.checkInStartTime);
            const threshold = new Date(now);
            threshold.setHours(hours, minutes + (policy.lateThresholdMinutes || 15), 0, 0);
            if (now > threshold) {
                isLateCheckIn = true;
            }
        }

        const effectiveWorkMode = workMode || "WFO";

        if (existing) {
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

        const attendance = await ManagerAttendance.create({
            manager: managerId,
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

        if (locationWithinBoundary === false) {
            await notifyAdmins({
                title: "Out-of-Boundary Check-in (Manager)",
                body: `${req.manager.name} checked in from outside the designated area`,
                icon: "/android-chrome-512x512.png",
                data: { url: "/admin/dashboard?tab=managerAttendance" },
            });
        }

        res.status(201).json(attendance);
    } catch (err) {
        console.error("Manager CheckIn error:", err);
        res.status(500).json({ message: err.message });
    }
};

// POST /api/manager/self-attendance/checkout
const checkOut = async (req, res) => {
    try {
        const { lat, lng, address, wfhTaskSummary } = req.body;
        const managerId = req.manager._id;
        const today = getTodayStr();

        const attendance = await ManagerAttendance.findOne({ manager: managerId, date: today });
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

        const checkInTime = new Date(attendance.checkIn.time);
        const diffMs = now - checkInTime;
        attendance.workingHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;

        const policy = await AttendancePolicy.findOne();
        if (policy && policy.checkOutMinTime) {
            const { hours, minutes } = parseTime(policy.checkOutMinTime);
            const minCheckout = new Date(now);
            minCheckout.setHours(hours, minutes, 0, 0);
            if (now < minCheckout) {
                attendance.isEarlyCheckOut = true;
            }
        }

        if (policy && attendance.workingHours < policy.workingHoursPerDay / 2) {
            attendance.status = "half-day";
        }

        if (wfhTaskSummary) {
            attendance.wfhTaskSummary = wfhTaskSummary;
        }

        await attendance.save();
        res.json(attendance);
    } catch (err) {
        console.error("Manager CheckOut error:", err);
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/self-attendance/today
const getToday = async (req, res) => {
    try {
        const today = getTodayStr();
        const attendance = await ManagerAttendance.findOne({
            manager: req.manager._id,
            date: today,
        });
        res.json(attendance || { date: today, status: null });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/self-attendance/calendar?month=3&year=2026
const getCalendar = async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        const endMonth = month === 12 ? 1 : month + 1;
        const endYear = month === 12 ? year + 1 : year;
        const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

        const records = await ManagerAttendance.find({
            manager: req.manager._id,
            date: { $gte: startDate, $lt: endDate },
        }).sort({ date: 1 });

        const policy = await AttendancePolicy.findOne();
        const holidays = policy
            ? policy.holidays.filter((h) => h.date >= startDate && h.date < endDate)
            : [];

        const leaves = await ManagerLeave.find({
            manager: req.manager._id,
            status: "approved",
            startDate: { $lte: endDate },
            endDate: { $gte: startDate },
        });

        res.json({ records, holidays, leaves });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/manager/self-attendance/correction
const submitCorrection = async (req, res) => {
    try {
        const { attendanceId, requestedCheckIn, requestedCheckOut, reason } = req.body;
        if (!attendanceId || !reason) {
            return res.status(400).json({ message: "attendanceId and reason are required" });
        }

        const attendance = await ManagerAttendance.findById(attendanceId);
        if (!attendance) {
            return res.status(404).json({ message: "Attendance record not found" });
        }
        if (String(attendance.manager) !== String(req.manager._id)) {
            return res.status(403).json({ message: "Not authorized" });
        }

        // Convert HH:MM time strings to full Date objects using the attendance date
        let parsedCheckIn, parsedCheckOut;
        if (requestedCheckIn && requestedCheckIn.includes(":")) {
            const [h, m] = requestedCheckIn.split(":").map(Number);
            const d = new Date(attendance.date + "T00:00:00");
            d.setHours(h, m, 0, 0);
            parsedCheckIn = d;
        }
        if (requestedCheckOut && requestedCheckOut.includes(":")) {
            const [h, m] = requestedCheckOut.split(":").map(Number);
            const d = new Date(attendance.date + "T00:00:00");
            d.setHours(h, m, 0, 0);
            parsedCheckOut = d;
        }

        const correction = await ManagerCorrectionRequest.create({
            manager: req.manager._id,
            attendance: attendanceId,
            date: attendance.date,
            requestedCheckIn: parsedCheckIn || undefined,
            requestedCheckOut: parsedCheckOut || undefined,
            reason,
        });

        await notifyAdmins({
            title: "Attendance Correction Request (Manager)",
            body: `${req.manager.name} submitted a correction for ${attendance.date}`,
            icon: "/android-chrome-512x512.png",
            data: { url: "/admin/dashboard?tab=managerAttendance" },
        });

        res.status(201).json(correction);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/self-attendance/corrections
const getCorrections = async (req, res) => {
    try {
        const corrections = await ManagerCorrectionRequest.find({
            manager: req.manager._id,
        })
            .populate("attendance")
            .sort({ createdAt: -1 });
        res.json(corrections);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/self-attendance/leaves
const getLeaves = async (req, res) => {
    try {
        const leaves = await ManagerLeave.find({ manager: req.manager._id }).sort({ createdAt: -1 });

        const year = new Date().getFullYear();
        const yearStart = `${year}-01-01`;
        const yearEnd = `${year + 1}-01-01`;

        const approvedLeaves = await ManagerLeave.find({
            manager: req.manager._id,
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

// POST /api/manager/self-attendance/leaves
const applyLeave = async (req, res) => {
    try {
        const { type, startDate, endDate, reason } = req.body;
        if (!type || !startDate || !endDate || !reason) {
            return res.status(400).json({ message: "type, startDate, endDate, and reason are required" });
        }

        const leave = await ManagerLeave.create({
            manager: req.manager._id,
            type,
            startDate,
            endDate,
            reason,
        });

        await notifyAdmins({
            title: "Manager Leave Request",
            body: `${req.manager.name} applied for ${type} leave (${startDate} to ${endDate})`,
            icon: "/android-chrome-512x512.png",
            data: { url: "/admin/dashboard?tab=managerAttendance" },
        });

        res.status(201).json(leave);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/self-attendance/policy
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
