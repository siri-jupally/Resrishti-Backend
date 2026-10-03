/**
 * Attendance month lock (Payroll, Phase 0).
 *
 * Payroll may only compute on a month that cannot move afterwards. These tests
 * cover the two halves of that promise:
 *
 *   · readiness — a month with approvals outstanding is not ready to close,
 *     because a pending out-of-premises day counts as neither worked nor
 *     rejected and the person would be paid short
 *   · the lock itself — once closed, every path that writes attendance is
 *     refused, including the ones that reach it indirectly through a leave
 *     approval, a correction or a holiday
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
const CorrectionRequest = require("../models/CorrectionRequest");
const Leave = require("../models/Leave");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");

const locks = require("../controllers/attendanceLockController");
const mgrAttendance = require("../controllers/attendanceManagerController");
const adminOrg = require("../controllers/adminOrgController");
const adminAttendance = require("../controllers/attendanceAdminController");
const {
    monthOf, monthsBetween, isMonthLocked, lockBlocks, lockBlocksRange,
} = require("../utils/attendanceLock");

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

// A month safely in the past, so "cannot lock the future" never trips.
const MONTH = "2026-03";
const DAY = "2026-03-10";

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
        CorrectionRequest.deleteMany({}), Leave.deleteMany({}),
        Employee.deleteMany({}), Manager.deleteMany({}), Admin.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    manager = await Manager.create({ name: "Mgr", email: "m@test.com", password: "secret123" });
    employee = await Employee.create({
        name: "Emp", email: "e@test.com", password: "secret123", manager: manager._id,
    });
});

const asAdmin = (o = {}) => mockReq({ admin, ...o });
const asManager = (o = {}) => mockReq({ manager, ...o });

const lockIt = async (month = MONTH, body = {}) => {
    const res = mockRes();
    await locks.lockMonth(asAdmin({ params: { month }, body }), res);
    return res;
};

const workedDay = (fields = {}) =>
    Attendance.create({
        employee: employee._id,
        date: DAY,
        status: "present",
        workingHours: 8,
        approvalStatus: "auto-approved",
        checkIn: { time: new Date(`${DAY}T09:00:00Z`) },
        ...fields,
    });

// ───────────────────────────── date maths ─────────────────────────────

describe("month arithmetic", () => {
    test("a date resolves to its month", () => {
        expect(monthOf("2026-03-10")).toBe("2026-03");
        expect(monthOf(new Date("2026-03-10T00:00:00"))).toBe("2026-03");
        expect(monthOf(null)).toBeNull();
    });

    test("a range spanning a year end lists every month it touches", () => {
        expect(monthsBetween("2026-11-20", "2027-01-05"))
            .toEqual(["2026-11", "2026-12", "2027-01"]);
    });

    test("a backwards range does not loop forever", () => {
        expect(monthsBetween("2026-05-10", "2026-01-01")).toEqual(["2026-05"]);
    });
});

// ───────────────────────────── readiness ──────────────────────────────

describe("readiness", () => {
    test("a quiet month is ready", async () => {
        await workedDay();
        const readiness = await locks.readinessFor(MONTH);
        expect(readiness.ready).toBe(true);
        expect(readiness.blockers).toEqual([]);
    });

    test("an out-of-premises day awaiting a decision blocks it", async () => {
        await workedDay({ approvalStatus: "pending", locationWithinBoundary: false });
        const readiness = await locks.readinessFor(MONTH);
        expect(readiness.ready).toBe(false);
        expect(readiness.blockers[0].key).toBe("premisesApprovals");
        expect(readiness.blockers[0].count).toBe(1);
    });

    test("a manager's pending day blocks it too", async () => {
        await ManagerAttendance.create({
            manager: manager._id, date: DAY, status: "present", workingHours: 8,
            approvalStatus: "pending", locationWithinBoundary: false,
            checkIn: { time: new Date(`${DAY}T09:00:00Z`) },
        });
        const readiness = await locks.readinessFor(MONTH);
        expect(readiness.blockers.some((b) => b.key === "premisesApprovals")).toBe(true);
    });

    test("a pending correction blocks it", async () => {
        await CorrectionRequest.create({
            employee: employee._id, date: DAY, reason: "Forgot to check out", status: "pending",
        });
        const readiness = await locks.readinessFor(MONTH);
        expect(readiness.blockers.some((b) => b.key === "corrections")).toBe(true);
    });

    test("a pending leave overlapping the month blocks it", async () => {
        await Leave.create({
            employee: employee._id, type: "casual",
            startDate: "2026-02-27", endDate: "2026-03-02",
            reason: "Family", status: "pending",
        });
        const readiness = await locks.readinessFor(MONTH);
        expect(readiness.blockers.some((b) => b.key === "leaves")).toBe(true);
    });

    test("a decided leave does not", async () => {
        await Leave.create({
            employee: employee._id, type: "casual",
            startDate: "2026-03-01", endDate: "2026-03-02",
            reason: "Family", status: "approved",
        });
        const readiness = await locks.readinessFor(MONTH);
        expect(readiness.ready).toBe(true);
    });

    test("the snapshot counts only hours that actually count", async () => {
        await workedDay();
        await Attendance.create({
            employee: (await Employee.create({
                name: "E2", email: "e2@test.com", password: "secret123", manager: manager._id,
            }))._id,
            date: "2026-03-11", status: "present", workingHours: 8,
            approvalStatus: "rejected",
        });
        const readiness = await locks.readinessFor(MONTH);
        expect(readiness.snapshot.attendanceRecords).toBe(2);
        expect(readiness.snapshot.workedHours).toBe(8);   // the rejected day is not pay
    });
});

// ─────────────────────────── locking a month ──────────────────────────

describe("locking", () => {
    test("a ready month locks", async () => {
        await workedDay();
        const res = await lockIt();
        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe("locked");
        expect(res.body.lockedBy.name).toBe("a@test.com");
        expect(await isMonthLocked(MONTH)).toBe(true);
    });

    test("a month with blockers refuses, and says what they are", async () => {
        await workedDay({ approvalStatus: "pending", locationWithinBoundary: false });
        const res = await lockIt();
        expect(res.statusCode).toBe(409);
        expect(res.body.blockers[0].key).toBe("premisesApprovals");
        expect(await isMonthLocked(MONTH)).toBe(false);
    });

    test("an admin can close it anyway, and what was outstanding is recorded", async () => {
        await workedDay({ approvalStatus: "pending", locationWithinBoundary: false });
        const res = await lockIt(MONTH, { force: true, note: "Decided at the pay meeting" });
        expect(res.statusCode).toBe(200);
        expect(res.body.history[0].reason).toMatch(/outstanding/i);
        expect(res.body.history[0].reason).toMatch(/pay meeting/);
    });

    test("the snapshot is kept on the lock", async () => {
        await workedDay();
        const res = await lockIt();
        expect(res.body.snapshot.workedHours).toBe(8);
        expect(res.body.snapshot.attendanceRecords).toBe(1);
    });

    test("locking twice is refused", async () => {
        await workedDay();
        await lockIt();
        const res = await lockIt();
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/already locked/i);
    });

    test("a future month cannot be locked", async () => {
        const next = new Date();
        next.setFullYear(next.getFullYear() + 1);
        const future = `${next.getFullYear()}-01`;
        const res = await lockIt(future);
        expect(res.statusCode).toBe(400);
    });

    test("a manager cannot lock", async () => {
        const res = mockRes();
        await locks.lockMonth(asManager({ params: { month: MONTH }, body: {} }), res);
        expect(res.statusCode).toBe(403);
    });

    test("a malformed month is refused", async () => {
        const res = await lockIt("2026-13");
        expect(res.statusCode).toBe(400);
    });
});

// ────────────────────── what a locked month refuses ───────────────────

describe("a locked month refuses writes", () => {
    beforeEach(async () => {
        await workedDay();
        await lockIt();
    });

    test("a new attendance row for that month", async () => {
        const other = await Employee.create({
            name: "E3", email: "e3@test.com", password: "secret123", manager: manager._id,
        });
        await expect(
            Attendance.create({ employee: other._id, date: "2026-03-12", status: "present" })
        ).rejects.toThrow(/locked/i);
    });

    test("editing a row already in that month", async () => {
        const row = await Attendance.findOne({ date: DAY });
        row.workingHours = 12;
        await expect(row.save()).rejects.toThrow(/locked/i);
    });

    test("an upsert aimed at that month", async () => {
        await expect(
            Attendance.findOneAndUpdate(
                { employee: employee._id, date: DAY },
                { status: "leave" },
                { upsert: true }
            )
        ).rejects.toThrow(/locked/i);
    });

    test("a sweeping update across that date", async () => {
        await expect(
            Attendance.updateMany({ date: DAY }, { status: "holiday" })
        ).rejects.toThrow(/locked/i);
    });

    test("deleting a row in that month", async () => {
        await expect(Attendance.deleteOne({ date: DAY })).rejects.toThrow(/locked/i);
    });

    test("a bulk insert into that month", async () => {
        // insertMany takes a different hook signature from the rest, so it had
        // its own way of slipping past the lock until this covered it.
        const other = await Employee.create({
            name: "E4", email: "e4@test.com", password: "secret123", manager: manager._id,
        });
        await expect(
            Attendance.insertMany([
                { employee: other._id, date: "2026-03-20", status: "present" },
                { employee: other._id, date: "2026-03-21", status: "present" },
            ])
        ).rejects.toThrow(/locked/i);
        expect(await Attendance.countDocuments({ date: "2026-03-20" })).toBe(0);
    });

    test("a manager attendance row in that month", async () => {
        await expect(
            ManagerAttendance.create({ manager: manager._id, date: DAY, status: "present" })
        ).rejects.toThrow(/locked/i);
    });

    test("but an open month is untouched", async () => {
        const row = await Attendance.create({
            employee: employee._id, date: "2026-04-02", status: "present", workingHours: 8,
        });
        expect(row.date).toBe("2026-04-02");
    });
});

// ─────────────── the paths that reach attendance indirectly ───────────

describe("indirect paths are refused with a readable message", () => {
    beforeEach(async () => {
        await workedDay();
        await lockIt();
    });

    test("approving a leave that falls in the month", async () => {
        const leave = await Leave.create({
            employee: employee._id, type: "casual",
            startDate: "2026-03-05", endDate: "2026-03-06",
            reason: "Family", status: "pending",
        });
        const res = mockRes();
        await mgrAttendance.reviewLeave(
            asManager({ params: { id: String(leave._id) }, body: { status: "approved" } }),
            res
        );
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/2026-03 is locked/);
        expect((await Leave.findById(leave._id)).status).toBe("pending");
    });

    test("a leave spanning a locked month and an open one is refused whole", async () => {
        const leave = await Leave.create({
            employee: employee._id, type: "casual",
            startDate: "2026-03-30", endDate: "2026-04-02",
            reason: "Family", status: "pending",
        });
        const res = mockRes();
        await mgrAttendance.reviewLeave(
            asManager({ params: { id: String(leave._id) }, body: { status: "approved" } }),
            res
        );
        expect(res.statusCode).toBe(409);
    });

    test("an admin override of the same leave", async () => {
        const leave = await Leave.create({
            employee: employee._id, type: "casual",
            startDate: "2026-03-05", endDate: "2026-03-06",
            reason: "Family", status: "pending",
        });
        const res = mockRes();
        await adminOrg.adminReviewLeave(
            asAdmin({ params: { id: String(leave._id) }, body: { status: "approved" } }),
            res
        );
        expect(res.statusCode).toBe(409);
    });

    test("approving an attendance correction for that month", async () => {
        const correction = await CorrectionRequest.create({
            employee: employee._id, date: DAY, reason: "Forgot to check out", status: "pending",
        });
        const res = mockRes();
        await mgrAttendance.reviewCorrection(
            asManager({ params: { id: String(correction._id) }, body: { status: "approved" } }),
            res
        );
        expect(res.statusCode).toBe(409);
        expect((await CorrectionRequest.findById(correction._id)).status).toBe("pending");
    });

    test("deciding an attendance day in that month", async () => {
        const row = await Attendance.findOne({ date: DAY });
        const res = mockRes();
        await mgrAttendance.approveAttendance(
            asManager({ params: { id: String(row._id) }, body: { status: "approved" } }),
            res
        );
        expect(res.statusCode).toBe(409);
    });

    test("declaring a holiday on a date in that month", async () => {
        const res = mockRes();
        await adminAttendance.addHoliday(
            asAdmin({ body: { date: DAY, name: "Founders Day" } }),
            res
        );
        expect(res.statusCode).toBe(409);
        // ...and the day is still a worked day, not rewritten to a holiday.
        expect((await Attendance.findOne({ date: DAY })).status).toBe("present");
    });
});

// ────────────────────────────── reopening ─────────────────────────────

describe("reopening", () => {
    beforeEach(async () => {
        await workedDay();
        await lockIt();
    });

    test("needs a reason", async () => {
        const res = mockRes();
        await locks.reopenMonth(asAdmin({ params: { month: MONTH }, body: {} }), res);
        expect(res.statusCode).toBe(400);
        expect(await isMonthLocked(MONTH)).toBe(true);
    });

    test("a manager cannot reopen", async () => {
        const res = mockRes();
        await locks.reopenMonth(
            asManager({ params: { month: MONTH }, body: { reason: "Correction needed" } }),
            res
        );
        expect(res.statusCode).toBe(403);
    });

    test("an admin can, and writes are allowed again", async () => {
        const res = mockRes();
        await locks.reopenMonth(
            asAdmin({ params: { month: MONTH }, body: { reason: "Late leave approval agreed" } }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect(await isMonthLocked(MONTH)).toBe(false);

        const row = await Attendance.findOne({ date: DAY });
        row.workingHours = 9;
        await expect(row.save()).resolves.toBeTruthy();
    });

    test("the reason stays on the record", async () => {
        await locks.reopenMonth(
            asAdmin({ params: { month: MONTH }, body: { reason: "Late leave approval agreed" } }),
            mockRes()
        );
        const lock = await AttendanceMonthLock.findOne({ month: MONTH });
        expect(lock.reopenReason).toBe("Late leave approval agreed");
        expect(lock.history.map((h) => h.action)).toEqual(["locked", "reopened"]);
    });

    test("reopening a month that is not locked is refused", async () => {
        const res = mockRes();
        await locks.reopenMonth(
            asAdmin({ params: { month: "2026-04" }, body: { reason: "Nothing to reopen" } }),
            res
        );
        expect(res.statusCode).toBe(409);
    });
});

// ─────────────────────────── the year view ────────────────────────────

describe("the year view", () => {
    test("lists twelve months with their state", async () => {
        await workedDay();
        await lockIt();
        const res = mockRes();
        await locks.listLocks(asAdmin({ query: { year: 2026 } }), res);
        expect(res.body.items).toHaveLength(12);
        const march = res.body.items.find((i) => i.month === MONTH);
        expect(march.status).toBe("locked");
        expect(march.lockedAt).toBeTruthy();
    });

    test("months still to come are marked, not assessed", async () => {
        const nextYear = new Date().getFullYear() + 1;
        const res = mockRes();
        await locks.listLocks(asAdmin({ query: { year: nextYear } }), res);
        expect(res.body.items.every((i) => i.inFuture)).toBe(true);
        expect(res.body.items.every((i) => i.ready === null)).toBe(true);
    });
});

// ──────────────────────── the guard helpers ───────────────────────────

describe("the guard helpers", () => {
    test("lockBlocks is quiet on an open month", async () => {
        expect(await lockBlocks("2026-04-02")).toBeNull();
    });

    test("lockBlocks names the month when closed", async () => {
        await workedDay();
        await lockIt();
        const blocked = await lockBlocks(DAY);
        expect(blocked.month).toBe(MONTH);
        expect(blocked.body.lockedMonths).toEqual([MONTH]);
    });

    test("lockBlocksRange catches a locked month inside the span", async () => {
        await workedDay();
        await lockIt();
        const blocked = await lockBlocksRange("2026-02-25", "2026-04-05");
        expect(blocked.body.lockedMonths).toEqual([MONTH]);
    });
});
