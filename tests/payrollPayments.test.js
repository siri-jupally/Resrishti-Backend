/**
 * Disbursement — the bank file, recording what the bank did, and the rule that
 * keeps the status list at five.
 *
 * The thing worth pinning down: a failed transfer is a fact about one person,
 * so the run stays `approved` until every line is settled. A part-paid month
 * must never read as paid, and a person with no bank account must never be
 * marked paid at all.
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
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");

const payments = require("../controllers/payrollPaymentController");

let mongod;
let admin;
let accountant;
let manager;

const MONTH = "2026-03";

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
const asAccountant = (o = {}) =>
    mockReq({ payrollEmployee: accountant, params: { month: MONTH }, ...o });
const asAdmin = (o = {}) => mockReq({ admin, params: { month: MONTH }, ...o });

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    admin = await Admin.create({ email: "admin@test.com", password: "Secret@123" });
    // Employee.manager is required by the schema, so the manager comes first:
    // the accountant is an employee too, now that there is no separate login.
    manager = await Manager.create({
        name: "Mgr", email: "mgr@test.com", password: "Secret@123",
    });
    accountant = await Employee.create({
        name: "Acc", email: "acc@test.com", password: "Secret@123",
        manager: manager._id, canPreparePayroll: true,
    });
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

let run;
let people = [];

/** Three people with bank accounts, one without. */
const seedRun = async ({ status = "approved", withBank = 3, withoutBank = 1 } = {}) => {
    run = await PayrollRun.create({ month: MONTH, status });
    people = [];
    const make = async (i, bank) => {
        const emp = await Employee.create({
            name: `Person ${i}`,
            email: `p${i}.${Date.now()}@test.com`,
            password: "Secret@123",
            manager: manager._id,
            ...(bank
                ? {
                      bank: {
                          accountHolderName: `Person ${i}`,
                          accountNumber: `9876543210${i}`,
                          ifsc: "HDFC0001234",
                          bankName: "HDFC Bank",
                      },
                  }
                : {}),
        });
        const line = await PayrollLine.create({
            run: run._id,
            month: MONTH,
            personType: "Employee",
            personId: emp._id,
            personName: emp.name,
            payModel: "monthly",
            employmentType: "permanent",
            rateAmount: 30000,
            perDayRate: 1000,
            daysOnPayroll: 31,
            payableDays: 31,
            basePay: 30000,
            gross: 30000,
            net: 30000,
        });
        people.push({ emp, line, hasBank: bank });
    };
    for (let i = 0; i < withBank; i += 1) await make(i, true);
    for (let i = 0; i < withoutBank; i += 1) await make(100 + i, false);
};

beforeEach(async () => {
    await Promise.all([
        PayrollRun.deleteMany({}), PayrollLine.deleteMany({}),
        PayrollAudit.deleteMany({}), Employee.deleteMany({}),
    ]);
});

const record = async (body, req) => {
    const res = mockRes();
    await payments.recordPayments(req || asAccountant({ body }), res);
    return res;
};

// ─────────────────────────────── the bank file ───────────────────────────────

