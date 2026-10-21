/**
 * The month review: extra pay, leave, and the admin's confirmation.
 *
 * Pending approvals block a close because an undecided day is wrong. These
 * two are different: they are already decided and correct, and they are the
 * two places where attendance quietly becomes money. A Sunday somebody worked
 * is overtime nobody approved; a leave type decides whether a day is paid. So
 * the close is gated on an admin having agreed to both figures, and extra pay
 * carries the one adjustment available — taking a day out of it.
 *
 * Also covers the combined staff list, which is the same idea read the other
 * way round: a manager is a member of staff whose role is manager, so there is
 * one list with a role rather than two endpoints.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const AttendanceMonthLock = require("../models/AttendanceMonthLock");
const Attendance = require("../models/Attendance");
const ManagerAttendance = require("../models/ManagerAttendance");
const AttendancePolicy = require("../models/AttendancePolicy");
const Leave = require("../models/Leave");
const ManagerLeave = require("../models/ManagerLeave");
const PayrollProfile = require("../models/PayrollProfile");
const PayrollSettings = require("../models/PayrollSettings");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");

const settlements = require("../controllers/attendanceLockSettlements");
const locks = require("../controllers/attendanceLockController");
const staff = require("../controllers/adminStaffController");

let mongod;

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { res.statusCode = code; return res; },
        json(data) { res.body = data; return res; },
    };
    return res;
}
const mockReq = (o = {}) => ({ body: {}, params: {}, query: {}, ...o });

// March 2026. The 1st is a Sunday and the 8th is a Sunday, so both are weekly
// offs under the default pattern; the 10th is a Tuesday.
const MONTH = "2026-03";
const SUNDAY = "2026-03-08";
const TUESDAY = "2026-03-10";

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

let admin;
let manager;
let employee;

beforeEach(async () => {
    await Promise.all([
        AttendanceMonthLock.deleteMany({}), Attendance.deleteMany({}),
        ManagerAttendance.deleteMany({}), AttendancePolicy.deleteMany({}),
        Leave.deleteMany({}), ManagerLeave.deleteMany({}),
        PayrollProfile.deleteMany({}), PayrollSettings.deleteMany({}),
        Employee.deleteMany({}), Manager.deleteMany({}), Admin.deleteMany({}),
    ]);
    // The Admin model has no name, so an actor name falls back to the email.
    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    manager = await Manager.create({ name: "Mgr", email: "m@test.com", password: "secret123" });
    employee = await Employee.create({
        name: "Emp", email: "e@test.com", password: "secret123", manager: manager._id,
    });

    // Overtime on, and the employee eligible for it, so a Sunday worked is
    // pay rather than just a day recorded.
    await PayrollSettings.create({
        overtime: { enabled: true, mode: "multiplier", value: 2, countWeeklyOff: true, countHoliday: true },
    });
    await PayrollProfile.create({
        personType: "Employee", personId: employee._id,
        employmentType: "permanent", payModel: "monthly",
        overtimeEligible: true,
        rates: [{ amount: 30000, effectiveFrom: "2026-01-01" }],
    });
});

const asAdmin = (o = {}) => mockReq({ admin, ...o });

const workedOn = (date, fields = {}) =>
    Attendance.create({
        employee: employee._id,
        date,
        status: "present",
        workingHours: 8,
        approvalStatus: "auto-approved",
        checkIn: { time: new Date(`${date}T09:00:00Z`) },
        ...fields,
    });

const get = async (month = MONTH) => {
    const res = mockRes();
    await settlements.getSettlements(asAdmin({ params: { month } }), res);
    return res;
};

// ─────────────────────────────── extra pay ────────────────────────────────

describe("extra pay", () => {
    test("a day worked on a weekly off is listed, with whose it is", async () => {
        await workedOn(SUNDAY);
        const res = await get();
        expect(res.body.extraPay.totalDays).toBe(1);
        expect(res.body.extraPay.payableDays).toBe(1);
        expect(res.body.extraPay.people[0].name).toBe("Emp");
        expect(res.body.extraPay.people[0].days[0].kind).toBe("weeklyOff");
    });

    test("an ordinary working day is not extra pay", async () => {
        await workedOn(TUESDAY);
        const res = await get();
        expect(res.body.extraPay.totalDays).toBe(0);
    });

    test("a holiday worked is listed as a holiday, by name", async () => {
        await AttendancePolicy.create({
            holidays: [{ date: TUESDAY, name: "Holi" }],
        });
        await workedOn(TUESDAY);
        const res = await get();
        expect(res.body.extraPay.people[0].days[0].kind).toBe("holiday");
        expect(res.body.extraPay.people[0].days[0].holiday).toBe("Holi");
    });

    /*
      Listed but not payable: the work happened and should be visible, and the
      admin should not be asked to agree to money the rules never create.
    */
    test("somebody not eligible for overtime is listed, with why it pays nothing", async () => {
        await PayrollProfile.updateOne(
            { personId: employee._id }, { $set: { overtimeEligible: false } }
        );
        await workedOn(SUNDAY);
        const res = await get();
        expect(res.body.extraPay.totalDays).toBe(1);
        expect(res.body.extraPay.payableDays).toBe(0);
        expect(res.body.extraPay.people[0].days[0].whyNot).toMatch(/not eligible/i);
    });

    test("overtime switched off pays nothing, and says so", async () => {
        await PayrollSettings.updateOne({}, { $set: { "overtime.enabled": false } });
        await workedOn(SUNDAY);
        const res = await get();
        expect(res.body.extraPay.payableDays).toBe(0);
        expect(res.body.extraPay.overtimePaysFor.enabled).toBe(false);
    });

    test("a day still awaiting an out-of-premises decision is not counted as pay", async () => {
        // It is a blocker, not a payment - it counts as neither worked nor
        // rejected until somebody decides.
        await workedOn(SUNDAY, { approvalStatus: "pending", locationWithinBoundary: false });
        const res = await get();
        expect(res.body.extraPay.totalDays).toBe(0);
    });

    test("managers appear too — they are paid by the same run", async () => {
        await PayrollProfile.create({
            personType: "Manager", personId: manager._id,
            employmentType: "permanent", payModel: "monthly",
            overtimeEligible: true,
            rates: [{ amount: 50000, effectiveFrom: "2026-01-01" }],
        });
        await ManagerAttendance.create({
            manager: manager._id, date: SUNDAY, status: "present",
            workingHours: 8, approvalStatus: "auto-approved",
        });
        const res = await get();
        expect(res.body.extraPay.people.some((p) => p.personType === "Manager")).toBe(true);
    });
});

