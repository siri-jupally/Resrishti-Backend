/*
  Phase 2 — Pickup Closure (v2). Verifies closeRun: confirm/edit final stream
  weights → status 'closed', weightsStatus 'confirmed', audit trail, and that
  closure is INDEPENDENT of certificates (no cert created). Plus auth + guards.
*/
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({ sendPush: jest.fn().mockResolvedValue({}), notifyIfEnabled: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/s3", () => ({
    uploadPickupEvidence: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    uploadFile: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    getS3Client: jest.fn(() => ({ send: jest.fn() })),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Certificate = require("../models/Certificate");
const sup = require("../controllers/supervisorPickupController");

let mongod;
const mockRes = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(d) { r.body = d; return r; } }; return r; };
let agent, other, coordinator, client;

const makePickup = (over = {}) => Pickup.create({
    pickupID: `PU-CL-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    client: client._id, status: "v2-at-facility", pipelineVersion: 2,
    supervisor: { userType: "Employee", userId: agent._id, name: agent.name },
    lineItems: [{ stream: "plastic", qtyKg: 500 }, { stream: "paper", qtyKg: 300 }],
    totalKg: 800, weightsStatus: "preliminary",
    ...over,
});
const close = async (actorReqKey, actor, id, body = {}) => {
    const req = { [actorReqKey]: actor, params: { id: String(id) }, query: {}, body };
    const res = mockRes(); await sup.closeRun(req, res); return res;
};

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([Pickup.deleteMany({}), Client.deleteMany({}), Employee.deleteMany({}), Manager.deleteMany({}), Certificate.deleteMany({})]);
    client = await Client.create({ name: "Acme", contactName: "A", contactEmail: "a@acme.com", contactPhone: "1", status: "active", isOnboardingComplete: true });
    agent = await Employee.create({ name: "Agent", email: "a@test.com", password: "secret123", manager: new mongoose.Types.ObjectId(), canSupervise: true });
    other = await Employee.create({ name: "Other", email: "o@test.com", password: "secret123", manager: new mongoose.Types.ObjectId(), canSupervise: true });
    coordinator = await Manager.create({ name: "Coord", email: "c@test.com", password: "secret123", canCoordinate: true });
});

describe("Phase 2 — closeRun", () => {
    it("closes with edited final weights → confirmed, no certificate", async () => {
        const p = await makePickup();
        const res = await close("employee", agent, p._id, {
            lineItems: JSON.stringify([{ stream: "plastic", qtyKg: 480 }, { stream: "paper", qtyKg: 260 }]),
        });
        expect(res.statusCode).toBe(200);
        const fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("closed");
        expect(fresh.weightsStatus).toBe("confirmed");
        expect(fresh.weightsConfirmedBy.name).toBe("Agent");
        expect(fresh.totalKg).toBe(740);
        expect(fresh.wasteDataHistory.some((h) => /confirmed at closure/i.test(h.reason))).toBe(true);
        expect(fresh.evidence.some((e) => e.status === "closed")).toBe(true);
        expect(await Certificate.countDocuments()).toBe(0); // decoupled
    });

    it("closes confirming the preliminary weights when none are supplied", async () => {
        const p = await makePickup();
        const res = await close("employee", agent, p._id, {});
        expect(res.statusCode).toBe(200);
        const fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("closed");
        expect(fresh.weightsStatus).toBe("confirmed");
        expect(fresh.totalKg).toBe(800);
    });

    it("a coordinator can close a pickup they don't own", async () => {
        const p = await makePickup();
        const res = await close("manager", coordinator, p._id, {});
        expect(res.statusCode).toBe(200);
    });

    it("a non-owner, non-coordinator cannot close", async () => {
        const p = await makePickup();
        const res = await close("employee", other, p._id, {});
        expect(res.statusCode).toBe(403);
    });

    it("cannot close before reaching the facility", async () => {
        const p = await makePickup({ status: "v2-loaded" });
        const res = await close("employee", agent, p._id, {});
        expect(res.statusCode).toBe(409);
    });

    it("cannot close a legacy (v1) pickup", async () => {
        const p = await makePickup({ pipelineVersion: 1, status: "v2-at-facility" });
        const res = await close("employee", agent, p._id, {});
        expect(res.statusCode).toBe(409);
    });
});