describe("the bank file", () => {
    test("is one row per payable person, and leaves out anyone with no account", async () => {
        await seedRun();
        const res = mockRes();
        await payments.exportBankFile(asAccountant(), res);

        expect(res.headers["Content-Type"]).toMatch(/text\/csv/);
        expect(res.headers["Content-Disposition"]).toContain(`salary-${MONTH}.csv`);
        const rows = res.body.split("\r\n");
        expect(rows).toHaveLength(4);                 // header + 3 with accounts
        expect(res.headers["X-Skipped-No-Bank"]).toBe("1");
    });

    test("opens as UTF-8 in Excel", async () => {
        await seedRun();
        const res = mockRes();
        await payments.exportBankFile(asAccountant(), res);
        expect(res.body.startsWith("﻿")).toBe(true);
    });

    test("a name with a comma does not shift the columns", async () => {
        await seedRun({ withBank: 0, withoutBank: 0 });
        const emp = await Employee.create({
            name: "Kumar, Anil", email: `k.${Date.now()}@test.com`, password: "Secret@123",
            manager: manager._id,
            bank: { accountNumber: "1234567890", ifsc: "ICIC0001", bankName: "ICICI" },
        });
        await PayrollLine.create({
            run: run._id, month: MONTH, personType: "Employee", personId: emp._id,
            personName: emp.name, payModel: "monthly", employmentType: "permanent",
            rateAmount: 1, perDayRate: 1, daysOnPayroll: 31, payableDays: 31,
            basePay: 1, gross: 1, net: 1,
        });

        const res = mockRes();
        await payments.exportBankFile(asAccountant(), res);
        expect(res.body).toContain('"Kumar, Anil"');
    });

    test("somebody already paid is not in a fresh file, so they cannot be paid twice", async () => {
        await seedRun();
        await record({ outcomes: [{ lineId: String(people[0].line._id), status: "paid", reference: "UTR1" }] });

        const res = mockRes();
        await payments.exportBankFile(asAccountant(), res);
        expect(res.body.split("\r\n")).toHaveLength(3);   // header + the 2 unpaid
        expect(res.body).not.toContain("Person 0");
    });

    test("it is refused before the run is approved", async () => {
        await seedRun({ status: "draft" });
        const res = mockRes();
        await payments.exportBankFile(asAccountant(), res);
        expect(res.statusCode).toBe(409);
    });
});

// ───────────────────────── recording what the bank did ─────────────────────────

