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
const multer = require("multer");
const { sendPush, notifyIfEnabled } = require("../utils/push");
const { uploadCheckinPhoto } = require("../utils/s3");
const { isWeekOff } = require("../utils/attendanceDays");

// Live camera capture only — see attendanceController for the same pattern.
const checkInUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype)) {
            return cb(new Error("Only image/jpeg, image/png, image/webp allowed"));
        }
        cb(null, true);
    },
}).single("photo");

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

// Notify all admins via push (gated by notification settings)
async function notifyAdmins(type, payload) {
    try {
        const admins = await Admin.find().select("pushSubscription");
        for (const admin of admins) {
            if (admin.pushSubscription) {
                await notifyIfEnabled(type, admin.pushSubscription, payload);
            }
        }
    } catch (err) {
        console.error("Admin push error:", err);
    }
}

// POST /api/manager/self-attendance/checkin
const checkIn = async (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ message: "Check-in photo is required" });
        }
        const { lat, lng, address, workMode, wfhTaskSummary } = req.body;
        const managerId = req.manager._id;
        const today = getTodayStr();

        const policy = await AttendancePolicy.findOne();
        const allowMultiple = policy?.allowMultipleCheckIns === true;
        console.log("[ManagerCheckIn] allowMultiple:", allowMultiple, "policy.allowMultipleCheckIns:", policy?.allowMultipleCheckIns);

        const existing = await ManagerAttendance.findOne({ manager: managerId, date: today });
        if (existing && existing.checkIn && existing.checkIn.time) {
            console.log("[ManagerCheckIn] Existing record found. checkIn:", !!existing.checkIn?.time, "checkOut:", !!existing.checkOut?.time, "sessions:", existing.sessions?.length || 0);
            if (!allowMultiple) {
                console.log("[ManagerCheckIn] Blocking: multiple check-ins not allowed");
                return res.status(400).json({ message: "Already checked in today" });
            }
            const sessionsArr = existing.sessions || [];
            const lastSession = sessionsArr[sessionsArr.length - 1];
            const lastSessionOpen = lastSession && lastSession.checkIn?.time && !lastSession.checkOut?.time;
            // Legacy "open" only applies when no sessions array entries exist yet
            const legacyOpen = sessionsArr.length === 0 && existing.checkIn?.time && !existing.checkOut?.time;
            console.log("[ManagerCheckIn] lastSessionOpen:", lastSessionOpen, "legacyOpen:", legacyOpen);
            if (lastSessionOpen || legacyOpen) {
                return res.status(400).json({ message: "Please check out from your current session first" });
            }
        }
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
        const now = new Date();

        let photo;
        try {
            photo = await uploadCheckinPhoto({
                role: "manager",
                userId: String(managerId),
                buffer: req.file.buffer,
                contentType: req.file.mimetype || "image/jpeg",
            });
        } catch (uploadErr) {
            console.error("Manager check-in photo upload failed:", uploadErr);
            return res.status(500).json({ message: "Failed to store check-in photo" });
        }

        const newCheckIn = {
            time: now,
            location: lat !== undefined ? { lat, lng, address } : undefined,
            photo,
        };

        if (existing) {
            const sessionsArr = existing.sessions || [];
            const lastSessionClosed =
                sessionsArr.length > 0 &&
                !!sessionsArr[sessionsArr.length - 1].checkIn?.time &&
                !!sessionsArr[sessionsArr.length - 1].checkOut?.time;
            const legacyClosed =
                sessionsArr.length === 0 &&
                !!existing.checkIn?.time &&
                !!existing.checkOut?.time;
            const isAdditionalSession = allowMultiple && (legacyClosed || lastSessionClosed);
            console.log("[ManagerCheckIn] isAdditionalSession:", isAdditionalSession, "lastSessionClosed:", lastSessionClosed, "legacyClosed:", legacyClosed);

            if (isAdditionalSession) {
                // Backfill the legacy first-session into the array if it's empty
                if (sessionsArr.length === 0) {
                    const ci = existing.checkIn?.toObject ? existing.checkIn.toObject() : existing.checkIn;
                    const co = existing.checkOut?.toObject ? existing.checkOut.toObject() : existing.checkOut;
                    existing.sessions.push({ checkIn: ci, checkOut: co });
                }
                existing.sessions.push({ checkIn: newCheckIn });
                // NOTE: we intentionally do NOT clear existing.checkOut here.
                // The sessions array is the source of truth for "is the day open".
                // The legacy checkOut field stays as the latest checkout time and gets updated
                // by the next checkOut call.
                existing.workMode = effectiveWorkMode;
                existing.status = "present";
                if (wfhTaskSummary) existing.wfhTaskSummary = wfhTaskSummary;
                await existing.save();
                console.log("[ManagerCheckIn] Saved additional session. Total sessions:", existing.sessions.length);
                return res.status(200).json(existing);
            }

            existing.checkIn = newCheckIn;
            existing.workMode = effectiveWorkMode;
            existing.status = "present";
            existing.approvalStatus = locationWithinBoundary === false ? "pending" : "auto-approved";
            existing.isLateCheckIn = isLateCheckIn;
            existing.isWeekendWork = isWeekOff(today, policy);
            existing.locationWithinBoundary = locationWithinBoundary;
            if (wfhTaskSummary) existing.wfhTaskSummary = wfhTaskSummary;
            await existing.save();
            return res.status(200).json(existing);
        }

        const attendance = await ManagerAttendance.create({
            manager: managerId,
            date: today,
            checkIn: newCheckIn,
            workMode: effectiveWorkMode,
            status: "present",
            approvalStatus: locationWithinBoundary === false ? "pending" : "auto-approved",
            isLateCheckIn,
            isWeekendWork: isWeekOff(today, policy),
            locationWithinBoundary,
            wfhTaskSummary: wfhTaskSummary || undefined,
        });

        if (locationWithinBoundary === false) {
            await notifyAdmins("attendance", {
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

        // Find the most recent open session
        const lastSession = attendance.sessions?.[attendance.sessions.length - 1];
        const lastSessionOpen = lastSession && lastSession.checkIn?.time && !lastSession.checkOut?.time;
        const legacyOpen = attendance.checkIn?.time && !attendance.checkOut?.time && (!attendance.sessions || attendance.sessions.length === 0);

        if (!lastSessionOpen && !legacyOpen) {
            return res.status(400).json({ message: "No active session to check out from" });
        }

        const now = new Date();
        const checkOutPayload = {
            time: now,
            location: lat !== undefined ? { lat, lng, address } : undefined,
        };

        if (lastSessionOpen) {
            attendance.sessions[attendance.sessions.length - 1].checkOut = checkOutPayload;
        }
        attendance.checkOut = checkOutPayload;

        // Recalculate total working hours: sum of all completed sessions, or fall back to legacy single span
        let totalMs = 0;
        if (attendance.sessions && attendance.sessions.length > 0) {
            for (const s of attendance.sessions) {
                if (s.checkIn?.time && s.checkOut?.time) {
                    totalMs += new Date(s.checkOut.time) - new Date(s.checkIn.time);
                }
            }
        } else {
            totalMs = now - new Date(attendance.checkIn.time);
        }
        attendance.workingHours = Math.round((totalMs / (1000 * 60 * 60)) * 100) / 100;

        const policy = await AttendancePolicy.findOne();
        if (policy && policy.checkOutMinTime) {
            const { hours, minutes } = parseTime(policy.checkOutMinTime);
            const minCheckout = new Date(now);
            minCheckout.setHours(hours, minutes, 0, 0);
            if (now < minCheckout) {
                attendance.isEarlyCheckOut = true;
            }
        }

        // Use the explicit halfDayThresholdHours, not workingHoursPerDay / 2 —
        // see employee attendanceController.js for the bug history. Flip back
        // to "present" when above threshold so corrections clear stale half-days.
        if (policy && attendance.status !== "leave" && attendance.status !== "holiday" && attendance.status !== "weekend") {
            const threshold = policy.halfDayThresholdHours || 4;
            attendance.status = attendance.workingHours < threshold ? "half-day" : "present";
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

        res.json({ records, holidays, leaves, weeklyOffDays: policy?.weeklyOffDays || [0, 6], weekendExceptions: policy?.weekendExceptions || [] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/manager/self-attendance/correction
const submitCorrection = async (req, res) => {
    try {
        const { attendanceId, date, correctionType, requestedCheckIn, requestedCheckOut, reason } = req.body;
        if (!reason) {
            return res.status(400).json({ message: "reason is required" });
        }

        // Resolve the target date. Managers can now file a correction for ANY date in the
        // current month — including absent days that have no ManagerAttendance record yet.
        // A legacy `attendanceId` reference is still accepted for backward compatibility.
        let attendance = null;
        let targetDate = date;

        if (attendanceId) {
            attendance = await ManagerAttendance.findById(attendanceId);
            if (!attendance) {
                return res.status(404).json({ message: "Attendance record not found" });
            }
            if (String(attendance.manager) !== String(req.manager._id)) {
                return res.status(403).json({ message: "Not authorized" });
            }
            targetDate = attendance.date;
        }

        if (!targetDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
            return res.status(400).json({ message: "A valid date is required" });
        }

        // Validation: allowed window is current + previous month, no future dates.
        // Mirrors the employee flow (attendanceController.js).
        const now = new Date();
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
        const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const windowStart = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, "0")}-01`;
        if (targetDate < windowStart) {
            return res.status(400).json({ message: "Corrections are only allowed for the current or previous month" });
        }
        if (targetDate > todayStr) {
            return res.status(400).json({ message: "Cannot submit a correction for a future date" });
        }

        // Link an existing record for this date if one exists (absent days have none).
        if (!attendance) {
            attendance = await ManagerAttendance.findOne({ manager: req.manager._id, date: targetDate });
        }

        // Parse the requested times. The frontend sends a full ISO timestamp built from
        // the target date + picked HH:MM in the user's local timezone, so the instant is
        // unambiguous. A bare "HH:MM" string is still accepted as a fallback (interpreted
        // on the target date in the server's local timezone).
        const parseTimeValue = (val) => {
            if (!val) return undefined;
            if (typeof val === "string" && /^\d{1,2}:\d{2}(:\d{2})?$/.test(val)) {
                const [h, m] = val.split(":").map(Number);
                const d = new Date(targetDate + "T00:00:00");
                d.setHours(h, m, 0, 0);
                return d;
            }
            const d = new Date(val);
            return isNaN(d.getTime()) ? undefined : d;
        };
        const parsedCheckIn = parseTimeValue(requestedCheckIn);
        const parsedCheckOut = parseTimeValue(requestedCheckOut);

        const correction = await ManagerCorrectionRequest.create({
            manager: req.manager._id,
            attendance: attendance ? attendance._id : undefined,
            date: targetDate,
            correctionType: correctionType || "incorrect-data",
            requestedCheckIn: parsedCheckIn || undefined,
            requestedCheckOut: parsedCheckOut || undefined,
            reason,
        });

        await notifyAdmins("attendance", {
            title: "Attendance Correction Request (Manager)",
            body: `${req.manager.name} submitted a correction for ${targetDate}`,
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

        await notifyAdmins("attendance", {
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
    checkInUpload,
    checkOut,
    getToday,
    getCalendar,
    submitCorrection,
    getCorrections,
    getLeaves,
    applyLeave,
    getPolicy,
};
