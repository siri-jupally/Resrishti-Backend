/**
 * An admin acting as a pickup agent.
 *
 * `canSupervise` has always existed on the Admin model and the assign-
 * supervisor list has always read it, but nothing could set it — so an admin
 * could never be assigned a pickup and their My Pickups tab stayed empty.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Admin = require("../models/Admin");
const Client = require("../models/Client");
const Pickup = require("../models/Pickup");

const org = require("../controllers/adminOrgController");
const adminPickups = require("../controllers/adminPickupController");

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

let admin;
let client;

beforeEach(async () => {
    await Promise.all([
        Admin.deleteMany({}), Client.deleteMany({}), Pickup.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    client = await Client.create({
        name: "Acme", contactName: "Ann", contactEmail: "ann@acme.com",
        contactPhone: "1", status: "active", isOnboardingComplete: true,
    });
});

const asAdmin = (o = {}) => mockReq({ admin, ...o });

const setFlag = async (canSupervise) => {
    const res = mockRes();
    await org.updateMyPickupAgentFlag(asAdmin({ body: { canSupervise } }), res);
    return res;
};

describe("switching it on", () => {
    test("starts off", async () => {
        const res = mockRes();
        await org.getMyPickupAgentFlag(asAdmin(), res);
        expect(res.body.canSupervise).toBe(false);
    });

    test("can be switched on", async () => {
        const res = await setFlag(true);
        expect(res.statusCode).toBe(200);
        expect((await Admin.findById(admin._id)).canSupervise).toBe(true);
    });

    test("the admin then appears in the assign-supervisor list", async () => {
        const before = mockRes();
        await adminPickups.getSupervisorPool(asAdmin(), before);
        const countBefore = (before.body.items || before.body).length ?? 0;

        await setFlag(true);

        const after = mockRes();
        await adminPickups.getSupervisorPool(asAdmin(), after);
        const pool = after.body.items || after.body;
        expect(pool.length).toBe(countBefore + 1);
        expect(pool.some((p) => String(p._id) === String(admin._id))).toBe(true);
    });

    test("a non-boolean is refused", async () => {
        const res = mockRes();
        await org.updateMyPickupAgentFlag(asAdmin({ body: { canSupervise: "yes" } }), res);
        expect(res.statusCode).toBe(400);
    });
});

describe("switching it off", () => {
    const makePickup = (status) =>
        Pickup.create({
            pickupID: `PU-${Math.random().toString(16).slice(2, 8).toUpperCase()}`,
            client: client._id,
            clientNameSnapshot: client.name,
            status,
            supervisor: { userType: "Admin", userId: admin._id, name: "a@test.com" },
        });

    test("is fine when nothing is in progress", async () => {
        await setFlag(true);
        const res = await setFlag(false);
        expect(res.statusCode).toBe(200);
        expect((await Admin.findById(admin._id)).canSupervise).toBe(false);
    });

    test("is refused while a pickup is still running", async () => {
        await setFlag(true);
        await makePickup("en-route");
        const res = await setFlag(false);
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/1 pickup/);
        expect((await Admin.findById(admin._id)).canSupervise).toBe(true);
    });

    test("a finished pickup is not in the way", async () => {
        await setFlag(true);
        await makePickup("cert-sent");
        const res = await setFlag(false);
        expect(res.statusCode).toBe(200);
    });
});
