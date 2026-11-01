/*
  Phase 0 — pickup pipeline revamp migration safety net.

  Pure unit tests (no DB): they lock the additive migration contract so that the
  later phases can't silently break backward compatibility:
    - pipelineVersion defaults to 1 (legacy) and only accepts 1|2
    - isLegacyPipeline grandfathers v1/missing rows
    - the new CLOSED_EQUIVALENT_STATUSES stays in sync with the report filter
    - no legacy pickup status value was removed from the enum
*/
// @react-pdf/renderer is ESM and can't be required under Jest's CJS runtime, so
// reportController's PDF renderers are mocked (same pattern as the cert tests).
jest.mock("../utils/impactReportPdf", () => ({ renderImpactReportPdf: jest.fn() }));
jest.mock("../utils/ghgReportPdf", () => ({ renderGhgReportPdf: jest.fn() }));
jest.mock("../utils/monthlyCodPdf", () => ({ renderMonthlyCodPdf: jest.fn() }));

const mongoose = require("mongoose");
const Pickup = require("../models/Pickup");
const { ELIGIBLE_PICKUP_STATUSES } = require("../controllers/reportController");

const LEGACY_STATUSES = [
    "requested", "accepted", "rejected", "scheduled", "en-route", "at-client",
    "picked-up", "at-facility", "weighed", "processed", "cert-draft",
    "cert-issued", "cert-sent", "cancelled", "postponed", "failed", "no-show",
];

describe("Phase 0 — pipeline revamp migration safety net", () => {
    describe("pipelineVersion field", () => {
        it("defaults to 1 (legacy) — so a field-less existing row is grandfathered; new pickups are set to 2 at creation", () => {
            const p = new Pickup({
                pickupID: "PU-TEST-0001",
                client: new mongoose.Types.ObjectId(),
                status: "requested",
            });
            expect(p.pipelineVersion).toBe(1);
        });
        it("only accepts versions 1 or 2", () => {
            expect(Pickup.schema.path("pipelineVersion").options.enum).toEqual([1, 2]);
        });
    });

    describe("isLegacyPipeline()", () => {
        it("treats v1 / missing / undefined / null as legacy (grandfathered)", () => {
            expect(Pickup.isLegacyPipeline({ pipelineVersion: 1 })).toBe(true);
            expect(Pickup.isLegacyPipeline({})).toBe(true);
            expect(Pickup.isLegacyPipeline({ pipelineVersion: undefined })).toBe(true);
            expect(Pickup.isLegacyPipeline(null)).toBe(true);
        });
        it("treats v2 as NOT legacy", () => {
            expect(Pickup.isLegacyPipeline({ pipelineVersion: 2 })).toBe(false);
        });
    });

    describe("closed-equivalent set (single source of truth)", () => {
        it("stays in sync with reportController.ELIGIBLE_PICKUP_STATUSES (drift guard)", () => {
            expect([...Pickup.CLOSED_EQUIVALENT_STATUSES].sort())
                .toEqual([...ELIGIBLE_PICKUP_STATUSES].sort());
        });
        it("isClosedEquivalent true for completed-ish statuses (incl. v2 'closed')", () => {
            for (const s of ["processed", "cert-draft", "cert-issued", "cert-sent", "closed"]) {
                expect(Pickup.isClosedEquivalent(s)).toBe(true);
            }
        });
        it("isClosedEquivalent false for in-field / terminal statuses", () => {
            for (const s of [
                "requested", "accepted", "scheduled", "en-route", "at-client",
                "picked-up", "at-facility", "weighed", "cancelled", "failed", "no-show",
            ]) {
                expect(Pickup.isClosedEquivalent(s)).toBe(false);
            }
        });
        it("accepts either a status string or a pickup object", () => {
            expect(Pickup.isClosedEquivalent({ status: "cert-sent" })).toBe(true);
            expect(Pickup.isClosedEquivalent({ status: "weighed" })).toBe(false);
        });
    });

    describe("legacy status enum preserved (no accidental removal)", () => {
        it("still contains every legacy status value", () => {
            const enumVals = Pickup.schema.path("status").enumValues;
            for (const s of LEGACY_STATUSES) expect(enumVals).toContain(s);
        });
    });
});
