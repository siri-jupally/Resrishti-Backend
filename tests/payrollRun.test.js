/**
 * The payroll run lifecycle (Payroll, Phase 2).
 *
 * What turns a calculation into a payroll: it may only run on a closed
 * attendance month, anybody who cannot be computed is named rather than paid a
 * guess, the person who prepared it cannot approve it, and a locked month
 * cannot be paid twice.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const PayrollRun = require("../models/PayrollRun");
const PayrollLine = require("../models/PayrollLine");
const PayrollProfile = require("../models/PayrollProfile");
const PayrollAudit = require("../models/PayrollAudit");
const PaidDayPolicy = require("../models/PaidDayPolicy");
const PayrollSettings = require("../models/PayrollSettings");
const AttendanceMonthLock = require("../models/AttendanceMonthLock");
const AttendancePolicy = require("../models/AttendancePolicy");
const Attendance = require("../models/Attendance");
const Leave = require("../models/Leave");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");

const runs = require("../controllers/payrollRunController");
const { seedPaidDayPolicies, getSettings } = require("../utils/payrollDefaults");
const { buildMonthCalendar } = require("../utils/payrollCalendar");

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

const MONTH = "2026-03";

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

let admin;
let accountant;
let manager;
let employee;
let workingDates;

beforeEach(async () => {
    await Promise.all([
        PayrollRun.deleteMany({}), PayrollLine.deleteMany({}), PayrollProfile.deleteMany({}),
        PayrollAudit.deleteMany({}), PaidDayPolicy.deleteMany({}), PayrollSettings.deleteMany({}),
        AttendanceMonthLock.deleteMany({}), AttendancePolicy.deleteMany({}),
        Attendance.deleteMany({}), Leave.deleteMany({}),
        Employee.deleteMany({}), Manager.deleteMany({}), Admin.deleteMany({}),
    ]);

    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    manager = await Manager.create({ name: "Mgr", email: "m@test.com", password: "secret123" });
    employee = await Employee.create({
        name: "Emp", email: "e@test.com", password: "secret123", manager: manager._id,
    });
    // The accountant is an employee with the payroll tag, not a login of its
    // own; the controllers see them as req.payrollEmployee. Employee.manager
    // is required, so this comes after the manager exists.
    accountant = await Employee.create({
        name: "Acc", email: "acc@test.com", password: "secret123",
        manager: manager._id, canPreparePayroll: true,
    });

    await AttendancePolicy.create({ weeklyOffDays: [0, 6], holidays: [] });
    await seedPaidDayPolicies();

    workingDates = buildMonthCalendar(MONTH, { weeklyOffDays: [0, 6], holidays: [] })
        .filter((d) => d.kind === "working")
        .map((d) => d.date);
});

const asAdmin = (o = {}) => mockReq({ admin, ...o });
const asAccountant = (o = {}) => mockReq({ payrollEmployee: accountant, ...o });

const closeAttendanceMonth = () =>
    AttendanceMonthLock.create({ month: MONTH, status: "locked", lockedAt: new Date() });

const tagForPayroll = async (person = employee, personType = "Employee", overrides = {}) =>
    PayrollProfile.create({
        personType,
        personId: person._id,
        employmentType: "permanent",
        payModel: "monthly",
        rates: [{ effectiveFrom: "2026-01-01", amount: 30000 }],
        paidDayPolicy: (await PaidDayPolicy.findOne({ name: "Salaried — everything paid" }))._id,
        ...overrides,
    });

// Attendance has to be written before the month is closed, or the lock guard
// refuses it — which is the guard doing its job.
const markFullMonth = async (person = employee, field = "employee") => {
    await Attendance.insertMany(
        workingDates.map((date) => ({
            [field]: person._id,
            date,
            status: "present",
            workingHours: 8,
            approvalStatus: "auto-approved",
        }))
    );
};

// The lock guard refuses attendance writes once a month is closed — correctly.
// A test that needs to change attendance therefore reopens, writes, and closes
// again, which is what an admin would have to do too.
const withMonthOpen = async (fn) => {
    await AttendanceMonthLock.updateOne({ month: MONTH }, { $set: { status: "open" } });
    await fn();
    await AttendanceMonthLock.updateOne({ month: MONTH }, { $set: { status: "locked" } });
};

const calculate = async (req = asAccountant({ params: { month: MONTH } })) => {
    const res = mockRes();
    await runs.calculateRun(req, res);
    return res;
};

// ──────────────────────── the hard dependency ────────────────────────────

describe("the attendance lock gate", () => {
    test("payroll refuses to calculate on a month that is still open", async () => {
        await tagForPayroll();
        await markFullMonth();
        const res = await calculate();
        expect(res.statusCode).toBe(409);
        expect(res.body.needsAttendanceLock).toBe(true);
        expect(await PayrollRun.countDocuments()).toBe(0);
    });

    test("and calculates once the month is closed", async () => {
        await tagForPayroll();
        await markFullMonth();
        await closeAttendanceMonth();
        const res = await calculate();
        expect(res.statusCode).toBe(200);
        expect(res.body.run.status).toBe("draft");
        expect(res.body.lineCount).toBe(1);
    });
});

// ───────────────────────────── calculating ───────────────────────────────

describe("calculating a month", () => {
    beforeEach(async () => {
        await markFullMonth();
        await closeAttendanceMonth();
    });

    test("a full month pays the full salary", async () => {
        await tagForPayroll();
        await calculate();
        const line = await PayrollLine.findOne({ month: MONTH });
        expect(line.net).toBe(30000);
        expect(line.lopDays).toBe(0);
        expect(line.personName).toBe("Emp");
    });

    test("the run totals match its lines", async () => {
        await tagForPayroll();
        await calculate();
        const run = await PayrollRun.findOne({ month: MONTH });
        const lines = await PayrollLine.find({ run: run._id }).lean();
        const sum = lines.reduce((s, l) => s + l.net, 0);
        expect(run.totals.net).toBe(sum);
        expect(run.totals.people).toBe(lines.length);
    });

    test("unpaid leave is deducted, paid leave is not", async () => {
        await tagForPayroll();
        const [firstWorking] = workingDates;
        await withMonthOpen(() =>
            Attendance.updateOne(
                { employee: employee._id, date: firstWorking },
                { $set: { status: "leave" } }
            )
        );
        await Leave.create({
            employee: employee._id, type: "unpaid",
            startDate: firstWorking, endDate: firstWorking,
            reason: "Personal", status: "approved",
        });
        await calculate();
        const line = await PayrollLine.findOne({ month: MONTH });
        expect(line.days.leaveUnpaid).toBe(1);
        expect(line.net).toBe(29000);
    });

    test("what the figures were worked out from is kept on the run", async () => {
        await tagForPayroll();
        await calculate();
        const run = await PayrollRun.findOne({ month: MONTH });
        expect(run.settingsSnapshot.perDayRateBasis).toBe("fixed30");
        expect(run.settingsSnapshot.overtime.value).toBe(2);
    });

    test("managers are paid by the same run", async () => {
        await tagForPayroll();
        await tagForPayroll(manager, "Manager");
        const ManagerAttendance = require("../models/ManagerAttendance");
        await withMonthOpen(() =>
            ManagerAttendance.insertMany(
                workingDates.map((date) => ({
                    manager: manager._id, date, status: "present",
                    workingHours: 8, approvalStatus: "auto-approved",
                }))
            )
        );
        await calculate();
        const lines = await PayrollLine.find({ month: MONTH }).lean();
        expect(lines.map((l) => l.personType).sort()).toEqual(["Employee", "Manager"]);
    });
});

// ───────────────────────── nobody is paid a guess ────────────────────────

describe("people who cannot be calculated", () => {
    beforeEach(async () => {
        await markFullMonth();
        await closeAttendanceMonth();
    });

    test("somebody with no payroll profile is named, not paid", async () => {
        const res = await calculate();
        const codes = res.body.exceptions.map((e) => e.code);
        expect(codes).toContain("noProfile");
        expect(res.body.lineCount).toBe(0);
    });

    test("somebody with no rate in force that month is named", async () => {
        await tagForPayroll(employee, "Employee", {
            rates: [{ effectiveFrom: "2026-06-01", amount: 30000 }],
        });
        const res = await calculate();
        expect(res.body.exceptions.map((e) => e.code)).toContain("noRate");
    });

    test("somebody with no attendance at all is named rather than docked", async () => {
        await Attendance.deleteMany({});
        await tagForPayroll();
        const res = await calculate();
        expect(res.body.exceptions.map((e) => e.code)).toContain("noAttendance");
        expect(res.body.lineCount).toBe(0);
    });

    test("somebody taken off payroll is simply left out, not an exception", async () => {
        await tagForPayroll(employee, "Employee", { isActive: false });
        const res = await calculate();
        // The manager is genuinely untagged, so noProfile is expected for them.
        // The point is that the leaver is neither paid nor flagged.
        const names = res.body.exceptions.map((e) => e.name);
        expect(names).not.toContain("Emp");
        expect(res.body.lineCount).toBe(0);
    });

    test("days nobody approved are flagged on the line", async () => {
        await tagForPayroll();
        await AttendanceMonthLock.updateOne({ month: MONTH }, { $set: { status: "open" } });
        await Attendance.updateOne(
            { employee: employee._id, date: workingDates[0] },
            { $set: { approvalStatus: "pending", locationWithinBoundary: false } }
        );
        await AttendanceMonthLock.updateOne({ month: MONTH }, { $set: { status: "locked" } });
        await calculate();
        const line = await PayrollLine.findOne({ month: MONTH });
        expect(line.exceptions.map((e) => e.code)).toContain("unapprovedDays");
        expect(line.net).toBe(29000);
    });
});

// ──────────────────────────── the lifecycle ──────────────────────────────

describe("the five-status lifecycle", () => {
    beforeEach(async () => {
        await tagForPayroll();
        await markFullMonth();
        await closeAttendanceMonth();
        await calculate();
        // Generating leaves a draft; submitting is a separate, deliberate step.
        await submit();
    });

    const submit = async (req) => {
        const res = mockRes();
        await runs.submitRun(req || mockReq({ payrollEmployee: accountant, params: { month: MONTH } }), res);
        return res;
    };

    const approve = async (req) => {
        const res = mockRes();
        await runs.approveRun(req, res);
        return res;
    };

    test("an admin approves what the accountant prepared", async () => {
        const res = await approve(asAdmin({ params: { month: MONTH } }));
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe("approved");
    });

    test("the person who prepared it cannot approve it", async () => {
        // Recalculate as the admin, so they are the preparer.
        await PayrollRun.updateOne({ month: MONTH }, { $set: { status: "draft" } });
        const settings = await getSettings();
        settings.approvalDepth = "makerChecker";
        await settings.save();
        // Recalculate and submit as the admin, so they are the preparer.
        await calculate(asAdmin({ params: { month: MONTH } }));
        await submit(asAdmin({ params: { month: MONTH } }));

        const res = await approve(asAdmin({ params: { month: MONTH } }));
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/somebody else/i);
    });

    test("an approved run cannot be closed until it is paid", async () => {
        await approve(asAdmin({ params: { month: MONTH } }));
        const res = mockRes();
        await runs.closeRun(asAdmin({ params: { month: MONTH } }), res);
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/record the payments first/i);
    });

    test("a submitted month cannot be recalculated, so it cannot be paid twice", async () => {
        await approve(asAdmin({ params: { month: MONTH } }));
        const res = await calculate();
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/before recalculating/i);
    });

    test("rejection needs a reason and sends it back to draft", async () => {
        const noReason = mockRes();
        await runs.rejectRun(asAdmin({ params: { month: MONTH }, body: {} }), noReason);
        expect(noReason.statusCode).toBe(400);

        const res = mockRes();
        await runs.rejectRun(
            asAdmin({ params: { month: MONTH }, body: { reason: "Overtime looks wrong for the yard crew" } }),
            res
        );
        expect(res.body.status).toBe("draft");
        expect(res.body.rejectionReason).toMatch(/yard crew/);
    });

    test("a rejected run can be corrected and resubmitted", async () => {
        await runs.rejectRun(
            asAdmin({ params: { month: MONTH }, body: { reason: "Please check the half-days" } }),
            mockRes()
        );
        // Recalculating is allowed again now it is a draft, and it clears the
        // rejection rather than leaving a stale reason on a fresh run.
        const recalc = await calculate();
        expect(recalc.statusCode).toBe(200);
        const again = await submit();
        expect(again.body.status).toBe("pending-approval");
        expect(again.body.rejectionReason).toBeUndefined();
    });

    test("reopening needs a reason and puts it back to draft", async () => {
        await approve(asAdmin({ params: { month: MONTH } }));
        const noReason = mockRes();
        await runs.reopenRun(asAdmin({ params: { month: MONTH }, body: {} }), noReason);
        expect(noReason.statusCode).toBe(400);

        const res = mockRes();
        await runs.reopenRun(
            asAdmin({ params: { month: MONTH }, body: { reason: "Late leave approval" } }),
            res
        );
        expect(res.body.status).toBe("draft");
        expect(res.body.reopenReason).toBe("Late leave approval");
    });

    test("approving is refused before submission", async () => {
        await runs.rejectRun(
            asAdmin({ params: { month: MONTH }, body: { reason: "back to draft please" } }),
            mockRes()
        );
        const res = await approve(asAdmin({ params: { month: MONTH } }));
        expect(res.statusCode).toBe(409);
    });
});

// ────────────────────────── manual adjustments ───────────────────────────

describe("adjustments", () => {
    let line;
    beforeEach(async () => {
        await tagForPayroll();
        await markFullMonth();
        await closeAttendanceMonth();
        await calculate();
        line = await PayrollLine.findOne({ month: MONTH });
    });

    const adjust = async (body) => {
        const res = mockRes();
        await runs.adjustLine(
            asAccountant({ params: { month: MONTH, lineId: String(line._id) }, body }),
            res
        );
        return res;
    };

    test("an adjustment changes the net and is kept with its reason", async () => {
        const res = await adjust({ category: "bonus", amount: 2000, reason: "Festival bonus agreed" });
        expect(res.statusCode).toBe(200);
        expect(res.body.net).toBe(32000);
        expect(res.body.adjustmentEntries[0].reason).toBe("Festival bonus agreed");
    });

    test("the run total follows", async () => {
        await adjust({ category: "bonus", amount: 2000, reason: "Festival bonus agreed" });
        const run = await PayrollRun.findOne({ month: MONTH });
        expect(run.totals.net).toBe(32000);
    });

    test("an uncategorised adjustment is refused", async () => {
        const res = await adjust({ category: "whatever", amount: 100, reason: "Because" });
        expect(res.statusCode).toBe(400);
    });

    test("one beyond the cap is refused", async () => {
        const res = await adjust({ category: "bonus", amount: 999999, reason: "Very large bonus" });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/cannot exceed/i);
    });

    test("one without a reason is refused", async () => {
        const res = await adjust({ category: "bonus", amount: 100, reason: "" });
        expect(res.statusCode).toBe(400);
    });

    test("a run with the approver cannot be adjusted", async () => {
        // Submitting is enough — once it has left the preparer's hands the
        // figures are what somebody is being asked to approve.
        await runs.submitRun(mockReq({ payrollEmployee: accountant, params: { month: MONTH } }), mockRes());
        const res = await adjust({ category: "bonus", amount: 100, reason: "Too late now" });
        expect(res.statusCode).toBe(409);
    });

    /*
      An accountant is an employee now, so they have a line of their own in the
      run they prepare. These two cover the guard that stops them from paying
      themselves a bonus, and confirm it does not get in anybody else's way.
    */
    describe("their own line", () => {
        let ownLine;
        beforeEach(async () => {
            // The outer beforeEach has already closed the month, and the lock
            // refuses attendance writes — correctly — so the accountant's own
            // attendance goes in with the month briefly open, then the run is
            // recalculated to pick up their line.
            await tagForPayroll(accountant);
            await withMonthOpen(() => markFullMonth(accountant));
            await calculate(asAdmin({ params: { month: MONTH } }));
            ownLine = await PayrollLine.findOne({ month: MONTH, personId: accountant._id });
        });

        const adjustOwn = async (req) => {
            const res = mockRes();
            await runs.adjustLine(
                req({
                    params: { month: MONTH, lineId: String(ownLine._id) },
                    body: { category: "bonus", amount: 1000, reason: "A bonus for myself" },
                }),
                res
            );
            return res;
        };

        test("an accountant cannot adjust their own pay", async () => {
            const res = await adjustOwn(asAccountant);
            expect(res.statusCode).toBe(403);
            const after = await PayrollLine.findById(ownLine._id);
            expect(after.adjustments || 0).toBe(0);
        });

        test("but an admin can adjust it for them", async () => {
            const res = await adjustOwn(asAdmin);
            expect(res.statusCode).toBe(200);
            expect(res.body.adjustments).toBe(1000);
        });

        // The guard reads whichever of the two staff branches the request
        // came in on, so the manager case is worth its own test rather than
        // assumed from the employee one.
        test("a manager accountant cannot adjust their own pay either", async () => {
            const ManagerAttendance = require("../models/ManagerAttendance");
            await tagForPayroll(manager, "Manager");
            await withMonthOpen(() =>
                ManagerAttendance.insertMany(
                    workingDates.map((date) => ({
                        manager: manager._id, date, status: "present",
                        workingHours: 8, approvalStatus: "auto-approved",
                    }))
                )
            );
            await calculate(asAdmin({ params: { month: MONTH } }));
            const mgrLine = await PayrollLine.findOne({
                month: MONTH, personType: "Manager", personId: manager._id,
            });
            expect(mgrLine).toBeTruthy();

            const res = mockRes();
            await runs.adjustLine(
                mockReq({
                    payrollManager: manager,
                    params: { month: MONTH, lineId: String(mgrLine._id) },
                    body: { category: "bonus", amount: 1000, reason: "A bonus for myself" },
                }),
                res
            );
            expect(res.statusCode).toBe(403);
        });

        test("and the accountant can still adjust everybody else", async () => {
            const other = await PayrollLine.findOne({ month: MONTH, personId: employee._id });
            const res = mockRes();
            await runs.adjustLine(
                asAccountant({
                    params: { month: MONTH, lineId: String(other._id) },
                    body: { category: "bonus", amount: 500, reason: "Worked the weekend" },
                }),
                res
            );
            expect(res.statusCode).toBe(200);
        });
    });

    test("an approved run cannot be adjusted without reopening", async () => {
        await runs.submitRun(mockReq({ payrollEmployee: accountant, params: { month: MONTH } }), mockRes());
        await runs.approveRun(asAdmin({ params: { month: MONTH } }), mockRes());
        const res = await adjust({ category: "bonus", amount: 100, reason: "Too late now" });
        expect(res.statusCode).toBe(409);
    });
});

