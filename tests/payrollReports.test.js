/**
 * The payroll register, reporting and audit (Payroll, Phase 4).
 *
 * What finance reconciles against, and what proves what happened. The register
 * reads from each line's own snapshot, so it shows what was paid rather than
 * what today's rates would produce.
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
const PayrollAudit = require("../models/PayrollAudit");

const reports = require("../controllers/payrollReportController");

let mongod;

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { res.statusCode = code; return res; },
        json(data) { res.body = data; return res; },
        send(data) { res.body = data; return res; },
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

let run;

const makeLine = (overrides = {}) =>
    PayrollLine.create({
        run: run._id,
        month: MONTH,
        personType: "Employee",
        personId: new mongoose.Types.ObjectId(),
        personName: "Someone",
        personEmail: "s@test.com",
        department: "Operations",
        payModel: "monthly",
        employmentType: "permanent",
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
        deductions: 0,
        adjustments: 0,
        net: 30000,
        ...overrides,
    });

beforeEach(async () => {
    await Promise.all([
        PayrollRun.deleteMany({}), PayrollLine.deleteMany({}), PayrollAudit.deleteMany({}),
    ]);
    run = await PayrollRun.create({ month: MONTH, status: "locked" });
});

const register = async (month = MONTH) => {
    const res = mockRes();
    await reports.getRegister(mockReq({ params: { month } }), res);
    return res;
};

// ───────────────────────────── the register ──────────────────────────────

describe("the register", () => {
    test("totals every line", async () => {
        await makeLine();
        await makeLine({ personName: "Another", net: 20000, gross: 20000 });
        const res = await register();
        expect(res.body.totals.people).toBe(2);
        expect(res.body.totals.net).toBe(50000);
    });

    test("groups by department", async () => {
        await makeLine({ department: "Operations" });
        await makeLine({ personName: "B", department: "Facilities", net: 25000, gross: 25000 });
        const res = await register();
        const names = res.body.byDepartment.map((d) => d.name);
        expect(names).toContain("Operations");
        expect(names).toContain("Facilities");
        // Biggest first, because that is the one finance asks about.
        expect(res.body.byDepartment[0].net).toBeGreaterThanOrEqual(res.body.byDepartment[1].net);
    });

    test("people without a department are shown, not dropped", async () => {
        await makeLine({ department: undefined });
        const res = await register();
        expect(res.body.byDepartment[0].name).toBe("No department");
        expect(res.body.totals.people).toBe(1);
    });

    test("groups by pay model and employment type", async () => {
        await makeLine();
        await makeLine({
            personName: "Daily", payModel: "daily", employmentType: "daily-wage",
            net: 12000, gross: 12000,
        });
        const res = await register();
        expect(res.body.byPayModel.map((g) => g.name).sort()).toEqual(["daily", "monthly"]);
        expect(res.body.byEmploymentType.map((g) => g.name).sort()).toEqual(["daily-wage", "permanent"]);
    });

    test("each group's people add up to the whole", async () => {
        await makeLine();
        await makeLine({ personName: "B", department: "Facilities" });
        await makeLine({ personName: "C", department: undefined });
        const res = await register();
        const grouped = res.body.byDepartment.reduce((s, g) => s + g.people, 0);
        expect(grouped).toBe(res.body.totals.people);
    });

    test("it carries who was left out of the run", async () => {
        run.exceptions = [{ name: "Untagged", code: "noProfile", message: "Not on payroll yet" }];
        await run.save();
        await makeLine();
        const res = await register();
        expect(res.body.run.exceptions).toHaveLength(1);
        expect(res.body.run.exceptions[0].name).toBe("Untagged");
    });

    test("a month with nothing calculated is a 404, not an empty register", async () => {
        const res = await register("2026-04");
        expect(res.statusCode).toBe(404);
    });
});

// ─────────────────────────────── the export ──────────────────────────────

describe("the CSV export", () => {
    const exportCsv = async () => {
        const res = mockRes();
        await reports.exportRegisterCsv(mockReq({ params: { month: MONTH } }), res);
        return res;
    };

    test("comes back as a downloadable file", async () => {
        await makeLine();
        const res = await exportCsv();
        expect(res.headers["Content-Type"]).toMatch(/text\/csv/);
        expect(res.headers["Content-Disposition"]).toContain("payroll-register-2026-03.csv");
    });

    test("has a header row, a row per person and a total", async () => {
        await makeLine();
        await makeLine({ personName: "Another", net: 20000 });
        const res = await exportCsv();
        const rows = res.body.split("\r\n");
        expect(rows).toHaveLength(4);           // header + 2 people + total
        expect(rows[0]).toContain('"Name"');
        expect(rows[3]).toContain("TOTAL (2 people)");
    });

    test("a name containing a comma does not shift the columns", async () => {
        await makeLine({ personName: "Kumar, Anil" });
        const res = await exportCsv();
        const dataRow = res.body.split("\r\n")[1];
        expect(dataRow).toContain('"Kumar, Anil"');
        // Every field is quoted, so the count of quoted fields is the header's.
        const quoted = (dataRow.match(/"(?:[^"]|"")*"/g) || []).length;
        const headerQuoted = (res.body.split("\r\n")[0].match(/"[^"]*"/g) || []).length;
        expect(quoted).toBe(headerQuoted);
    });

    test("a quote inside a name is escaped rather than breaking the row", async () => {
        await makeLine({ personName: 'Ali "Bob" Khan' });
        const res = await exportCsv();
        expect(res.body).toContain('"Ali ""Bob"" Khan"');
    });

    test("it opens as UTF-8 in Excel", async () => {
        await makeLine();
        const res = await exportCsv();
        expect(res.body.startsWith("﻿")).toBe(true);
    });
});

// ──────────────────────────── month over month ───────────────────────────

describe("the trend", () => {
    test("only settled months appear", async () => {
        await makeLine();
        const draft = await PayrollRun.create({ month: "2026-04", status: "review" });
        await makeLine({ run: draft._id, month: "2026-04" });

        const res = mockRes();
        await reports.getTrend(mockReq({ query: {} }), res);
        expect(res.body.months.map((m) => m.month)).toEqual([MONTH]);
    });

    test("movement against the month before is worked out", async () => {
        await makeLine();
        const april = await PayrollRun.create({ month: "2026-04", status: "locked" });
        await makeLine({ run: april._id, month: "2026-04", net: 33000, gross: 33000 });

        const res = mockRes();
        await reports.getTrend(mockReq({ query: {} }), res);
        const [first, second] = res.body.months;
        expect(first.changePercent).toBeNull();      // nothing to compare against
        expect(second.changePercent).toBe(10);       // 30000 -> 33000
    });

    test("the two pay models are split out", async () => {
        await makeLine();
        await makeLine({ personName: "Daily", payModel: "daily", net: 12000, gross: 12000 });
        const res = mockRes();
        await reports.getTrend(mockReq({ query: {} }), res);
        expect(res.body.months[0].monthly).toBe(30000);
        expect(res.body.months[0].daily).toBe(12000);
    });
});

// ────────────────────────────── the audit log ────────────────────────────

describe("the audit log", () => {
    beforeEach(async () => {
        await PayrollAudit.create([
            { action: "run.calculated", month: MONTH, actor: { userType: "Accountant", name: "Acc" } },
            { action: "run.approved", month: MONTH, actor: { userType: "Admin", name: "Ada" } },
            { action: "run.calculated", month: "2026-04", actor: { userType: "Accountant", name: "Acc" } },
        ]);
    });

    const audit = async (query = {}) => {
        const res = mockRes();
        await reports.getAuditLog(mockReq({ query }), res);
        return res;
    };

    test("reads across every run, newest first", async () => {
        const res = await audit();
        expect(res.body.total).toBe(3);
    });

    test("can be narrowed to one month", async () => {
        const res = await audit({ month: MONTH });
        expect(res.body.total).toBe(2);
    });

    test("can be narrowed to one kind of action", async () => {
        const res = await audit({ action: "run.approved" });
        expect(res.body.total).toBe(1);
        expect(res.body.items[0].actor.name).toBe("Ada");
    });

    test("it offers only the actions that actually occur", async () => {
        const res = await audit();
        expect(res.body.actions).toEqual(["run.approved", "run.calculated"]);
    });

    test("a nonsense month filter is ignored rather than returning nothing", async () => {
        const res = await audit({ month: "not-a-month" });
        expect(res.body.total).toBe(3);
    });
});
