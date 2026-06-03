/*
  Public stats routes — Client Management module (Phase 1, Chunk 3)

  Mounted in server.js at `/api/public`. Single endpoint:

    GET /api/public/stats → getPublicStats

  No auth — the marketing site fetches this on every `/impact` page load.
  Privacy guarantees live at the StatsSnapshot model + controller level
  (see clientmngmt.md §12.3): aggregate-only, no client-identifying data.

  HTTP caching:
  - The controller sets `Cache-Control: public, max-age=900` (matching the
    15-minute background recompute cadence). Don't add per-route caching
    middleware here — keeping the cache TTL co-located with the controller
    makes the contract obvious.
*/
const router = require("express").Router();
const { getPublicStats } = require("../controllers/publicStatsController");

router.get("/stats", getPublicStats);

module.exports = router;
