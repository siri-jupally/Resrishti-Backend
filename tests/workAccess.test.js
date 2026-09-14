/**
 * Job-role based attendance access + out-of-premises approval counting.
 *
 * Covers:
 *   - which modes a person may use (override → role → unassigned)
 *   - job role rules (unique names, at least one mode, retire vs delete)
 *   - assigning roles / overrides per person, including employee defaults
 *   - worked days and hours count only once approved
 *   - the pending queue and admin approval audit trail
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));

const JobRole = require("../models/JobRole");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Attendance = require("../models/Attendance");
const { resolveAllowedWorkModes, checkModePermitted } = require("../utils/workModePermissions");
const { summariseWorked } = require("../utils/attendanceCounting");
const access = require("../controllers/workAccessController");

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

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

let manager;
let employee;
const admin = { _id: new mongoose.Types.ObjectId() };

beforeEach(async () => {
    await Promise.all([
        JobRole.deleteMany({}),
        Employee.deleteMany({}),
        Manager.deleteMany({}),
        Attendance.deleteMany({}),
    ]);
    manager = await Manager.create({ name: "M", email: "m@test.com", password: "secret123" });
    employee = await Employee.create({
        name: "E", email: "e@test.com", password: "secret123", manager: manager._id,
    });
});

const makeRole = (fields) =>
    JobRole.create({
        name: fields.name,
        nameKey: fields.name.toLowerCase(),
        allowedWorkModes: fields.allowedWorkModes || ["WFO"],
        appliesTo: fields.appliesTo || "both",
        isActive: fields.isActive !== undefined ? fields.isActive : true,
    });

// ───────────────────────── resolution ─────────────────────────

describe("resolveAllowedWorkModes", () => {
    test("unassigned people may use every mode", async () => {
        const r = await resolveAllowedWorkModes(employee);
        expect(r.source).toBe("unassigned");
        expect(r.modes.sort()).toEqual(["WFH", "WFO", "remote"]);
    });

    test("a role restricts to its modes", async () => {
        const role = await makeRole({ name: "Plant Operator", allowedWorkModes: ["WFO"] });
        employee.jobRoleId = role._id;
        const r = await resolveAllowedWorkModes(employee);
        expect(r.source).toBe("role");
        expect(r.modes).toEqual(["WFO"]);
        expect(r.roleName).toBe("Plant Operator");
    });

    test("an individual override wins over the role", async () => {
        const role = await makeRole({ name: "Plant Operator", allowedWorkModes: ["WFO"] });
        employee.jobRoleId = role._id;
        employee.workModesOverride = ["WFO", "remote"];
        const r = await resolveAllowedWorkModes(employee);
        expect(r.source).toBe("override");
        expect(r.modes.sort()).toEqual(["WFO", "remote"]);
    });

    test("an empty override falls back to the role", async () => {
        const role = await makeRole({ name: "Field Supervisor", allowedWorkModes: ["WFO", "remote"] });
        employee.jobRoleId = role._id;
        employee.workModesOverride = [];
        const r = await resolveAllowedWorkModes(employee);
        expect(r.source).toBe("role");
    });

    test("checkModePermitted refuses a mode outside the set and says what is allowed", async () => {
        const role = await makeRole({ name: "Plant Operator", allowedWorkModes: ["WFO"] });
        employee.jobRoleId = role._id;
        const denied = await checkModePermitted(employee, "remote");
        expect(denied.status).toBe(403);
        expect(denied.message).toMatch(/Plant Operator/);
        expect(denied.message).toMatch(/Office/);
        expect(await checkModePermitted(employee, "WFO")).toBeNull();
    });
});

// ───────────────────────── job roles ─────────────────────────

describe("job roles", () => {
    test("names are unique regardless of case", async () => {
        await makeRole({ name: "Supervisor" });
        const res = mockRes();
        await access.createJobRole(mockReq({ admin, body: { name: "supervisor ", allowedWorkModes: ["WFO"] } }), res);
        expect(res.statusCode).toBe(409);
    });

    test("a role needs at least one mode", async () => {
        const res = mockRes();
        await access.createJobRole(mockReq({ admin, body: { name: "Empty", allowedWorkModes: [] } }), res);
        expect(res.statusCode).toBe(400);
    });

    test("an assigned role cannot be deleted", async () => {
        const role = await makeRole({ name: "Plant Operator" });
        await Employee.updateOne({ _id: employee._id }, { jobRoleId: role._id });
        const res = mockRes();
        await access.deleteJobRole(mockReq({ admin, params: { id: String(role._id) } }), res);
        expect(res.statusCode).toBe(409);
        expect(await JobRole.countDocuments()).toBe(1);
    });

    test("renaming a role updates holders' job role label", async () => {
        const role = await makeRole({ name: "Operator" });
        await Employee.updateOne({ _id: employee._id }, { jobRoleId: role._id, jobRole: "Operator" });
        const res = mockRes();
        await access.updateJobRole(mockReq({ admin, params: { id: String(role._id) }, body: { name: "Plant Operator" } }), res);
        expect(res.statusCode).toBe(200);
        expect((await Employee.findById(employee._id)).jobRole).toBe("Plant Operator");
    });

    test("narrowing a role's modes moves holders' default mode onto an allowed one", async () => {
        const role = await makeRole({ name: "Field", allowedWorkModes: ["WFO", "remote"] });
        await Employee.updateOne({ _id: employee._id }, { jobRoleId: role._id, defaultWorkMode: "remote" });
        await access.updateJobRole(
            mockReq({ admin, params: { id: String(role._id) }, body: { allowedWorkModes: ["WFO"] } }),
            mockRes()
        );
        expect((await Employee.findById(employee._id)).defaultWorkMode).toBe("WFO");
    });

    test("cannot limit a role to employees while managers hold it", async () => {
        const role = await makeRole({ name: "Lead" });
        await Manager.updateOne({ _id: manager._id }, { jobRoleId: role._id });
        const res = mockRes();
        await access.updateJobRole(mockReq({ admin, params: { id: String(role._id) }, body: { appliesTo: "employee" } }), res);
        expect(res.statusCode).toBe(409);
    });
});

// ───────────────────────── per-person access ─────────────────────────

describe("updateWorkAccess", () => {
    test("assigning a role sets the label and the allowed modes", async () => {
        const role = await makeRole({ name: "Plant Operator", allowedWorkModes: ["WFO"] });
        const res = mockRes();
        await access.updateWorkAccess("employee")(
            mockReq({ admin, params: { id: String(employee._id) }, body: { jobRoleId: String(role._id) } }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.allowedWorkModes).toEqual(["WFO"]);
        expect(res.body.source).toBe("role");
        expect((await Employee.findById(employee._id)).jobRole).toBe("Plant Operator");
    });

    test("a manager-only role cannot be given to an employee", async () => {
        const role = await makeRole({ name: "Plant Head", appliesTo: "manager" });
        const res = mockRes();
        await access.updateWorkAccess("employee")(
            mockReq({ admin, params: { id: String(employee._id) }, body: { jobRoleId: String(role._id) } }),
            res
        );
        expect(res.statusCode).toBe(400);
    });

    test("a retired role cannot be newly assigned", async () => {
        const role = await makeRole({ name: "Old Role", isActive: false });
        const res = mockRes();
        await access.updateWorkAccess("employee")(
            mockReq({ admin, params: { id: String(employee._id) }, body: { jobRoleId: String(role._id) } }),
            res
        );
        expect(res.statusCode).toBe(400);
    });

    test("an override applies and can be cleared back to the role", async () => {
        const role = await makeRole({ name: "Plant Operator", allowedWorkModes: ["WFO"] });
        await Employee.updateOne({ _id: employee._id }, { jobRoleId: role._id });

        const set = mockRes();
        await access.updateWorkAccess("employee")(
            mockReq({ admin, params: { id: String(employee._id) }, body: { workModesOverride: ["WFO", "WFH"] } }),
            set
        );
        expect(set.body.source).toBe("override");

        const clear = mockRes();
        await access.updateWorkAccess("employee")(
            mockReq({ admin, params: { id: String(employee._id) }, body: { workModesOverride: null } }),
            clear
        );
        expect(clear.body.source).toBe("role");
        expect(clear.body.allowedWorkModes).toEqual(["WFO"]);
    });

    test("restricting access moves an employee's default mode onto an allowed one", async () => {
        await Employee.updateOne({ _id: employee._id }, { defaultWorkMode: "WFH" });
        const role = await makeRole({ name: "Plant Operator", allowedWorkModes: ["WFO"] });
        await access.updateWorkAccess("employee")(
            mockReq({ admin, params: { id: String(employee._id) }, body: { jobRoleId: String(role._id) } }),
            mockRes()
        );
        expect((await Employee.findById(employee._id)).defaultWorkMode).toBe("WFO");
    });

    test("works for managers too", async () => {
        const role = await makeRole({ name: "Site Manager", allowedWorkModes: ["WFO", "remote"], appliesTo: "manager" });
        const res = mockRes();
        await access.updateWorkAccess("manager")(
            mockReq({ admin, params: { id: String(manager._id) }, body: { jobRoleId: String(role._id) } }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.allowedWorkModes.sort()).toEqual(["WFO", "remote"]);
    });
});

// ───────────────────────── counting ─────────────────────────

describe("summariseWorked", () => {
    const rec = (status, approvalStatus, workingHours, locationWithinBoundary) =>
        ({ status, approvalStatus, workingHours, locationWithinBoundary });

    test("counts approved and auto-approved days and hours", () => {
        const s = summariseWorked([
            rec("present", "auto-approved", 8),
            rec("present", "approved", 7.5),
            rec("half-day", "auto-approved", 3),
        ]);
        expect(s.present).toBe(2);
        expect(s.halfDay).toBe(1);
        expect(s.totalHours).toBe(18.5);
    });

    test("excludes pending days from hours but reports them separately", () => {
        const s = summariseWorked([rec("present", "auto-approved", 8), rec("present", "pending", 6, false)]);
        expect(s.present).toBe(1);
        expect(s.totalHours).toBe(8);
        expect(s.pendingApproval).toBe(1);
        expect(s.pendingHours).toBe(6);
    });

    test("rejected days never count", () => {
        const s = summariseWorked([rec("present", "rejected", 8)]);
        expect(s.present).toBe(0);
        expect(s.totalHours).toBe(0);
        expect(s.rejected).toBe(1);
    });

    // The schema defaults approvalStatus to "pending". A row that only has the
    // default — no out-of-premises flag — is not an out-of-premises login.
    test("a default-pending record with no out-of-premises flag still counts", () => {
        const s = summariseWorked([rec("present", "pending", 8)]);
        expect(s.present).toBe(1);
        expect(s.totalHours).toBe(8);
        expect(s.pendingApproval).toBe(0);
    });

    test("records predating approvalStatus still count", () => {
        const s = summariseWorked([rec("present", undefined, 8)]);
        expect(s.present).toBe(1);
        expect(s.totalHours).toBe(8);
    });

    test("leave and holiday are not treated as worked time", () => {
        const s = summariseWorked([rec("leave", "approved", 0), rec("holiday", "auto-approved", 0)]);
        expect(s.present + s.halfDay + s.pendingApproval).toBe(0);
    });
});

// ───────────────────────── approvals ─────────────────────────

describe("out-of-premises approvals", () => {
    test("pending queue lists check-ins, not records that merely default to pending", async () => {
        await Attendance.create({
            employee: employee._id, date: "2026-03-10", status: "present",
            approvalStatus: "pending", checkIn: { time: new Date() }, locationWithinBoundary: false,
        });
        // No check-in: default "pending" but nothing to approve.
        await Attendance.create({ employee: employee._id, date: "2026-03-11", status: "absent" });
        // Checked in, default "pending", but never flagged out of premises.
        await Attendance.create({
            employee: employee._id, date: "2026-03-12", status: "present", checkIn: { time: new Date() },
        });

        const res = mockRes();
        await access.getPendingEmployeeAttendance(mockReq({ admin }), res);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].date).toBe("2026-03-10");
    });

    test("manager queue only shows their own team", async () => {
        const other = await Manager.create({ name: "Other", email: "o@test.com", password: "secret123" });
        const outsider = await Employee.create({ name: "X", email: "x@test.com", password: "secret123", manager: other._id });
        for (const who of [employee, outsider]) {
            await Attendance.create({
                employee: who._id, date: "2026-03-10", status: "present",
                approvalStatus: "pending", checkIn: { time: new Date() }, locationWithinBoundary: false,
            });
        }
        const res = mockRes();
        await access.getPendingTeamAttendance(mockReq({ manager }), res);
        expect(res.body).toHaveLength(1);
        expect(String(res.body[0].employee._id)).toBe(String(employee._id));
    });

    test("admin approval records who decided and when", async () => {
        const record = await Attendance.create({
            employee: employee._id, date: "2026-03-10", status: "present",
            approvalStatus: "pending", checkIn: { time: new Date() }, workingHours: 8,
            locationWithinBoundary: false,
        });
        // Held back while pending...
        expect(summariseWorked([record]).totalHours).toBe(0);
        const res = mockRes();
        await access.adminApproveEmployeeAttendance(
            mockReq({ admin, params: { id: String(record._id) }, body: { status: "approved", remarks: "Site visit" } }),
            res
        );
        expect(res.statusCode).toBe(200);
        const saved = await Attendance.findById(record._id);
        expect(saved.approvalStatus).toBe("approved");
        expect(saved.approvedBy.userType).toBe("Admin");
        expect(String(saved.approvedBy.userId)).toBe(String(admin._id));
        expect(saved.approvedAt).toBeInstanceOf(Date);
        expect(saved.adminRemarks).toBe("Site visit");
        // ...and now it counts.
        expect(summariseWorked([saved]).totalHours).toBe(8);
    });

    test("rejects an invalid decision", async () => {
        const record = await Attendance.create({
            employee: employee._id, date: "2026-03-10", status: "present",
            approvalStatus: "pending", checkIn: { time: new Date() },
        });
        const res = mockRes();
        await access.adminApproveEmployeeAttendance(
            mockReq({ admin, params: { id: String(record._id) }, body: { status: "maybe" } }),
            res
        );
        expect(res.statusCode).toBe(400);
    });
});
