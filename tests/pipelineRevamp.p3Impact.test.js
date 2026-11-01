/*
  Phase 3 — impact decoupled from certificate issuance.

  Both formerly cert-gated consumers must now count every COMPLETED pickup
  (Pickup.CLOSED_EQUIVALENT_STATUSES, incl. the v2 'closed' state) instead of
  only cert-issued/sent, while still excluding in-flight pickups:
    - services/statsJob.computePublicStats   (public-site totals)
    - clientPortalController.getDashboard     (client-portal totals)
*/
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({ sendPush: jest.fn().mockResolvedValue({}), notifyIfEnabled: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const StatsSnapshot = require("../models/StatsSnapshot");
const { computePublicStats } = require("../services/statsJob");
const clientPortal = require("../controllers/clientPortalController");

let mongod, client, otherClient;
const mockRes = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(d) { r.body = d; return r; } }; return r; };

const mk = (over = {}) => Pickup.create({
    pickupID: `PU-P3-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    client: client._id,
    lineItems: [{ stream: "plastic", qtyKg: 100 }],
    totalKg: 100,
    ...over,
});

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([Pickup.deleteMany({}), Client.deleteMany({}), StatsSnapshot.deleteMany({})]);
    client = await Client.create({ name: "Acme", contactName: "A", contactEmail: "a@acme.com", contactPhone: "1", status: "active", isOnboardingComplete: true });
    otherClient = await Client.create({ name: "Beta", contactName: "B", contactEmail: "b@beta.com", contactPhone: "2", status: "active", isOnboardingComplete: true });
});

describe("Phase 3 — public stats count completed pickups, not certificates", () => {
    it("includes v1 processed + cert-sent AND v2 'closed'; excludes in-flight", async () => {
        await mk({ status: "processed" });                                                                      // v1 complete, no cert → 100
        await mk({ status: "cert-sent", lineItems: [{ stream: "paper", qtyKg: 50 }], totalKg: 50 });            // v1 cert sent → 50
        await mk({ status: "closed", pipelineVersion: 2, weightsStatus: "confirmed", lineItems: [{ stream: "plastic", qtyKg: 30 }], totalKg: 30 }); // v2 complete → 30
        await mk({ status: "v2-at-facility", pipelineVersion: 2, weightsStatus: "preliminary" });               // in-flight → excluded
        await mk({ status: "weighed" });                                                                        // in-flight → excluded

        await computePublicStats();
        const snap = await StatsSnapshot.findOne({ key: "public-live-stats" }).lean();
        expect(snap.totalKgDiverted).toBe(180); // 100 + 50 + 30
    });
});

describe("Phase 3 — client dashboard counts completed pickups, not certificates", () => {
    it("sums the client's completed pickups incl. v2 'closed'; excludes in-flight and other clients", async () => {
        await mk({ status: "processed" });                                                                      // 100
        await mk({ status: "closed", pipelineVersion: 2, lineItems: [{ stream: "paper", qtyKg: 25 }], totalKg: 25 }); // 25
        await mk({ status: "v2-loaded-weighed", pipelineVersion: 2, weightsStatus: "preliminary" });            // in-flight → excluded
        await Pickup.create({ pickupID: "PU-OTHER", client: otherClient._id, status: "processed", lineItems: [{ stream: "plastic", qtyKg: 999 }], totalKg: 999 }); // other client → excluded

        const res = mockRes();
        await clientPortal.getDashboard({ client: { _id: client._id } }, res);
        expect(res.statusCode).toBe(200);
        expect(res.body.totalKgDiverted).toBe(125); // 100 + 25 only
    });
});
