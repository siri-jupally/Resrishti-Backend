/**
 * Role-based payroll defaults — a job role carries a pay template, people
 * inherit it when tagged, and "add everyone in this role" creates profiles in
 * bulk from the template without ever overwriting one that already exists.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const JobRole = require("../models/JobRole");
const PaidDayPolicy = require("../models/PaidDayPolicy");
const PayrollProfile = require("../models/PayrollProfile");
const PayrollAudit = require("../models/PayrollAudit");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");

const config = require("../controllers/payrollConfigController");
const profiles = require("../controllers/payrollProfileController");
const { seedPaidDayPolicies } = require("../utils/payrollDefaults");

let mongod, admin, accountant, manager;

function mockRes() {
    const res = { statusCode: 200, body: null, status(c) { res.statusCode = c; return res; }, json(d) { res.body = d; return res; } };
    return res;
}
const mockReq = (o = {}) => ({ body: {}, params: {}, query: {}, ...o });
const asAdmin = (o = {}) => mockReq({ admin, ...o });

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

let policy;
beforeEach(async () => {
    await Promise.all([
        JobRole.deleteMany({}), PaidDayPolicy.deleteMany({}), PayrollProfile.deleteMany({}),
        PayrollAudit.deleteMany({}), Employee.deleteMany({}), Manager.deleteMany({}), Admin.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    manager = await Manager.create({ name: "Mgr", email: "m@test.com", password: "secret123" });
    accountant = await Employee.create({
        name: "Acc", email: "acc@test.com", password: "secret123", manager: manager._id, canPreparePayroll: true,
    });
    await seedPaidDayPolicies();
    policy = await PaidDayPolicy.findOne({});
});

const makeEmp = (name, roleId) =>
    Employee.create({ name, email: `${name}.${Date.now()}@t.com`, password: "secret123", manager: manager._id, jobRoleId: roleId });
const setDefaults = async (roleId, body) => {
    const res = mockRes();
    await config.setRoleDefaults(asAdmin({ params: { id: String(roleId) }, body }), res);
    return res;
};
const apply = async (body) => {
    const res = mockRes();
    await profiles.applyRole(asAdmin({ body }), res);
    return res;
};

describe("a role's payroll template", () => {
    test("an admin sets daily-wage defaults with a default rate", async () => {
        const role = await JobRole.create({ name: "Labour" });
        const res = await setDefaults(role._id, {
            employmentType: "daily-wage", payModel: "daily",
            paidDayPolicy: String(policy._id), overtimeEligible: true, defaultRate: 600,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.configured).toBe(true);
        const saved = await JobRole.findById(role._id);
        expect(saved.payroll.payModel).toBe("daily");
        expect(saved.payroll.defaultRate).toBe(600);
        expect(saved.payroll.overtimeEligible).toBe(true);
        // The change is written to the audit trail.
        const entry = await PayrollAudit.findOne({ action: "role.payrollSet" }).lean();
        expect(entry.detail.role).toBe("Labour");
    });

    test("a nonsense pay model is refused", async () => {
        const role = await JobRole.create({ name: "X" });
        const res = await setDefaults(role._id, { employmentType: "daily-wage", payModel: "lunar" });
        expect(res.statusCode).toBe(400);
    });

    test("clearing removes the template", async () => {
        const role = await JobRole.create({ name: "Driver", payroll: { employmentType: "daily-wage", payModel: "daily" } });
        const res = await setDefaults(role._id, { clear: true });
        expect(res.body.configured).toBe(false);
        const saved = await JobRole.findById(role._id);
        expect(saved.payroll?.employmentType).toBeFalsy();
    });

    test("listRoles reports holders and who is already on payroll", async () => {
        const role = await JobRole.create({ name: "Driver", payroll: { employmentType: "daily-wage", payModel: "daily", defaultRate: 700 } });
        const e1 = await makeEmp("D1", role._id);
        await makeEmp("D2", role._id);
        await PayrollProfile.create({ personType: "Employee", personId: e1._id, employmentType: "daily-wage", payModel: "daily", rates: [{ effectiveFrom: "2026-01-01", amount: 700 }] });
        const res = mockRes();
        await config.listRoles(asAdmin(), res);
        const driver = res.body.items.find((r) => r.name === "Driver");
        expect(driver.people).toBe(2);
        expect(driver.onPayroll).toBe(1);
        expect(driver.configured).toBe(true);
    });
});

describe("adding everyone in a role", () => {
    test("creates a profile for each holder from the template + default rate, skipping the already-tagged and never overwriting", async () => {
        const role = await JobRole.create({
            name: "Labour", appliesTo: "employee",
            payroll: { employmentType: "daily-wage", payModel: "daily", paidDayPolicy: policy._id, overtimeEligible: false, defaultRate: 600 },
        });
        const a = await makeEmp("L1", role._id);
        const b = await makeEmp("L2", role._id);
        await PayrollProfile.create({ personType: "Employee", personId: a._id, employmentType: "daily-wage", payModel: "daily", rates: [{ effectiveFrom: "2026-01-01", amount: 500 }] });

        const res = await apply({ jobRoleId: String(role._id) });
        expect(res.statusCode).toBe(201);
        expect(res.body.created).toBe(1);
        expect(res.body.skipped).toBe(1);

        const prof = await PayrollProfile.findOne({ personId: b._id });
        expect(prof.payModel).toBe("daily");
        expect(prof.rates[0].amount).toBe(600);
        // The already-tagged person's profile is untouched.
        const aProf = await PayrollProfile.findOne({ personId: a._id });
        expect(aProf.rates[0].amount).toBe(500);
    });

    test("a batch rate overrides the role default", async () => {
        const role = await JobRole.create({ name: "Labour", appliesTo: "employee", payroll: { employmentType: "daily-wage", payModel: "daily", defaultRate: 600 } });
        const b = await makeEmp("L2", role._id);
        const res = await apply({ jobRoleId: String(role._id), rate: 750 });
        expect(res.body.created).toBe(1);
        const prof = await PayrollProfile.findOne({ personId: b._id });
        expect(prof.rates[0].amount).toBe(750);
    });

    test("refuses when the role has no payroll template", async () => {
        const role = await JobRole.create({ name: "Bare" });
        await makeEmp("P", role._id);
        const res = await apply({ jobRoleId: String(role._id) });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe("roleNotConfigured");
    });

    test("refuses when no rate is available (no role default, none passed)", async () => {
        const role = await JobRole.create({ name: "Driver", appliesTo: "employee", payroll: { employmentType: "daily-wage", payModel: "daily" } });
        await makeEmp("D", role._id);
        const res = await apply({ jobRoleId: String(role._id) });
        expect(res.statusCode).toBe(400);
        expect(res.body.code).toBe("rateRequired");
    });
});
