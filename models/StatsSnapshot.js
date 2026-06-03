/*
  StatsSnapshot model — Client Management module (Phase 1, Chunk 3)

  Purpose:
  - Cached, denormalized snapshot of the public-site live-stats numbers.
  - Recomputed every 15 minutes by `services/statsJob.js` and read by the
    public-facing `GET /api/public/stats` endpoint.

  Why a snapshot collection (not an on-the-fly aggregate)?
  - The public endpoint has no auth, must be sub-millisecond, and is hit on
    every marketing-page load. Aggregating Pickup line items + Certificate
    counts + Client counts per request would be wasteful and unbounded.
  - The 15-minute cadence is sufficient for impact numbers — see clientmngmt.md
    §12 and open question 16 (cache TTL).

  Privacy (clientmngmt.md §12.3):
  - This snapshot intentionally contains **aggregate-only** data:
      totalKgDiverted, totalCertsIssued, totalClientsServed, co2eAvoidedKg,
      and a per-stream breakdown.
  - It NEVER stores client names, per-client kg, or any per-pickup detail.
    Industry-level stream breakdowns are deemed non-identifying.

  Document shape:
  - A single document keyed by `key: 'public-live-stats'` is upserted by the
    background job. The unique index on `key` guarantees we never accumulate
    multiple snapshots.
*/
const mongoose = require("mongoose");

const statsSnapshotSchema = new mongoose.Schema(
    {
        // Single canonical key for the public live-stats snapshot. Other keys
        // could be introduced in P2 (e.g., per-month snapshots), so we don't
        // assume it's a singleton at the schema level.
        key: {
            type: String,
            unique: true,
            default: "public-live-stats",
        },

        // Sum of qtyKg across pickup line items whose certs have been issued
        // or sent. Rounded to 2 decimals in the job.
        totalKgDiverted: Number,
        // Count of Certificate docs with status in ['issued', 'sent'].
        totalCertsIssued: Number,
        // Count of Client docs with status 'active'.
        totalClientsServed: Number,
        // Sum of (kg per stream × emission factor). See utils/emissionFactors.js.
        co2eAvoidedKg: Number,

        // Per-stream breakdown sorted desc by kg. _id: false to keep the
        // sub-docs lean — they're write-once-per-recompute, never queried
        // individually.
        byStream: [
            {
                stream: String,
                kg: Number,
                _id: false,
            },
        ],

        // Exposed publicly so the marketing site can render a "Last updated"
        // timestamp and a health-check can alert if the snapshot goes stale
        // (see clientmngmt.md §22 — background job crash mitigation).
        computedAt: Date,
    },
    { timestamps: true }
);

module.exports = mongoose.model("StatsSnapshot", statsSnapshotSchema);
