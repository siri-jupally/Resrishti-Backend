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
            workingHoursPerDay,
            graceMinutes,
            halfDayThresholdHours,
            lateThresholdMinutes,
            checkInStartTime,
            checkInEndTime,
            checkOutMinTime,
            wfhEnabled,
            maxWfhDaysPerMonth,
            leaveQuotas,
        } = req.body;

        let policy = await AttendancePolicy.findOne();
        if (!policy) {
            policy = new AttendancePolicy();
        }

        if (officeLocations !== undefined) policy.officeLocations = officeLocations;
        if (workingHoursPerDay !== undefined) policy.workingHoursPerDay = workingHoursPerDay;
        if (graceMinutes !== undefined) policy.graceMinutes = graceMinutes;
        if (halfDayThresholdHours !== undefined) policy.halfDayThresholdHours = halfDayThresholdHours;
        if (lateThresholdMinutes !== undefined) policy.lateThresholdMinutes = lateThresholdMinutes;
        if (checkInStartTime !== undefined) policy.checkInStartTime = checkInStartTime;
        if (checkInEndTime !== undefined) policy.checkInEndTime = checkInEndTime;
        if (checkOutMinTime !== undefined) policy.checkOutMinTime = checkOutMinTime;
        if (wfhEnabled !== undefined) policy.wfhEnabled = wfhEnabled;
        if (maxWfhDaysPerMonth !== undefined) policy.maxWfhDaysPerMonth = maxWfhDaysPerMonth;
        if (leaveQuotas !== undefined) policy.leaveQuotas = leaveQuotas;

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
        const from = req.query.from;
        const to = req.query.to;

        if (!from || !to) {
            return res.status(400).json({ message: "from and to date params are required" });
        }

        const employees = await Employee.find().select("name email manager defaultWorkMode");

        const records = await Attendance.find({
            date: { $gte: from, $lte: to },
        }).populate("employee", "name email manager");

        // Aggregate per employee
        const employeeMap = {};
        employees.forEach((emp) => {
            employeeMap[String(emp._id)] = {
                employee: { _id: emp._id, name: emp.name, email: emp.email },
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
            };
        });

        records.forEach((r) => {
            const key = String(r.employee._id || r.employee);
            if (!employeeMap[key]) return;

            switch (r.status) {
                case "present":
                    employeeMap[key].present++;
                    break;
                case "half-day":
                    employeeMap[key].halfDay++;
                    break;
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
            employeeMap[key].totalHours += r.workingHours || 0;
            if (r.isLateCheckIn) employeeMap[key].lateCount++;
            if (r.isEarlyCheckOut) employeeMap[key].earlyCheckout++;
            if (r.locationWithinBoundary === false) employeeMap[key].outOfBoundary++;
        });

        const report = Object.values(employeeMap);

        // Org-level summary
        const orgSummary = {
            totalEmployees: employees.length,
            totalRecords: records.length,
            totalPresent: records.filter((r) => r.status === "present").length,
            totalAbsent: records.filter((r) => r.status === "absent").length,
            totalLeave: records.filter((r) => r.status === "leave").length,
            totalWfh: records.filter((r) => r.workMode === "WFH").length,
            totalLate: records.filter((r) => r.isLateCheckIn).length,
        };

        res.json({ from, to, orgSummary, employeeReports: report });
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
