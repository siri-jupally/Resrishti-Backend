/*
  tests/reportCalculations.test.js

  These figures go onto documents clients hand to auditors, so the maths is
  pinned against the client's own approved sample document rather than against
  whatever the code happens to produce today.

  Reference: "GHG Sample document.pdf" page 4 — four buildings, tonnage and
  MTCO2E columns. See utils/reportFactors.js for factor provenance.
*/

const { calcImpact, calcGHG } = require("../utils/reportCalculations");
const {
    STREAM_TO_IMPACT_MATERIAL,
    GHG_ORGANIC_STREAMS,
} = require("../utils/reportFactors");

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

describe("calcImpact", () => {
    test("total counts every stream; savings only count mapped materials", () => {
        const res = calcImpact([
            {
                lineItems: [
                    { stream: "plastic", qtyKg: 10 },
                    { stream: "hazardous", qtyKg: 57 }, // no impact factor
                ],
            },
        ]);
        // The sample document's headline is TOTAL WASTE RECYCLED — everything.
        expect(res.totalWasteKg).toBe(67);
        expect(res.unmappedKg).toBe(57);
        // 10kg plastic x 5.774 kWh/kg
        expect(res.energySaved).toBeCloseTo(57.74, 2);
        expect(res.waterSaved).toBeCloseTo(181.7, 2);
    });

    test("battery maps to E-waste, matching the CoD template's bucketing", () => {
        expect(STREAM_TO_IMPACT_MATERIAL.battery).toBe("E-waste");
        const viaBattery = calcImpact([{ lineItems: [{ stream: "battery", qtyKg: 10 }] }]);
        const viaEwaste = calcImpact([{ lineItems: [{ stream: "ewaste", qtyKg: 10 }] }]);
        expect(viaBattery.energySaved).toBeCloseTo(viaEwaste.energySaved, 4);
    });

    test("all five indicator rows are always present, even at zero", () => {
        const res = calcImpact([]);
        expect(res.rows.map((r) => r.material)).toEqual([
            "Plastic", "Paper", "Cardboard", "Metal", "E-waste",
        ]);
        expect(res.totalWasteKg).toBe(0);
    });

    test("quantities aggregate across multiple pickups", () => {
        const split = calcImpact([
            { lineItems: [{ stream: "paper", qtyKg: 100 }] },
            { lineItems: [{ stream: "paper", qtyKg: 200 }] },
        ]);
        const single = calcImpact([{ lineItems: [{ stream: "paper", qtyKg: 300 }] }]);
        expect(split.energySaved).toBeCloseTo(single.energySaved, 4);
        expect(split.totalWasteKg).toBe(300);
    });

    test("negative and non-numeric quantities are ignored, not coerced", () => {
        const res = calcImpact([
            {
                lineItems: [
                    { stream: "plastic", qtyKg: 10 },
                    { stream: "plastic", qtyKg: -5 },
                    { stream: "plastic", qtyKg: "abc" },
                    { stream: "plastic" },
                ],
            },
        ]);
        expect(res.totalWasteKg).toBe(10);
    });

    test("tolerates missing lineItems without throwing", () => {
        expect(() => calcImpact([{}, { lineItems: null }])).not.toThrow();
        expect(calcImpact([{}]).totalWasteKg).toBe(0);
    });
});
