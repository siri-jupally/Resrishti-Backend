/*
  utils/reportCalculations.js — pure maths for the two monthly reports.

  No mongoose, no I/O, no dates-from-now: numbers in, numbers out. The
  controller does the querying and hands plain objects in here, which keeps
  every figure on a client-facing legal document unit-testable in isolation.

  Rounding:
  - All outputs are rounded to 2dp at the boundary only. Intermediate sums stay
    full-precision so a 30-pickup month doesn't accumulate rounding drift.
  - `round` uses Number.EPSILON compensation so 1.005 → 1.01 rather than 1.00.
*/

// Impact factors are now per-stream and admin-configurable (WasteCategory →
// wasteCategories.impactFactorConfig), passed into calcImpact. Only the GHG
// report still reads the hard-coded factors here.
const {
    GHG_FACTORS,
    GHG_ORGANIC_STREAMS,
    KG_PER_TON,
} = require("./reportFactors");

const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
};

const round = (n, d = 2) => {
    const f = Math.pow(10, d);
    return Math.round((n + Number.EPSILON) * f) / f;
};

// The metrics carried on the savings indicators, in the shape the per-stream
// factor config uses. CO2 reuses each stream's co2e factor (see
// wasteCategories.impactFactorConfig) — it is a first-class impact metric here.
const IMPACT_METRICS = ["energy", "oil", "landfill", "air", "water", "trees", "co2"];

/**
 * Environmental Impact report.
 *
 * Factors are PER STREAM and admin-configurable (WasteCategory): the caller
 * passes `factorByStream` = { [stream]: { energy, oil, landfill, air, water,
 * trees, co2 } }. Every stream contributes according to its own configured
 * factors; a stream with no factors set (all zero) adds nothing but its mass.
 *
 * @param {Array<{lineItems: Array<{stream: string, qtyKg: number}>}>} pickups
 * @param {Object<string, {energy,oil,landfill,air,water,trees,co2}>} factorByStream
 * @returns {{
 *   totalWasteKg, waterSaved, energySaved, treesSaved, airPollutants,
 *   oilSaved, landfillSaved, co2Saved, rows, unmappedKg
 * }}
 *
 * `totalWasteKg` counts EVERY stream — the "TOTAL WASTE RECYCLED" headline.
 * `unmappedKg` is how much mass came from streams with NO environmental impact
 * factors configured (CO2 aside), so a reviewer can see if a big chunk of the
 * month produced no savings figures yet.
 */
function calcImpact(pickups = [], factorByStream = {}) {
    const kgByStream = new Map();
    let totalWasteKg = 0;

    for (const p of pickups) {
        for (const li of p.lineItems || []) {
            const kg = num(li.qtyKg);
            if (kg <= 0) continue;
            totalWasteKg += kg;
            kgByStream.set(li.stream, (kgByStream.get(li.stream) || 0) + kg);
        }
    }

    const totals = { energy: 0, oil: 0, landfill: 0, air: 0, water: 0, trees: 0, co2: 0 };
    const rows = [];
    let unmappedKg = 0;

    for (const [stream, qty] of kgByStream) {
        const f = factorByStream[stream] || {};
        const row = { stream, qtyKg: round(qty) };
        // A stream is "mapped" when it has at least one environmental savings
        // factor (CO2 excluded — nearly every stream carries a CO2e default).
        let hasEnvFactor = false;

        for (const metric of IMPACT_METRICS) {
            const factor = num(f[metric]);
            const val = qty * factor;
            totals[metric] += val;
            row[metric] = round(val);
            if (metric !== "co2" && factor > 0) hasEnvFactor = true;
        }
        if (!hasEnvFactor) unmappedKg += qty;
        rows.push(row);
    }

    // Largest stream first — the report table reads top-down by volume.
    rows.sort((a, b) => b.qtyKg - a.qtyKg);

    return {
        totalWasteKg: round(totalWasteKg),
        waterSaved: round(totals.water),
        energySaved: round(totals.energy),
        treesSaved: round(totals.trees),
        airPollutants: round(totals.air),
        oilSaved: round(totals.oil),
        landfillSaved: round(totals.landfill),
        co2Saved: round(totals.co2),
        rows,
        unmappedKg: round(unmappedKg),
    };
}

/**
 * GHG emission report.
 *
 * Groups organic/food waste by SITE, mirroring the client's sample document
 * where each building (HDC2..HDC5) is one row of the emissions table and one
 * series on the chart.
 *
 * @param {Array<{siteNameSnapshot?: string, site?: object, lineItems: Array}>} pickups
 * @returns {{rows: Array, totals: object, netGHGSavings: number, hasData: boolean}}
 *
 * Pickups with no site fall into an "Unassigned" row rather than being
 * silently dropped — a missing site tag must never quietly shrink the
 * client's reported tonnage.
 */
function calcGHG(pickups = []) {
    // siteName -> organic kg
    const kgBySite = new Map();

    for (const p of pickups) {
        const siteName =
            (p.siteNameSnapshot && String(p.siteNameSnapshot).trim()) ||
            (p.site && p.site.name) ||
            "Unassigned";

        for (const li of p.lineItems || []) {
            if (!GHG_ORGANIC_STREAMS.includes(li.stream)) continue;
            const kg = num(li.qtyKg);
            if (kg <= 0) continue;
            kgBySite.set(siteName, (kgBySite.get(siteName) || 0) + kg);
        }
    }

    // Stable, human-friendly ordering: alphabetical, but "Unassigned" last so
    // it reads as a footnote rather than a building.
    const siteNames = Array.from(kgBySite.keys()).sort((a, b) => {
        if (a === "Unassigned") return 1;
        if (b === "Unassigned") return -1;
        return a.localeCompare(b, undefined, { numeric: true });
    });

    const rows = siteNames.map((siteName) => {
        const tons = kgBySite.get(siteName) / KG_PER_TON;
        // The sample assumes everything collected is composted.
        const composted = tons;
        return {
            siteName,
            foodWasteTons: round(tons),
            composted: round(composted),
            totalGHG: round(composted * GHG_FACTORS.compostEmissionPerTon),
            production: round(composted * GHG_FACTORS.productionPerTon),
            prodEndOfLife: round(composted * GHG_FACTORS.prodEndOfLifePerTon),
        };
    });

    const sum = (key) => rows.reduce((acc, r) => acc + r[key], 0);

    const totals = {
        foodWasteTons: round(sum("foodWasteTons")),
        composted: round(sum("composted")),
        totalGHG: round(sum("totalGHG")),
        production: round(sum("production")),
        prodEndOfLife: round(sum("prodEndOfLife")),
    };

    return {
        rows,
        totals,
        // Headline on the overview page. Note: the client's sample prints
        // 15.55 t against per-row values summing to 15.35 t — the extra
        // appears to be a transport allocation the sample never shows a
        // formula for. We report the defensible sum of the rows so the
        // headline always reconciles with the table beneath it.
        netGHGSavings: totals.prodEndOfLife,
        hasData: rows.length > 0,
    };
}

module.exports = { calcImpact, calcGHG, round };
