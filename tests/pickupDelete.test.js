/**
 * Deleting a pickup.
 *
 * Delete is for a record that should never have existed — a mistake or a test
 * entry. Cancel stays the right tool for a collection that did not happen.
 *
 * The rule that matters: once a certificate has been issued or sent, the client
 * holds a document whose figures come from this pickup, so the pickup is its
 * evidence and cannot be removed.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));

// Track what the handler asks S3 to remove, so the evidence cleanup is
// verifiable without touching a bucket.
const deleted = [];
jest.mock("../utils/s3", () => ({
    uploadPickupEvidence: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    uploadFile: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    getS3Client: jest.fn(),
    deleteS3Object: jest.fn(async ({ key }) => { deleted.push(key); }),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Certificate = require("../models/Certificate");
const Admin = require("../models/Admin");

const adminPickups = require("../controllers/adminPickupController");

let mongod;
let admin;
let client;

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
    admin = await Admin.create({ email: "triage@test.com", password: "Secret@123", canCoordinate: true });
    client = await Client.create({
        name: "Acme Waste", contactName: "A", contactEmail: "a@test.com",
        contactPhone: "9999999999", status: "active",
    });
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    deleted.length = 0;
    await Promise.all([Pickup.deleteMany({}), Certificate.deleteMany({})]);
});

let seq = 0;
const makePickup = (fields = {}) => {
    seq += 1;
    return Pickup.create({
        pickupID: `PU-DEL-${String(seq).padStart(4, "0")}`,
        client: client._id,
        clientNameSnapshot: client.name,
        status: "scheduled",
        ...fields,
    });
};

const makeCert = (pickup, status, revision = 1) =>
    Certificate.create({
        certNumber: `CERT-${pickup.pickupID}-${revision}`,
        revision,
        pickup: pickup._id,
        client: client._id,
        status,
        totalKgSnapshot: 10,
        clientNameSnapshot: client.name,
        pickupDateSnapshot: new Date(),
    });

const del = async (pickup, body = { confirm: true }) => {
    const res = mockRes();
    await adminPickups.deletePickup(
        mockReq({ admin, params: { id: String(pickup._id) }, body }),
        res
    );
    return res;
};
const forceDel = (pickup) => del(pickup, { confirm: true, force: true });

// ───────────────────────────── the happy path ─────────────────────────────

describe("deleting a pickup", () => {
    test("removes it", async () => {
        const pickup = await makePickup();
        const res = await del(pickup);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.deleted.pickupID).toBe(pickup.pickupID);
        expect(await Pickup.findById(pickup._id)).toBeNull();
    });

    test("works for a pickup that was already cancelled or failed", async () => {
        for (const status of ["cancelled", "failed", "no-show", "rejected"]) {
            const pickup = await makePickup({ status });
            const res = await del(pickup);
            expect(res.statusCode).toBe(200);
        }
    });

    test("takes the evidence photos with it", async () => {
        const pickup = await makePickup({
            evidence: [
                { status: "at-client", photos: [{ key: "pickup-evidence/a.jpg", bucket: "b" }] },
                // An older row with only the deprecated singular field.
                { status: "picked-up", photo: { key: "pickup-evidence/b.jpg", bucket: "b" } },
            ],
        });

        const res = await del(pickup);

        expect(res.body.photosDeleted).toBe(2);
        expect(deleted.sort()).toEqual(["pickup-evidence/a.jpg", "pickup-evidence/b.jpg"]);
    });

    test("the shared weighbridge photo is removed once, not once per line item", async () => {
        const shared = { key: "pickup-evidence/slip.jpg", bucket: "b" };
        const pickup = await makePickup({
            status: "processed",
            totalKg: 30,
            lineItems: [
                { stream: "plastic", qtyKg: 10, weighbridgePhoto: shared },
                { stream: "paper", qtyKg: 20, weighbridgePhoto: shared },
            ],
        });

        const res = await del(pickup);

        expect(res.body.photosTotal).toBe(1);
        expect(deleted).toEqual(["pickup-evidence/slip.jpg"]);
    });

    test("a draft certificate goes with it, with no force needed", async () => {
        const pickup = await makePickup({ status: "cert-draft" });
        const cert = await makeCert(pickup, "draft");

        const res = await del(pickup);

        expect(res.statusCode).toBe(200);
        expect(res.body.certificatesDeleted).toBe(1);
        expect(res.body.forced).toBe(false);
        expect(await Certificate.findById(cert._id)).toBeNull();
    });

    test("a photo that cannot be removed does not keep the pickup", async () => {
        const s3 = require("../utils/s3");
        s3.deleteS3Object.mockRejectedValueOnce(new Error("AccessDenied"));
        const pickup = await makePickup({
            evidence: [{ status: "at-client", photos: [{ key: "pickup-evidence/stuck.jpg", bucket: "b" }] }],
        });

        const res = await del(pickup);

        expect(res.statusCode).toBe(200);
        expect(res.body.photoFailures).toEqual(["pickup-evidence/stuck.jpg"]);
        expect(await Pickup.findById(pickup._id)).toBeNull();
    });
});

// ──────────────────────── what must not be deletable ─────────────────────

describe("a pickup behind a released certificate", () => {
    test("the first attempt asks again instead of deleting", async () => {
        const pickup = await makePickup({ status: "cert-issued" });
        await makeCert(pickup, "issued");

        const res = await del(pickup);

        expect(res.statusCode).toBe(409);
        expect(res.body.requiresForce).toBe(true);
        expect(res.body.message).toMatch(/already been issued/i);
        expect(await Pickup.findById(pickup._id)).not.toBeNull();
    });

    test("a sent certificate asks too", async () => {
        const pickup = await makePickup({ status: "cert-sent" });
        await makeCert(pickup, "sent");

        const res = await del(pickup);
        expect(res.statusCode).toBe(409);
        expect(res.body.requiresForce).toBe(true);
    });

    test("an older issued revision counts, even when the current one is a draft", async () => {
        // Revise leaves the superseded row behind; the client still holds the
        // document that was sent to them.
        const pickup = await makePickup({ status: "cert-draft" });
        await makeCert(pickup, "sent", 1);
        await makeCert(pickup, "draft", 2);

        const res = await del(pickup);

        expect(res.statusCode).toBe(409);
        expect(res.body.certificates).toHaveLength(1);
        expect(res.body.certificates[0].revision).toBe(1);
    });

    test("nothing is removed while it is still asking", async () => {
        const pickup = await makePickup({
            status: "cert-sent",
            evidence: [{ status: "at-client", photos: [{ key: "pickup-evidence/keep.jpg", bucket: "b" }] }],
        });
        const cert = await makeCert(pickup, "sent");

        await del(pickup);

        expect(deleted).toEqual([]);
        expect(await Certificate.findById(cert._id)).not.toBeNull();
    });

    // ---- force: the operator has been shown what goes, and said yes --------

    test("force deletes the pickup and the issued certificate", async () => {
        const pickup = await makePickup({ status: "cert-sent" });
        const cert = await makeCert(pickup, "sent");

        const res = await forceDel(pickup);

        expect(res.statusCode).toBe(200);
        expect(res.body.forced).toBe(true);
        expect(await Pickup.findById(pickup._id)).toBeNull();
        expect(await Certificate.findById(cert._id)).toBeNull();
    });

    test("it reports exactly which released certificates it destroyed", async () => {
        const pickup = await makePickup({ status: "cert-draft" });
        await makeCert(pickup, "sent", 1);
        await makeCert(pickup, "draft", 2);

        const res = await forceDel(pickup);

        expect(res.body.certificatesDeleted).toBe(2);
        expect(res.body.releasedCertificatesDeleted).toHaveLength(1);
        expect(res.body.releasedCertificatesDeleted[0]).toMatchObject({
            revision: 1,
            status: "sent",
        });
    });

    test("the certificate PDF is removed from storage too", async () => {
        const pickup = await makePickup({ status: "cert-sent" });
        await Certificate.create({
            certNumber: "CERT-PDF-1",
            revision: 1,
            pickup: pickup._id,
            client: client._id,
            status: "sent",
            totalKgSnapshot: 10,
            clientNameSnapshot: client.name,
            pickupDateSnapshot: new Date(),
            pdf: { key: "cods/2026/CERT-PDF-1.pdf", bucket: "b" },
        });

        const res = await forceDel(pickup);

        expect(deleted).toContain("cods/2026/CERT-PDF-1.pdf");
        expect(res.body.photosTotal).toBe(1);
    });

    test("force on a pickup with no released certificate behaves the same as without it", async () => {
        const pickup = await makePickup();
        const res = await forceDel(pickup);

        expect(res.statusCode).toBe(200);
        expect(res.body.forced).toBe(false);
    });
});

// ─────────────────────────── guards ───────────────────────────

describe("guards", () => {
    test("confirm is required", async () => {
        const pickup = await makePickup();
        const res = await del(pickup, {});

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/confirm/i);
        expect(await Pickup.findById(pickup._id)).not.toBeNull();
    });

    test("a string 'true' is accepted, since multipart and query carry strings", async () => {
        const pickup = await makePickup();
        const res = await del(pickup, { confirm: "true" });
        expect(res.statusCode).toBe(200);
    });

    test("a missing pickup is a 404", async () => {
        const res = mockRes();
        await adminPickups.deletePickup(
            mockReq({ admin, params: { id: String(new mongoose.Types.ObjectId()) }, body: { confirm: true } }),
            res
        );
        expect(res.statusCode).toBe(404);
    });

    test("a nonsense id is a 400", async () => {
        const res = mockRes();
        await adminPickups.deletePickup(
            mockReq({ admin, params: { id: "not-an-id" }, body: { confirm: true } }),
            res
        );
        expect(res.statusCode).toBe(400);
    });

    test("someone without triage permission cannot delete", async () => {
        const pickup = await makePickup();
        const res = mockRes();
        await adminPickups.deletePickup(
            mockReq({ params: { id: String(pickup._id) }, body: { confirm: true } }),
            res
        );
        expect(res.statusCode).toBe(403);
        expect(await Pickup.findById(pickup._id)).not.toBeNull();
    });
});
