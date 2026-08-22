/*
  Client portal routes — Client Management module (Phase 1)

  Mounted in server.js at `/api/client`. Coexists with Backend B's
  `/api/client/onboarding` mount — Express matches longer prefixes first,
  so the onboarding sub-router does NOT need to be mounted here.

  Routes:
  - POST /api/client/login → loginClient   (rate-limited centrally in server.js)
  - GET  /api/client/me    → getMe         (protectClient)

  Rate limiting note:
  - There is no `middleware/rateLimiter.js` file in this repo. The login
    limiter is defined inline in `server.js` and applied via the central
    `app.post([...login paths...], loginLimiter)` block. The spec calls for
    5/15min per IP on /api/client/login — that should be added to the same
    central array in server.js. See TODO below.

  TODO(rate-limit):
  - Add `"/api/client/login"` to the central `app.post([...], loginLimiter)`
    array in server.js so this endpoint gets the same brute-force protection
    as the other three login routes (clientmngmt.md §10.4).
*/
const router = require("express").Router();
const { protectClient } = require("../middleware/authClient");
const {
  loginClient,
  getMe,
  getDashboard,
  listMyCertificates,
  downloadMyCertificate,
  listMyReports,
  downloadMyReport,
  listMySites,
} = require("../controllers/clientPortalController");
const {
  forgotPassword,
  verifyResetToken,
  resetPassword,
} = require("../controllers/clientPasswordResetController");

router.post("/login", loginClient);

// Forgot / reset password — PUBLIC by definition (the caller has no session).
// Declared before the protectClient routes below so the middleware ordering
// stays obvious. `forgot-password` is rate-limited centrally in server.js
// alongside the login endpoints.
router.post("/forgot-password", forgotPassword);
router.get("/reset-password/:token", verifyResetToken);
router.post("/reset-password", resetPassword);

router.get("/me", protectClient, getMe);

// Chunk 3 (Backend I) — dashboard KPIs + certificate list + presigned download.
// All three are scoped to req.client._id inside the controller.
router.get("/dashboard", protectClient, getDashboard);
router.get("/certificates", protectClient, listMyCertificates);
router.get("/certificates/:id/download", protectClient, downloadMyCertificate);

// Monthly reports (Environmental Impact + GHG). Only 'sent'/'superseded' are
// ever returned — see CLIENT_VISIBLE_REPORT_STATUSES in the controller.
router.get("/reports", protectClient, listMyReports);
router.get("/reports/:id/download", protectClient, downloadMyReport);

// The client's own buildings, for tagging a pickup request to a site.
router.get("/sites", protectClient, listMySites);

module.exports = router;
