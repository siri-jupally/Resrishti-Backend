/*
  Attendance Manager Controller

  Purpose:
  - Handles manager-facing attendance operations:
    - getTeamAttendance: GET /api/manager/attendance/team
    - getTeamSummary: GET /api/manager/attendance/team/summary
    - approveAttendance: PATCH /api/manager/attendance/:id/approve
    - setEmployeeWorkMode: PATCH /api/manager/employees/:id/workmode
    - getCorrectionRequests: GET /api/manager/attendance/corrections
    - reviewCorrection: PATCH /api/manager/attendance/corrections/:id
    - getLeaveRequests: GET /api/manager/leaves
    - reviewLeave: PATCH /api/manager/leaves/:id
*/
const Attendance = require("../models/Attendance");
const AttendancePolicy = require("../models/AttendancePolicy");
const CorrectionRequest = require("../models/CorrectionRequest");
const Leave = require("../models/Leave");
const Employee = require("../models/Employee");
const Admin = require("../models/Admin");
const { sendPush, notifyIfEnabled } = require("../utils/push");
const { isWeekOff } = require("../utils/attendanceDays");

// GET /api/manager/attendance/team?date=YYYY-MM-DD
const getTeamAttendance = async (req, res) => {
    try {
        const date = req.query.date || new Date().toISOString().split("T")[0];

        // Is this a weekly-off day? If so, missing records are "weekend", not "absent".
        const policy = await AttendancePolicy.findOne();
        const dayIsOff = isWeekOff(date, policy);

        // Get all employees under this manager
        const employees = await Employee.find({ manager: req.manager._id }).select(
            "-password"
        );
        const employeeIds = employees.map((e) => e._id);

        // Get attendance for these employees on this date
        const records = await Attendance.find({
            employee: { $in: employeeIds },
            date,
        }).populate("employee", "name email defaultWorkMode");

        // Create a map for quick lookup
        const recordMap = {};
        records.forEach((r) => {
            recordMap[String(r.employee._id)] = r;
        });

        // Build team data; people without a record are absent on working days, or
        // "weekend" on a configured weekly-off day.
        const teamData = employees.map((emp) => {
            const record = recordMap[String(emp._id)];
            return {
                employee: {
                    _id: emp._id,
                    name: emp.name,
                    email: emp.email,
                    defaultWorkMode: emp.defaultWorkMode,
                },
                attendance: record || {
                    date,
                    status: dayIsOff ? "weekend" : "absent",
                    approvalStatus: null,
                },
            };
        });

        // Summary counts. On a weekly-off day nobody is "absent".
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

// GET /api/manager/attendance/team/summary?month=3&year=2026
const getTeamSummary = async (req, res) => {
    try {
        const month = parseInt(req.query.month) || new Date().getMonth() + 1;
        const year = parseInt(req.query.year) || new Date().getFullYear();

        const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
        const endMonth = month === 12 ? 1 : month + 1;
        const endYear = month === 12 ? year + 1 : year;
        const endDate = `${endYear}-${String(endMonth).padStart(2, "0")}-01`;

        const employees = await Employee.find({ manager: req.manager._id }).select(
            "name email"
        );
        const employeeIds = employees.map((e) => e._id);

        const records = await Attendance.find({
            employee: { $in: employeeIds },
            date: { $gte: startDate, $lt: endDate },
        });

        // Per-employee summary
        const empSummaries = employees.map((emp) => {
            const empRecords = records.filter(
                (r) => String(r.employee) === String(emp._id)
            );
            return {
                employee: { _id: emp._id, name: emp.name, email: emp.email },
                present: empRecords.filter((r) => r.status === "present").length,
                absent: 0, // calculated below
                halfDay: empRecords.filter((r) => r.status === "half-day").length,
                leave: empRecords.filter((r) => r.status === "leave").length,
                wfh: empRecords.filter((r) => r.workMode === "WFH").length,
                totalHours: empRecords.reduce((sum, r) => sum + (r.workingHours || 0), 0),
                lateCount: empRecords.filter((r) => r.isLateCheckIn).length,
            };
        });

        res.json({ month, year, summaries: empSummaries });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/attendance/employee/:employeeId/calendar?month=3&year=2026
// Monthly attendance calendar for a specific employee reporting to this manager.
const getEmployeeCalendar = async (req, res) => {
    try {
        const { employeeId } = req.params;

        // Verify the employee reports to the requesting manager.
        const employee = await Employee.findOne({
            _id: employeeId,
            manager: req.manager._id,
        }).select("name email defaultWorkMode");
        if (!employee) {
            return res.status(404).json({ message: "Employee not found in your team" });
        }

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

        res.json({ employee, records, holidays, leaves, weeklyOffDays: policy?.weeklyOffDays || [0, 6], weekendExceptions: policy?.weekendExceptions || [] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/manager/attendance/:id/approve
const approveAttendance = async (req, res) => {
    try {
        const { status, remarks } = req.body; // status: 'approved' or 'rejected'
        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }

        const attendance = await Attendance.findById(req.params.id).populate(
            "employee",
            "name pushSubscription manager"
        );
        if (!attendance) {
            return res.status(404).json({ message: "Attendance record not found" });
        }

        // Verify manager owns this employee
        if (String(attendance.employee.manager) !== String(req.manager._id)) {
            return res.status(403).json({ message: "Not authorized" });
        }

        attendance.approvalStatus = status;
        if (remarks) attendance.managerRemarks = remarks;
        await attendance.save();

        // Notify employee
        if (attendance.employee.pushSubscription) {
            try {
                await notifyIfEnabled("attendance", attendance.employee.pushSubscription, {
                    title: `Attendance ${status === "approved" ? "Approved" : "Rejected"}`,
                    body: `Your attendance for ${attendance.date} has been ${status}${remarks ? ": " + remarks : ""}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/employee/dashboard?tab=attendance" },
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

// PATCH /api/manager/employees/:id/workmode
const setEmployeeWorkMode = async (req, res) => {
    try {
        const { workMode } = req.body;
        if (!["WFO", "WFH", "remote"].includes(workMode)) {
            return res.status(400).json({ message: "Invalid work mode" });
        }

        const employee = await Employee.findOne({
            _id: req.params.id,
            manager: req.manager._id,
        });
        if (!employee) {
            return res.status(404).json({ message: "Employee not found" });
        }

        employee.defaultWorkMode = workMode;
        await employee.save();

        // Notify employee
        if (employee.pushSubscription) {
            try {
                await notifyIfEnabled("attendance", employee.pushSubscription, {
                    title: "Work Mode Updated",
                    body: `Your work mode has been changed to ${workMode}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/employee/dashboard?tab=attendance" },
                });
            } catch (pushErr) {
                console.error("Push error:", pushErr);
            }
        }

        res.json({ _id: employee._id, name: employee.name, defaultWorkMode: employee.defaultWorkMode });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/attendance/corrections
const getCorrectionRequests = async (req, res) => {
    try {
        const employees = await Employee.find({ manager: req.manager._id }).select("_id");
        const employeeIds = employees.map((e) => e._id);

        const statusFilter = req.query.status || "pending";
        const corrections = await CorrectionRequest.find({
            employee: { $in: employeeIds },
            status: statusFilter,
        })
            .populate("employee", "name email")
            .populate("attendance")
            .sort({ createdAt: -1 });

        res.json(corrections);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/manager/attendance/corrections/:id
const reviewCorrection = async (req, res) => {
    try {
        const { status, reviewRemarks } = req.body;
        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }

        const correction = await CorrectionRequest.findById(req.params.id).populate(
            "employee",
            "name pushSubscription manager"
        );
        if (!correction) {
            return res.status(404).json({ message: "Correction request not found" });
        }

        // Verify manager owns this employee
        if (String(correction.employee.manager) !== String(req.manager._id)) {
            return res.status(403).json({ message: "Not authorized" });
        }

        correction.status = status;
        correction.reviewedBy = req.manager._id;
        if (reviewRemarks) correction.reviewRemarks = reviewRemarks;
        await correction.save();

        // If approved, apply the correction to the attendance record. For absent days
        // there is no record yet, so we create one (so corrections for unmarked days are
        // stored and reflected correctly).
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

            // Assign the time directly (don't spread the Mongoose subdoc — that leaks
            // internal props and breaks casting of nested fields like checkIn.photo).
            if (correction.requestedCheckIn) {
                if (attendance.checkIn) attendance.checkIn.time = correction.requestedCheckIn;
                else attendance.checkIn = { time: correction.requestedCheckIn };
            }
            if (correction.requestedCheckOut) {
                if (attendance.checkOut) attendance.checkOut.time = correction.requestedCheckOut;
                else attendance.checkOut = { time: correction.requestedCheckOut };
            }

            // Recalculate working hours + status when we have a full check-in/out span.
            if (attendance.checkIn?.time && attendance.checkOut?.time) {
                const diffMs =
                    new Date(attendance.checkOut.time) - new Date(attendance.checkIn.time);
                attendance.workingHours =
                    Math.round((diffMs / (1000 * 60 * 60)) * 100) / 100;
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

            // Backfill the link for absent-day corrections that had no record at submit time.
            if (!correction.attendance) {
                correction.attendance = attendance._id;
                await correction.save();
            }
        }

        // Notify employee
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

// GET /api/manager/leaves
const getLeaveRequests = async (req, res) => {
    try {
        const employees = await Employee.find({ manager: req.manager._id }).select("_id");
        const employeeIds = employees.map((e) => e._id);

        const statusFilter = req.query.status || "pending";
        const leaves = await Leave.find({
            employee: { $in: employeeIds },
            status: statusFilter,
        })
            .populate("employee", "name email")
            .sort({ createdAt: -1 });

        res.json(leaves);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PATCH /api/manager/leaves/:id
const reviewLeave = async (req, res) => {
    try {
        const { status, reviewRemarks } = req.body;
        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }

        const leave = await Leave.findById(req.params.id).populate(
            "employee",
            "name pushSubscription manager"
        );
        if (!leave) {
            return res.status(404).json({ message: "Leave request not found" });
        }

        if (String(leave.employee.manager) !== String(req.manager._id)) {
            return res.status(403).json({ message: "Not authorized" });
        }

        leave.status = status;
        leave.reviewedBy = req.manager._id;
        if (reviewRemarks) leave.reviewRemarks = reviewRemarks;
        await leave.save();

        // If approved, create attendance records with 'leave' status for each day
        if (status === "approved") {
            const start = new Date(leave.startDate);
            const end = new Date(leave.endDate);
            for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
                const dateStr = d.toISOString().split("T")[0];
                await Attendance.findOneAndUpdate(
                    { employee: leave.employee._id, date: dateStr },
                    {
                        employee: leave.employee._id,
                        date: dateStr,
                        status: "leave",
                        approvalStatus: "approved",
                        workMode: "WFO",
                    },
                    { upsert: true, new: true }
                );
            }
        }

        // Notify employee
        if (leave.employee.pushSubscription) {
            try {
                await notifyIfEnabled("attendance", leave.employee.pushSubscription, {
                    title: `Leave ${status === "approved" ? "Approved" : "Rejected"}`,
                    body: `Your ${leave.type} leave (${leave.startDate} to ${leave.endDate}) has been ${status}`,
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/employee/dashboard?tab=attendance" },
                });
            } catch (pushErr) {
                console.error("Push error:", pushErr);
            }
        }

        // Notify all admins of the leave decision
        try {
            const admins = await Admin.find().select("pushSubscription");
            for (const admin of admins) {
                if (admin.pushSubscription) {
                    await notifyIfEnabled("attendance", admin.pushSubscription, {
                        title: `Leave ${status === "approved" ? "Approved" : "Rejected"} by Manager`,
                        body: `${leave.employee.name}'s ${leave.type} leave (${leave.startDate} to ${leave.endDate}) was ${status}`,
                        icon: "/android-chrome-512x512.png",
                        data: { url: "/admin/dashboard?tab=leaves" },
                    });
                }
            }
        } catch (adminPushErr) {
            console.error("Admin push error:", adminPushErr);
        }

        res.json(leave);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = {
    getTeamAttendance,
    getTeamSummary,
    getEmployeeCalendar,
    approveAttendance,
    setEmployeeWorkMode,
    getCorrectionRequests,
    reviewCorrection,
    getLeaveRequests,
    reviewLeave,
};
