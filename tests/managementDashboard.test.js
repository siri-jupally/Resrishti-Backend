/**
 * Management dashboard KPIs (Phase 4).
 *
 *   · pickups are counted on when they were asked for, tonnage on when it was
 *     weighed — a pickup requested in one month and weighed in the next lands
 *     in both, correctly
 *   · every filter narrows every figure: date range, client, location,
 *     waste category, pickup status
 *   · category and month series come back ready to chart
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
    getS3Client: jest.fn(),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Site = require("../models/Site");
const Admin = require("../models/Admin");
const Certificate = require("../models/Certificate");
const WasteCategory = require("../models/WasteCategory");

const dashboard = require("../controllers/managementDashboardController");
const registry = require("../utils/wasteCategories");

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

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

let admin;
let acme;
let globex;
let acmeSiteA;
let acmeSiteB;

const MARCH = new Date("2026-03-10T09:00:00Z");
const APRIL = new Date("2026-04-05T09:00:00Z");
const MAY = new Date("2026-05-02T09:00:00Z");

const overview = async (query = {}) => {
    const res = mockRes();
    await dashboard.getOverview({ query, admin }, res);
    return res;
};

const makePickup = (fields = {}) =>
    Pickup.create({
        pickupID: `PU-${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
        client: acme._id,
        clientNameSnapshot: "Acme",
        status: "processed",
        requestedAt: MARCH,
        ...fields,
    });

beforeEach(async () => {
    await Promise.all([
        Pickup.deleteMany({}), Client.deleteMany({}), Site.deleteMany({}),
        Admin.deleteMany({}), Certificate.deleteMany({}), WasteCategory.deleteMany({}),
    ]);
    admin = await Admin.create({ email: "a@test.com", password: "secret123" });
    acme = await Client.create({
        name: "Acme", contactName: "Ann", contactEmail: "ann@acme.com",
        contactPhone: "1", status: "active", isOnboardingComplete: true,
    });
    globex = await Client.create({
        name: "Globex", contactName: "Gus", contactEmail: "gus@globex.com",
        contactPhone: "2", status: "active", isOnboardingComplete: true,
    });
    acmeSiteA = await Site.create({ client: acme._id, name: "Head Office" });
    acmeSiteB = await Site.create({ client: acme._id, name: "Warehouse" });
    // Seed the built-in categories so factor edits in these tests are real.
    await registry.initWasteCategories();
});

// ────────────────────────────── counts ──────────────────────────────

describe("pickup counts", () => {
    beforeEach(async () => {
        await makePickup({ status: "requested" });
        await makePickup({ status: "accepted" });
        await makePickup({ status: "scheduled" });
        await makePickup({ status: "postponed" });
        await makePickup({ status: "en-route" });
        await makePickup({ status: "cert-sent" });
        await makePickup({ status: "failed" });
        await makePickup({ status: "no-show" });
        await makePickup({ status: "cancelled" });
    });

    test("statuses fold into the stages management asks about", async () => {
        const res = await overview();
        expect(res.statusCode).toBe(200);
        const k = res.body.kpis;
        expect(k.pendingPickups).toBe(1);
        expect(k.scheduledPickups).toBe(3);   // accepted + scheduled + postponed
        expect(k.inProgressPickups).toBe(1);
        expect(k.completedPickups).toBe(1);
        expect(k.failedOrCancelledPickups).toBe(3);
        expect(k.totalPickups).toBe(9);
    });

    test("the raw status breakdown comes back too", async () => {
        const res = await overview();
        expect(res.body.byStatus["no-show"]).toBe(1);
        expect(res.body.byStatus.postponed).toBe(1);
    });

    test("active clients are counted", async () => {
        const res = await overview();
        expect(res.body.kpis.activeClients).toBe(2);
    });

    test("a paused client is not an active one", async () => {
        await Client.updateOne({ _id: globex._id }, { $set: { status: "paused" } });
        const res = await overview();
        expect(res.body.kpis.activeClients).toBe(1);
    });
});

// ───────────────────────────── tonnage ──────────────────────────────

describe("waste collected", () => {
    beforeEach(async () => {
        await makePickup({
            requestedAt: MARCH, wasteDataEnteredAt: MARCH,
            lineItems: [{ stream: "plastic", qtyKg: 100 }], totalKg: 100,
        });
        await makePickup({
            requestedAt: MARCH, wasteDataEnteredAt: APRIL,
            lineItems: [{ stream: "paper", qtyKg: 50 }, { stream: "plastic", qtyKg: 25 }],
            totalKg: 75,
        });
        // Requested but never weighed — must not count toward tonnage.
        await makePickup({ requestedAt: APRIL, status: "scheduled" });
    });

    test("only weighed pickups contribute", async () => {
        const res = await overview();
        expect(res.body.kpis.totalWasteKg).toBe(175);
        expect(res.body.kpis.weighedPickups).toBe(2);
    });

    test("category-wise summary adds up to the total", async () => {
        const res = await overview();
        const byStream = Object.fromEntries(
            res.body.categories.map((c) => [c.stream, c.kg])
        );
        expect(byStream.plastic).toBe(125);
        expect(byStream.paper).toBe(50);
        const sum = res.body.categories.reduce((s, c) => s + c.kg, 0);
        expect(sum).toBe(res.body.kpis.totalWasteKg);
    });

    test("categories carry their configured label and share", async () => {
        const res = await overview();
        const plastic = res.body.categories.find((c) => c.stream === "plastic");
        expect(plastic.label).toBe("Plastic");
        expect(plastic.share).toBeCloseTo(71.4, 1);
    });

    test("CO2e is derived from the configured factors", async () => {
        const res = await overview();
        // plastic 125kg x 1.5 + paper 50kg x 0.94
        expect(res.body.kpis.co2eAvoidedKg).toBeCloseTo(234.5, 1);
    });

    test("an edited factor changes the figure", async () => {
        await WasteCategory.updateOne(
            { key: "plastic" },
            { $set: { co2eFactorKgPerKg: 3 } }
        );
        const res = await overview();
        // plastic 125 x 3 + paper 50 x 0.94
        expect(res.body.kpis.co2eAvoidedKg).toBeCloseTo(422, 1);
    });

    test("partial collections are flagged", async () => {
        await makePickup({
            wasteDataEnteredAt: MARCH, isPartial: true, partialReason: "vehicle full",
            lineItems: [{ stream: "paper", qtyKg: 5 }], totalKg: 5,
        });
        const res = await overview();
        expect(res.body.kpis.partialPickups).toBe(1);
    });
});

// ──────────────────────────── the two dates ─────────────────────────

describe("which date a figure is counted on", () => {
    beforeEach(async () => {
        // Asked for in March, weighed in April.
        await makePickup({
            requestedAt: MARCH, wasteDataEnteredAt: APRIL,
            lineItems: [{ stream: "plastic", qtyKg: 60 }], totalKg: 60,
        });
    });

    test("March sees the pickup but not the tonnage", async () => {
        const res = await overview({ from: "2026-03-01", to: "2026-03-31" });
        expect(res.body.kpis.totalPickups).toBe(1);
        expect(res.body.kpis.totalWasteKg).toBe(0);
    });

    test("April sees the tonnage but not the pickup", async () => {
        const res = await overview({ from: "2026-04-01", to: "2026-04-30" });
        expect(res.body.kpis.totalPickups).toBe(0);
        expect(res.body.kpis.totalWasteKg).toBe(60);
    });

    test("the response says which date each half uses", async () => {
        const res = await overview();
        expect(res.body.countedOn).toEqual({
            pickups: "requestedAt",
            waste: "wasteDataEnteredAt",
        });
    });

    test("the end of the range includes that whole day", async () => {
        await makePickup({ requestedAt: new Date("2026-05-31T22:30:00") });
        const res = await overview({ from: "2026-05-01", to: "2026-05-31" });
        expect(res.body.kpis.totalPickups).toBe(1);
    });
});

// ───────────────────────────── filters ──────────────────────────────

describe("filters", () => {
    beforeEach(async () => {
        await makePickup({
            client: acme._id, site: acmeSiteA._id, status: "cert-sent",
            requestedAt: MARCH, wasteDataEnteredAt: MARCH,
            lineItems: [{ stream: "plastic", qtyKg: 10 }], totalKg: 10,
        });
        await makePickup({
            client: acme._id, site: acmeSiteB._id, status: "failed",
            requestedAt: APRIL,
        });
        await makePickup({
            client: globex._id, status: "cert-sent",
            requestedAt: MAY, wasteDataEnteredAt: MAY,
            clientNameSnapshot: "Globex",
            lineItems: [{ stream: "paper", qtyKg: 40 }], totalKg: 40,
        });
    });

    test("by client", async () => {
        const res = await overview({ clientId: String(globex._id) });
        expect(res.body.kpis.totalPickups).toBe(1);
        expect(res.body.kpis.totalWasteKg).toBe(40);
        expect(res.body.kpis.activeClients).toBe(1);
    });

    test("by location", async () => {
        const res = await overview({ siteId: String(acmeSiteA._id) });
        expect(res.body.kpis.totalPickups).toBe(1);
        expect(res.body.kpis.totalWasteKg).toBe(10);
    });

    test("by waste category", async () => {
        const res = await overview({ stream: "paper" });
        expect(res.body.kpis.totalPickups).toBe(1);
        expect(res.body.categories).toHaveLength(1);
        expect(res.body.categories[0].stream).toBe("paper");
    });

    test("by pickup status", async () => {
        const res = await overview({ status: "failed" });
        expect(res.body.kpis.totalPickups).toBe(1);
        expect(res.body.kpis.failedOrCancelledPickups).toBe(1);
    });

    test("by date range", async () => {
        const res = await overview({ from: "2026-04-01", to: "2026-04-30" });
        expect(res.body.kpis.totalPickups).toBe(1);
    });

    test("filters combine", async () => {
        const res = await overview({
            clientId: String(acme._id),
            from: "2026-03-01",
            to: "2026-03-31",
        });
        expect(res.body.kpis.totalPickups).toBe(1);
        expect(res.body.kpis.completedPickups).toBe(1);
    });

    test("a nonsense date is ignored rather than returning nothing", async () => {
        const res = await overview({ from: "not-a-date" });
        expect(res.statusCode).toBe(200);
        expect(res.body.kpis.totalPickups).toBe(3);
    });
});

// ──────────── weight when a category is filtered to ────────────
//
// The reported fault: filtering by a category still showed the whole weight of
// every pickup that happened to contain it, so the headline disagreed with the
// bar underneath it.

describe("weight under a category filter", () => {
    beforeEach(async () => {
        // One mixed pickup: 100 kg plastic + 50 kg paper.
        await makePickup({
            requestedAt: MARCH, wasteDataEnteredAt: MARCH, status: "cert-sent",
            lineItems: [
                { stream: "plastic", qtyKg: 100 },
                { stream: "paper", qtyKg: 50 },
            ],
            totalKg: 150,
        });
        // One plastic-only pickup: 20 kg.
        await makePickup({
            requestedAt: MARCH, wasteDataEnteredAt: MARCH, status: "cert-sent",
            lineItems: [{ stream: "plastic", qtyKg: 20 }],
            totalKg: 20,
        });
    });

    test("the headline is that category's weight, not the pickups' weight", async () => {
        const res = await overview({ stream: "plastic" });
        expect(res.body.kpis.totalWasteKg).toBe(120);   // not 170
    });

    test("the headline matches the category bar exactly", async () => {
        const res = await overview({ stream: "plastic" });
        expect(res.body.categories).toHaveLength(1);
        expect(res.body.categories[0].kg).toBe(res.body.kpis.totalWasteKg);
        expect(res.body.categories[0].share).toBe(100);
    });

    test("the smaller category is right too", async () => {
        const res = await overview({ stream: "paper" });
        expect(res.body.kpis.totalWasteKg).toBe(50);
        expect(res.body.kpis.weighedPickups).toBe(1);
    });

    test("CO2e follows the filtered weight", async () => {
        const res = await overview({ stream: "plastic" });
        expect(res.body.kpis.co2eAvoidedKg).toBeCloseTo(120 * 1.5, 1);
    });

    test("the month series is the filtered weight as well", async () => {
        const res = await overview({ stream: "plastic" });
        expect(res.body.monthly).toHaveLength(1);
        expect(res.body.monthly[0].kg).toBe(120);
    });

    test("the page can name the category it is showing", async () => {
        const res = await overview({ stream: "plastic" });
        expect(res.body.filters.streamLabels).toEqual(["Plastic"]);
    });

    test("pickups are counted per category, not per line", async () => {
        const res = await overview({ stream: "plastic" });
        expect(res.body.categories[0].pickups).toBe(2);
        expect(res.body.categories[0].averageKgPerPickup).toBe(60);
    });

    test("the whole weight is still reported alongside, to compare against", async () => {
        const res = await overview({ stream: "plastic" });
        expect(res.body.kpis.allCategoriesKg).toBe(170);
    });

    test("with no filter the headline is every category together", async () => {
        const res = await overview();
        expect(res.body.kpis.totalWasteKg).toBe(170);
        expect(res.body.kpis.weighedPickups).toBe(2);
        const sum = res.body.categories.reduce((s, c) => s + c.kg, 0);
        expect(sum).toBe(170);
    });

    test("shares add up to 100 across the categories", async () => {
        const res = await overview();
        const shares = res.body.categories.reduce((s, c) => s + c.share, 0);
        expect(shares).toBeCloseTo(100, 1);
    });

    test("each category carries the factor its CO2e was worked out from", async () => {
        const res = await overview();
        const plastic = res.body.categories.find((c) => c.stream === "plastic");
        expect(plastic.factor).toBe(1.5);
        expect(plastic.co2eKg).toBeCloseTo(plastic.kg * plastic.factor, 1);
    });
});

describe("weight recorded without a category", () => {
    test("is reported rather than quietly missing from the chart", async () => {
        // Legacy shape: a total with no line items behind it.
        await makePickup({
            requestedAt: MARCH, wasteDataEnteredAt: MARCH, status: "cert-sent",
            lineItems: [], totalKg: 40,
        });
        await makePickup({
            requestedAt: MARCH, wasteDataEnteredAt: MARCH, status: "cert-sent",
            lineItems: [{ stream: "paper", qtyKg: 10 }], totalKg: 10,
        });
        const res = await overview();
        expect(res.body.kpis.totalWasteKg).toBe(50);
        expect(res.body.kpis.categorisedKg).toBe(10);
        expect(res.body.kpis.uncategorisedKg).toBe(40);
    });

    test("is zero when every kilo has a category", async () => {
        await makePickup({
            requestedAt: MARCH, wasteDataEnteredAt: MARCH, status: "cert-sent",
            lineItems: [{ stream: "paper", qtyKg: 10 }], totalKg: 10,
        });
        const res = await overview();
        expect(res.body.kpis.uncategorisedKg).toBe(0);
        expect(res.body.kpis.categorisedKg).toBe(res.body.kpis.totalWasteKg);
    });
});

// ────────────────────────── month series ────────────────────────────

describe("month series", () => {
    beforeEach(async () => {
        await makePickup({
            requestedAt: MARCH, wasteDataEnteredAt: MARCH, status: "cert-sent",
            lineItems: [{ stream: "plastic", qtyKg: 30 }], totalKg: 30,
        });
        await makePickup({
            requestedAt: APRIL, wasteDataEnteredAt: APRIL, status: "cert-sent",
            lineItems: [{ stream: "plastic", qtyKg: 70 }], totalKg: 70,
        });
        await makePickup({ requestedAt: APRIL, status: "failed" });
    });

    test("one row per month, in order", async () => {
        const res = await overview();
        expect(res.body.monthly.map((m) => m.month)).toEqual(["2026-03", "2026-04"]);
    });

    test("each row carries tonnage and pickup outcomes", async () => {
        const res = await overview();
        const april = res.body.monthly.find((m) => m.month === "2026-04");
        expect(april.kg).toBe(70);
        expect(april.pickups).toBe(2);
        expect(april.completed).toBe(1);
        expect(april.lost).toBe(1);
    });

    test("a month with pickups but nothing weighed still appears", async () => {
        await Pickup.deleteMany({ wasteDataEnteredAt: { $ne: null } });
        const res = await overview();
        expect(res.body.monthly).toHaveLength(1);
        expect(res.body.monthly[0].kg).toBe(0);
        expect(res.body.monthly[0].pickups).toBe(1);
    });
});

// ──────────────────────────── certificates ──────────────────────────

describe("certificate KPIs", () => {
    const makeCert = (status, n) =>
        Certificate.create({
            certNumber: `COD-2026-${String(n).padStart(4, "0")}`,
            pickup: new mongoose.Types.ObjectId(),
            client: acme._id,
            status,
        });

    test("drafted and issued are what is still outstanding", async () => {
        await makeCert("draft", 1);
        await makeCert("issued", 2);
        await makeCert("sent", 3);
        const res = await overview();
        expect(res.body.kpis.pendingCertificates).toBe(2);
        expect(res.body.kpis.certificatesIssued).toBe(1);
        expect(res.body.kpis.certificatesSent).toBe(1);
    });

    test("cancelled ones are reported separately", async () => {
        await makeCert("cancelled", 4);
        const res = await overview();
        expect(res.body.kpis.certificatesCancelled).toBe(1);
        expect(res.body.kpis.pendingCertificates).toBe(0);
    });

    test("the client filter applies to certificates too", async () => {
        await makeCert("sent", 5);
        const res = await overview({ clientId: String(globex._id) });
        expect(res.body.kpis.certificatesSent).toBe(0);
    });
});

// ─────────────────────────── empty state ────────────────────────────

describe("with no data", () => {
    test("every figure is zero rather than missing", async () => {
        const res = await overview();
        expect(res.statusCode).toBe(200);
        expect(res.body.kpis.totalPickups).toBe(0);
        expect(res.body.kpis.totalWasteKg).toBe(0);
        expect(res.body.kpis.co2eAvoidedKg).toBe(0);
        expect(res.body.categories).toEqual([]);
        expect(res.body.monthly).toEqual([]);
    });
});
