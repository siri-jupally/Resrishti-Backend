/**
 * A certificate must carry the weights the pickup actually has.
 *
 * The reported case: cancel a certificate, correct the pickup weights, draft a
 * replacement — and the replacement printed the ORIGINAL figures, because
 * reviseCertificate copies the previous snapshots forward and nothing ever
 * refreshed them. Issuing now re-reads the pickup, and a correction keeps any
 * draft in step in the meantime.
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
    uploadFile: jest.fn().mockResolvedValue({ key: "cods/2026/X.pdf", bucket: "test" }),
    getS3Client: jest.fn(() => ({ send: jest.fn() })),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));
jest.mock("../utils/certificatePdf", () => ({
    renderCertificatePdf: jest.fn().mockResolvedValue(Buffer.from("pdf")),
}));

const Certificate = require("../models/Certificate");
const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Admin = require("../models/Admin");

const certs = require("../controllers/certificateController");
const adminPickups = require("../controllers/adminPickupController");
const { renderCertificatePdf } = require("../utils/certificatePdf");
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
        Client.deleteMany({}), Admin.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    client = await Client.create({
        name: "Acme", contactName: "Ann", contactEmail: "ann@acme.com",
        contactPhone: "1", status: "active", isOnboardingComplete: true,
    });
    pickup = await Pickup.create({
        pickupID: "PU-W-1",
        client: client._id,
        clientNameSnapshot: client.name,
        status: "cert-sent",
        lineItems: [{ stream: "plastic", qtyKg: 100 }],
        totalKg: 100,
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
        lineItemsSnapshot: [{ stream: "plastic", qtyKg: 100 }],
        totalKgSnapshot: 100,
        clientNameSnapshot: client.name,
        pdf: { key: "cods/2026/COD-2026-0001.pdf", bucket: "test" },
        ...fields,
    });

const cancel = (cert) =>
    certs.cancelCertificate(
        asAdmin({ params: { id: String(cert._id) }, body: { reason: "Weights were wrong" } }),
        mockRes()
    );

const correctTo = (kg) =>
    adminPickups.correctWasteData(
        asAdmin({
            params: { id: String(pickup._id) },
            body: { lineItems: [{ stream: "plastic", qtyKg: kg }], reason: "Re-weighed on the bridge" },
        }),
        mockRes()
    );

// ────────────── the reported case, end to end ──────────────

describe("replacing a cancelled certificate after a correction", () => {
    test("the replacement is issued with the corrected weight", async () => {
        const cert = await makeCert();
        await cancel(cert);
        await correctTo(80);

        const reviseRes = mockRes();
        await certs.reviseCertificate(asAdmin({ params: { id: String(cert._id) } }), reviseRes);
        const replacementId = reviseRes.body._id;

        const issueRes = mockRes();
        await certs.issueCertificate(asAdmin({ params: { id: String(replacementId) } }), issueRes);
        expect(issueRes.statusCode).toBe(200);

        const saved = await Certificate.findById(replacementId);
        expect(saved.totalKgSnapshot).toBe(80);
        expect(saved.lineItemsSnapshot[0].qtyKg).toBe(80);
    });

    test("the PDF is rendered from the corrected figures", async () => {
        const cert = await makeCert();
        await cancel(cert);
        await correctTo(80);
        const reviseRes = mockRes();
        await certs.reviseCertificate(asAdmin({ params: { id: String(cert._id) } }), reviseRes);
        await certs.issueCertificate(
            asAdmin({ params: { id: String(reviseRes.body._id) } }),
            mockRes()
        );

        const [certArg] = renderCertificatePdf.mock.calls.at(-1);
        expect(certArg.totalKgSnapshot).toBe(80);
    });

    test("the replacement keeps the certificate number and bumps the revision", async () => {
        const cert = await makeCert();
        await cancel(cert);
        await correctTo(80);
        const reviseRes = mockRes();
        await certs.reviseCertificate(asAdmin({ params: { id: String(cert._id) } }), reviseRes);
        expect(reviseRes.body.certNumber).toBe("COD-2026-0001");
        expect(reviseRes.body.revision).toBe(2);
    });

    test("the cancelled original keeps the figures it was cancelled with", async () => {
        const cert = await makeCert();
        await cancel(cert);
        await correctTo(80);
        const original = await Certificate.findById(cert._id);
        expect(original.status).toBe("cancelled");
        expect(original.totalKgSnapshot).toBe(100);
    });

    test("correcting weights is allowed once the certificate is cancelled", async () => {
        const cert = await makeCert();
        await cancel(cert);
        const res = mockRes();
        await adminPickups.correctWasteData(
            asAdmin({
                params: { id: String(pickup._id) },
                body: {
                    lineItems: [{ stream: "plastic", qtyKg: 80 }],
                    reason: "Re-weighed on the bridge",
                },
            }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.certificateIssued).toBe(false);
        expect((await Pickup.findById(pickup._id)).totalKg).toBe(80);
    });
});

// ─────────── corrections and drafts generally ───────────

describe("a draft certificate follows a correction", () => {
    test("its snapshot is updated straight away", async () => {
        const draft = await makeCert({ status: "draft", sentAt: null, pdf: undefined });
        await Pickup.updateOne(
            { _id: pickup._id },
            { $set: { status: "cert-draft", certificate: draft._id } }
        );
        await correctTo(65);
        const saved = await Certificate.findById(draft._id);
        expect(saved.totalKgSnapshot).toBe(65);
        expect(saved.lineItemsSnapshot[0].qtyKg).toBe(65);
    });

    test("an already-sent certificate is left alone and flagged instead", async () => {
        const cert = await makeCert();
        await Pickup.updateOne({ _id: pickup._id }, { $set: { certificate: cert._id } });
        const res = mockRes();
        await adminPickups.correctWasteData(
            asAdmin({
                params: { id: String(pickup._id) },
                body: {
                    lineItems: [{ stream: "plastic", qtyKg: 70 }],
                    reason: "Re-weighed on the bridge",
                },
            }),
            res
        );
        expect(res.body.certificateIssued).toBe(true);
        const saved = await Certificate.findById(cert._id);
        expect(saved.totalKgSnapshot).toBe(100);
    });

    test("a revision of a sent certificate also issues with the current weights", async () => {
        const cert = await makeCert();
        await Pickup.updateOne({ _id: pickup._id }, { $set: { certificate: cert._id } });
        await correctTo(90);

        const reviseRes = mockRes();
        await certs.reviseCertificate(asAdmin({ params: { id: String(cert._id) } }), reviseRes);
        await certs.issueCertificate(
            asAdmin({ params: { id: String(reviseRes.body._id) } }),
            mockRes()
        );
        const saved = await Certificate.findById(reviseRes.body._id);
        expect(saved.totalKgSnapshot).toBe(90);
    });
});

// ────────────────── the email link ──────────────────

describe("the certificate email", () => {
    test("links to a page that exists", async () => {
        process.env.CLIENT_URL = "https://resrishti.com";
        const cert = await makeCert({ status: "issued", sentAt: null });
        const res = mockRes();
        await certs.sendCertificate(
            asAdmin({ params: { id: String(cert._id) }, body: {} }),
            res
        );
        expect(sendEmail).toHaveBeenCalled();
        const [, , text, html] = sendEmail.mock.calls[0];
        const expected = "https://resrishti.com/client/dashboard?tab=certificates";
        expect(text).toContain(expected);
        expect(html).toContain(expected);
        expect(text).not.toContain("resrishti.com/client/certificates");
    });
});
