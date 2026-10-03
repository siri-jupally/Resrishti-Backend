/**
 * Payroll profiles, paid-day policies and access (Payroll, Phase 1).
 *
 * Three things matter here:
 *   · a rate is effective-dated, so a raise in June cannot change what March
 *     paid — the engine asks for the rate in force on a date
 *   · nobody is paid by default: an untagged person is visibly missing rather
 *     than quietly assumed to be on zero
 *   · preparing and approving are different jobs, and the gates enforce it
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const PayrollProfile = require("../models/PayrollProfile");
const PaidDayPolicy = require("../models/PaidDayPolicy");
const PayrollSettings = require("../models/PayrollSettings");
const Accountant = require("../models/Accountant");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");

const profiles = require("../controllers/payrollProfileController");
const config = require("../controllers/payrollConfigController");
const { getSettings, seedPaidDayPolicies, defaultPolicyFor } = require("../utils/payrollDefaults");
const { protectPreparer, protectApprover } = require("../middleware/authPayroll");

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
const mockReq = (o = {}) => ({ body: {}, params: {}, query: {}, headers: {}, ...o });

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
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
        PayrollProfile.deleteMany({}), PaidDayPolicy.deleteMany({}),
        PayrollSettings.deleteMany({}), Accountant.deleteMany({}),
        Employee.deleteMany({}), Manager.deleteMany({}), Admin.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    manager = await Manager.create({ name: "Mgr", email: "m@test.com", password: "secret123" });
    employee = await Employee.create({
        name: "Emp", email: "e@test.com", password: "secret123", manager: manager._id,
    });
    await seedPaidDayPolicies();
});

const asAdmin = (o = {}) => mockReq({ admin, ...o });

const tag = async (body, person = employee, type = "employee") => {
    const res = mockRes();
    await profiles.upsertProfile(
        asAdmin({ params: { type, id: String(person._id) }, body }),
        res
    );
    return res;
};

const monthlyBody = (overrides = {}) => ({
    employmentType: "permanent",
    payModel: "monthly",
    amount: 30000,
    effectiveFrom: "2026-01-01",
    ...overrides,
});

const dailyBody = (overrides = {}) => ({
    employmentType: "daily-wage",
    payModel: "daily",
    amount: 600,
    effectiveFrom: "2026-01-01",
    ...overrides,
});

// ────────────────────────── seeded configuration ──────────────────────────

describe("what payroll starts with", () => {
    test("the paid-day policies the workforce needs are seeded", async () => {
        const names = (await PaidDayPolicy.find({}).lean()).map((p) => p.name);
        expect(names).toEqual(
            expect.arrayContaining([
                "Casual — work only",
                "Regular — weekly-off paid",
                "Salaried — everything paid",
            ])
        );
    });

    test("casual pays for nothing but days worked", async () => {
        const casual = await PaidDayPolicy.findOne({ name: "Casual — work only" });
        expect(casual.payWeeklyOff).toBe(false);
        expect(casual.payHoliday).toBe(false);
    });

    test("seeding twice does not duplicate them", async () => {
        await seedPaidDayPolicies();
        expect(await PaidDayPolicy.countDocuments()).toBe(3);
    });

    test("settings arrive with the agreed defaults", async () => {
        const settings = await getSettings();
        expect(settings.payPeriod).toBe("calendar");
        expect(settings.perDayRateBasis).toBe("fixed30");
        expect(settings.halfDayWeight).toBe(0.5);
        expect(settings.approvalDepth).toBe("makerChecker");
    });

    test("the default overtime terms are a weekly-off day at a multiple of the rate", async () => {
        const { overtime } = await getSettings();
        expect(overtime.enabled).toBe(true);
        expect(overtime.countWeeklyOff).toBe(true);
        expect(overtime.mode).toBe("multiplier");
        expect(overtime.value).toBe(2);
    });

    test("who earns overtime is not decided in the settings", async () => {
        const { overtime } = await getSettings();
        // Eligibility is a per-person flag; a rule here would hide the
        // exceptions between two people doing the same job.
        expect(overtime.appliesToDaily).toBeUndefined();
        expect(overtime.appliesToMonthly).toBeUndefined();
    });});

// ─────────────────────────── tagging people ───────────────────────────────

describe("tagging somebody for payroll", () => {
    test("a monthly profile is created with its first rate", async () => {
        const res = await tag(monthlyBody());
        expect(res.statusCode).toBe(200);
        expect(res.body.payModel).toBe("monthly");
        expect(res.body.rates).toHaveLength(1);
        expect(res.body.rates[0].amount).toBe(30000);
    });

    test("a daily-wage profile defaults to the work-only policy", async () => {
        const res = await tag(dailyBody());
        const expected = await defaultPolicyFor("daily");
        expect(String(res.body.paidDayPolicy._id)).toBe(String(expected._id));
        expect(res.body.paidDayPolicy.payWeeklyOff).toBe(false);
    });

    test("a monthly profile defaults to everything paid", async () => {
        const res = await tag(monthlyBody());
        expect(res.body.paidDayPolicy.payWeeklyOff).toBe(true);
    });

    test("a manager can be tagged too", async () => {
        const res = await tag(monthlyBody(), manager, "manager");
        expect(res.statusCode).toBe(200);
        expect(res.body.personType).toBe("Manager");
    });

    test("tagging needs a rate", async () => {
        const res = await tag(monthlyBody({ amount: undefined }));
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/monthly salary is required/i);
        expect(await PayrollProfile.countDocuments()).toBe(0);
    });

    test("tagging needs a date the rate starts from", async () => {
        const res = await tag(monthlyBody({ effectiveFrom: "01-01-2026" }));
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/YYYY-MM-DD/);
    });

    test("an unknown employment type is refused", async () => {
        const res = await tag(monthlyBody({ employmentType: "freelance" }));
        expect(res.statusCode).toBe(400);
    });

    test("updating a profile leaves the rate history alone", async () => {
        await tag(monthlyBody());
        const res = await tag({ employmentType: "contract", payModel: "monthly" });
        expect(res.statusCode).toBe(200);
        expect(res.body.employmentType).toBe("contract");
        expect(res.body.rates).toHaveLength(1);
    });

    test("nobody earns overtime until somebody says they do", async () => {
        const res = await tag(dailyBody());
        expect(res.body.overtimeEligible).toBe(false);
    });

    test("overtime is granted to a person, not to a pay model", async () => {
        // Two daily-wage workers on identical terms, one with overtime.
        const other = await Employee.create({
            name: "E2", email: "e2@test.com", password: "secret123", manager: manager._id,
        });
        await tag(dailyBody({ overtimeEligible: true }));
        await tag(dailyBody(), other);

        const withOt = await PayrollProfile.findOne({ personId: employee._id });
        const withoutOt = await PayrollProfile.findOne({ personId: other._id });
        expect(withOt.overtimeEligible).toBe(true);
        expect(withoutOt.overtimeEligible).toBe(false);
        expect(withOt.payModel).toBe(withoutOt.payModel);
    });

    test("a salaried person can earn it too, if that is their arrangement", async () => {
        const res = await tag(monthlyBody({ overtimeEligible: true }));
        expect(res.body.overtimeEligible).toBe(true);
    });

    test("an overtime rate can be set just for one person", async () => {
        await tag(dailyBody({ overtimeEligible: true }));
        const res = await tag({
            employmentType: "daily-wage",
            payModel: "daily",
            overtimeOverride: { mode: "flat", value: 900 },
        });
        expect(res.body.overtimeOverride.mode).toBe("flat");
        expect(res.body.overtimeOverride.value).toBe(900);
    });

    test("without their own rate they follow the organisation's", async () => {
        const res = await tag(dailyBody({ overtimeEligible: true }));
        expect(res.body.overtimeOverride?.mode).toBeUndefined();
        const { overtime } = await getSettings();
        expect(overtime.mode).toBe("multiplier");
    });

    test("eligibility can be taken away again", async () => {
        await tag(dailyBody({ overtimeEligible: true }));
        const res = await tag({
            employmentType: "daily-wage",
            payModel: "daily",
            overtimeEligible: false,
        });
        expect(res.body.overtimeEligible).toBe(false);
    });

    test("a nonsense overtime override is refused", async () => {
        await tag(dailyBody());
        const res = await tag({
            employmentType: "daily-wage",
            payModel: "daily",
            overtimeOverride: { mode: "double", value: 2 },
        });
        expect(res.statusCode).toBe(400);
    });
});

// ───────────────────── leaving and joining payroll ────────────────────────

describe("taking somebody off payroll", () => {
    test("a leaver is excluded from future runs without losing their history", async () => {
        await tag(monthlyBody());
        const res = await tag({
            employmentType: "permanent",
            payModel: "monthly",
            isActive: false,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.isActive).toBe(false);
        // The rate history is untouched — past months still compute.
        expect(res.body.rates).toHaveLength(1);
    });

    test("somebody active is the default", async () => {
        const res = await tag(monthlyBody());
        expect(res.body.isActive).toBe(true);
    });

    test("they can be brought back", async () => {
        await tag(monthlyBody());
        await tag({ employmentType: "permanent", payModel: "monthly", isActive: false });
        const res = await tag({ employmentType: "permanent", payModel: "monthly", isActive: true });
        expect(res.body.isActive).toBe(true);
    });

    test("the summary counts who is still active", async () => {
        await tag(monthlyBody());
        await tag(dailyBody(), manager, "manager");
        await tag({ employmentType: "permanent", payModel: "monthly", isActive: false });
        const res = mockRes();
        await profiles.summary(asAdmin(), res);
        expect(res.body.tagged).toBe(2);
        expect(res.body.active).toBe(1);
    });

    test("the list shows who is off payroll", async () => {
        await tag(monthlyBody());
        await tag({ employmentType: "permanent", payModel: "monthly", isActive: false });
        const res = mockRes();
        await profiles.listProfiles(asAdmin({ query: { status: "tagged" } }), res);
        expect(res.body.items[0].isActive).toBe(false);
    });
});

describe("joining or leaving part-way through a month", () => {
    test("the dates are recorded for the engine to prorate against", async () => {
        await tag(monthlyBody());
        const res = await tag({
            employmentType: "permanent",
            payModel: "monthly",
            payrollStartDate: "2026-03-16",
            payrollEndDate: "2026-09-15",
        });
        expect(res.body.payrollStartDate).toBe("2026-03-16");
        expect(res.body.payrollEndDate).toBe("2026-09-15");
    });

    test("clearing them puts the person back on the whole month", async () => {
        await tag(monthlyBody());
        await tag({
            employmentType: "permanent",
            payModel: "monthly",
            payrollStartDate: "2026-03-16",
        });
        const res = await tag({
            employmentType: "permanent",
            payModel: "monthly",
            payrollStartDate: null,
        });
        expect(res.body.payrollStartDate).toBeUndefined();
    });
});

// ──────────────────────── rates are effective-dated ───────────────────────

describe("rate history", () => {
    const addRate = async (body) => {
        const res = mockRes();
        await profiles.addRate(
            asAdmin({ params: { type: "employee", id: String(employee._id) }, body }),
            res
        );
        return res;
    };

    beforeEach(async () => {
        await tag(monthlyBody({ amount: 30000, effectiveFrom: "2026-01-01" }));
    });

    test("a raise is added rather than overwriting the old rate", async () => {
        const res = await addRate({
            amount: 36000, effectiveFrom: "2026-06-01", reason: "Annual increment",
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.rates).toHaveLength(2);
    });

    test("March still pays the March rate after a June raise", async () => {
        await addRate({ amount: 36000, effectiveFrom: "2026-06-01", reason: "Annual increment" });
        const profile = await PayrollProfile.findOne({ personId: employee._id });
        expect(profile.rateOn("2026-03-15").amount).toBe(30000);
        expect(profile.rateOn("2026-06-15").amount).toBe(36000);
    });

    test("the rate on the day it takes effect is the new one", async () => {
        await addRate({ amount: 36000, effectiveFrom: "2026-06-01", reason: "Annual increment" });
        const profile = await PayrollProfile.findOne({ personId: employee._id });
        expect(profile.rateOn("2026-06-01").amount).toBe(36000);
    });

    test("a date before anybody had a rate returns nothing, rather than zero", async () => {
        const profile = await PayrollProfile.findOne({ personId: employee._id });
        expect(profile.rateOn("2025-12-31")).toBeNull();
    });

    test("a back-dated correction is honoured from its own date", async () => {
        await addRate({ amount: 32000, effectiveFrom: "2026-02-01", reason: "Corrected, entered wrong" });
        const profile = await PayrollProfile.findOne({ personId: employee._id });
        expect(profile.rateOn("2026-01-15").amount).toBe(30000);
        expect(profile.rateOn("2026-02-15").amount).toBe(32000);
    });

    test("a rate change needs a reason", async () => {
        const res = await addRate({ amount: 36000, effectiveFrom: "2026-06-01", reason: "x" });
        expect(res.statusCode).toBe(400);
    });

    test("two rates cannot start on the same day", async () => {
        const res = await addRate({
            amount: 36000, effectiveFrom: "2026-01-01", reason: "Annual increment",
        });
        expect(res.statusCode).toBe(409);
    });

    test("a rate cannot be set on somebody who is not tagged", async () => {
        const other = await Employee.create({
            name: "E2", email: "e2@test.com", password: "secret123", manager: manager._id,
        });
        const res = mockRes();
        await profiles.addRate(
            asAdmin({
                params: { type: "employee", id: String(other._id) },
                body: { amount: 100, effectiveFrom: "2026-01-01", reason: "Starting rate" },
            }),
            res
        );
        expect(res.statusCode).toBe(404);
        expect(res.body.message).toMatch(/Tag this person/i);
    });
});

// ───────────────────── who is still missing from payroll ──────────────────

describe("the workforce list", () => {
    test("untagged people are listed, not hidden", async () => {
        const res = mockRes();
        await profiles.listProfiles(asAdmin({ query: {} }), res);
        expect(res.body.counts).toEqual({ people: 2, tagged: 0, untagged: 2 });
        expect(res.body.items.every((i) => i.tagged === false)).toBe(true);
    });

    test("they sort to the top, because they are the work", async () => {
        await tag(monthlyBody());
        const res = mockRes();
        await profiles.listProfiles(asAdmin({ query: {} }), res);
        expect(res.body.items[0].tagged).toBe(false);
    });

    test("the list can be narrowed to whoever is still missing", async () => {
        await tag(monthlyBody());
        const res = mockRes();
        await profiles.listProfiles(asAdmin({ query: { status: "untagged" } }), res);
        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].name).toBe("Mgr");
    });

    test("the summary answers the workforce-split question", async () => {
        await tag(dailyBody());
        await tag(monthlyBody(), manager, "manager");
        const res = mockRes();
        await profiles.summary(asAdmin(), res);
        expect(res.body.tagged).toBe(2);
        expect(res.body.untagged).toBe(0);
        expect(res.body.byPayModel).toEqual({ daily: 1, monthly: 1 });
        expect(res.body.byEmploymentType).toEqual({ "daily-wage": 1, permanent: 1 });
    });
});

// ──────────────────────────── bank details ────────────────────────────────

describe("bank details", () => {
    beforeEach(async () => { await tag(monthlyBody()); });

    const setBank = async (bank) => {
        const res = mockRes();
        await profiles.updateBank(
            asAdmin({ params: { type: "employee", id: String(employee._id) }, body: { bank } }),
            res
        );
        return res;
    };

    test("can be filled in later, separately from pay", async () => {
        const res = await setBank({
            accountHolderName: "Emp", accountNumber: "12345678901",
            ifsc: "hdfc0001234", bankName: "HDFC",
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.bank.ifsc).toBe("HDFC0001234");
    });

    test("a malformed IFSC is refused rather than stored", async () => {
        const res = await setBank({ accountNumber: "123", ifsc: "NOTANIFSC" });
        expect(res.statusCode).toBe(400);
        const profile = await PayrollProfile.findOne({ personId: employee._id });
        expect(profile.bank?.accountNumber).toBeFalsy();
    });

    test("the list shows who still has none", async () => {
        const res = mockRes();
        await profiles.listProfiles(asAdmin({ query: { status: "tagged" } }), res);
        expect(res.body.items[0].hasBankDetails).toBe(false);
    });
});

// ────────────────────── preparing versus approving ────────────────────────

describe("access", () => {
    const run = async (middleware, req) => {
        const res = mockRes();
        let passed = false;
        await middleware(req, res, () => { passed = true; });
        return { passed, res };
    };

    let accountant;
    beforeEach(async () => {
        accountant = await Accountant.create({
            name: "Acc", email: "acc@test.com", password: "secret123",
        });
    });

    const jwt = require("jsonwebtoken");
    const tokenFor = (id, kind) =>
        jwt.sign({ id: String(id), kind }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const withToken = (token) => mockReq({ headers: { authorization: `Bearer ${token}` } });

    test("an accountant may prepare", async () => {
        const { passed } = await run(
            protectPreparer, withToken(tokenFor(accountant._id, "accountant"))
        );
        expect(passed).toBe(true);
    });

    test("an accountant may not approve", async () => {
        const { passed, res } = await run(
            protectApprover, withToken(tokenFor(accountant._id, "accountant"))
        );
        expect(passed).toBe(false);
        expect(res.statusCode).toBe(403);
    });

    test("under maker-checker an admin may not prepare", async () => {
        const { passed, res } = await run(protectPreparer, withToken(tokenFor(admin._id, "admin")));
        expect(passed).toBe(false);
        expect(res.statusCode).toBe(403);
        expect(res.body.message).toMatch(/accountant/i);
    });

    test("switched to single-approver, an admin may prepare", async () => {
        const settings = await getSettings();
        settings.approvalDepth = "single";
        await settings.save();
        const { passed } = await run(protectPreparer, withToken(tokenFor(admin._id, "admin")));
        expect(passed).toBe(true);
    });

    test("an admin may approve", async () => {
        const { passed } = await run(protectApprover, withToken(tokenFor(admin._id, "admin")));
        expect(passed).toBe(true);
    });

    test("a deactivated accountant is locked out", async () => {
        accountant.isActive = false;
        await accountant.save();
        const { passed, res } = await run(
            protectPreparer, withToken(tokenFor(accountant._id, "accountant"))
        );
        expect(passed).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    test("a client portal token cannot reach payroll", async () => {
        const { passed, res } = await run(
            protectPayrollRef, withToken(jwt.sign({ id: String(admin._id), kind: "client" }, process.env.JWT_SECRET))
        );
        expect(passed).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    const { protectPayroll: protectPayrollRef } = require("../middleware/authPayroll");

    test("no token at all is refused", async () => {
        const { passed, res } = await run(protectPayrollRef, mockReq());
        expect(passed).toBe(false);
        expect(res.statusCode).toBe(401);
    });
});

// ─────────────────────── accountant logins ────────────────────────────────

describe("accountant logins", () => {
    test("an admin creates one and is shown the password once", async () => {
        const res = mockRes();
        await config.createAccountant(
            asAdmin({ body: { name: "Acc", email: "acc@test.com" } }), res
        );
        expect(res.statusCode).toBe(201);
        expect(res.body.temporaryPassword).toHaveLength(14);
        // ...and it is not what is stored.
        const saved = await Accountant.findOne({ email: "acc@test.com" });
        expect(saved.password).not.toBe(res.body.temporaryPassword);
    });

    test("they can sign in with it", async () => {
        const created = mockRes();
        await config.createAccountant(asAdmin({ body: { email: "acc@test.com" } }), created);
        const res = mockRes();
        await config.loginAccountant(
            mockReq({ body: { email: "acc@test.com", password: created.body.temporaryPassword } }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.token).toBeTruthy();
    });

    test("a wrong password says nothing about whether the account exists", async () => {
        await config.createAccountant(asAdmin({ body: { email: "acc@test.com" } }), mockRes());
        const wrongPassword = mockRes();
        await config.loginAccountant(
            mockReq({ body: { email: "acc@test.com", password: "nope" } }), wrongPassword
        );
        const noSuchUser = mockRes();
        await config.loginAccountant(
            mockReq({ body: { email: "nobody@test.com", password: "nope" } }), noSuchUser
        );
        expect(wrongPassword.body.message).toBe(noSuchUser.body.message);
        expect(wrongPassword.statusCode).toBe(noSuchUser.statusCode);
    });

    test("a duplicate email is refused", async () => {
        await config.createAccountant(asAdmin({ body: { email: "acc@test.com" } }), mockRes());
        const res = mockRes();
        await config.createAccountant(asAdmin({ body: { email: "acc@test.com" } }), res);
        expect(res.statusCode).toBe(409);
    });
});

// ───────────────────────── paid-day policies ──────────────────────────────

describe("paid-day policies", () => {
    test("a policy people are on cannot be switched off", async () => {
        await tag(dailyBody());
        const casual = await PaidDayPolicy.findOne({ name: "Casual — work only" });
        const res = mockRes();
        await config.updatePolicy(
            asAdmin({ params: { id: String(casual._id) }, body: { isActive: false } }), res
        );
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/1 person is on this policy/i);
    });

    test("the list says how many people each one covers", async () => {
        await tag(dailyBody());
        const res = mockRes();
        await config.listPolicies(asAdmin({ query: {} }), res);
        const casual = res.body.items.find((p) => p.name === "Casual — work only");
        expect(casual.peopleCount).toBe(1);
    });

    test("a new arrangement can be added without code", async () => {
        const res = mockRes();
        await config.createPolicy(
            asAdmin({
                body: {
                    name: "Seasonal — holidays paid only",
                    payWeeklyOff: false,
                    payHoliday: true,
                    appliesTo: ["daily"],
                },
            }),
            res
        );
        expect(res.statusCode).toBe(201);
        expect(res.body.payHoliday).toBe(true);
    });
});

// ──────────────────────────── settings ────────────────────────────────────

describe("settings", () => {
    test("the overtime rate is changed without touching code", async () => {
        const res = mockRes();
        await config.updateSettings(
            asAdmin({ body: { overtime: { mode: "multiplier", value: 1.5 } } }), res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.overtime.value).toBe(1.5);
    });

    test("overtime can be paid as a flat amount instead", async () => {
        const res = mockRes();
        await config.updateSettings(
            asAdmin({ body: { overtime: { mode: "flat", value: 800 } } }), res
        );
        expect(res.body.overtime.mode).toBe("flat");
        expect(res.body.overtime.value).toBe(800);
    });

    test("a nonsense per-day basis is refused", async () => {
        const res = mockRes();
        await config.updateSettings(asAdmin({ body: { perDayRateBasis: "lunar" } }), res);
        expect(res.statusCode).toBe(400);
    });

    test("half-day weighting must be a fraction of a day", async () => {
        const res = mockRes();
        await config.updateSettings(asAdmin({ body: { halfDayWeight: 2 } }), res);
        expect(res.statusCode).toBe(400);
    });
});
