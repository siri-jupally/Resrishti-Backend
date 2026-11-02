/*
  Phase 4 — manual CoD generation for CLOSED v2 pickups.

  v1 pickups auto-draft a certificate at waste-data entry; v2 pickups close
  WITHOUT one (closure decoupled from certs). This verifies the manual
  generate action + that issuing/sending the resulting cert never moves the
  v2 pickup out of its terminal 'closed' state.
*/
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({ sendPush: jest.fn().mockResolvedValue({}), notifyIfEnabled: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/certificatePdf", () => ({ renderCertificatePdf: jest.fn().mockResolvedValue(Buffer.from("pdf")) }));
jest.mock("../utils/s3", () => ({
    uploadFile: jest.fn().mockResolvedValue({ key: "cods/2026/x.pdf", bucket: "test" }),
    uploadPickupEvidence: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    getS3Client: jest.fn(() => ({
        send: jest.fn().mockResolvedValue({ Body: (async function* () { yield Buffer.from("pdf"); })() }),
    })),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Admin = require("../models/Admin");
const Certificate = require("../models/Certificate");
const ctrl = require("../controllers/certificateController");

let mongod, admin, client;
const mockRes = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(d) { r.body = d; return r; } }; return r; };

const makePickup = (over = {}) => Pickup.create({
    pickupID: `PU-P4-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    client: client._id,
    clientNameSnapshot: client.name,
    status: "closed",
    pipelineVersion: 2,
    weightsStatus: "confirmed",
    weightsConfirmedAt: new Date(),
    lineItems: [{ stream: "plastic", qtyKg: 480 }, { stream: "paper", qtyKg: 260 }],
    totalKg: 740,
    supervisor: { userType: "Employee", userId: new mongoose.Types.ObjectId(), name: "Sup" },
    ...over,
});

const generate = async (pickupId) => { const res = mockRes(); await ctrl.generateCertificateForPickup({ admin, body: { pickupId: String(pickupId) } }, res); return res; };

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([Pickup.deleteMany({}), Client.deleteMany({}), Admin.deleteMany({}), Certificate.deleteMany({})]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123", canCoordinate: true });
    client = await Client.create({ name: "Acme", contactName: "A", contactEmail: "a@acme.com", contactPhone: "1", status: "active", isOnboardingComplete: true });
});

describe("Phase 4 — generate CoD for a closed v2 pickup", () => {
    it("drafts a CoD from the confirmed weights, links the pickup, and keeps it 'closed'", async () => {
        const p = await makePickup();
        const res = await generate(p._id);
        expect(res.statusCode).toBe(201);
        expect(res.body.status).toBe("draft");
        expect(res.body.certNumber).toMatch(/^CoD-\d{4}-\d{4}$/);
        expect(res.body.totalKgSnapshot).toBe(740);

        const fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("closed");                       // NOT moved to cert-draft
        expect(String(fresh.certificate)).toBe(String(res.body._id));
        expect(fresh.evidence.some((e) => /drafted/i.test(e.notes || ""))).toBe(true);
        expect(await Certificate.countDocuments()).toBe(1);
    });

    it("is idempotent — a second generate 409s with the existing certificate id", async () => {
        const p = await makePickup();
        const first = await generate(p._id);
        const second = await generate(p._id);
        expect(second.statusCode).toBe(409);
        expect(String(second.body.certificateId)).toBe(String(first.body._id));
        expect(await Certificate.countDocuments()).toBe(1);
    });

    it("rejects a v1 (legacy) pickup — those auto-draft", async () => {
        const p = await makePickup({ pipelineVersion: 1, status: "processed" });
        const res = await generate(p._id);
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/auto-draft/i);
    });

    it("rejects a v2 pickup that isn't closed yet", async () => {
        const p = await makePickup({ status: "v2-at-facility" });
        const res = await generate(p._id);
        expect(res.statusCode).toBe(409);
        expect(res.body.message).toMatch(/closed/i);
    });

    it("requires triage permission", async () => {
        const p = await makePickup();
        const res = mockRes();
        await ctrl.generateCertificateForPickup({ employee: { _id: new mongoose.Types.ObjectId() }, body: { pickupId: String(p._id) } }, res);
        expect(res.statusCode).toBe(403);
    });
});

describe("Phase 4 — issuing/sending a v2 cert keeps the pickup 'closed'", () => {
    it("issue then send advances the cert but never regresses pickup.status", async () => {
        const p = await makePickup();
        const gen = await generate(p._id);
        const certId = gen.body._id;

        const issueRes = mockRes();
        await ctrl.issueCertificate({ admin, params: { id: String(certId) }, body: {} }, issueRes);
        expect(issueRes.statusCode).toBe(200);
        expect((await Certificate.findById(certId)).status).toBe("issued");
        expect((await Pickup.findById(p._id)).status).toBe("closed");

        const sendRes = mockRes();
        await ctrl.sendCertificate({ admin, params: { id: String(certId) }, body: {} }, sendRes);
        expect(sendRes.statusCode).toBe(200);
        expect((await Certificate.findById(certId)).status).toBe("sent");
        expect((await Pickup.findById(p._id)).status).toBe("closed");
    });

    it("revising a SENT v2 cert keeps the pickup 'closed' (never strands it in cert-draft)", async () => {
        const p = await makePickup();
        const certId = (await generate(p._id)).body._id;
        await ctrl.issueCertificate({ admin, params: { id: String(certId) }, body: {} }, mockRes());
        await ctrl.sendCertificate({ admin, params: { id: String(certId) }, body: {} }, mockRes());

        const revRes = mockRes();
        await ctrl.reviseCertificate({ admin, params: { id: String(certId) }, body: {} }, revRes);
        expect(revRes.statusCode).toBe(200);
        // old cert superseded, a new draft exists, and the pickup stays closed
        expect((await Certificate.findById(certId)).status).toBe("superseded");
        const fresh = await Pickup.findById(p._id);
        expect(fresh.status).toBe("closed");
    });

    it("concurrent generate makes only ONE live cert for a closed pickup", async () => {
        const p = await makePickup();
        const [a, b] = await Promise.all([generate(p._id), generate(p._id)]);
        const codes = [a.statusCode, b.statusCode].sort();
        expect(codes).toEqual([201, 409]);                 // one wins, one is refused
        expect(await Certificate.countDocuments({ pickup: p._id })).toBe(1);
    });
});
