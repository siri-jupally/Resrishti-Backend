/*
  Stats job — Client Management module (Phase 1, Chunk 3)

  Purpose:
  - Background job that recomputes the public-site live-stats snapshot every
    15 minutes (see clientmngmt.md §12.1) and upserts it into the single
    `StatsSnapshot` document keyed by `'public-live-stats'`.

  Eligibility:
  - Every COMPLETED pickup counts toward the public total, whether or not a
    certificate was ever issued (P3 — impact decoupled from cert issuance). The
    set is Pickup.CLOSED_EQUIVALENT_STATUSES (processed + cert stages for v1,
    "closed" for v2), the same set the monthly Impact report uses. Pickups still
    in the pipeline are excluded because their weights aren't finalized yet.

  Privacy (clientmngmt.md §12.3):
  - The snapshot only contains aggregate numbers + a per-stream kg breakdown.
    No client names, no per-pickup detail. The per-stream breakdown is
    deemed industry-level info, not client-identifying.

  Failure handling:
  - The setInterval callback swallows + logs errors so a transient Mongo
    blip never crashes the server. The boot-time invocation is fire-and-forget
    for the same reason — the next 15-min tick will retry.
  - `unref()` on the timer handle ensures `process.exit()` from a script
    isn't blocked by a pending interval.
*/
const Pickup = require("../models/Pickup");
const Certificate = require("../models/Certificate");
const Client = require("../models/Client");
const StatsSnapshot = require("../models/StatsSnapshot");
const { co2eForLineItems } = require("../utils/emissionFactors");

/**
 * Compute the snapshot once and upsert it. Safe to call manually (admin
 * "Recompute Now" button, tests, scripts). Idempotent.
 */
const computePublicStats = async () => {
    // Every completed pickup counts toward public stats (P3 — impact decoupled
    // from cert issuance). Still-in-flight pickups are excluded because their
    // weights aren't finalized yet. Shared set keeps this in lock-step with the
    // monthly Impact report and the client dashboard.
    const eligiblePickups = await Pickup.find({
        status: { $in: Pickup.CLOSED_EQUIVALENT_STATUSES },
    })
        .select("lineItems")
        .lean();

    // Roll up kg per stream and running total in a single pass. Map preserves
    // insertion order which we don't depend on (we sort below).
    const byStreamMap = new Map();
    let totalKg = 0;
    for (const p of eligiblePickups) {
        for (const li of p.lineItems || []) {
            const stream = li.stream;
            const kg = Number(li.qtyKg) || 0;
            byStreamMap.set(stream, (byStreamMap.get(stream) || 0) + kg);
            totalKg += kg;
        }
    }

    // Sorted desc by kg so the marketing site can render a "top streams" bar
    // chart without re-sorting client-side. Rounded to 2dp for a clean UI.
    const byStream = Array.from(byStreamMap.entries())
        .map(([stream, kg]) => ({ stream, kg: Math.round(kg * 100) / 100 }))
        .sort((a, b) => b.kg - a.kg);

    // Counts are independent of the per-stream aggregation so they live as
    // separate count queries (cheaper than another full aggregate).
    const totalCerts = await Certificate.countDocuments({
        status: { $in: ["issued", "sent"] },
    });
    const totalClients = await Client.countDocuments({ status: "active" });

    // Pass per-stream totals (not raw line items) into the CO₂e helper —
    // the multiplier is linear so this is mathematically equivalent and
    // avoids re-iterating eligiblePickups.
    const co2e = co2eForLineItems(
        Array.from(byStreamMap.entries()).map(([stream, kg]) => ({
            stream,
            qtyKg: kg,
        }))
    );

    await StatsSnapshot.findOneAndUpdate(
        { key: "public-live-stats" },
        {
            totalKgDiverted: Math.round(totalKg * 100) / 100,
            totalCertsIssued: totalCerts,
            totalClientsServed: totalClients,
            co2eAvoidedKg: Math.round(co2e * 100) / 100,
            byStream,
            computedAt: new Date(),
        },
        { upsert: true, new: true }
    );
};

// Module-level handle so startStatsJob is idempotent — calling it twice in
// the same process (e.g., during tests or hot reload) is a no-op.
let _intervalHandle = null;

/**
 * Wire the recurring 15-min job. Called from server.js after `app.listen`.
 * Best-effort boot computation so the very first request after deploy
 * doesn't see the safe-defaults fallback.
 */
const startStatsJob = () => {
    if (_intervalHandle) return;
    // Compute once on boot (best-effort — swallow errors so the server stays up).
    computePublicStats().catch((err) =>
        console.error("Stats job (boot) error:", err.message)
    );
    _intervalHandle = setInterval(() => {
        computePublicStats().catch((err) =>
            console.error("Stats job error:", err.message)
        );
    }, 15 * 60 * 1000);
    // Don't keep the process alive solely for this timer — important for
    // scripts that import server.js and expect a clean process.exit().
    _intervalHandle.unref();
};

/**
 * Stop the recurring job. Mainly for tests and graceful shutdown.
 */
const stopStatsJob = () => {
    if (_intervalHandle) {
        clearInterval(_intervalHandle);
        _intervalHandle = null;
    }
};

module.exports = { computePublicStats, startStatsJob, stopStatsJob };
