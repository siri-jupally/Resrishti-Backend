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

const {
    IMPACT_FACTORS,
    IMPACT_MATERIALS,
    STREAM_TO_IMPACT_MATERIAL,
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

/**
 * Environmental Impact report.
 *
 * @param {Array<{lineItems: Array<{stream: string, qtyKg: number}>}>} pickups
 *        Every eligible pickup in the reporting month.
 * @returns {{
 *   totalWasteKg: number, waterSaved: number, energySaved: number,
 *   treesSaved: number, airPollutants: number, oilSaved: number,
 *   landfillSaved: number, rows: Array, unmappedKg: number
 * }}
 *
 * `totalWasteKg` counts EVERY stream — that is the "TOTAL WASTE RECYCLED"
 * headline. The six savings indicators only accumulate from streams that map
 * to a material in the client's impact sheet; `unmappedKg` reports how much
 * mass produced no savings figure, so the manager can see at review time
 * whether a big chunk of the month went uncounted.
 */
function calcImpact(pickups = []) {
    // Roll every pickup's line items up into per-material kg first.
    const kgByMaterial = new Map();
    let totalWasteKg = 0;
    let unmappedKg = 0;

    for (const p of pickups) {
        for (const li of p.lineItems || []) {
            const kg = num(li.qtyKg);
            if (kg <= 0) continue;
            totalWasteKg += kg;

            const material = STREAM_TO_IMPACT_MATERIAL[li.stream];
            if (!material) {
                unmappedKg += kg;
                continue;
            }
            kgByMaterial.set(material, (kgByMaterial.get(material) || 0) + kg);
        }
    }

    const totals = { energy: 0, oil: 0, landfill: 0, air: 0, water: 0, trees: 0 };
    const rows = [];

    for (const material of IMPACT_MATERIALS) {
        const qty = kgByMaterial.get(material) || 0;
        const f = IMPACT_FACTORS[material];
        const row = { material, qtyKg: round(qty) };

        for (const metric of Object.keys(totals)) {
            const val = qty * f[metric];
            totals[metric] += val;
            row[metric] = round(val);
        }
        rows.push(row);
    }

    return {
        totalWasteKg: round(totalWasteKg),
        waterSaved: round(totals.water),
        energySaved: round(totals.energy),
        treesSaved: round(totals.trees),
        airPollutants: round(totals.air),
        oilSaved: round(totals.oil),
        landfillSaved: round(totals.landfill),
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