describe("recording payments", () => {
    test("marking everyone paid settles the run", async () => {
        await seedRun({ withBank: 3, withoutBank: 0 });
        const res = await record({ markAllPaid: true, reference: "BULK-001" });

        expect(res.statusCode).toBe(200);
        expect(res.body.allSettled).toBe(true);
        expect(res.body.run.status).toBe("paid");
        expect(res.body.payment).toMatchObject({ paidCount: 3, failedCount: 0, pendingCount: 0 });
        expect(res.body.payment.paidAmount).toBe(90000);
    });

    test("a part-paid month stays approved — it is not a status of its own", async () => {
        await seedRun({ withBank: 3, withoutBank: 0 });
        const res = await record({
            outcomes: [
                { lineId: String(people[0].line._id), status: "paid", reference: "UTR1" },
                { lineId: String(people[1].line._id), status: "failed", failureReason: "Account frozen" },
            ],
        });

        expect(res.body.allSettled).toBe(false);
        expect(res.body.run.status).toBe("approved");
        expect(res.body.payment).toMatchObject({ paidCount: 1, failedCount: 1, pendingCount: 1 });
    });

    test("a failure is recorded against the person, with its reason", async () => {
        await seedRun({ withBank: 1, withoutBank: 0 });
        await record({
            outcomes: [{ lineId: String(people[0].line._id), status: "failed", failureReason: "IFSC invalid" }],
        });

        const line = await PayrollLine.findById(people[0].line._id).lean();
        expect(line.payment.status).toBe("failed");
        expect(line.payment.failureReason).toBe("IFSC invalid");
        expect(line.payment.paidAt).toBeUndefined();
    });

    test("a retry after a failure keeps both attempts", async () => {
        await seedRun({ withBank: 1, withoutBank: 0 });
        const id = String(people[0].line._id);
        await record({ outcomes: [{ lineId: id, status: "failed", failureReason: "Account frozen" }] });
        await record({ outcomes: [{ lineId: id, status: "paid", reference: "UTR-RETRY" }] });

        const line = await PayrollLine.findById(id).lean();
        expect(line.payment.status).toBe("paid");
        expect(line.payment.reference).toBe("UTR-RETRY");
        // Without the history, a payment that bounced and then worked would
        // look like it always worked.
        expect(line.payment.attempts.map((a) => a.status)).toEqual(["failed", "paid"]);
    });

    test("the account it went to is snapshotted, since the employee can change it", async () => {
        await seedRun({ withBank: 1, withoutBank: 0 });
        await record({ outcomes: [{ lineId: String(people[0].line._id), status: "paid", reference: "UTR1" }] });

        const line = await PayrollLine.findById(people[0].line._id).lean();
        expect(line.payment.bankSnapshot.accountNumberLast4).toBe("2100");
        expect(line.payment.bankSnapshot.bankName).toBe("HDFC Bank");
    });

    test("somebody with no bank account cannot be marked paid", async () => {
        await seedRun({ withBank: 0, withoutBank: 1 });
        const res = await record({
            outcomes: [{ lineId: String(people[0].line._id), status: "paid", reference: "UTR1" }],
        });

        expect(res.statusCode).toBe(400);
        const line = await PayrollLine.findById(people[0].line._id).lean();
        expect(line.payment.status).toBe("pending");
    });

    test("mark-all is refused outright when anyone is missing an account", async () => {
        await seedRun({ withBank: 2, withoutBank: 1 });
        const res = await record({ markAllPaid: true, reference: "BULK" });

        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe("noBankDetails");
        // Nothing partially applied.
        const paid = await PayrollLine.countDocuments({ run: run._id, "payment.status": "paid" });
        expect(paid).toBe(0);
    });

    test("payments are refused before an admin has approved", async () => {
        await seedRun({ status: "pending-approval", withBank: 1, withoutBank: 0 });
        const res = await record({ markAllPaid: true });
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/approved/i);
    });

    test("a closed month is refused", async () => {
        await seedRun({ status: "closed", withBank: 1, withoutBank: 0 });
        const res = await record({ markAllPaid: true });
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/closed/i);
    });

    test("an unknown line is reported rather than silently skipped", async () => {
        await seedRun({ withBank: 1, withoutBank: 0 });
        const res = await record({
            outcomes: [
                { lineId: String(people[0].line._id), status: "paid", reference: "UTR1" },
                { lineId: String(new mongoose.Types.ObjectId()), status: "paid" },
            ],
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.problems).toHaveLength(1);
    });

    test("the run reaching paid is in the audit log", async () => {
        await seedRun({ withBank: 2, withoutBank: 0 });
        await record({ markAllPaid: true, reference: "BULK" });

        const actions = (await PayrollAudit.find({ month: MONTH }).lean()).map((a) => a.action);
        expect(actions).toContain("payment.recorded");
        expect(actions).toContain("run.paid");
    });

    test("an admin may record payments too", async () => {
        await seedRun({ withBank: 1, withoutBank: 0 });
        const res = await record(null, asAdmin({ body: { markAllPaid: true, reference: "X" } }));
        expect(res.statusCode).toBe(200);
        expect(res.body.run.status).toBe("paid");
    });
});

// ──────────────────────────── the disbursement list ────────────────────────────

describe("the payment list", () => {
    test("masks the account to the last four digits", async () => {
        await seedRun({ withBank: 1, withoutBank: 0 });
        const res = mockRes();
        await payments.listPayments(asAccountant(), res);

        expect(res.body.items[0].accountMasked).toBe("•••• 2100");
        expect(JSON.stringify(res.body)).not.toContain("98765432100");
    });

    test("says who has no account on file", async () => {
        await seedRun({ withBank: 1, withoutBank: 1 });
        const res = mockRes();
        await payments.listPayments(asAccountant(), res);

        const without = res.body.items.filter((i) => !i.hasBank);
        expect(without).toHaveLength(1);
        expect(without[0].accountMasked).toBeNull();
    });

    test("flags an account that changed after the run was generated", async () => {
        await seedRun({ withBank: 1, withoutBank: 0 });
        run.calculatedAt = new Date(Date.now() - 60_000);
        await run.save();
        await Employee.updateOne(
            { _id: people[0].emp._id },
            { $set: { bankUpdatedAt: new Date() } }
        );

        const res = mockRes();
        await payments.listPayments(asAccountant(), res);
        expect(res.body.items[0].bankChangedAfterRun).toBe(true);
    });
});
