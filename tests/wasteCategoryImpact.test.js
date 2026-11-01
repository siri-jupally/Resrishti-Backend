/*
  Per-stream Environmental Impact factors — admin-configurable, like the CO2e
  factor. Covers: the seeded defaults, impactFactorConfig() (what the report
  reads), admin update + validation, reset-to-shipped, and the admin-only gate.
*/
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const WasteCategory = require("../models/WasteCategory");
const wc = require("../utils/wasteCategories");
const ctrl = require("../controllers/wasteCategoryController");

let mongod;
const admin = { name: "Admin", email: "admin@test.com" };
const mockRes = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(d) { r.body = d; return r; } }; return r; };

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
    await WasteCategory.deleteMany({});
    await wc.initWasteCategories(); // seeds the 11 core streams with impact factors
});

describe("per-stream impact factors", () => {
    it("seeds env factors + co2 for mapped streams; zero env for the rest", async () => {
        const cfg = await wc.impactFactorConfig();
        // plastic has official figures
        expect(cfg.plastic.energy).toBeCloseTo(5.774, 3);
        expect(cfg.plastic.water).toBeCloseTo(18.17, 2);
        expect(cfg.plastic.co2).toBeCloseTo(1.5, 2);
        // battery mirrors E-waste
        expect(cfg.battery.energy).toBeCloseTo(cfg.ewaste.energy, 4);
        // unmapped stream: env factors 0, but still carries a co2 factor
        expect(cfg.hazardous.energy).toBe(0);
        expect(cfg.hazardous.water).toBe(0);
        expect(cfg.hazardous.co2).toBeCloseTo(1.6, 2);
    });

    it("an admin can set impact factors; negatives are rejected", async () => {
        const neg = mockRes();
        await ctrl.updateWasteCategory({ admin, params: { key: "other" }, body: { impactEnergyPerKg: -1 } }, neg);
        expect(neg.statusCode).toBe(400);
        expect(neg.body.message).toMatch(/impactEnergyPerKg/);

        const ok = mockRes();
        await ctrl.updateWasteCategory({ admin, params: { key: "other" }, body: { impactEnergyPerKg: 3.2, impactWaterPerKg: 9 } }, ok);
        expect(ok.statusCode).toBe(200);

        const cfg = await wc.impactFactorConfig();
        expect(cfg.other.energy).toBeCloseTo(3.2, 4);
        expect(cfg.other.water).toBe(9);
    });

    it("reset-factors restores the shipped impact figures", async () => {
        await WasteCategory.updateOne({ key: "plastic" }, { $set: { impactEnergyPerKg: 0, impactWaterPerKg: 0 } });
        const res = mockRes();
        await ctrl.resetFactors({ admin }, res);
        expect(res.statusCode).toBe(200);
        const cfg = await wc.impactFactorConfig();
        expect(cfg.plastic.energy).toBeCloseTo(5.774, 3);
        expect(cfg.plastic.water).toBeCloseTo(18.17, 2);
    });

    it("writing impact factors is admin-only (a coordinator manager is rejected)", async () => {
        const res = mockRes();
        await ctrl.updateWasteCategory({ manager: { canCoordinate: true }, params: { key: "other" }, body: { impactEnergyPerKg: 1 } }, res);
        expect(res.statusCode).toBe(403);
    });
});
