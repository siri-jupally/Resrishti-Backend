/*
  Admin Employee-Attendance Controller

  Mirrors adminManagerAttendanceController, but lets an ADMIN oversee ALL
  employees' attendance — the same day-level view a manager has for their own
  team, across the whole company (grouped by manager for readability). Previously
  an admin could only see a monthly summary; this adds the by-date view, the
  per-employee calendar, and correction review.

  Approving a pending employee day reuses the existing endpoint
  PATCH /api/admin/attendance/:id/approve (controllers/workAccessController).
  Employee leave requests are reviewed via the existing /api/admin/leaves.

  Routes (mounted at /api/admin/employee-attendance):
    - getEmployeesAttendance:  GET   /team
    - getEmployeesSummary:     GET   /team/summary
    - getEmployeeCalendar:     GET   /employee/:employeeId/calendar
    - getCorrectionRequests:   GET   /corrections
    - reviewCorrection:        PATCH /corrections/:id
*/
const Attendance = require("../models/Attendance");
const Leave = require("../models/Leave");
const CorrectionRequest = require("../models/CorrectionRequest");
const AttendancePolicy = require("../models/AttendancePolicy");
const Employee = require("../models/Employee");
const { notifyIfEnabled } = require("../utils/push");
const { isWeekOff } = require("../utils/attendanceDays");
const { summariseWorked } = require("../utils/attendanceCounting");

const ACTIVE = { archived: { $ne: true }, isTestAccount: { $ne: true } };

// GET /api/admin/employee-attendance/team?date=YYYY-MM-DD
// Every active employee's attendance for the date, each tagged with its manager
// so the UI can group them.
const getEmployeesAttendance = async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().split("T")[0];

        const policy = await AttendancePolicy.findOne();
        const dayIsOff = isWeekOff(date, policy);

        const employees = await Employee.find(ACTIVE)
            .select("name email manager")
            .populate("manager", "name")
            .sort({ name: 1 });
        const employeeIds = employees.map((e) => e._id);

        const records = await Attendance.find({ employee: { $in: employeeIds }, date })
            .populate("employee", "name email");

        const recordMap = {};
        records.forEach((r) => { recordMap[String(r.employee._id)] = r; });

        const teamData = employees.map((emp) => ({
            employee: {
                _id: emp._id,
                name: emp.name,
                email: emp.email,
                manager: emp.manager ? { _id: emp.manager._id, name: emp.manager.name } : null,
            },
            attendance: recordMap[String(emp._id)] || {
                date,
                status: dayIsOff ? "weekend" : "absent",
                approvalStatus: null,
            },
        }));

        const summary = {
            total: employees.length,
            present: records.filter((r) => r.status === "present").length,
            absent: dayIsOff
                ? 0
                : employees.length -
                  records.filter((r) =>
                      ["present", "half-day", "leave", "holiday", "weekend"].includes(r.status)
                  ).length,
            wfh: records.filter((r) => r.workMode === "WFH").length,
            leave: records.filter((r) => r.status === "leave").length,
            late: records.filter((r) => r.isLateCheckIn).length,
            outOfBoundary: records.filter((r) => r.locationWithinBoundary === false).length,
            isWeekOff: dayIsOff,
        };

        res.json({ date, team: teamData, summary });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/employee-attendance/team/summary?month=3&year=2026
const getEmployeesSummary = async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        const endMonth = month === 12 ? 1 : month + 1;
        const endYear = month === 12 ? year + 1 : year;
        const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

        const employees = await Employee.find(ACTIVE)
            .select("name email manager")
            .populate("manager", "name");
        const employeeIds = employees.map((e) => e._id);

        const records = await Attendance.find({
            employee: { $in: employeeIds },
            date: { $gte: startDate, $lt: endDate },
        });

        const summaries = employees.map((emp) => {
            const own = records.filter((r) => String(r.employee) === String(emp._id));
            return {
                employee: {
                    _id: emp._id,
                    name: emp.name,
                    email: emp.email,
                    manager: emp.manager ? { _id: emp.manager._id, name: emp.manager.name } : null,
                },
                leave: own.filter((r) => r.status === "leave").length,
                wfh: own.filter((r) => r.workMode === "WFH").length,
                lateCount: own.filter((r) => r.isLateCheckIn).length,
                ...summariseWorked(own),
            };
        });

        res.json({ month, year, summaries });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/employee-attendance/employee/:employeeId/calendar?month=3&year=2026
