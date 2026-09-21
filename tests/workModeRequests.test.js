/**
 * WFH / remote requests — one per day, and one decision per request.
 *
 * Two reported faults:
 *   · an employee could raise a second request for a day they had already
 *     requested, as long as it named the other mode
 *   · Approve stayed on screen for an already-approved request, and pressing it
 *     re-applied the same decision: nothing changed except a second push
 *     notification to the employee
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const WorkModeRequest = require("../models/WorkModeRequest");
const AttendancePolicy = require("../models/AttendancePolicy");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");

const ctrl = require("../controllers/workModeRequestController");
const { notifyIfEnabled } = require("../utils/push");

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
let admin;

beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([
        WorkModeRequest.deleteMany({}), AttendancePolicy.deleteMany({}),
        Employee.deleteMany({}), Manager.deleteMany({}), Admin.deleteMany({}),
    ]);
    manager = await Manager.create({ name: "Mgr", email: "m@test.com", password: "secret123" });
    employee = await Employee.create({
        name: "Emp", email: "e@test.com", password: "secret123", manager: manager._id,
    });
    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    await AttendancePolicy.create({
        wfhEnabled: true,
        remoteEnabled: true,
        maxWfhDaysPerMonth: 20,
        maxRemoteDaysPerMonth: 20,
    });
});

const ask = async (body) => {
    const res = mockRes();
    await ctrl.createRequest(mockReq({ employee, body }), res);
    return res;
};

const wfhOn = (startDate, endDate = startDate) => ({
    workMode: "WFH", startDate, endDate, reason: "Plumber coming",
});
const remoteOn = (startDate, endDate = startDate) => ({
    workMode: "remote", startDate, endDate, reason: "Travelling",
});

// ──────────────────── one request per day ────────────────────

describe("one live request per day", () => {
    test("a first request is accepted", async () => {
        const res = await ask(wfhOn("2026-10-05"));
        expect(res.statusCode).toBe(201);
    });

    test("a second request for the same day in the same mode is refused", async () => {
        await ask(wfhOn("2026-10-05"));
        const res = await ask(wfhOn("2026-10-05"));
        expect(res.statusCode).toBe(409);
        expect(await WorkModeRequest.countDocuments()).toBe(1);
    });

    test("a second request for the same day in the OTHER mode is refused too", async () => {
        await ask(wfhOn("2026-10-05"));
        const res = await ask(remoteOn("2026-10-05"));
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/already have a pending work from home request/i);
        expect(await WorkModeRequest.countDocuments()).toBe(1);
    });

    test("a range that overlaps an existing request by one day is refused", async () => {
        await ask(wfhOn("2026-10-05", "2026-10-07"));
        const res = await ask(remoteOn("2026-10-07", "2026-10-09"));
        expect(res.statusCode).toBe(409);
    });

    test("an already-approved day blocks a new request", async () => {
        await ask(wfhOn("2026-10-05"));
        await WorkModeRequest.updateOne({}, { $set: { status: "approved" } });
        const res = await ask(remoteOn("2026-10-05"));
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/approved/i);
    });

    test("a different day is still fine", async () => {
        await ask(wfhOn("2026-10-05"));
        const res = await ask(remoteOn("2026-10-06"));
        expect(res.statusCode).toBe(201);
        expect(await WorkModeRequest.countDocuments()).toBe(2);
    });

    test("a rejected request does not block the day", async () => {
        await ask(wfhOn("2026-10-05"));
        await WorkModeRequest.updateOne({}, { $set: { status: "rejected" } });
        const res = await ask(remoteOn("2026-10-05"));
        expect(res.statusCode).toBe(201);
    });

    test("a cancelled request does not block the day", async () => {
        await ask(wfhOn("2026-10-05"));
        await WorkModeRequest.updateOne({}, { $set: { status: "cancelled" } });
        const res = await ask(wfhOn("2026-10-05"));
        expect(res.statusCode).toBe(201);
    });

    test("another employee's request for the same day is not in the way", async () => {
        await ask(wfhOn("2026-10-05"));
        const other = await Employee.create({
            name: "Other", email: "o@test.com", password: "secret123", manager: manager._id,
        });
        const res = mockRes();
        await ctrl.createRequest(
            mockReq({ employee: other, body: wfhOn("2026-10-05") }),
            res
        );
        expect(res.statusCode).toBe(201);
    });
});

// ──────────────────── one decision per request ────────────────────

describe("deciding a request", () => {
    const makeRequest = (status = "pending") =>
        WorkModeRequest.create({
            employee: employee._id,
            workMode: "WFH",
            startDate: "2026-10-05",
            endDate: "2026-10-05",
            reason: "Plumber coming",
            status,
        });

    const adminDecide = async (request, status) => {
        const res = mockRes();
        await ctrl.adminReviewRequest(
            mockReq({ admin, params: { id: String(request._id) }, body: { status } }),
            res
        );
        return res;
    };

    test("an admin can approve a pending request", async () => {
        const request = await makeRequest();
        const res = await adminDecide(request, "approved");
        expect(res.statusCode).toBe(200);
        expect((await WorkModeRequest.findById(request._id)).status).toBe("approved");
    });

    test("approving an already-approved request is refused", async () => {
        const request = await makeRequest("approved");
        const res = await adminDecide(request, "approved");
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/already approved/i);
    });

    test("...and the employee is not notified a second time", async () => {
        const request = await makeRequest("approved");
        await adminDecide(request, "approved");
        expect(notifyIfEnabled).not.toHaveBeenCalled();
    });

    test("rejecting an already-rejected request is refused", async () => {
        const request = await makeRequest("rejected");
        const res = await adminDecide(request, "rejected");
        expect(res.statusCode).toBe(409);
    });

    test("an admin can still overturn an approval", async () => {
        const request = await makeRequest("approved");
        const res = await adminDecide(request, "rejected");
        expect(res.statusCode).toBe(200);
        const saved = await WorkModeRequest.findById(request._id);
        expect(saved.status).toBe("rejected");
        expect(saved.adminOverride).toBe(true);
    });

    test("an admin can still overturn a rejection", async () => {
        const request = await makeRequest("rejected");
        const res = await adminDecide(request, "approved");
        expect(res.statusCode).toBe(200);
        expect((await WorkModeRequest.findById(request._id)).status).toBe("approved");
    });

    test("a cancelled request cannot be decided", async () => {
        const request = await makeRequest("cancelled");
        const res = await adminDecide(request, "approved");
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/cancelled/i);
    });

    test("a manager still only decides pending requests", async () => {
        const request = await makeRequest("approved");
        const res = mockRes();
        await ctrl.reviewRequest(
            mockReq({ manager, params: { id: String(request._id) }, body: { status: "rejected" } }),
            res
        );
        expect(res.statusCode).toBe(409);
    });
});