// ─────────────────────────────── the audit ───────────────────────────────

describe("the audit log", () => {
    test("every step is recorded with who did it", async () => {
        await tagForPayroll();
        await markFullMonth();
        await closeAttendanceMonth();
        await calculate();
        await runs.submitRun(mockReq({ payrollEmployee: accountant, params: { month: MONTH } }), mockRes());
        await runs.approveRun(asAdmin({ params: { month: MONTH } }), mockRes());

        const entries = await PayrollAudit.find({ month: MONTH }).sort({ createdAt: 1 }).lean();
        expect(entries.map((e) => e.action)).toEqual([
            "run.calculated", "run.submitted", "run.approved",
        ]);
        // Recorded against the employee record, which is what still exists
        // if the assignment is later revoked.
        expect(entries[0].actor.userType).toBe("Employee");
        expect(entries[1].actor.userType).toBe("Employee");
        expect(entries[2].actor.userType).toBe("Admin");
    });

    test("a reopen keeps its reason in the log", async () => {
        await tagForPayroll();
        await markFullMonth();
        await closeAttendanceMonth();
        await calculate();
        await runs.submitRun(mockReq({ payrollEmployee: accountant, params: { month: MONTH } }), mockRes());
        await runs.approveRun(asAdmin({ params: { month: MONTH } }), mockRes());
        await runs.reopenRun(
            asAdmin({ params: { month: MONTH }, body: { reason: "Leave approved late" } }),
            mockRes()
        );
        const entry = await PayrollAudit.findOne({ action: "run.reopened" });
        expect(entry.reason).toBe("Leave approved late");
    });
});
