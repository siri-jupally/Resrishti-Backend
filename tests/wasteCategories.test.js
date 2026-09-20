/**
 * Configurable waste categories (Phase 2).
 *
 *   · the eleven built-in streams seed themselves
 *   · an admin can correct a CO2e factor, and the impact numbers follow
 *   · a coordinator-manager can read the list but not change it
 *   · switching a stream off hides it from new requests without touching
 *     anything already recorded
 *   · a custom stream can be added, used, and then only deactivated
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

const WasteCategory = require("../models/WasteCategory");
const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");
const Employee = require("../models/Employee");

const ctrl = require("../controllers/wasteCategoryController");
const clientPickups = require("../controllers/clientPortalPickupController");
const supervisor = require("../controllers/supervisorPickupController");
const registry = require("../utils/wasteCategories");
const { co2eForLineItems } = require("../utils/emissionFactors");

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
let coordinator;
let client;
let supervisorEmp;

beforeEach(async () => {
    await Promise.all([
        WasteCategory.deleteMany({}), Pickup.deleteMany({}), Client.deleteMany({}),
        Admin.deleteMany({}), Manager.deleteMany({}), Employee.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123", name: "Ada" });
    coordinator = await Manager.create({
        name: "Coordinator", email: "c@test.com", password: "secret123", canCoordinate: true,
    });
    client = await Client.create({
        name: "Acme", contactName: "Ann", contactEmail: "ann@acme.com",
        contactPhone: "1", status: "active", isOnboardingComplete: true,
    });
    supervisorEmp = await Employee.create({
        name: "Sup", email: "s@test.com", password: "secret123",
        manager: coordinator._id, canSupervise: true,
    });
    await registry.refreshCache();
});

const asAdmin = (o = {}) => mockReq({ admin, ...o });
const asCoordinator = (o = {}) => mockReq({ manager: coordinator, ...o });

const seed = async () => {
    const res = mockRes();
    await ctrl.listWasteCategories(asAdmin({ query: { includeInactive: "true" } }), res);
    return res;
};

// ───────────────────────────── seeding ─────────────────────────────

describe("seeding", () => {
    test("the built-in streams appear on first read", async () => {
        const res = await seed();
        expect(res.statusCode).toBe(200);
        expect(res.body.total).toBe(11);
        expect(res.body.items.map((c) => c.key)).toContain("plastic");
        expect(res.body.items.every((c) => c.isCore)).toBe(true);
    });

    test("reading twice does not duplicate them", async () => {
        await seed();
        const res = await seed();
        expect(res.body.total).toBe(11);
        expect(await WasteCategory.countDocuments()).toBe(11);
    });

    test("an edited factor survives re-seeding", async () => {
        await seed();
        await WasteCategory.updateOne({ key: "plastic" }, { $set: { co2eFactorKgPerKg: 9 } });
        await seed();
        const plastic = await WasteCategory.findOne({ key: "plastic" });
        expect(plastic.co2eFactorKgPerKg).toBe(9);
    });

    test("the shipped list carries a certificate row for every stream", async () => {
        const res = await seed();
        expect(res.body.items.every((c) => Boolean(c.certificateBucket))).toBe(true);
    });
});

// ──────────────────────────── permissions ───────────────────────────

describe("permissions", () => {
    test("a coordinator can read the list", async () => {
        const res = mockRes();
        await ctrl.listWasteCategories(asCoordinator({ query: {} }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.total).toBe(11);
    });

    test("a coordinator cannot change a factor", async () => {
        await seed();
        const res = mockRes();
        await ctrl.updateWasteCategory(
            asCoordinator({ params: { key: "plastic" }, body: { co2eFactorKgPerKg: 99 } }),
            res
        );
        expect(res.statusCode).toBe(403);
        const plastic = await WasteCategory.findOne({ key: "plastic" });
        expect(plastic.co2eFactorKgPerKg).toBe(1.5);
    });

    test("a coordinator cannot add a category", async () => {
        const res = mockRes();
        await ctrl.createWasteCategory(
            asCoordinator({ body: { key: "cooking-oil", label: "Cooking Oil" } }),
            res
        );
        expect(res.statusCode).toBe(403);
    });
});

// ─────────────────────────── editing factors ────────────────────────

describe("editing", () => {
    test("an admin can correct a factor and the impact figure follows", async () => {
        await seed();
        expect(co2eForLineItems([{ stream: "plastic", qtyKg: 10 }])).toBeCloseTo(15, 5);

        const res = mockRes();
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "plastic" }, body: { co2eFactorKgPerKg: 2 } }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect(co2eForLineItems([{ stream: "plastic", qtyKg: 10 }])).toBeCloseTo(20, 5);
    });

    test("renaming changes the label, never the key", async () => {
        await seed();
        const res = mockRes();
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "agr" }, body: { label: "Agricultural Residue", key: "agri" } }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect(res.body.key).toBe("agr");
        expect(res.body.label).toBe("Agricultural Residue");
        expect(await WasteCategory.findOne({ key: "agri" })).toBeNull();
    });

    test("a negative factor is refused", async () => {
        await seed();
        const res = mockRes();
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "paper" }, body: { co2eFactorKgPerKg: -1 } }),
            res
        );
        expect(res.statusCode).toBe(400);
    });

    test("an unknown certificate row is refused", async () => {
        await seed();
        const res = mockRes();
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "paper" }, body: { certificateBucket: "somewhere" } }),
            res
        );
        expect(res.statusCode).toBe(400);
    });

    test("reset-factors puts the shipped numbers back", async () => {
        await seed();
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "plastic" }, body: { co2eFactorKgPerKg: 7 } }),
            mockRes()
        );
        const res = mockRes();
        await ctrl.resetFactors(asAdmin(), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.changed).toBe(1);
        expect((await WasteCategory.findOne({ key: "plastic" })).co2eFactorKgPerKg).toBe(1.5);
    });
});

// ────────────────────────── switching off ───────────────────────────

describe("switching a stream off", () => {
    test("it disappears from what a client may request", async () => {
        await seed();
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "hazardous" }, body: { isActive: false } }),
            mockRes()
        );

        const res = mockRes();
        await clientPickups.requestPickup(
            mockReq({
                client,
                body: { requestedDate: "2030-01-01", requestedStreams: ["hazardous"] },
            }),
            res
        );
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/hazardous/);
    });

    test("pickups already recorded against it are untouched", async () => {
        await seed();
        const pickup = await Pickup.create({
            pickupID: "PU-OFF-1",
            client: client._id,
            clientNameSnapshot: client.name,
            status: "processed",
            lineItems: [{ stream: "hazardous", qtyKg: 5 }],
            totalKg: 5,
        });
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "hazardous" }, body: { isActive: false } }),
            mockRes()
        );
        const saved = await Pickup.findById(pickup._id);
        expect(saved.lineItems[0].stream).toBe("hazardous");
        expect(co2eForLineItems(saved.lineItems)).toBeGreaterThan(0);
    });

    test("a crew can still record weights against a stream switched off mid-run", async () => {
        await seed();
        const pickup = await Pickup.create({
            pickupID: "PU-OFF-2",
            client: client._id,
            clientNameSnapshot: client.name,
            status: "weighed",
            requestedStreams: ["hazardous"],
            supervisor: { userType: "Employee", userId: supervisorEmp._id, name: "Sup" },
        });
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "hazardous" }, body: { isActive: false } }),
            mockRes()
        );
        const res = mockRes();
        await supervisor.recordWasteData(
            mockReq({
                employee: supervisorEmp,
                params: { id: String(pickup._id) },
                body: { lineItems: [{ stream: "hazardous", qtyKg: 12 }] },
            }),
            res
        );
        expect(res.statusCode).toBe(200);
        expect((await Pickup.findById(pickup._id)).totalKg).toBe(12);
    });

    test("the last active stream cannot be switched off", async () => {
        await seed();
        await WasteCategory.updateMany({ key: { $ne: "plastic" } }, { $set: { isActive: false } });
        const res = mockRes();
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "plastic" }, body: { isActive: false } }),
            res
        );
        expect(res.statusCode).toBe(409);
        expect((await WasteCategory.findOne({ key: "plastic" })).isActive).toBe(true);
    });

    test("switching it back on makes it requestable again", async () => {
        await seed();
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "hazardous" }, body: { isActive: false } }),
            mockRes()
        );
        await ctrl.updateWasteCategory(
            asAdmin({ params: { key: "hazardous" }, body: { isActive: true } }),
            mockRes()
        );
        const res = mockRes();
        await clientPickups.requestPickup(
            mockReq({
                client,
                body: { requestedDate: "2030-01-01", requestedStreams: ["hazardous"] },
            }),
            res
        );
        expect(res.statusCode).toBe(201);
    });
});

// ────────────────────────── custom streams ──────────────────────────

describe("custom streams", () => {
    const makeOil = () =>
        ctrl.createWasteCategory(
            asAdmin({
                body: {
                    key: "cooking-oil",
                    label: "Cooking Oil",
                    co2eFactorKgPerKg: 2.4,
                    certificateBucket: "wet",
                },
            }),
            mockRes()
        );

    test("an admin can add one and it is immediately usable", async () => {
        await seed();
        await makeOil();

        const res = mockRes();
        await clientPickups.requestPickup(
            mockReq({
                client,
                body: { requestedDate: "2030-01-01", requestedStreams: ["cooking-oil"] },
            }),
            res
        );
        expect(res.statusCode).toBe(201);
    });

    test("its factor is used for the impact figure", async () => {
        await seed();
        await makeOil();
        expect(co2eForLineItems([{ stream: "cooking-oil", qtyKg: 10 }])).toBeCloseTo(24, 5);
    });

    test("it is counted under the certificate row it was given", async () => {
        await seed();
        await makeOil();
        expect(registry.bucketForStream("cooking-oil")).toBe("wet");
    });

    test("a malformed id is refused", async () => {
        await seed();
        const res = mockRes();
        await ctrl.createWasteCategory(
            asAdmin({ body: { key: "Cooking Oil!", label: "Cooking Oil" } }),
            res
        );
        expect(res.statusCode).toBe(400);
    });

    test("a duplicate id is refused", async () => {
        await seed();
        const res = mockRes();
        await ctrl.createWasteCategory(
            asAdmin({ body: { key: "plastic", label: "Plastic Again" } }),
            res
        );
        expect(res.statusCode).toBe(409);
    });

    test("an unused custom stream can be removed", async () => {
        await seed();
        await makeOil();
        const res = mockRes();
        await ctrl.deleteWasteCategory(asAdmin({ params: { key: "cooking-oil" } }), res);
        expect(res.statusCode).toBe(200);
        expect(await WasteCategory.findOne({ key: "cooking-oil" })).toBeNull();
    });

    test("one already used on a pickup is not removed", async () => {
        await seed();
        await makeOil();
        await Pickup.create({
            pickupID: "PU-OIL-1",
            client: client._id,
            clientNameSnapshot: client.name,
            status: "processed",
            lineItems: [{ stream: "cooking-oil", qtyKg: 3 }],
            totalKg: 3,
        });
        const res = mockRes();
        await ctrl.deleteWasteCategory(asAdmin({ params: { key: "cooking-oil" } }), res);
        expect(res.statusCode).toBe(409);
        expect(await WasteCategory.findOne({ key: "cooking-oil" })).not.toBeNull();
    });

    test("a built-in stream is never removed", async () => {
        await seed();
        const res = mockRes();
        await ctrl.deleteWasteCategory(asAdmin({ params: { key: "plastic" } }), res);
        expect(res.statusCode).toBe(409);
        expect(await WasteCategory.findOne({ key: "plastic" })).not.toBeNull();
    });
});

// ─────────────────────────── validation ─────────────────────────────

describe("pickup validation", () => {
    test("a stream that was never configured is rejected", async () => {
        await seed();
        await expect(
            Pickup.create({
                pickupID: "PU-BAD-1",
                client: client._id,
                clientNameSnapshot: client.name,
                status: "processed",
                lineItems: [{ stream: "moon-rock", qtyKg: 1 }],
                totalKg: 1,
            })
        ).rejects.toThrow(/moon-rock/);
    });

    test("every built-in stream still saves", async () => {
        await seed();
        const lineItems = registry.CORE_CATEGORIES.map((c) => ({ stream: c.key, qtyKg: 1 }));
        const pickup = await Pickup.create({
            pickupID: "PU-ALL-1",
            client: client._id,
            clientNameSnapshot: client.name,
            status: "processed",
            lineItems,
            totalKg: lineItems.length,
        });
        expect(pickup.lineItems).toHaveLength(11);
    });
});
