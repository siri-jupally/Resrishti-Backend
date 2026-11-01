/*
  End-to-end — the whole v2 pickup lifecycle through the REAL controllers.

  One pickup, cradle to certificate:
    create (v2, scheduled)
      → 7 guided stages (departed → … → loaded → stream weights → at-facility)
      → preliminary weights recorded in the field
      → [impact: NOT counted while in-flight]
      → closure confirms the final weights (admin)       → status 'closed'
      → [impact: now counted on public stats + client dashboard]
      → generate CoD (admin)                             → draft, pickup stays 'closed'
      → issue → send                                     → cert 'sent', pickup stays 'closed'
      → [impact: still counted once]

  Mocks the side-effects only (S3 / email / push / PDF / socket); every state
  transition runs the production controller code.
*/
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({ sendPush: jest.fn().mockResolvedValue({}), notifyIfEnabled: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/certificatePdf", () => ({ renderCertificatePdf: jest.fn().mockResolvedValue(Buffer.from("pdf")) }));
jest.mock("../utils/s3", () => ({
    uploadPickupEvidence: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    uploadFile: jest.fn().mockResolvedValue({ key: "cods/2026/x.pdf", bucket: "b" }),
    uploadCheckinPhoto: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    getS3Client: jest.fn(() => ({ send: jest.fn().mockResolvedValue({ Body: (async function* () { yield Buffer.from("pdf"); })() }) })),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Employee = require("../models/Employee");
const Admin = require("../models/Admin");
const Certificate = require("../models/Certificate");
const StatsSnapshot = require("../models/StatsSnapshot");

const sup = require("../controllers/supervisorPickupController");
const certCtrl = require("../controllers/certificateController");
const clientPortal = require("../controllers/clientPortalController");
const { computePublicStats } = require("../services/statsJob");

let mongod, agent, admin, client;
const mockRes = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(d) { r.body = d; return r; } }; return r; };
const PHOTO = () => ({ photos: [{ buffer: Buffer.from("img"), mimetype: "image/jpeg" }] });

const advance = async (id, status, body = {}) => {
    const req = { employee: agent, params: { id: String(id) }, query: {}, body: { status, ...body }, files: PHOTO() };
    const res = mockRes(); await sup.updatePickupStatus(req, res); return res;
};
const publicTotal = async () => {
    await computePublicStats();
    const snap = await StatsSnapshot.findOne({ key: "public-live-stats" }).lean();
    return snap ? snap.totalKgDiverted : null;
};

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([Pickup.deleteMany({}), Client.deleteMany({}), Employee.deleteMany({}), Admin.deleteMany({}), Certificate.deleteMany({}), StatsSnapshot.deleteMany({})]);
    client = await Client.create({ name: "Acme", contactName: "A", contactEmail: "a@acme.com", contactPhone: "1", status: "active", isOnboardingComplete: true });
    agent = await Employee.create({ name: "V2 Agent", email: "agent@test.com", password: "secret123", manager: new mongoose.Types.ObjectId(), canSupervise: true });
    admin = await Admin.create({ email: "admin@test.com", password: "secret123", canCoordinate: true });
});

describe("E2E — v2 pickup: creation → stages → close → certificate", () => {
    it("drives one pickup all the way through, asserting each milestone", async () => {
        // ── create ────────────────────────────────────────────────────────
        const p = await Pickup.create({
            pickupID: "PU-E2E-0001",
            client: client._id,
            clientNameSnapshot: client.name,
            status: "scheduled",
            pipelineVersion: 2,
            requestedStreams: ["plastic", "paper"],
            scheduledDate: new Date(),
            supervisor: { userType: "Employee", userId: agent._id, name: agent.name },
        });
        expect(p.pipelineVersion).toBe(2);

        // ── 7 guided stages (as the assigned agent) ────────────────────────
        for (const s of ["v2-departed", "v2-empty-weighed", "v2-at-client", "v2-loading", "v2-loaded"]) {
            expect((await advance(p._id, s)).statusCode).toBe(200);
        }
        // stage 6 — stream-wise preliminary weights
        expect((await advance(p._id, "v2-loaded-weighed", {
            lineItems: JSON.stringify([{ stream: "plastic", qtyKg: 500 }, { stream: "paper", qtyKg: 300 }]),
        })).statusCode).toBe(200);
        // stage 7 — reached facility
        expect((await advance(p._id, "v2-at-facility")).statusCode).toBe(200);

        let fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("v2-at-facility");
        expect(fresh.weightsStatus).toBe("preliminary");
        expect(fresh.totalKg).toBe(800);
        expect(fresh.vehicleWeights).toBeUndefined();          // no vehicle weighing
        expect(fresh.evidence).toHaveLength(7);                 // a photo trail per stage
        expect(fresh.evidence.every((e) => e.photos && e.photos.length > 0)).toBe(true);

        // ── impact BEFORE closure: in-flight → not counted ─────────────────
        expect(await publicTotal()).toBe(0);

        // ── closure (admin confirms edited final weights) ──────────────────
        const closeRes = mockRes();
        await sup.closeRun({ admin, params: { id: String(p._id) }, query: {}, body: {
            lineItems: JSON.stringify([{ stream: "plastic", qtyKg: 480 }, { stream: "paper", qtyKg: 260 }]),
        } }, closeRes);
        expect(closeRes.statusCode).toBe(200);
        fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("closed");
        expect(fresh.weightsStatus).toBe("confirmed");
        expect(fresh.totalKg).toBe(740);
        expect(await Certificate.countDocuments()).toBe(0);     // closure is decoupled from certs

        // ── impact AFTER closure: counted (public + client dashboard) ──────
        expect(await publicTotal()).toBe(740);
        const dashRes = mockRes();
        await clientPortal.getDashboard({ client: { _id: client._id } }, dashRes);
        expect(dashRes.body.totalKgDiverted).toBe(740);

        // ── generate the CoD (admin) ───────────────────────────────────────
        const genRes = mockRes();
        await certCtrl.generateCertificateForPickup({ admin, body: { pickupId: String(p._id) } }, genRes);
        expect(genRes.statusCode).toBe(201);
        const certId = genRes.body._id;
        expect(genRes.body.status).toBe("draft");
        expect(genRes.body.totalKgSnapshot).toBe(740);
        fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("closed");                    // generating doesn't move it
        expect(String(fresh.certificate)).toBe(String(certId));

        // ── issue → send ───────────────────────────────────────────────────
        const issueRes = mockRes();
        await certCtrl.issueCertificate({ admin, params: { id: String(certId) }, body: {} }, issueRes);
        expect(issueRes.statusCode).toBe(200);
        const sendRes = mockRes();
        await certCtrl.sendCertificate({ admin, params: { id: String(certId) }, body: {} }, sendRes);
        expect(sendRes.statusCode).toBe(200);
        expect((await Certificate.findById(certId)).status).toBe("sent");
        expect((await Pickup.findById(p._id)).status).toBe("closed"); // STILL closed after issue/send

        // ── impact unchanged — the pickup is counted exactly once ──────────
        expect(await publicTotal()).toBe(740);
    });
});