const getEmployeeCalendar = async (req, res) => {
    try {
        const { employeeId } = req.params;
        const employee = await Employee.findById(employeeId)
            .select("name email manager").populate("manager", "name");
        if (!employee) return res.status(404).json({ message: "Employee not found" });

        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        const endMonth = month === 12 ? 1 : month + 1;
        const endYear = month === 12 ? year + 1 : year;
        const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

        const records = await Attendance.find({
            employee: employeeId,
            date: { $gte: startDate, $lt: endDate },
        }).sort({ date: 1 });

        const policy = await AttendancePolicy.findOne();
        const holidays = policy
            ? policy.holidays.filter((h) => h.date >= startDate && h.date < endDate)
            : [];

        const leaves = await Leave.find({
            employee: employeeId,
            status: "approved",
            startDate: { $lte: endDate },
            endDate: { $gte: startDate },
        });

        res.json({
            employee, records, holidays, leaves,
            weeklyOffDays: policy?.weeklyOffDays || [0, 6],
            weekendExceptions: policy?.weekendExceptions || [],
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/employee-attendance/corrections?status=pending
const getCorrectionRequests = async (req, res) => {
    try {
        const statusFilter = req.query.status || "pending";
        const corrections = await CorrectionRequest.find({ status: statusFilter })
            .populate("employee", "name email")
            .populate("attendance")
            .sort({ createdAt: -1 });
        res.json(corrections);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/employee-attendance/corrections/:id
const reviewCorrection = async (req, res) => {
    try {
        const { status, reviewRemarks } = req.body;
        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }

        const correction = await CorrectionRequest.findById(req.params.id)
            .populate("employee", "name pushSubscription");
        if (!correction) return res.status(404).json({ message: "Correction request not found" });

        correction.status = status;
        correction.reviewedBy = req.admin._id;
        if (reviewRemarks) correction.reviewRemarks = reviewRemarks;
        await correction.save();

        if (status === "approved") {
            let attendance = correction.attendance
                ? await Attendance.findById(correction.attendance)
                : await Attendance.findOne({ employee: correction.employee._id, date: correction.date });

            if (!attendance) {
                attendance = new Attendance({
                    employee: correction.employee._id,
                    date: correction.date,
                    status: "present",
                    workMode: "WFO",
                });
            }

            if (correction.requestedCheckIn) {
                if (attendance.checkIn) attendance.checkIn.time = correction.requestedCheckIn;
                else attendance.checkIn = { time: correction.requestedCheckIn };
            }
            if (correction.requestedCheckOut) {
                if (attendance.checkOut) attendance.checkOut.time = correction.requestedCheckOut;
                else attendance.checkOut = { time: correction.requestedCheckOut };
            }

            if (attendance.checkIn?.time && attendance.checkOut?.time) {
                const diffMs = new Date(attendance.checkOut.time) - new Date(attendance.checkIn.time);
                attendance.workingHours = Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
                const policy = await AttendancePolicy.findOne();
                if (policy && attendance.workingHours < policy.workingHoursPerDay / 2) {
                    attendance.status = "half-day";
                } else if (!["leave", "holiday"].includes(attendance.status)) {
                    attendance.status = "present";
                }
            } else if (attendance.checkIn?.time && !["leave", "holiday"].includes(attendance.status)) {
                attendance.status = "present";
            }

            attendance.approvalStatus = "approved";
            await attendance.save();

            if (!correction.attendance) {
                correction.attendance = attendance._id;
                await correction.save();
            }
        }

        if (correction.employee.pushSubscription) {
            try {
                await notifyIfEnabled("attendance", correction.employee.pushSubscription, {
                    title: `Correction ${status === "approved" ? "Approved" : "Rejected"}`,
                    body: `Your correction for ${correction.date} has been ${status}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/employee/dashboard?tab=attendance" },
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

module.exports = {
    getEmployeesAttendance,
    getEmployeesSummary,
    getEmployeeCalendar,
    getCorrectionRequests,
    reviewCorrection,
};
