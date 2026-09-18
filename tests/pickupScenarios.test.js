/**
 * Pickup operational scenarios (Phase 1).
 *
 *   · failed / no-show with a reason
 *   · partial collection (flag + reason, certificate still produced)
 *   · reschedule, keeping the previous date on record
 *   · weight corrections with a full audit trail
 *   · client choosing which of their locations a pickup is for
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
    uploadFile: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    getS3Client: jest.fn(),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Site = require("../models/Site");
const Admin = require("../models/Admin");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");

const adminPickups = require("../controllers/adminPickupController");
const supervisor = require("../controllers/supervisorPickupController");
const clientPickups = require("../controllers/clientPortalPickupController");

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

const PHOTO = { buffer: Buffer.from("img"), mimetype: "image/jpeg" };

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
let supervisorEmp;

beforeEach(async () => {
    await Promise.all([
        Pickup.deleteMany({}), Client.deleteMany({}), Site.deleteMany({}),
        Admin.deleteMany({}), Employee.deleteMany({}), Manager.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123", canCoordinate: true });
    client = await Client.create({
        name: "Acme", contactName: "Ann", contactEmail: "ann@acme.com",
        contactPhone: "1", status: "active", isOnboardingComplete: true,
    });
    const mgr = await Manager.create({ name: "M", email: "m@test.com", password: "secret123" });
    supervisorEmp = await Employee.create({
        name: "Sup", email: "s@test.com", password: "secret123", manager: mgr._id, canSupervise: true,
    });
});

const makePickup = (fields = {}) =>
    Pickup.create({
        pickupID: `PU-TEST-${Math.random().toString(16).slice(2, 8).toUpperCase()}`,
        client: client._id,
        clientNameSnapshot: client.name,
        status: "scheduled",
        supervisor: { userType: "Employee", userId: supervisorEmp._id, name: "Sup" },
        ...fields,
    });

const asSupervisor = (body, params) =>
    mockReq({ employee: supervisorEmp, body, params, files: [] });

// ───────────────────────── failed / no-show ─────────────────────────

describe("failed and no-show", () => {
    test("a supervisor can mark a pickup failed with a reason", async () => {
        const pickup = await makePickup({ status: "at-client" });
        const res = mockRes();
        await supervisor.updatePickupStatus(
            asSupervisor({ status: "failed", reason: "Access denied at gate" }, { id: String(pickup._id) }),
            res
        );
        expect(res.statusCode).toBe(200);
        const saved = await Pickup.findById(pickup._id);
        expect(saved.status).toBe("failed");
        expect(saved.failureReason).toBe("Access denied at gate");
        // ...and it is on the evidence trail.
        expect(saved.evidence.at(-1).status).toBe("failed");
    });

    test("no-show is recorded the same way", async () => {
        const pickup = await makePickup({ status: "at-client" });
        const res = mockRes();
        await supervisor.updatePickupStatus(
            asSupervisor({ status: "no-show", reason: "Nobody on site" }, { id: String(pickup._id) }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect((await Pickup.findById(pickup._id)).status).toBe("no-show");
    });

    test("a reason is required", async () => {
        const pickup = await makePickup({ status: "at-client" });
        const res = mockRes();
        await supervisor.updatePickupStatus(
            asSupervisor({ status: "failed" }, { id: String(pickup._id) }),
            res
        );
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/reason is required/i);
        expect((await Pickup.findById(pickup._id)).status).toBe("at-client");
    });

    test("cannot fail a pickup once the waste has been collected", async () => {
        const pickup = await makePickup({ status: "picked-up" });
        const res = mockRes();
        await supervisor.updatePickupStatus(
            asSupervisor({ status: "failed", reason: "too late" }, { id: String(pickup._id) }),
            res
        );
        expect(res.statusCode).toBe(409);
    });
});

// ───────────────────────── partial collection ─────────────────────────

describe("partial collection", () => {
    const recordWaste = (pickup, body) =>
        mockReq({ employee: supervisorEmp, params: { id: String(pickup._id) }, body });

    test("a partial pickup is flagged, with the reason, and still certifies", async () => {
        const pickup = await makePickup({ status: "weighed" });
        const res = mockRes();
        await supervisor.recordWasteData(
            recordWaste(pickup, {
                lineItems: JSON.stringify([{ stream: "plastic", qtyKg: 40 }]),
                isPartial: "true",
                partialReason: "Vehicle full — rest to follow",
            }),
            res
        );
        const saved = await Pickup.findById(pickup._id);
        expect(saved.isPartial).toBe(true);
        expect(saved.partialReason).toMatch(/Vehicle full/);
        expect(saved.totalKg).toBe(40);
        // Partial is a flag, not a dead end: the certificate still gets drafted.
        expect(saved.status).toBe("cert-draft");
        expect(saved.certificate).toBeTruthy();
    });

    test("marking partial without a reason is refused", async () => {
        const pickup = await makePickup({ status: "weighed" });
        const res = mockRes();
        await supervisor.recordWasteData(
            recordWaste(pickup, {
                lineItems: JSON.stringify([{ stream: "plastic", qtyKg: 40 }]),
                isPartial: "true",
            }),
            res
        );
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/partialReason/);
    });

    test("a normal collection is not flagged partial", async () => {
        const pickup = await makePickup({ status: "weighed" });
        await supervisor.recordWasteData(
            recordWaste(pickup, { lineItems: JSON.stringify([{ stream: "paper", qtyKg: 12 }]) }),
            mockRes()
        );
        const saved = await Pickup.findById(pickup._id);
        expect(saved.isPartial).toBe(false);
        // The first weights are the start of the audit trail.
        expect(saved.wasteDataHistory).toHaveLength(1);
        expect(saved.wasteDataHistory[0].totalKg).toBe(12);
    });
});

// ───────────────────────── reschedule ─────────────────────────

describe("reschedule", () => {
    const asAdmin = (pickup, body) => mockReq({ admin, params: { id: String(pickup._id) }, body });

    test("moves the date and keeps the previous one on record", async () => {
        const first = new Date("2026-04-01T00:00:00Z");
        const pickup = await makePickup({ status: "scheduled", scheduledDate: first });
        const res = mockRes();
        await adminPickups.reschedulePickup(
            asAdmin(pickup, { scheduledDate: "2026-04-08", reason: "Client asked to move it" }),
            res
        );
        expect(res.statusCode).toBe(200);
        const saved = await Pickup.findById(pickup._id);
        expect(saved.scheduleHistory).toHaveLength(1);
        expect(saved.scheduleHistory[0].from.toISOString()).toBe(first.toISOString());
        expect(saved.scheduleHistory[0].reason).toMatch(/Client asked/);
        expect(saved.scheduledDate.toISOString().slice(0, 10)).toBe("2026-04-08");
        expect(saved.status).toBe("scheduled");
    });

    test("a postponed pickup goes back on the calendar", async () => {
        const pickup = await makePickup({ status: "postponed" });
        await adminPickups.reschedulePickup(
            asAdmin(pickup, { scheduledDate: "2026-04-08", reason: "Rebooked" }),
            mockRes()
        );
        expect((await Pickup.findById(pickup._id)).status).toBe("scheduled");
    });

    test("a reason and a valid date are both required", async () => {
        const pickup = await makePickup({ status: "scheduled" });
        const noReason = mockRes();
        await adminPickups.reschedulePickup(asAdmin(pickup, { scheduledDate: "2026-04-08" }), noReason);
        expect(noReason.statusCode).toBe(400);

        const badDate = mockRes();
        await adminPickups.reschedulePickup(asAdmin(pickup, { scheduledDate: "nonsense", reason: "x" }), badDate);
        expect(badDate.statusCode).toBe(400);
    });

    test("cannot reschedule once the crew has set off", async () => {
        const pickup = await makePickup({ status: "en-route" });
        const res = mockRes();
        await adminPickups.reschedulePickup(
            asAdmin(pickup, { scheduledDate: "2026-04-08", reason: "too late" }),
            res
        );
        expect(res.statusCode).toBe(409);
    });
});

// ───────────────────────── weight corrections ─────────────────────────

describe("weight corrections", () => {
    const asAdmin = (pickup, body) => mockReq({ admin, params: { id: String(pickup._id) }, body });

    test("records the change with who, what, when and why", async () => {
        const pickup = await makePickup({
            status: "processed",
            lineItems: [{ stream: "plastic", qtyKg: 100 }],
            totalKg: 100,
        });
        const res = mockRes();
        await adminPickups.correctWasteData(
            asAdmin(pickup, {
                lineItems: [{ stream: "plastic", qtyKg: 85 }],
                reason: "Weighbridge misread",
            }),
            res
        );
        expect(res.statusCode).toBe(200);
        const saved = await Pickup.findById(pickup._id);
        expect(saved.totalKg).toBe(85);
        expect(saved.wasteDataHistory).toHaveLength(1);
        const entry = saved.wasteDataHistory[0];
        expect(entry.previousTotalKg).toBe(100);
        expect(entry.totalKg).toBe(85);
        expect(entry.reason).toBe("Weighbridge misread");
        expect(entry.by.userType).toBe("Admin");
        expect(entry.at).toBeInstanceOf(Date);
    });

    test("says the certificate needs revising when one has been issued", async () => {
        const pickup = await makePickup({
            status: "cert-sent", lineItems: [{ stream: "paper", qtyKg: 10 }], totalKg: 10,
        });
        const res = mockRes();
        await adminPickups.correctWasteData(
            asAdmin(pickup, { lineItems: [{ stream: "paper", qtyKg: 11 }], reason: "recount" }),
            res
        );
        expect(res.body.certificateIssued).toBe(true);
        expect(res.body.message).toMatch(/revise/i);
    });

    test("a reason is required, and unknown categories are refused", async () => {
        const pickup = await makePickup({ status: "processed", totalKg: 10 });
        const noReason = mockRes();
        await adminPickups.correctWasteData(
            asAdmin(pickup, { lineItems: [{ stream: "paper", qtyKg: 11 }] }), noReason
        );
        expect(noReason.statusCode).toBe(400);

        const badStream = mockRes();
        await adminPickups.correctWasteData(
            asAdmin(pickup, { lineItems: [{ stream: "unicorns", qtyKg: 11 }], reason: "x" }), badStream
        );
        expect(badStream.statusCode).toBe(400);
    });

    test("cannot correct weights before any were recorded", async () => {
        const pickup = await makePickup({ status: "scheduled" });
        const res = mockRes();
        await adminPickups.correctWasteData(
            asAdmin(pickup, { lineItems: [{ stream: "paper", qtyKg: 11 }], reason: "x" }), res
        );
        expect(res.statusCode).toBe(409);
    });
});

// ───────────────────────── client locations ─────────────────────────

describe("pickup location", () => {
    const asClient = (body) => mockReq({ client, body });

    test("a client can request a pickup for one of their locations", async () => {
        const site = await Site.create({
            client: client._id, name: "Plant 2",
            address: { line1: "12 Industrial Rd", city: "Hyderabad" },
        });
        const res = mockRes();
        await clientPickups.requestPickup(
            asClient({ requestedDate: "2030-01-01", requestedStreams: ["plastic"], siteId: String(site._id) }),
            res
        );
        expect(res.statusCode).toBe(201);
        const saved = await Pickup.findById(res.body._id);
        expect(String(saved.site)).toBe(String(site._id));
        expect(saved.siteNameSnapshot).toBe("Plant 2");
        expect(saved.pickupAddressSnapshot).toMatch(/Industrial Rd/);
    });

    test("another client's location is refused", async () => {
        const other = await Client.create({
            name: "Other", contactName: "O", contactEmail: "o@x.com", contactPhone: "2",
        });
        const site = await Site.create({ client: other._id, name: "Theirs" });
        const res = mockRes();
        await clientPickups.requestPickup(
            asClient({ requestedDate: "2030-01-01", requestedStreams: ["plastic"], siteId: String(site._id) }),
            res
        );
        expect(res.statusCode).toBe(404);
    });

    test("a client with no locations can still request a pickup", async () => {
        const res = mockRes();
        await clientPickups.requestPickup(
            asClient({ requestedDate: "2030-01-01", requestedStreams: ["plastic"] }),
            res
        );
        expect(res.statusCode).toBe(201);
        expect((await Pickup.findById(res.body._id)).site).toBeNull();
    });
});
