/*
  Emission factors — Client Management module (Phase 1, Chunk 3)

  Purpose:
  - Source of truth for the per-stream "kg CO₂e avoided per kg recycled"
    multipliers used to compute the public site's `co2eAvoidedKg` metric.
  - Hard-coded in Phase 1 (see clientmngmt.md §12.1, open question 17). In
    Phase 2 these become editable from an admin settings screen — exporting
    them as a plain object now makes that swap a one-file change later.

  Numbers:
  - Sourced from the table in clientmngmt.md §12.1. They're directional
    placeholders pending a senior decision; the marketing site's "About these
    numbers" footer should note the methodology when it ships.

  Fallback:
  - `0.5` is used for any stream not in the table (defensive — the Pickup
    enum can grow without breaking the job).
*/

// kg CO₂e avoided per kg of recycled material.
const FACTORS = {
    plastic: 1.5,
    paper: 0.94,
    ewaste: 1.44,
    biomedical: 1.1,
    "foam-thermocol": 0.6,
    "dry-waste": 0.4,
    agr: 0.3,
    battery: 1.2,
    "expired-food": 0.5,
    hazardous: 1.6,
    other: 0.5,
};

/**
 * Sum CO₂e across an array of line items.
 *
 * Defensive about input shape (the stats job calls it with the per-stream
 * aggregation output, but it's reused for the client dashboard too):
 *   - Tolerates null/undefined input → returns 0.
 *   - Tolerates missing qtyKg → treats as 0.
 *   - Unknown streams fall back to 0.5 (see header).
 *
 * @param {Array<{stream: string, qtyKg: number}>} lineItems
 * @returns {number}
 */
const co2eForLineItems = (lineItems) =>
    (lineItems || []).reduce((sum, li) => {
        const f = FACTORS[li.stream] ?? 0.5;
        return sum + (li.qtyKg || 0) * f;
    }, 0);

module.exports = { FACTORS, co2eForLineItems };
