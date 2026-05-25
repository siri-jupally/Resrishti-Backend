/*
  Admin Manager-Attendance Controller

  Mirrors attendanceManagerController but for admin overseeing managers.
  Admin plays the supervisor role that Manager plays for employees.

  Routes (mounted at /api/admin/manager-attendance):
    - getManagersAttendance:    GET  /team
    - getManagersSummary:       GET  /team/summary
    - approveAttendance:        PATCH /:id/approve
    - getCorrectionRequests:    GET  /corrections
    - reviewCorrection:         PATCH /corrections/:id
    - getLeaveRequests:         GET  /leaves
    - reviewLeave:              PATCH /leaves/:id
*/
const ManagerAttendance = require("../models/ManagerAttendance");
const ManagerLeave = require("../models/ManagerLeave");
const ManagerCorrectionRequest = require("../models/ManagerCorrectionRequest");
const Manager = require("../models/Manager");
const { sendPush, notifyIfEnabled } = require("../utils/push");

// GET /api/admin/manager-attendance/team?date=YYYY-MM-DD
const getManagersAttendance = async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().split("T")[0];

        const managers = await Manager.find().select("-password");
        const managerIds = managers.map((m) => m._id);

        const records = await ManagerAttendance.find({
            manager: { $in: managerIds },
            date,
        }).populate("manager", "name email");

        const recordMap = {};
        records.forEach((r) => {
            recordMap[String(r.manager._id)] = r;
        });

        const teamData = managers.map((mgr) => {
            const record = recordMap[String(mgr._id)];
            return {
                manager: {
                    _id: mgr._id,
                    name: mgr.name,
                    email: mgr.email,
                },
                attendance: record || {
                    date,
                    status: "absent",
                    approvalStatus: null,
                },
            };
        });

        const summary = {
            total: managers.length,
            present: records.filter((r) => r.status === "present").length,
            absent:
                managers.length -
                records.filter((r) =>
                    ["present", "half-day", "leave", "holiday", "weekend"].includes(r.status)
                ).length,
            wfh: records.filter((r) => r.workMode === "WFH").length,
            leave: records.filter((r) => r.status === "leave").length,
            late: records.filter((r) => r.isLateCheckIn).length,
            outOfBoundary: records.filter((r) => r.locationWithinBoundary === false).length,
        };

        res.json({ date, team: teamData, summary });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/manager-attendance/team/summary?month=3&year=2026
const getManagersSummary = async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        const endMonth = month === 12 ? 1 : month + 1;
        const endYear = month === 12 ? year + 1 : year;
        const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

        const managers = await Manager.find().select("name email");
        const managerIds = managers.map((m) => m._id);

        const records = await ManagerAttendance.find({
            manager: { $in: managerIds },
            date: { $gte: startDate, $lt: endDate },
        });

        const summaries = managers.map((mgr) => {
            const mgrRecords = records.filter(
                (r) => String(r.manager) === String(mgr._id)
            );
            return {
                manager: { _id: mgr._id, name: mgr.name, email: mgr.email },
                present: mgrRecords.filter((r) => r.status === "present").length,
                absent: 0,
                halfDay: mgrRecords.filter((r) => r.status === "half-day").length,
                leave: mgrRecords.filter((r) => r.status === "leave").length,
                wfh: mgrRecords.filter((r) => r.workMode === "WFH").length,
                totalHours: mgrRecords.reduce((sum, r) => sum + (r.workingHours || 0), 0),
                lateCount: mgrRecords.filter((r) => r.isLateCheckIn).length,
            };
        });

        res.json({ month, year, summaries });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/manager-attendance/:id/approve
