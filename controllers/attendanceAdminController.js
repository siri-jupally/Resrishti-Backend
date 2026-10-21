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
const {
    summariseWorked, isCountedTowardHours, isOutOfPremisesPending,
} = require("../utils/attendanceCounting");
const { buildMonthCalendar } = require("../utils/payrollCalendar");
const { lockBlocks } = require("../utils/attendanceLock");

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

        // Declaring a holiday rewrites every attendance row on that date, which
        // would rewrite pay in a month already closed.
        const holidayBlocked = await lockBlocks(date, "this date");
        if (holidayBlocked) return res.status(409).json(holidayBlocked.body);

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

/*
  GET /api/admin/attendance/reports

  Accepts either a month (?month=2026-10, or ?month=10&year=2026) or an
  explicit range (?from=YYYY-MM-DD&to=YYYY-MM-DD). The monthly report screen
  asks by month; it used to ask by month against a handler that only accepted
  a range, so every request came back 400 and the screen was permanently empty.

  The hard part is not the totals, it is "absent". Absence has no attendance
  record - a day nobody turned up is a day with no row at all - so counting
  rows with status "absent" reports almost nothing, which is what this did
  before. So the month is laid out from the organisation's own calendar
  (utils/payrollCalendar.js, the same one payroll uses), and each working day
  a person was employed for is classified from what is or is not recorded
  against it. That makes the report agree with the payslip, which is the only
  way an admin can use one to check the other.

  Days worked on a weekly-off or holiday are counted separately as extra days
  rather than folded into attendance, because they are not attendance against
  a day somebody was due in - they are the overtime an admin confirms before
  the month closes.
*/

const pad2 = (n) => String(n).padStart(2, "0");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The range a month covers. */
const monthRange = (month) => {
    const [y, m] = month.split("-").map(Number);
    return {
        from: `${y}-${pad2(m)}-01`,
        to: `${y}-${pad2(m)}-${pad2(new Date(y, m, 0).getDate())}`,
    };
};

/** Every month touched by a date range, as YYYY-MM. */
const monthsBetween = (from, to) => {
    const out = [];
    let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    const last = to.slice(0, 7);
    for (let i = 0; i < 120; i += 1) {
        const key = `${y}-${pad2(m)}`;
        out.push(key);
        if (key >= last) break;
        m += 1;
        if (m > 12) { m = 1; y += 1; }
    }
    return out;
};

/** What each date in the range is, from the organisation's calendar. */
const calendarForRange = (from, to, policy) => {
    const days = [];
    for (const month of monthsBetween(from, to)) {
        for (const day of buildMonthCalendar(month, policy)) {
            if (day.date >= from && day.date <= to) days.push(day);
        }
    }
    return days;
};

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

