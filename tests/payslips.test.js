/**
 * Payslips (Payroll, Phase 3).
 *
 * The rules that matter:
 *   · a payslip only comes from a LOCKED run — a figure that can still change
 *     is not something to put in somebody's hands
 *   · releasing twice does not produce two payslips
 *   · a person sees their own and nobody else's
 *   · nothing is visible until it has been released
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));
// @react-pdf/renderer is ESM and cannot be required under Jest's CJS runtime,
// so the renderer is stubbed; utils/payslipPdf has its own shape covered by the
// data it is handed here.
jest.mock("../utils/payslipPdf", () => ({
    renderPayslipPdf: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4 payslip")),
    money: (n) => `Rs. ${n}`,
    monthLabel: (m) => m,
}));
jest.mock("../utils/s3", () => ({
    uploadFile: jest.fn(async ({ originalName }) => ({
        key: `payslips/2026-03/${originalName}`,
        bucket: "test-bucket",
    })),
    getS3Client: jest.fn(() => ({ send: jest.fn() })),
    uploadPickupEvidence: jest.fn(),
    uploadCheckinPhoto: jest.fn(),
}));

const PayrollRun = require("../models/PayrollRun");
const PayrollLine = require("../models/PayrollLine");
const PayrollAudit = require("../models/PayrollAudit");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");

const payslips = require("../controllers/payslipController");
const { renderPayslipPdf } = require("../utils/payslipPdf");
const { notifyIfEnabled } = require("../utils/push");

let mongod;

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { res.statusCode = code; return res; },
        json(data) { res.body = data; return res; },
        setHeader(k, v) { res.headers[k] = v; },
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
let manager;
let employee;
let other;
let run;

const makeLine = (person, personType, overrides = {}) =>
    PayrollLine.create({
        run: run._id,
        month: MONTH,
        personType,
        personId: person._id,
        personName: person.name || person.email,
        personEmail: person.email,
        payModel: "monthly",
        rateAmount: 30000,
        perDayRate: 1000,
        daysOnPayroll: 31,
        days: { worked: 21, halfDays: 0, leavePaid: 0, leaveUnpaid: 0, weeklyOffs: 9, holidays: 1, absent: 0, unapproved: 0, overtimeDays: 0 },
        lopDays: 0,
        payableDays: 31,
        basePay: 30000,
        overtimeDays: 0,
        overtimePay: 0,
        gross: 30000,
        net: 30000,
        ...overrides,
    });

beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([
        PayrollRun.deleteMany({}), PayrollLine.deleteMany({}), PayrollAudit.deleteMany({}),
        Employee.deleteMany({}), Manager.deleteMany({}), Admin.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    manager = await Manager.create({ name: "Mgr", email: "m@test.com", password: "secret123" });
    employee = await Employee.create({
        name: "Emp", email: "e@test.com", password: "secret123", manager: manager._id,
    });
    other = await Employee.create({
        name: "Other", email: "o@test.com", password: "secret123", manager: manager._id,
    });
    run = await PayrollRun.create({ month: MONTH, status: "locked" });
});

const asAdmin = (o = {}) => mockReq({ admin, params: { month: MONTH }, ...o });
const release = async (req = asAdmin()) => {
    const res = mockRes();
    await payslips.releasePayslips(req, res);
    return res;
};

// ───────────────────────── releasing ─────────────────────────

describe("releasing payslips", () => {
    test("a locked run produces one payslip per line", async () => {
        await makeLine(employee, "Employee");
        await makeLine(other, "Employee");
        const res = await release();
        expect(res.statusCode).toBe(200);
        expect(res.body.produced).toBe(2);
        expect(renderPayslipPdf).toHaveBeenCalledTimes(2);
    });

    test("a run still under review produces none", async () => {
        run.status = "review";
        await run.save();
        await makeLine(employee, "Employee");
        const res = await release();
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/locked run/i);
        expect(renderPayslipPdf).not.toHaveBeenCalled();
    });

    test("an approved but unlocked run produces none either", async () => {
        run.status = "approved";
        await run.save();
        await makeLine(employee, "Employee");
        expect((await release()).statusCode).toBe(409);
    });

    test("each payslip gets its own number", async () => {
        await makeLine(employee, "Employee");
        await makeLine(other, "Employee");
        await release();
        const lines = await PayrollLine.find({ month: MONTH }).lean();
        const numbers = lines.map((l) => l.payslip.number);
        expect(new Set(numbers).size).toBe(2);
        expect(numbers[0]).toMatch(/^PS-2026-03-\d{4}$/);
    });

    test("releasing again does not produce a second payslip", async () => {
        await makeLine(employee, "Employee");
        await release();
        jest.clearAllMocks();

        const second = await release();
        expect(second.body.produced).toBe(0);
        expect(second.body.alreadyHad).toBe(1);
        expect(renderPayslipPdf).not.toHaveBeenCalled();
    });

    test("a new person added later gets theirs on the next release", async () => {
        await makeLine(employee, "Employee");
        await release();
        await makeLine(other, "Employee");
        const second = await release();
        expect(second.body.produced).toBe(1);
    });

    test("the person is told it is ready", async () => {
        await Employee.updateOne(
            { _id: employee._id },
            { $set: { pushSubscription: { endpoint: "https://example.test/x" } } }
        );
        await makeLine(employee, "Employee");
        await release();
        expect(notifyIfEnabled).toHaveBeenCalledTimes(1);
        expect(notifyIfEnabled.mock.calls[0][2].title).toMatch(/payslip/i);
    });

    test("one that fails to render does not stop the rest", async () => {
        await makeLine(employee, "Employee");
        await makeLine(other, "Employee");
        renderPayslipPdf.mockRejectedValueOnce(new Error("font missing"));
        const res = await release();
        expect(res.body.produced).toBe(1);
        expect(res.body.failed).toHaveLength(1);
    });

    test("the release is recorded in the audit log", async () => {
        await makeLine(employee, "Employee");
        await release();
        const entry = await PayrollAudit.findOne({ action: "payslips.released" });
        expect(entry.detail.produced).toBe(1);
        expect(entry.actor.userType).toBe("Admin");
    });

    test("managers get payslips too", async () => {
        await makeLine(manager, "Manager");
        const res = await release();
        expect(res.body.produced).toBe(1);
        const line = await PayrollLine.findOne({ personType: "Manager" });
        expect(line.payslip.number).toBeTruthy();
    });
});

// ──────────────────────── seeing your own ────────────────────────

describe("a person's own payslips", () => {
    const asEmployee = (person = employee) => mockReq({ employee: person });

    test("nothing is visible before release", async () => {
        await makeLine(employee, "Employee");
        const res = mockRes();
        await payslips.listMyPayslips(asEmployee(), res);
        expect(res.body.items).toHaveLength(0);
    });

    test("their own appears once released", async () => {
        await makeLine(employee, "Employee");
        await release();
        const res = mockRes();
        await payslips.listMyPayslips(asEmployee(), res);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].month).toBe(MONTH);
        expect(res.body.items[0].net).toBe(30000);
    });

    test("somebody else's does not", async () => {
        await makeLine(employee, "Employee");
        await makeLine(other, "Employee");
        await release();
        const res = mockRes();
        await payslips.listMyPayslips(asEmployee(other), res);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].lineId).toBeTruthy();
        // ...and it is theirs, not the other person's.
        const theirs = await PayrollLine.findOne({ personId: other._id }).lean();
        expect(String(res.body.items[0].lineId)).toBe(String(theirs._id));
    });

    test("a manager sees their own through the same endpoint", async () => {
        await makeLine(manager, "Manager");
        await release();
        const res = mockRes();
        await payslips.listMyPayslips(mockReq({ manager }), res);
        expect(res.body.items).toHaveLength(1);
    });

    test("downloading somebody else's is simply not found", async () => {
        await makeLine(employee, "Employee");
        await release();
        const theirs = await PayrollLine.findOne({ personId: employee._id }).lean();
        const res = mockRes();
        await payslips.downloadMyPayslip(
            mockReq({ employee: other, params: { lineId: String(theirs._id) } }),
            res
        );
        expect(res.statusCode).toBe(404);
    });

    test("downloading an unreleased payslip is not found either", async () => {
        const line = await makeLine(employee, "Employee");
        const res = mockRes();
        await payslips.downloadMyPayslip(
            mockReq({ employee, params: { lineId: String(line._id) } }),
            res
        );
        expect(res.statusCode).toBe(404);
    });

    test("a malformed id is refused rather than searched for", async () => {
        const res = mockRes();
        await payslips.downloadMyPayslip(
            mockReq({ employee, params: { lineId: "not-an-id" } }),
            res
        );
        expect(res.statusCode).toBe(400);
    });
});

// ──────────────────────── the run's view ────────────────────────

describe("the run's payslip list", () => {
    test("shows who has one and who does not", async () => {
        await makeLine(employee, "Employee");
        await makeLine(other, "Employee");
        await release();

        // Somebody added after the release has no payslip yet.
        const third = await Employee.create({
            name: "Third", email: "t@test.com", password: "secret123", manager: manager._id,
        });
        await makeLine(third, "Employee");

        const res = mockRes();
        await payslips.listRunPayslips(asAdmin(), res);
        expect(res.body.total).toBe(3);
        expect(res.body.released).toBe(2);
        expect(res.body.items.find((i) => i.personName === "Third").payslipNumber).toBeNull();
    });
});