const approveAttendance = async (req, res) => {
    try {
        const { status, remarks } = req.body;
        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }

        const attendance = await ManagerAttendance.findById(req.params.id).populate(
            "manager",
            "name pushSubscription"
        );
        if (!attendance) {
            return res.status(404).json({ message: "Attendance record not found" });
        }

        attendance.approvalStatus = status;
        if (remarks) attendance.adminRemarks = remarks;
        await attendance.save();

        if (attendance.manager.pushSubscription) {
            try {
                await notifyIfEnabled("attendance", attendance.manager.pushSubscription, {
                    title: `Attendance ${status === "approved" ? "Approved" : "Rejected"}`,
                    body: `Your attendance for ${attendance.date} has been ${status}${remarks ? ": " + remarks : ""}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/manager/dashboard?tab=myAttendance" },
                });
            } catch (pushErr) {
                console.error("Push error:", pushErr);
            }
        }

        res.json(attendance);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/manager-attendance/corrections
const getCorrectionRequests = async (req, res) => {
    try {
        const statusFilter = req.query.status || "pending";
        const corrections = await ManagerCorrectionRequest.find({
            status: statusFilter,
        })
            .populate("manager", "name email")
            .populate("attendance")
            .sort({ createdAt: -1 });

        res.json(corrections);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/manager-attendance/corrections/:id
const reviewCorrection = async (req, res) => {
    try {
        const { status, reviewRemarks } = req.body;
        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }

        const correction = await ManagerCorrectionRequest.findById(req.params.id).populate(
            "manager",
            "name pushSubscription"
        );
        if (!correction) {
            return res.status(404).json({ message: "Correction request not found" });
        }

        correction.status = status;
        correction.reviewedBy = req.admin._id;
        if (reviewRemarks) correction.reviewRemarks = reviewRemarks;
        await correction.save();

        if (status === "approved") {
            const attendance = await ManagerAttendance.findById(correction.attendance);
            if (attendance) {
                if (correction.requestedCheckIn) {
                    attendance.checkIn = {
                        ...attendance.checkIn,
                        time: correction.requestedCheckIn,
                    };
                }
                if (correction.requestedCheckOut) {
                    attendance.checkOut = {
                        ...attendance.checkOut,
                        time: correction.requestedCheckOut,
                    };
                }
                if (attendance.checkIn?.time && attendance.checkOut?.time) {
                    const diffMs =
                        new Date(attendance.checkOut.time) - new Date(attendance.checkIn.time);
                    attendance.workingHours =
                        Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
                }
                attendance.approvalStatus = "approved";
                await attendance.save();
            }
        }

        if (correction.manager.pushSubscription) {
            try {
                await notifyIfEnabled("attendance", correction.manager.pushSubscription, {
                    title: `Correction ${status === "approved" ? "Approved" : "Rejected"}`,
                    body: `Your correction for ${correction.date} has been ${status}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/manager/dashboard?tab=myAttendance" },
                });
            } catch (pushErr) {
                console.error("Push error:", pushErr);
            }
        }

        res.json(correction);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/manager-attendance/leaves
const getLeaveRequests = async (req, res) => {
    try {
        const statusFilter = req.query.status || "pending";
        const leaves = await ManagerLeave.find({
            status: statusFilter,
        })
            .populate("manager", "name email")
            .sort({ createdAt: -1 });

        res.json(leaves);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/manager-attendance/leaves/:id
const reviewLeave = async (req, res) => {
    try {
        const { status, reviewRemarks } = req.body;
        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }

        const leave = await ManagerLeave.findById(req.params.id).populate(
            "manager",
            "name pushSubscription"
        );
        if (!leave) {
            return res.status(404).json({ message: "Leave request not found" });
        }

        leave.status = status;
        leave.reviewedBy = req.admin._id;
        if (reviewRemarks) leave.reviewRemarks = reviewRemarks;
        await leave.save();

        // If approved, create attendance records with 'leave' status
        if (status === "approved") {
            const start = new Date(leave.startDate);
            const end = new Date(leave.endDate);
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dateStr = d.toISOString().split("T")[0];
                await ManagerAttendance.findOneAndUpdate(
                    { manager: leave.manager._id, date: dateStr },
                    {
                        manager: leave.manager._id,
                        date: dateStr,
                        status: "leave",
                        approvalStatus: "approved",
                        workMode: "WFO",
                    },
                    { upsert: true, new: true }
                );
            }
        }

        if (leave.manager.pushSubscription) {
            try {
                await notifyIfEnabled("attendance", leave.manager.pushSubscription, {
                    title: `Leave ${status === "approved" ? "Approved" : "Rejected"}`,
                    body: `Your ${leave.type} leave (${leave.startDate} to ${leave.endDate}) has been ${status}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/manager/dashboard?tab=myAttendance" },
                });
            } catch (pushErr) {
                console.error("Push error:", pushErr);
            }
        }

        res.json(leave);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = {
    getManagersAttendance,
    getManagersSummary,
    approveAttendance,
    getCorrectionRequests,
    reviewCorrection,
    getLeaveRequests,
    reviewLeave,
};
