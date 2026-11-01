/*
  Phase 1 — v2 (7-stage) pickup workflow, backend state machine.

  Drives updatePickupStatus directly (same pattern as certificateWeights.test.js)
  to verify: the 7-stage happy path with stream-wise PRELIMINARY weights entered
  at the loaded-weighbridge stage (no vehicle weighing), that the field stages are
  photo-gated, invalid transitions, and that legacy (v1) pickups are untouched /
  grandfathered on the old flow.
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
    it("walks all 7 stages and records stream-wise preliminary weights (no vehicle weighing)", async () => {
        const p = await makePickup(2, "scheduled");
        const steps = [
            ["v2-departed", {}],
            ["v2-empty-weighed", {}],
            ["v2-at-client", {}],
            ["v2-loading", {}],
            ["v2-loaded", {}],
            ["v2-loaded-weighed", { body: { lineItems: JSON.stringify([{ stream: "plastic", qtyKg: 500 }, { stream: "paper", qtyKg: 300 }]) } }],
            ["v2-at-facility", {}],
        ];
        for (const [status, opts] of steps) {
            const res = await advance(p._id, status, opts);
            expect(res.statusCode).toBe(200);
        }
        const fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("v2-at-facility");
        // no vehicle empty/loaded/net weights are captured anymore
        expect(fresh.vehicleWeights).toBeUndefined();
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
        const res = await advance(p._id, "v2-loaded-weighed", {}); // no lineItems
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/waste stream weight/i);
    });

    it("accepts the loaded-weighbridge stage with NO photo (stream entry is photo-optional, like v1)", async () => {
        const p = await makePickup(2, "v2-loaded");
        const res = await advance(p._id, "v2-loaded-weighed", {
            noPhoto: true,
            body: { lineItems: JSON.stringify([{ stream: "plastic", qtyKg: 120 }]) },
        });
        expect(res.statusCode).toBe(200);
        const fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("v2-loaded-weighed");
        expect(fresh.weightsStatus).toBe("preliminary");
        expect(fresh.totalKg).toBe(120);
    });

    it("requires a photo at the field stages (e.g. v2-departed)", async () => {
        const p = await makePickup(2, "scheduled");
        const res = await advance(p._id, "v2-departed", { noPhoto: true });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/Photo evidence is required/);
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

    it("real legacy rows are grandfathered by the migration's explicit pipelineVersion:1, not by a missing field", async () => {
        // Now that the schema default is 2, a row whose field is genuinely
        // absent (e.g. inserted raw) picks up that default on hydration and
        // runs the v2 flow — so a v1-only transition is rejected...
        const p = await makePickup(2, "scheduled");
        await Pickup.collection.updateOne({ _id: p._id }, { $unset: { pipelineVersion: "" } });
        const asV2 = await advance(p._id, "en-route"); // v1-only transition
        expect(asV2.statusCode).toBe(409);
        // ...which is exactly why the migration backfills every existing row to
        // an explicit 1. Once it is 1, the legacy flow applies.
        await Pickup.collection.updateOne({ _id: p._id }, { $set: { pipelineVersion: 1 } });
        const asV1 = await advance(p._id, "en-route");
        expect(asV1.statusCode).toBe(200);
        expect((await Pickup.findById(p._id)).status).toBe("en-route");
    });
});