const getReports = async (req, res) => {
    try {
        const { month: monthParam, year, from: fromParam, to: toParam } = req.query;

        // ?month=2026-10, or the screen's ?month=10&year=2026, or from/to.
        let month = null;
        if (monthParam && MONTH_RE.test(String(monthParam))) {
            month = String(monthParam);
        } else if (monthParam && year) {
            month = `${year}-${pad2(monthParam)}`;
            if (!MONTH_RE.test(month)) {
                return res.status(400).json({ message: "month and year are not a real month" });
            }
        }

        let from = fromParam;
        let to = toParam;
        if (month) ({ from, to } = monthRange(month));

        if (!from || !to) {
            return res.status(400).json({
                message: "Pass a month (month=YYYY-MM, or month and year) or a from and to date",
            });
        }
        if (from > to) {
            return res.status(400).json({ message: "from must not be after to" });
        }

        const [policy, employees, records] = await Promise.all([
            AttendancePolicy.findOne().lean(),
            Employee.find()
                .select("name email department jobRole joiningDate manager")
                .populate("manager", "name email")
                .sort({ name: 1 })
                .lean(),
            Attendance.find({ date: { $gte: from, $lte: to } }).lean(),
        ]);

        const calendar = calendarForRange(from, to, policy);
        const workingDays = calendar.filter((d) => d.kind === "working");
        // Days nobody was due in. Work on one of these is overtime, not
        // attendance, so it is counted on its own.
        const nonWorking = new Set(
            calendar.filter((d) => d.kind !== "working").map((d) => d.date)
        );

        const recordsByEmployee = new Map();
        for (const r of records) {
            const key = String(r.employee);
            if (!recordsByEmployee.has(key)) recordsByEmployee.set(key, []);
            recordsByEmployee.get(key).push(r);
        }

        const report = employees.map((emp) => {
            const own = recordsByEmployee.get(String(emp._id)) || [];
            const byDate = new Map(own.map((r) => [r.date, r]));
            const worked = summariseWorked(own);

            // Somebody who joined on the 16th was not absent for the first
            // fortnight. Same reasoning as utils/payrollCalendar.daysOnPayroll.
            const joined = emp.joiningDate && emp.joiningDate > from ? emp.joiningDate : from;
            const dueIn = workingDays.filter((d) => d.date >= joined);

            let absent = 0;
            let leave = 0;
            let pendingDays = 0;
            for (const day of dueIn) {
                const r = byDate.get(day.date);
                if (!r) { absent += 1; continue; }
                if (r.status === "leave") { leave += 1; continue; }
                if (r.status === "holiday" || r.status === "weekend") continue;
                if (isOutOfPremisesPending(r)) { pendingDays += 1; continue; }
                if (!isCountedTowardHours(r)) { absent += 1; continue; }
                if (r.status === "absent") absent += 1;
            }

            const extraDaysWorked = own.filter(
                (r) => nonWorking.has(r.date)
                    && ["present", "half-day"].includes(r.status)
                    && isCountedTowardHours(r)
            ).length;

            const presentOnDueDays = own.filter(
                (r) => !nonWorking.has(r.date)
                    && r.date >= joined
                    && ["present", "half-day"].includes(r.status)
                    && isCountedTowardHours(r)
            );
            const creditedDays = presentOnDueDays.reduce(
                (sum, r) => sum + (r.status === "half-day" ? 0.5 : 1), 0
            );

            return {
                employee: {
                    _id: emp._id,
                    name: emp.name,
                    email: emp.email,
                    department: emp.department || null,
                    jobRole: emp.jobRole || null,
                    manager: emp.manager?.name || null,
                },
                dueDays: dueIn.length,
                // On days they were due in, so these never double-count the
                // extra days reported beside them.
                present: presentOnDueDays.filter((r) => r.status === "present").length,
                halfDay: presentOnDueDays.filter((r) => r.status === "half-day").length,
                absent,
                leave,
                extraDaysWorked,
                totalHours: worked.totalHours,
                pendingApproval: worked.pendingApproval,
                pendingDays,
                pendingHours: worked.pendingHours,
                rejected: worked.rejected,
                lateCount: own.filter((r) => r.isLateCheckIn).length,
                earlyCheckout: own.filter((r) => r.isEarlyCheckOut).length,
                wfh: own.filter((r) => r.workMode === "WFH").length,
                outOfBoundary: own.filter((r) => r.locationWithinBoundary === false).length,
                // Their own attendance against the days they were due in.
                attendancePct: dueIn.length
                    ? Math.round((creditedDays / dueIn.length) * 100)
                    : null,
                holiday: own.filter((r) => r.status === "holiday").length,
            };
        });

        const orgWorked = summariseWorked(records);
        const rated = report.filter((r) => r.attendancePct !== null);

        const summary = {
            from,
            to,
            totalEmployees: employees.length,
            totalWorkingDays: workingDays.length,
            // The average of each person's own percentage, so a part-month
            // joiner does not drag the figure down for everybody else.
            avgAttendance: rated.length
                ? round1(rated.reduce((sum, r) => sum + r.attendancePct, 0) / rated.length)
                : 0,
            totalLateCheckins: records.filter((r) => r.isLateCheckIn).length,
            // The old name for the same figure, still read in places.
            totalLate: records.filter((r) => r.isLateCheckIn).length,
            totalPresent: orgWorked.present,
            totalHalfDays: orgWorked.halfDay,
            totalAbsent: report.reduce((n, r) => n + r.absent, 0),
            totalLeave: report.reduce((n, r) => n + r.leave, 0),
            totalExtraDays: report.reduce((n, r) => n + r.extraDaysWorked, 0),
            totalHours: orgWorked.totalHours,
            totalPendingApproval: orgWorked.pendingApproval,
            totalPendingHours: orgWorked.pendingHours,
            totalWfh: records.filter((r) => r.workMode === "WFH").length,
            totalRecords: records.length,
        };

        return res.json({
            month: month || null,
            from,
            to,
            summary,
            employees: report,
            // Older names, kept so nothing that already reads them breaks.
            orgSummary: summary,
            employeeReports: report,
        });
    } catch (err) {
        console.error("getReports error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    getPolicy,
    updatePolicy,
    addHoliday,
    removeHoliday,
    getReports,
};
