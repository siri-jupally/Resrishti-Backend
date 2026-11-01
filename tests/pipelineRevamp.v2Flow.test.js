/*
  Phase 1 — v2 (7-stage) pickup workflow, backend state machine.

  Drives updatePickupStatus directly (same pattern as certificateWeights.test.js)
  to verify: the 7-stage happy path with vehicle-weight capture + net calc, that
  every v2 stage is photo-gated, weight validation, invalid transitions, and that
  legacy (v1) pickups are untouched / grandfathered on the old flow.
*/
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/s3", () => ({
    uploadPickupEvidence: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    uploadCheckinPhoto: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    uploadFile: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    getS3Client: jest.fn(() => ({ send: jest.fn() })),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Employee = require("../models/Employee");
const sup = require("../controllers/supervisorPickupController");

let mongod;
const mockRes = () => {
    const res = {
        statusCode: 200, body: null,
        status(c) { res.statusCode = c; return res; },
        json(d) { res.body = d; return res; },
    };
    return res;
};

let agent, client;

const PHOTO = () => ({ photos: [{ buffer: Buffer.from("img"), mimetype: "image/jpeg" }] });

// advance a pickup via the status endpoint as the assigned agent
const advance = async (pickupId, status, { body = {}, noPhoto = false } = {}) => {
    const req = {
        employee: agent,
        params: { id: String(pickupId) },
        query: {},
        body: { status, ...body },
        files: noPhoto ? {} : PHOTO(),
    };
    const res = mockRes();
    await sup.updatePickupStatus(req, res);
    return res;
};

const makePickup = async (pipelineVersion, status = "scheduled") =>
    Pickup.create({
        pickupID: `PU-${pipelineVersion}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        client: client._id,
        status,
        pipelineVersion,
        supervisor: { userType: "Employee", userId: agent._id, name: agent.name },
    });

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });

beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([Pickup.deleteMany({}), Client.deleteMany({}), Employee.deleteMany({})]);
    client = await Client.create({
        name: "Acme", contactName: "Ann", contactEmail: "ann@acme.com",
        contactPhone: "1", status: "active", isOnboardingComplete: true,
    });
    agent = await Employee.create({
        name: "Agent", email: "agent@test.com", password: "secret123",
        manager: new mongoose.Types.ObjectId(), canSupervise: true,
    });
});

describe("Phase 1 — v2 7-stage workflow", () => {
    it("walks all 7 stages and records empty/loaded/net vehicle weights", async () => {
        const p = await makePickup(2, "scheduled");
        const steps = [
            ["v2-departed", {}],
            ["v2-empty-weighed", { body: { emptyKg: 1000 } }],
            ["v2-at-client", {}],
            ["v2-loading", {}],
            ["v2-loaded", {}],
            ["v2-loaded-weighed", { body: { loadedKg: 1850, lineItems: JSON.stringify([{ stream: "plastic", qtyKg: 500 }, { stream: "paper", qtyKg: 300 }]) } }],
            ["v2-at-facility", {}],
        ];
        for (const [status, opts] of steps) {
            const res = await advance(p._id, status, opts);
            expect(res.statusCode).toBe(200);
        }
        const fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("v2-at-facility");
        expect(fresh.vehicleWeights.emptyKg).toBe(1000);
        expect(fresh.vehicleWeights.loadedKg).toBe(1850);
        expect(fresh.vehicleWeights.netKg).toBe(850);
        // preliminary stream weights recorded at the loaded-weighbridge stage
        expect(fresh.weightsStatus).toBe("preliminary");
        expect(fresh.lineItems).toHaveLength(2);
        expect(fresh.totalKg).toBe(800);
        expect(fresh.wasteDataHistory.some((h) => /preliminary/i.test(h.reason))).toBe(true);
        // every stage left an evidence entry with a photo
        expect(fresh.evidence).toHaveLength(7);
        expect(fresh.evidence.every((e) => e.photos && e.photos.length > 0)).toBe(true);
    });

    it("requires preliminary stream weights at the loaded-weighbridge stage", async () => {
        const p = await makePickup(2, "v2-loaded");
        await Pickup.updateOne({ _id: p._id }, { $set: { vehicleWeights: { emptyKg: 1000 } } });
        const res = await advance(p._id, "v2-loaded-weighed", { body: { loadedKg: 1850 } }); // no lineItems
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/waste stream weight/i);
    });

    it("requires a photo at EVERY v2 stage", async () => {
        const p = await makePickup(2, "scheduled");
        const res = await advance(p._id, "v2-departed", { noPhoto: true });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/Photo evidence is required/);
    });

    it("requires emptyKg at the empty-weighbridge stage", async () => {
        const p = await makePickup(2, "v2-departed");
        const res = await advance(p._id, "v2-empty-weighed", {}); // no emptyKg
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/emptyKg/);
    });

    it("rejects a loaded weight that isn't greater than empty", async () => {
        const p = await makePickup(2, "scheduled");
        await advance(p._id, "v2-departed");
        await advance(p._id, "v2-empty-weighed", { body: { emptyKg: 1000 } });
        await advance(p._id, "v2-at-client");
        await advance(p._id, "v2-loading");
        await advance(p._id, "v2-loaded");
        const res = await advance(p._id, "v2-loaded-weighed", { body: { loadedKg: 900 } });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/greater than empty/);
    });

    it("rejects an invalid v2 transition (skipping a stage)", async () => {
        const p = await makePickup(2, "scheduled");
        const res = await advance(p._id, "v2-at-client"); // skips departed/empty-weighed
        expect(res.statusCode).toBe(409);
    });

    it("cannot advance past v2-at-facility via the status endpoint (closure is P2)", async () => {
        const p = await makePickup(2, "v2-at-facility");
        const res = await advance(p._id, "closed");
        expect(res.statusCode).toBe(409);
    });
});

describe("Phase 1 — v1 pickups are grandfathered (unchanged)", () => {
    it("a v1 pickup still uses the legacy flow (scheduled → en-route)", async () => {
        const p = await makePickup(1, "scheduled");
        const res = await advance(p._id, "en-route"); // v1 photo-optional
        expect(res.statusCode).toBe(200);
        expect((await Pickup.findById(p._id)).status).toBe("en-route");
    });

    it("a v1 pickup CANNOT use v2 statuses", async () => {
        const p = await makePickup(1, "scheduled");
        const res = await advance(p._id, "v2-departed");
        expect(res.statusCode).toBe(409);
    });

    it("a pickup with missing pipelineVersion is treated as v1", async () => {
        const p = await makePickup(2, "scheduled");
        await Pickup.collection.updateOne({ _id: p._id }, { $unset: { pipelineVersion: "" } });
        const res = await advance(p._id, "en-route"); // legacy transition
        expect(res.statusCode).toBe(200);
    });
});
