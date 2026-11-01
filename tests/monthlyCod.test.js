/*
  Monthly Certificate of Disposal — the calcCod bucket rollup (pure) and the
  "cod" report type flowing through reportController.generateReport.
*/
jest.mock("../utils/push", () => ({ sendPush: jest.fn().mockResolvedValue({}), notifyIfEnabled: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/s3", () => ({ uploadFile: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }), getS3Client: jest.fn(() => ({ send: jest.fn() })) }));
// @react-pdf is ESM — mock every renderer the controller imports.
jest.mock("../utils/impactReportPdf", () => ({ renderImpactReportPdf: jest.fn() }));
jest.mock("../utils/ghgReportPdf", () => ({ renderGhgReportPdf: jest.fn() }));
jest.mock("../utils/monthlyCodPdf", () => ({ renderMonthlyCodPdf: jest.fn() }));

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const { calcCod } = require("../utils/reportCalculations");

describe("calcCod — bucket rollup", () => {
    const bucketOf = (s) => ({ plastic: "plastic", paper: "paper", ewaste: "ewaste", hazardous: "other-dry" }[s] || "other-dry");

    it("aggregates every stream into its certificate bucket", () => {
        const res = calcCod([
            { lineItems: [{ stream: "plastic", qtyKg: 100 }, { stream: "paper", qtyKg: 50 }, { stream: "hazardous", qtyKg: 10 }] },
            { lineItems: [{ stream: "plastic", qtyKg: 20 }] },
        ], bucketOf);

        expect(res.totalKg).toBe(180);
        expect(res.pickupCount).toBe(2);
        expect(res.rows).toHaveLength(7);               // the fixed CoD template rows
        expect(res.rows.find((r) => r.key === "plastic").qtyKg).toBe(120);
        expect(res.rows.find((r) => r.key === "paper").qtyKg).toBe(50);
        expect(res.rows.find((r) => r.key === "other-dry").qtyKg).toBe(10);
        expect(res.rows.find((r) => r.key === "metal").qtyKg).toBe(0); // no stream maps to it
    });

    it("ignores zero / negative quantities", () => {
        const res = calcCod([{ lineItems: [{ stream: "plastic", qtyKg: 0 }, { stream: "plastic", qtyKg: -5 }] }], bucketOf);
        expect(res.totalKg).toBe(0);
        expect(res.pickupCount).toBe(0);
    });
});

describe("reportController — generate a monthly CoD report", () => {
    let mongod, Report, Client, Pickup, wasteCategories, reportController, admin, client;
    const mockRes = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(d) { r.body = d; return r; } }; return r; };

    beforeAll(async () => {
        mongod = await MongoMemoryServer.create();
        await mongoose.connect(mongod.getUri());
        Report = require("../models/Report");
        Client = require("../models/Client");
        Pickup = require("../models/Pickup");
        require("../models/Site"); // registered for findEligiblePickups' populate("site")
        wasteCategories = require("../utils/wasteCategories");
        reportController = require("../controllers/reportController");
    });
    afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
    beforeEach(async () => {
        jest.clearAllMocks();
        await Promise.all([Report.deleteMany({}), Client.deleteMany({}), Pickup.deleteMany({})]);
        await wasteCategories.initWasteCategories();
        client = await Client.create({ name: "Acme", contactName: "A", contactEmail: "a@acme.com", contactPhone: "1", status: "active", isOnboardingComplete: true });
        admin = { name: "Admin", email: "admin@test.com" };
    });

    it("creates a draft CoD report with a CoD-#### number and bucketed snapshot", async () => {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        await Pickup.create({
            pickupID: "PU-COD-1", client: client._id, status: "closed", pipelineVersion: 2,
            scheduledDate: now, lineItems: [{ stream: "plastic", qtyKg: 300 }, { stream: "paper", qtyKg: 120 }], totalKg: 420,
        });

        const res = mockRes();
        await reportController.generateReport({ admin, body: { clientId: String(client._id), type: "cod", year, month } }, res);

        expect(res.statusCode).toBe(201);
        const report = res.body.report;
        expect(report.type).toBe("cod");
        expect(report.reportNumber).toMatch(/^CoD-\d{4}-\d{4}$/);
        expect(report.status).toBe("draft");
        expect(report.codSnapshot.totalKg).toBe(420);
        expect(report.codSnapshot.rows.find((r) => r.key === "plastic").qtyKg).toBe(300);
        expect(report.codSnapshot.rows.find((r) => r.key === "paper").qtyKg).toBe(120);
    });

    it("409s when there is nothing disposed that month", async () => {
        const now = new Date();
        const res = mockRes();
        await reportController.generateReport({ admin, body: { clientId: String(client._id), type: "cod", year: now.getFullYear(), month: now.getMonth() + 1 } }, res);
        expect(res.statusCode).toBe(409);
    });
});
