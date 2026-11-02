/*
  tests/reportCalculations.test.js

  These figures go onto documents clients hand to auditors, so the maths is
  pinned against the client's own approved sample document rather than against
  whatever the code happens to produce today.

  Reference: "GHG Sample document.pdf" page 4 — four buildings, tonnage and
  MTCO2E columns. See utils/reportFactors.js for factor provenance.
*/

const { calcImpact, calcGHG } = require("../utils/reportCalculations");
const { GHG_ORGANIC_STREAMS } = require("../utils/reportFactors");

/*
  The sample prints tonnage rounded to 2dp, so feeding its displayed figure
  back in can move a derived value by one rounding step (see reportFactors.js
  for the HDC4 worked example). Allow exactly one such step.

  The extra 5e-4 absorbs binary-float noise: |1.99 - 1.98| evaluates to
  0.010000000000000009, which a bare `<= 0.01` rejects. It is far below the
  0.01 a second real rounding step would cost, so a genuine factor error
  still fails this check.
*/
const withinOneRoundingStep = (actual, expected) =>
    Math.abs(actual - expected) <= 0.0105;

const ghgPickup = (siteName, kg) => ({
    siteNameSnapshot: siteName,
    lineItems: [{ stream: "expired-food", qtyKg: kg }],
});

describe("calcGHG — reproduces the client's sample document", () => {
    const samplePickups = [
        ghgPickup("HDC2", 510),
        ghgPickup("HDC3", 2200),
        ghgPickup("HDC4", 560),
        ghgPickup("HDC5", 1060),
    ];

    // siteName -> [foodWasteTons, totalGHG, production, prodEndOfLife]
    const sample = {
        HDC2: [0.51, -0.06, 1.87, 1.81],
        HDC3: [2.2, -0.25, 8.05, 7.8],
        HDC4: [0.56, -0.06, 2.05, 1.98],
        HDC5: [1.06, -0.12, 3.88, 3.76],
    };

    const result = calcGHG(samplePickups);

    test.each(Object.entries(sample))(
        "%s matches the sample row",
        (siteName, [tons, totalGHG, production, prodEndOfLife]) => {
            const row = result.rows.find((r) => r.siteName === siteName);
            expect(row).toBeDefined();
            expect(row.foodWasteTons).toBeCloseTo(tons, 2);
            expect(row.totalGHG).toBeCloseTo(totalGHG, 1);
            expect(withinOneRoundingStep(row.production, production)).toBe(true);
            expect(withinOneRoundingStep(row.prodEndOfLife, prodEndOfLife)).toBe(true);
        }
    );

    test("total organic tonnage matches the sample's stated 4.33 tons", () => {
        expect(result.totals.foodWasteTons).toBeCloseTo(4.33, 2);
    });

    test("composted equals generated (sample assumes full diversion)", () => {
        expect(result.totals.composted).toBeCloseTo(result.totals.foodWasteTons, 2);
    });

    test("net savings reconciles with the sum of the table rows", () => {
        const summed = result.rows.reduce((a, r) => a + r.prodEndOfLife, 0);
        expect(result.netGHGSavings).toBeCloseTo(summed, 2);
    });
});

describe("calcGHG — grouping and edge cases", () => {
    test("only organic streams count toward the GHG report", () => {
        const res = calcGHG([
            {
                siteNameSnapshot: "HDC1",
                lineItems: [
                    { stream: "expired-food", qtyKg: 1000 },
                    { stream: "plastic", qtyKg: 5000 },   // must be ignored
                    { stream: "hazardous", qtyKg: 5000 }, // must be ignored
                ],
            },
        ]);
        expect(res.totals.foodWasteTons).toBeCloseTo(1, 2);
    });

    test("GHG_ORGANIC_STREAMS is the single switch controlling that", () => {
        expect(GHG_ORGANIC_STREAMS).toContain("expired-food");
        expect(GHG_ORGANIC_STREAMS).not.toContain("plastic");
    });

    test("multiple pickups from one site aggregate into a single row", () => {
        const res = calcGHG([ghgPickup("HDC2", 300), ghgPickup("HDC2", 210)]);
        expect(res.rows).toHaveLength(1);
        expect(res.rows[0].foodWasteTons).toBeCloseTo(0.51, 2);
    });

    test("untagged pickups roll into 'Unassigned' rather than being dropped", () => {
        const res = calcGHG([
            ghgPickup("HDC2", 500),
            { lineItems: [{ stream: "expired-food", qtyKg: 500 }] }, // no site
        ]);
        expect(res.totals.foodWasteTons).toBeCloseTo(1, 2);
        expect(res.rows.map((r) => r.siteName)).toContain("Unassigned");
    });

    test("'Unassigned' sorts last, and site names sort numerically", () => {
        const res = calcGHG([
            { lineItems: [{ stream: "expired-food", qtyKg: 100 }] },
            ghgPickup("HDC10", 100),
            ghgPickup("HDC2", 100),
        ]);
        expect(res.rows.map((r) => r.siteName)).toEqual(["HDC2", "HDC10", "Unassigned"]);
    });

    test("a month with no organic waste is reported as empty, not as zeros", () => {
        const res = calcGHG([]);
        expect(res.hasData).toBe(false);
        expect(res.rows).toHaveLength(0);
        expect(res.netGHGSavings).toBe(0);
    });

    test("the live site ref is used when no snapshot was frozen", () => {
        const res = calcGHG([
            { site: { name: "HDC7" }, lineItems: [{ stream: "expired-food", qtyKg: 100 }] },
        ]);
        expect(res.rows[0].siteName).toBe("HDC7");
    });
});

