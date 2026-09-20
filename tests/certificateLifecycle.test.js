/**
 * Certificate cancellation (Phase 3).
 *
 *   · a certificate can be withdrawn at any point before it is superseded
 *   · a reason is required, and the client is told only if they had it
 *   · a cancelled certificate is never downloadable again
 *   · the pickup goes back to 'processed' so a replacement can be drafted
 *   · a replacement keeps the certificate number and leaves the cancelled
 *     record cancelled
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/s3", () => ({
    uploadPickupEvidence: jest.fn().mockResolvedValue({ key: "evidence/x.jpg", bucket: "test" }),
    uploadCheckinPhoto: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    uploadFile: jest.fn().mockResolvedValue({ key: "cods/2026/X.pdf", bucket: "test" }),
    getS3Client: jest.fn(() => ({ send: jest.fn() })),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));
// @react-pdf/renderer is ESM and cannot be required under Jest's CJS runtime.
jest.mock("../utils/certificatePdf", () => ({
    renderCertificatePdf: jest.fn().mockResolvedValue(Buffer.from("pdf")),
}));
jest.mock("@aws-sdk/s3-request-presigner", () => ({
    getSignedUrl: jest.fn().mockResolvedValue("https://example.test/signed.pdf"),
}));

const Certificate = require("../models/Certificate");
const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");

const certs = require("../controllers/certificateController");
const clientPortal = require("../controllers/clientPortalController");
const { sendEmail } = require("../utils/emailService");

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
let pickup;

beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([
        Certificate.deleteMany({}), Pickup.deleteMany({}),
        Client.deleteMany({}), Admin.deleteMany({}), Manager.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123", name: "Ada" });
    client = await Client.create({
        name: "Acme", contactName: "Ann", contactEmail: "ann@acme.com",
        contactPhone: "1", status: "active", isOnboardingComplete: true,
    });
    pickup = await Pickup.create({
        pickupID: "PU-CERT-1",
        client: client._id,
        clientNameSnapshot: client.name,
        status: "cert-sent",
        lineItems: [{ stream: "plastic", qtyKg: 10 }],
        totalKg: 10,
    });
});

const asAdmin = (o = {}) => mockReq({ admin, ...o });

const makeCert = (fields = {}) =>
    Certificate.create({
        certNumber: "COD-2026-0001",
        pickup: pickup._id,
        client: client._id,
        status: "sent",
        sentAt: new Date(),
        issuedAt: new Date(),
        lineItemsSnapshot: [{ stream: "plastic", qtyKg: 10 }],
        totalKgSnapshot: 10,
        clientNameSnapshot: client.name,
        pdf: { key: "cods/2026/COD-2026-0001.pdf", bucket: "test" },
        ...fields,
    });

// ──────────────────────────── cancelling ────────────────────────────

describe("cancelling a certificate", () => {
    test("a sent certificate can be withdrawn with a reason", async () => {
        const cert = await makeCert();
        const res = mockRes();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Issued against the wrong client" } }),
            res
        );
        expect(res.statusCode).toBe(200);
        const saved = await Certificate.findById(cert._id);
        expect(saved.status).toBe("cancelled");
        expect(saved.cancelledReason).toBe("Issued against the wrong client");
        expect(saved.cancelledBy.name).toBe("a@test.com"); // Admin has no name field; actorFromReq falls back to the email
        expect(saved.cancelledAt).toBeTruthy();
    });

    test("a reason is required", async () => {
        const cert = await makeCert();
        const res = mockRes();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: {} }),
            res
        );
        expect(res.statusCode).toBe(400);
        expect((await Certificate.findById(cert._id)).status).toBe("sent");
    });

    test("a draft can be withdrawn too", async () => {
        const cert = await makeCert({ status: "draft", sentAt: null, pdf: undefined });
        const res = mockRes();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Pickup never happened" } }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect((await Certificate.findById(cert._id)).status).toBe("cancelled");
    });

    test("a superseded certificate cannot be withdrawn", async () => {
        const cert = await makeCert({ status: "superseded" });
        const res = mockRes();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Changed my mind" } }),
            res
        );
        expect(res.statusCode).toBe(409);
    });

    test("cancelling twice is refused", async () => {
        const cert = await makeCert();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Wrong client entirely" } }),
            mockRes()
        );
        const res = mockRes();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Wrong client entirely" } }),
            res
        );
        expect(res.statusCode).toBe(409);
    });

    test("the pickup goes back to processed", async () => {
        const cert = await makeCert();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Weights were fabricated" } }),
            mockRes()
        );
        const saved = await Pickup.findById(pickup._id);
        expect(saved.status).toBe("processed");
        expect(saved.evidence.at(-1).notes).toMatch(/cancelled/i);
    });

    test("the collected waste is not erased", async () => {
        const cert = await makeCert();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Wrong template used" } }),
            mockRes()
        );
        const saved = await Pickup.findById(pickup._id);
        expect(saved.totalKg).toBe(10);
        expect(saved.lineItems).toHaveLength(1);
    });
});

// ──────────────────────── telling the client ─────────────────────────

describe("telling the client", () => {
    test("a client who already had it is emailed the reason", async () => {
        const cert = await makeCert();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Superseded by a merged pickup" } }),
            mockRes()
        );
        expect(sendEmail).toHaveBeenCalledTimes(1);
        const [to, subject, text] = sendEmail.mock.calls[0];
        expect(to).toBe("ann@acme.com");
        expect(subject).toMatch(/cancelled/i);
        expect(text).toMatch(/Superseded by a merged pickup/);
    });

    test("nobody is emailed about a draft the client never saw", async () => {
        const cert = await makeCert({ status: "draft", sentAt: null });
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Duplicate of another draft" } }),
            mockRes()
        );
        expect(sendEmail).not.toHaveBeenCalled();
    });
});

// ─────────────────────── what the client sees ────────────────────────

describe("the client portal", () => {
    const asClient = (o = {}) => mockReq({ client, ...o });

    test("a cancelled certificate cannot be downloaded", async () => {
        const cert = await makeCert();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Void — wrong facility" } }),
            mockRes()
        );
        const res = mockRes();
        await clientPortal.downloadMyCertificate(
            asClient({ params: { id: String(cert._id) } }),
            res
        );
        expect(res.statusCode).toBe(404);
    });

    test("one they were sent still appears, so they know it is void", async () => {
        const cert = await makeCert();
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Void — wrong facility" } }),
            mockRes()
        );
        const res = mockRes();
        await clientPortal.listMyCertificates(asClient({ query: {} }), res);
        expect(res.statusCode).toBe(200);
        const found = res.body.items.find((c) => String(c._id) === String(cert._id));
        expect(found.status).toBe("cancelled");
        expect(found.cancelledReason).toBe("Void — wrong facility");
    });

    test("one cancelled before it was ever sent is not listed", async () => {
        const cert = await makeCert({ status: "issued", sentAt: null });
        await certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Never should have existed" } }),
            mockRes()
        );
        const res = mockRes();
        await clientPortal.listMyCertificates(asClient({ query: {} }), res);
        expect(res.body.items).toHaveLength(0);
    });

    test("a sent certificate is still downloadable", async () => {
        const cert = await makeCert();
        const res = mockRes();
        await clientPortal.downloadMyCertificate(
            asClient({ params: { id: String(cert._id) } }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.url).toContain("https://");
    });
});

// ───────────────────────── replacing it ──────────────────────────────

describe("replacing a cancelled certificate", () => {
    const cancelIt = async (cert) =>
        certs.cancelCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: { reason: "Wrong weights entirely" } }),
            mockRes()
        );

    test("a replacement keeps the number and bumps the revision", async () => {
        const cert = await makeCert();
        await cancelIt(cert);
        const res = mockRes();
        await certs.reviseCertificate(asAdmin({ params: { id: String(cert._id) } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.certNumber).toBe("COD-2026-0001");
        expect(res.body.revision).toBe(2);
        expect(res.body.status).toBe("draft");
    });

    test("the cancelled one stays cancelled, not superseded", async () => {
        const cert = await makeCert();
        await cancelIt(cert);
        await certs.reviseCertificate(asAdmin({ params: { id: String(cert._id) } }), mockRes());
        expect((await Certificate.findById(cert._id)).status).toBe("cancelled");
    });

    test("the pickup points at the replacement draft", async () => {
        const cert = await makeCert();
        await cancelIt(cert);
        const res = mockRes();
        await certs.reviseCertificate(asAdmin({ params: { id: String(cert._id) } }), res);
        const saved = await Pickup.findById(pickup._id);
        expect(String(saved.certificate)).toBe(String(res.body._id));
        expect(saved.status).toBe("cert-draft");
    });

    test("a sent certificate is still revised the old way", async () => {
        const cert = await makeCert();
        const res = mockRes();
        await certs.reviseCertificate(asAdmin({ params: { id: String(cert._id) } }), res);
        expect(res.statusCode).toBe(200);
        expect((await Certificate.findById(cert._id)).status).toBe("superseded");
    });

    test("a draft cannot be revised", async () => {
        const cert = await makeCert({ status: "draft", sentAt: null });
        const res = mockRes();
        await certs.reviseCertificate(asAdmin({ params: { id: String(cert._id) } }), res);
        expect(res.statusCode).toBe(409);
    });
});
