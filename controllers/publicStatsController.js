/*
  Public stats controller — Client Management module (Phase 1, Chunk 3)

  Purpose:
  - Powers `GET /api/public/stats`, the unauthenticated endpoint consumed by
    the marketing site's `/impact` page (and the homepage hero strip).
  - Reads the cached `StatsSnapshot` document — NEVER aggregates on the fly.
    The recompute happens in `services/statsJob.js` every 15 minutes.

  Caching:
  - We set `Cache-Control: public, max-age=900` (15 minutes) so CDNs and
    intermediate caches can satisfy duplicate requests without hitting Mongo.
    The TTL matches the recompute cadence — no point caching past the next
    refresh.

  Safe-defaults on cold-start:
  - On a brand-new deploy the background job may not have run yet. Instead
    of returning 404 (which the frontend would have to special-case), we
    return zeros with `fresh: false` so the impact page renders cleanly
    with "no data yet" copy.

  Privacy (clientmngmt.md §12.3):
  - The response is intentionally aggregate-only. No client names, no per-
    pickup detail. The StatsSnapshot model is the privacy boundary.
*/
const StatsSnapshot = require("../models/StatsSnapshot");

// GET /api/public/stats — no auth.
const getPublicStats = async (req, res) => {
    try {
        const snap = await StatsSnapshot.findOne({
            key: "public-live-stats",
        }).lean();

        if (!snap) {
            // First deploy / job hasn't run yet — return safe zeros with
            // `fresh: false` so the frontend can render a "no data yet"
            // state without bespoke 404 handling.
            return res.json({
                totalKgDiverted: 0,
                totalCertsIssued: 0,
                totalClientsServed: 0,
                co2eAvoidedKg: 0,
                byStream: [],
                computedAt: null,
                fresh: false,
            });
        }

        // Match the recompute cadence (15 min). CDNs and browser caches can
        // safely satisfy duplicate requests within this window.
        res.setHeader("Cache-Control", "public, max-age=900");

        return res.json({
            totalKgDiverted: snap.totalKgDiverted ?? 0,
            totalCertsIssued: snap.totalCertsIssued ?? 0,
            totalClientsServed: snap.totalClientsServed ?? 0,
            co2eAvoidedKg: snap.co2eAvoidedKg ?? 0,
            byStream: snap.byStream || [],
            computedAt: snap.computedAt || null,
            fresh: true,
        });
    } catch (err) {
        console.error("getPublicStats error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = { getPublicStats };
