/**
 * Statutory deductions (PF / ESI / Professional Tax / TDS).
 *
 * Each is off until switched on, so with nothing enabled net stays equal to
 * gross — the behaviour before this existed. When on, each is computed from its
 * own configurable rate/threshold and summed into the total that comes off
 * take-home.
 */
const { computeStatutory } = require("../utils/payrollEngine");

describe("statutory deductions", () => {
    test("all off → nothing is deducted", () => {
        expect(computeStatutory(40000, {}).total).toBe(0);
        expect(computeStatutory(40000, { statutory: {} }).total).toBe(0);
    });

    test("PF — 12% of basic (50% of gross), capped at the ceiling", () => {
        const s = { statutory: { pf: { enabled: true, employeeRate: 12, wageBasis: "basic", basicPercent: 50, wageCeiling: 15000, capToCeiling: true } } };
        // gross 40000 → basic 20000 → capped to 15000 → 12% = 1800
        expect(computeStatutory(40000, s).pf).toBe(1800);
        // gross 20000 → basic 10000 (below the cap) → 12% = 1200
        expect(computeStatutory(20000, s).pf).toBe(1200);
    });

    test("PF — on the whole gross, uncapped", () => {
        const s = { statutory: { pf: { enabled: true, employeeRate: 12, wageBasis: "gross", capToCeiling: false } } };
        expect(computeStatutory(40000, s).pf).toBe(4800);
    });

    test("ESI — 0.75% of gross, only at or below the ceiling", () => {
        const s = { statutory: { esi: { enabled: true, employeeRate: 0.75, grossCeiling: 21000 } } };
        expect(computeStatutory(20000, s).esi).toBe(150);
        expect(computeStatutory(25000, s).esi).toBe(0);
    });

    test("Professional Tax — a flat amount above the threshold", () => {
        const s = { statutory: { pt: { enabled: true, amount: 200, minGross: 15000 } } };
        expect(computeStatutory(30000, s).pt).toBe(200);
        expect(computeStatutory(10000, s).pt).toBe(0);
    });

    test("TDS — a flat percent of gross", () => {
        const s = { statutory: { tds: { enabled: true, flatPercent: 10 } } };
        expect(computeStatutory(30000, s).tds).toBe(3000);
    });

    test("enabled components sum into the total", () => {
        const s = {
            statutory: {
                pf: { enabled: true, employeeRate: 12, wageBasis: "gross", capToCeiling: false },
                pt: { enabled: true, amount: 200, minGross: 0 },
                esi: { enabled: false },
            },
        };
        const r = computeStatutory(10000, s);
        expect(r.pf).toBe(1200);
        expect(r.pt).toBe(200);
        expect(r.esi).toBe(0);
        expect(r.total).toBe(1400);
    });

    test("zero gross → no deductions", () => {
        const s = { statutory: { pf: { enabled: true, employeeRate: 12, wageBasis: "gross", capToCeiling: false } } };
        expect(computeStatutory(0, s).total).toBe(0);
    });
});