// ─────────────────────────── the adjustment ───────────────────────────────

describe("taking a day out of extra pay", () => {
    test("the day stays worked; only the premium stops", async () => {
        const day = await workedOn(SUNDAY);
        const res = mockRes();
        await settlements.adjustExtraPay(
            asAdmin({
                params: { month: MONTH, type: "employee", id: String(day._id) },
                body: { excluded: true, note: "Came in to collect something" },
            }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.extraPay.payableDays).toBe(0);
        expect(res.body.extraPay.excludedDays).toBe(1);

        const after = await Attendance.findById(day._id);
        expect(after.status).toBe("present");
        expect(after.workingHours).toBe(8);
        expect(after.extraPayExcluded).toBe(true);
        expect(after.extraPayDecidedByName).toBe(admin.email);
    });

    test("it can be put back", async () => {
        const day = await workedOn(SUNDAY, { extraPayExcluded: true });
        const res = mockRes();
        await settlements.adjustExtraPay(
            asAdmin({
                params: { month: MONTH, type: "employee", id: String(day._id) },
                body: { excluded: false },
            }),
            res
        );
        expect(res.body.extraPay.payableDays).toBe(1);
    });

    test("the payroll engine honours it", () => {
        const { computeLine } = require("../utils/payrollEngine");
        const { buildMonthCalendar, summariseCalendar } = require("../utils/payrollCalendar");
        const calendar = buildMonthCalendar(MONTH, null);
        const base = {
            profile: { payModel: "monthly", overtimeEligible: true },
            rate: { amount: 30000, effectiveFrom: "2026-01-01" },
            policy: null,
            settings: {
                perDayBasis: "fixed30",
                overtime: { enabled: true, mode: "multiplier", value: 2, countWeeklyOff: true },
            },
            calendar,
            calendarSummary: summariseCalendar(calendar),
        };
        const worked = { date: SUNDAY, status: "present", workingHours: 8, approvalStatus: "auto-approved" };

        const paid = computeLine({ ...base, records: [worked] });
        const excluded = computeLine({
            ...base, records: [{ ...worked, extraPayExcluded: true }],
        });

        expect(paid.overtimeDays).toBe(1);
        expect(excluded.overtimeDays).toBe(0);
        expect(excluded.overtimePay).toBe(0);
    });

    test("a day from another month is refused", async () => {
        const day = await workedOn("2026-04-05");
        const res = mockRes();
        await settlements.adjustExtraPay(
            asAdmin({
                params: { month: MONTH, type: "employee", id: String(day._id) },
                body: { excluded: true },
            }),
            res
        );
        expect(res.statusCode).toBe(400);
    });

    test("only an admin may adjust it", async () => {
        const day = await workedOn(SUNDAY);
        const res = mockRes();
        await settlements.adjustExtraPay(
            mockReq({
                params: { month: MONTH, type: "employee", id: String(day._id) },
                body: { excluded: true },
            }),
            res
        );
        expect(res.statusCode).toBe(403);
    });

    test("a closed month refuses the change — the figure is settled", async () => {
        const day = await workedOn(SUNDAY);
        await AttendanceMonthLock.create({ month: MONTH, status: "locked", lockedAt: new Date() });
        const res = mockRes();
        await settlements.adjustExtraPay(
            asAdmin({
                params: { month: MONTH, type: "employee", id: String(day._id) },
                body: { excluded: true },
            }),
            res
        );
        expect(res.statusCode).toBe(409);
    });
});

// ────────────────────────────── leave ─────────────────────────────────────

describe("leave", () => {
    test("approved leave in the month is listed, paid or unpaid", async () => {
        await Leave.create({
            employee: employee._id, type: "sick",
            startDate: "2026-03-02", endDate: "2026-03-04",
            reason: "Flu", status: "approved",
        });
        await Leave.create({
            employee: employee._id, type: "unpaid",
            startDate: "2026-03-20", endDate: "2026-03-20",
            reason: "Personal", status: "approved",
        });
        const res = await get();
        expect(res.body.leave.paidDays).toBe(3);
        expect(res.body.leave.unpaidDays).toBe(1);
        expect(res.body.leave.people[0].items).toHaveLength(2);
    });

    test("only the days that fall inside the month are counted", async () => {
        await Leave.create({
            employee: employee._id, type: "casual",
            startDate: "2026-02-26", endDate: "2026-03-02",
            reason: "Family", status: "approved",
        });
        const res = await get();
        expect(res.body.leave.paidDays).toBe(2);   // the 1st and the 2nd
    });

    test("a leave still awaiting a decision is not here — it is a blocker", async () => {
        await Leave.create({
            employee: employee._id, type: "casual",
            startDate: "2026-03-02", endDate: "2026-03-02",
            reason: "Family", status: "pending",
        });
        const res = await get();
        expect(res.body.leave.totalDays).toBe(0);
    });

    test("manager leave is included", async () => {
        await ManagerLeave.create({
            manager: manager._id, type: "casual",
            startDate: "2026-03-05", endDate: "2026-03-05",
            reason: "Family", status: "approved",
        });
        const res = await get();
        expect(res.body.leave.people[0].personType).toBe("Manager");
    });
});

// ─────────────────────────── confirmation ─────────────────────────────────

describe("confirming", () => {
    test("an unconfirmed month is not ready to close", async () => {
        await workedOn(SUNDAY);
        const readiness = await locks.readinessFor(MONTH);
        expect(readiness.ready).toBe(false);
        expect(readiness.blockers.some((b) => b.key === "extraPayUnconfirmed")).toBe(true);
    });

    test("a month with nothing in it owes no confirmation", async () => {
        await workedOn(TUESDAY);
        const readiness = await locks.readinessFor(MONTH);
        expect(readiness.ready).toBe(true);
    });

    test("confirming records who agreed and how many days they saw", async () => {
        await workedOn(SUNDAY);
        const res = mockRes();
        await settlements.confirmSettlement(
            asAdmin({ params: { month: MONTH }, body: { kind: "extraPay", note: "Agreed at the pay meeting" } }),
            res
        );
        expect(res.body.extraPay.confirmation.by.name).toBe(admin.email);
        expect(res.body.extraPay.confirmation.daysConfirmed).toBe(1);
        expect(res.body.extraPay.confirmation.note).toBe("Agreed at the pay meeting");
        expect((await locks.readinessFor(MONTH)).ready).toBe(true);
    });

    /*
      A tick on four days does not cover a fifth that arrived afterwards. The
      count is kept with the confirmation so the difference is visible rather
      than hidden behind an old agreement.
    */
    test("a day added after the tick marks the confirmation stale", async () => {
        await workedOn(SUNDAY);
        await settlements.confirmSettlement(
            asAdmin({ params: { month: MONTH }, body: { kind: "extraPay" } }), mockRes()
        );
        await workedOn("2026-03-01");
        const res = await get();
        expect(res.body.extraPay.confirmation.stale).toBe(true);
        expect(res.body.extraPay.confirmation.daysConfirmed).toBe(1);
        expect(res.body.extraPay.totalDays).toBe(2);
    });

    test("adjusting a day withdraws a confirmation given over the old figure", async () => {
        const day = await workedOn(SUNDAY);
        await settlements.confirmSettlement(
            asAdmin({ params: { month: MONTH }, body: { kind: "extraPay" } }), mockRes()
        );
        const res = mockRes();
        await settlements.adjustExtraPay(
            asAdmin({
                params: { month: MONTH, type: "employee", id: String(day._id) },
                body: { excluded: true, note: "Not a shift" },
            }),
            res
        );
        expect(res.body.extraPay.confirmation).toBeNull();
    });

    test("a confirmation can be withdrawn", async () => {
        await workedOn(SUNDAY);
        await settlements.confirmSettlement(
            asAdmin({ params: { month: MONTH }, body: { kind: "extraPay" } }), mockRes()
        );
        const res = mockRes();
        await settlements.confirmSettlement(
            asAdmin({ params: { month: MONTH }, body: { kind: "extraPay", confirmed: false } }), res
        );
        expect(res.body.extraPay.confirmation).toBeNull();
        expect((await locks.readinessFor(MONTH)).ready).toBe(false);
    });

    test("there is nothing to confirm in an empty month", async () => {
        const res = mockRes();
        await settlements.confirmSettlement(
            asAdmin({ params: { month: MONTH }, body: { kind: "extraPay" } }), res
        );
        expect(res.statusCode).toBe(409);
    });

    test("an unknown kind is refused", async () => {
        const res = mockRes();
        await settlements.confirmSettlement(
            asAdmin({ params: { month: MONTH }, body: { kind: "whatever" } }), res
        );
        expect(res.statusCode).toBe(400);
    });

    test("only an admin may confirm", async () => {
        const res = mockRes();
        await settlements.confirmSettlement(
            mockReq({ params: { month: MONTH }, body: { kind: "extraPay" } }), res
        );
        expect(res.statusCode).toBe(403);
    });

    test("a closed month cannot be confirmed again", async () => {
        await workedOn(SUNDAY);
        await AttendanceMonthLock.create({ month: MONTH, status: "locked", lockedAt: new Date() });
        const res = mockRes();
        await settlements.confirmSettlement(
            asAdmin({ params: { month: MONTH }, body: { kind: "extraPay" } }), res
        );
        expect(res.statusCode).toBe(409);
    });

    test("closing anyway is still possible, and says what was unconfirmed", async () => {
        await workedOn(SUNDAY);
        const refused = mockRes();
        await locks.lockMonth(asAdmin({ params: { month: MONTH }, body: {} }), refused);
        expect(refused.statusCode).toBe(409);

        const forced = mockRes();
        await locks.lockMonth(asAdmin({ params: { month: MONTH }, body: { force: true } }), forced);
        expect(forced.statusCode).toBe(200);
        const entry = forced.body.history[forced.body.history.length - 1];
        expect(entry.reason).toMatch(/extra-pay days awaiting your confirmation/i);
    });

    test("a malformed month is refused", async () => {
        const res = await get("2026-3");
        expect(res.statusCode).toBe(400);
    });
});

// ───────────────────────── everybody, in one list ─────────────────────────

describe("the staff list", () => {
    test("employees and managers come back together, with role as a field", async () => {
        const res = mockRes();
        await staff.listStaff(asAdmin({ query: {} }), res);
        expect(res.body.counts.people).toBe(2);
        expect(res.body.counts.managers).toBe(1);
        expect(res.body.counts.employees).toBe(1);
        // Managers first: the list reads as the shape of the organisation.
        expect(res.body.items[0].role).toBe("Manager");
        expect(res.body.items[0].teamSize).toBe(1);
        expect(res.body.items[1].reportsTo.name).toBe("Mgr");
    });

    test("the job tags somebody carries are named, not left as flags", async () => {
        await Employee.updateOne(
            { _id: employee._id },
            { $set: { canPreparePayroll: true, canSupervise: true } }
        );
        const res = mockRes();
        await staff.listStaff(asAdmin({ query: { role: "Employee" } }), res);
        expect(res.body.items[0].tags).toEqual(["Accountant", "Pickup agent"]);
    });

    test("the gaps an admin chases each have a filter", async () => {
        const res = mockRes();
        await staff.listStaff(asAdmin({ query: { missing: "bank" } }), res);
        expect(res.body.items).toHaveLength(2);     // neither has entered one

        await Employee.updateOne(
            { _id: employee._id }, { $set: { bank: { accountNumber: "12345678901" } } }
        );
        const after = mockRes();
        await staff.listStaff(asAdmin({ query: { missing: "bank" } }), after);
        expect(after.body.items).toHaveLength(1);
        expect(after.body.items[0].role).toBe("Manager");
    });

    test("not on payroll means no pay profile, whatever their role", async () => {
        const res = mockRes();
        await staff.listStaff(asAdmin({ query: { missing: "payroll" } }), res);
        // The employee was tagged in the fixture; the manager never was.
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].name).toBe("Mgr");
    });

    test("the headline counts do not move when the list is filtered", async () => {
        const res = mockRes();
        await staff.listStaff(asAdmin({ query: { role: "Manager" } }), res);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.counts.people).toBe(2);
    });

    test("search covers name, email, role and department", async () => {
        await Employee.updateOne({ _id: employee._id }, { $set: { department: "Yard" } });
        const res = mockRes();
        await staff.listStaff(asAdmin({ query: { search: "yard" } }), res);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.departments).toContain("Yard");
    });

    test("an employee with no manager is counted, because nobody approves their days", async () => {
        await Employee.create({
            name: "Orphan", email: "o@test.com", password: "secret123", manager: manager._id,
        });
        await Employee.updateOne({ email: "o@test.com" }, { $unset: { manager: 1 } });
        const res = mockRes();
        await staff.listStaff(asAdmin({ query: {} }), res);
        expect(res.body.counts.unassigned).toBe(1);
    });
});
