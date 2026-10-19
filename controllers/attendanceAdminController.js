/*
  Attendance Admin Controller

  Purpose:
  - Handles HR/Admin attendance operations:
    - getPolicy: GET /api/admin/attendance/policy
    - updatePolicy: PUT /api/admin/attendance/policy
    - addHoliday: POST /api/admin/attendance/policy/holidays
    - removeHoliday: DELETE /api/admin/attendance/policy/holidays/:id
    - getReports: GET /api/admin/attendance/reports
*/
const AttendancePolicy = require("../models/AttendancePolicy");
const Attendance = require("../models/Attendance");
const Employee = require("../models/Employee");
const { summariseWorked } = require("../utils/attendanceCounting");

// GET /api/admin/attendance/policy
const getPolicy = async (req, res) => {
    try {
        let policy = await AttendancePolicy.findOne();
        if (!policy) {
            // Create default policy
            policy = await AttendancePolicy.create({});
        }
        res.json(policy);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// PUT /api/admin/attendance/policy
const updatePolicy = async (req, res) => {
    try {
        const {
            officeLocations,
            weeklyOffDays,
            weekendExceptions,
            workingHoursPerDay,
            graceMinutes,
            halfDayThresholdHours,
            lateThresholdMinutes,
            checkInStartTime,
            checkInEndTime,
            checkOutMinTime,
            wfhEnabled,
            maxWfhDaysPerMonth,
            requireApprovalForWfh,
            remoteEnabled,
            maxRemoteDaysPerMonth,
            requireApprovalForRemote,
            leaveQuotas,
            allowMultipleCheckIns,
            allowOutOfPremisesOfficeCheckIn,
        } = req.body;

        let policy = await AttendancePolicy.findOne();
        if (!policy) {
            policy = new AttendancePolicy();
        }

        if (officeLocations !== undefined) policy.officeLocations = officeLocations;
        if (weeklyOffDays !== undefined) {
            // Normalize to a unique, sorted list of valid day numbers (0..6).
            policy.weeklyOffDays = [...new Set(
                (Array.isArray(weeklyOffDays) ? weeklyOffDays : [])
                    .map(Number)
                    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
            )].sort((a, b) => a - b);
        }
        if (weekendExceptions !== undefined) {
            // Keep only well-formed, valid-typed entries; one entry per date (last wins).
            const byDate = {};
            (Array.isArray(weekendExceptions) ? weekendExceptions : []).forEach((e) => {
                if (e && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && ["working", "off"].includes(e.type)) {
                    byDate[e.date] = { date: e.date, type: e.type, note: e.note || undefined };
                }
            });
            policy.weekendExceptions = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
        }
        if (workingHoursPerDay !== undefined) policy.workingHoursPerDay = workingHoursPerDay;
        if (graceMinutes !== undefined) policy.graceMinutes = graceMinutes;
        if (halfDayThresholdHours !== undefined) policy.halfDayThresholdHours = halfDayThresholdHours;
        if (lateThresholdMinutes !== undefined) policy.lateThresholdMinutes = lateThresholdMinutes;
        if (checkInStartTime !== undefined) policy.checkInStartTime = checkInStartTime;
        if (checkInEndTime !== undefined) policy.checkInEndTime = checkInEndTime;
        if (checkOutMinTime !== undefined) policy.checkOutMinTime = checkOutMinTime;
        if (wfhEnabled !== undefined) policy.wfhEnabled = wfhEnabled;
        if (maxWfhDaysPerMonth !== undefined) policy.maxWfhDaysPerMonth = maxWfhDaysPerMonth;
        if (requireApprovalForWfh !== undefined) policy.requireApprovalForWfh = requireApprovalForWfh;
        if (remoteEnabled !== undefined) policy.remoteEnabled = remoteEnabled;
        if (maxRemoteDaysPerMonth !== undefined) policy.maxRemoteDaysPerMonth = maxRemoteDaysPerMonth;
        if (requireApprovalForRemote !== undefined) policy.requireApprovalForRemote = requireApprovalForRemote;
        if (leaveQuotas !== undefined) policy.leaveQuotas = leaveQuotas;
        if (allowMultipleCheckIns !== undefined) policy.allowMultipleCheckIns = allowMultipleCheckIns;
        if (typeof allowOutOfPremisesOfficeCheckIn === "boolean") {
            policy.allowOutOfPremisesOfficeCheckIn = allowOutOfPremisesOfficeCheckIn;
        }

        await policy.save();
        res.json(policy);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/admin/attendance/policy/holidays
const addHoliday = async (req, res) => {
    try {
        const { date, name, type } = req.body;
        if (!date || !name) {
            return res.status(400).json({ message: "date and name are required" });
        }

        let policy = await AttendancePolicy.findOne();
        if (!policy) {
            policy = new AttendancePolicy();
        }

        policy.holidays.push({ date, name, type: type || "public" });
        await policy.save();

        // Mark attendance records for this date as 'holiday'
        await Attendance.updateMany(
            { date },
            { status: "holiday", approvalStatus: "auto-approved" }
        );

        res.status(201).json(policy);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// DELETE /api/admin/attendance/policy/holidays/:id
const removeHoliday = async (req, res) => {
    try {
        const policy = await AttendancePolicy.findOne();
        if (!policy) {
            return res.status(404).json({ message: "Policy not found" });
        }

        const holidayIndex = policy.holidays.findIndex(
            (h) => String(h._id) === req.params.id
        );
        if (holidayIndex === -1) {
            return res.status(404).json({ message: "Holiday not found" });
        }

        policy.holidays.splice(holidayIndex, 1);
        await policy.save();
        res.json(policy);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/attendance/reports?from=YYYY-MM-DD&to=YYYY-MM-DD
const getReports = async (req, res) => {
    try {
        // Accept either an explicit from/to range or a month+year (the admin
        // Reports tab sends ?month=&year=). Attendance.date is a "YYYY-MM-DD"
        // string, so the range is built as padded ISO date strings.
        let from = req.query.from;
        let to = req.query.to;
        const month = parseInt(req.query.month, 10);
        const year = parseInt(req.query.year, 10);
        if ((!from || !to) && month >= 1 && month <= 12 && year) {
            const mm = String(month).padStart(2, "0");
            const lastDay = new Date(year, month, 0).getDate(); // day 0 of next month = last day of this one
            from = `${year}-${mm}-01`;
            to = `${year}-${mm}-${String(lastDay).padStart(2, "0")}`;
        }

        if (!from || !to) {
            return res.status(400).json({ message: "month+year (or from+to) are required" });
        }

        const employees = await Employee.find()
            .select("name email manager defaultWorkMode")
            .populate("manager", "name email");

        const records = await Attendance.find({
            date: { $gte: from, $lte: to },
        }).populate("employee", "name email manager");

        // Aggregate per employee
        const employeeMap = {};
        employees.forEach((emp) => {
            employeeMap[String(emp._id)] = {
                employee: { _id: emp._id, name: emp.name, email: emp.email },
                // Team the employee belongs to, for the admin Reports team filter.
                manager: emp.manager
                    ? { _id: emp.manager._id, name: emp.manager.name }
                    : null,
                // How many attendance records exist this period. 0 = "inactive"
                // (never checked in / nothing recorded) for the Reports filter.
                recordCount: 0,
                present: 0,
                absent: 0,
                halfDay: 0,
                leave: 0,
                holiday: 0,
                wfh: 0,
                totalHours: 0,
                lateCount: 0,
                earlyCheckout: 0,
                outOfBoundary: 0,
                pendingApproval: 0,
                pendingHours: 0,
                rejected: 0,
            };
        });

        // Group first so worked days/hours go through the shared approval rule
        // (utils/attendanceCounting.js) instead of being counted inline.
        const recordsByEmployee = {};
        records.forEach((r) => {
            if (!r.employee) return; // orphaned record (employee deleted)
            const key = String(r.employee._id || r.employee);
            (recordsByEmployee[key] = recordsByEmployee[key] || []).push(r);
        });
        Object.entries(recordsByEmployee).forEach(([key, list]) => {
            if (!employeeMap[key]) return;
            Object.assign(employeeMap[key], summariseWorked(list));
            employeeMap[key].recordCount = list.length;
        });

        records.forEach((r) => {
            if (!r.employee) return; // orphaned record (employee deleted)
            const key = String(r.employee._id || r.employee);
            if (!employeeMap[key]) return;

            // present / half-day / totalHours are already set above, counting
            // only approved or auto-approved days.
            switch (r.status) {
                case "leave":
                    employeeMap[key].leave++;
                    break;
                case "holiday":
                    employeeMap[key].holiday++;
                    break;
                case "absent":
                    employeeMap[key].absent++;
                    break;
            }

            if (r.workMode === "WFH") employeeMap[key].wfh++;
            if (r.isLateCheckIn) employeeMap[key].lateCount++;
            if (r.isEarlyCheckOut) employeeMap[key].earlyCheckout++;
            if (r.locationWithinBoundary === false) employeeMap[key].outOfBoundary++;
        });

        const report = Object.values(employeeMap);

        // Working days in the range = weekdays (Mon–Fri), not counting days in
        // the future (so the current, partial month isn't penalised).
        const startD = new Date(`${from}T00:00:00`);
        let endD = new Date(`${to}T00:00:00`);
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        if (endD > today) endD = today;
        let totalWorkingDays = 0;
        for (let d = new Date(startD); d <= endD; d.setDate(d.getDate() + 1)) {
            const dow = d.getDay();
            if (dow !== 0 && dow !== 6) totalWorkingDays++;
        }

        // Average attendance = worked days (half-days count half) over the
        // working days everyone could have attended, as a 0–100%.
        const totalPresentDays = report.reduce(
            (a, e) => a + e.present + 0.5 * e.halfDay,
            0
        );
        const denom = employees.length * totalWorkingDays;
        const avgAttendance = denom > 0
            ? Math.min(100, Math.round((totalPresentDays / denom) * 100))
            : 0;

        const totalLateCheckins = records.filter((r) => r.isLateCheckIn).length;

        // Shape consumed by the admin Reports tab (AdminAttendanceTab.jsx).
        const summary = {
            totalEmployees: employees.length,
            avgAttendance,
            totalWorkingDays,
            totalLateCheckins,
        };

        // Legacy org-level summary kept alongside in case anything else reads it.
        const orgSummary = {
            totalEmployees: employees.length,
            totalRecords: records.length,
            totalPresent: summariseWorked(records).present,
            totalPendingApproval: summariseWorked(records).pendingApproval,
            totalAbsent: records.filter((r) => r.status === "absent").length,
            totalLeave: records.filter((r) => r.status === "leave").length,
            totalWfh: records.filter((r) => r.workMode === "WFH").length,
            totalLate: totalLateCheckins,
        };

        res.json({
            from,
            to,
            month: month || null,
            year: year || null,
            summary,
            employees: report,
            orgSummary,
            employeeReports: report,
        });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = {
    getPolicy,
    updatePolicy,
    addHoliday,
    removeHoliday,
    getReports,
};