describe("calcImpact (per-stream configurable factors)", () => {
    // Mirrors what wasteCategories.impactFactorConfig() hands in: per-stream
    // { energy, oil, landfill, air, water, trees, co2 }. CO2 is the stream's
    // co2e factor. 'hazardous' here has a co2 factor but NO env-savings factors.
    const FACTORS = {
        plastic: { energy: 5.774, oil: 2.593, landfill: 0.81, air: 2.5, water: 18.17, trees: 0, co2: 1.5 },
        paper: { energy: 4.1, oil: 1.4384, landfill: 0.0891, air: 0.0272, water: 26.4978, trees: 0.017, co2: 0.94 },
        ewaste: { energy: 4.123779, oil: 1.85324644, landfill: 0.260361, air: 0.50409844, water: 3.653987, trees: 0, co2: 1.44 },
        hazardous: { co2: 1.6 },
    };

    test("total counts every stream; env savings only from streams with env factors", () => {
        const res = calcImpact([
            { lineItems: [{ stream: "plastic", qtyKg: 10 }, { stream: "hazardous", qtyKg: 57 }] },
        ], FACTORS);
        expect(res.totalWasteKg).toBe(67);          // TOTAL WASTE RECYCLED — everything
        expect(res.unmappedKg).toBe(57);            // hazardous has no env-savings factor
        expect(res.energySaved).toBeCloseTo(57.74, 2);  // 10 × 5.774
        expect(res.waterSaved).toBeCloseTo(181.7, 2);   // 10 × 18.17
    });

    test("CO2 is a first-class impact metric, counted for EVERY stream with a co2 factor", () => {
        const res = calcImpact([
            { lineItems: [{ stream: "plastic", qtyKg: 10 }, { stream: "hazardous", qtyKg: 57 }] },
        ], FACTORS);
        // 10×1.5 + 57×1.6 — hazardous contributes CO2 even though it has no env factors
        expect(res.co2Saved).toBeCloseTo(106.2, 2);
    });

    test("a stream with no configured factors adds only mass (unmapped), zero savings", () => {
        const res = calcImpact([{ lineItems: [{ stream: "other", qtyKg: 40 }] }], {});
        expect(res.totalWasteKg).toBe(40);
        expect(res.unmappedKg).toBe(40);
        expect(res.energySaved).toBe(0);
        expect(res.co2Saved).toBe(0);
    });

    test("quantities aggregate across multiple pickups", () => {
        const split = calcImpact([
            { lineItems: [{ stream: "paper", qtyKg: 100 }] },
            { lineItems: [{ stream: "paper", qtyKg: 200 }] },
        ], FACTORS);
        const single = calcImpact([{ lineItems: [{ stream: "paper", qtyKg: 300 }] }], FACTORS);
        expect(split.energySaved).toBeCloseTo(single.energySaved, 4);
        expect(split.totalWasteKg).toBe(300);
    });

    test("rows are per-stream, largest first", () => {
        const res = calcImpact([
            { lineItems: [{ stream: "plastic", qtyKg: 5 }, { stream: "paper", qtyKg: 50 }] },
        ], FACTORS);
        expect(res.rows.map((r) => r.stream)).toEqual(["paper", "plastic"]);
    });

    test("negative and non-numeric quantities are ignored, not coerced", () => {
        const res = calcImpact([
            { lineItems: [
                { stream: "plastic", qtyKg: 10 },
                { stream: "plastic", qtyKg: -5 },
                { stream: "plastic", qtyKg: "abc" },
                { stream: "plastic" },
            ] },
        ], FACTORS);
        expect(res.totalWasteKg).toBe(10);
    });

    test("tolerates missing lineItems and missing config without throwing", () => {
        expect(() => calcImpact([{}, { lineItems: null }])).not.toThrow();
        expect(calcImpact([{}]).totalWasteKg).toBe(0);
    });
});
