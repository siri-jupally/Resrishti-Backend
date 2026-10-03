/*
  onboardingRoutes — Client Management module (Phase 1)

  Two routers exported from one file because the routes share the same
  controller and lifecycle but mount under two different prefixes:

    - adminRouter   → mounted on /api/admin/clients (admin-protected,
                      shares prefix with Backend A's client CRUD routes)
    - publicRouter  → mounted on /api/client/onboarding (public; the
                      token itself is the auth)

  Spec: clientmngmt.md §7.1 (resend), §7.5 (client portal verify/complete).
*/
const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const { requireOnboardingEnabled } = require("../utils/onboardingFlag");
const ctrl = require("../controllers/onboardingController");

// Admin-side: piggy-backs on the /api/admin/clients prefix that Backend A
// mounts. Keeps the route URL natural (/api/admin/clients/:id/resend-...)
// without forcing both agents to coordinate on the same router file.
// Guarded by the onboarding flag too — no point resending a magic link while
// the completion flow is disabled.
const adminRouter = express.Router();
adminRouter.post("/:id/resend-onboarding", protect, requireOnboardingEnabled, ctrl.resendOnboarding);

// Public client-portal-side: no auth middleware — the magic-link token in
// the body IS the credential. Rate-limiting (if/when needed) should be
// applied at the app level via express-rate-limit on these paths.
// requireOnboardingEnabled is the real enforcement of the temporary disable —
// it 503s verify/complete while CLIENT_ONBOARDING_ENABLED=false. Handlers are
// left fully intact; flip the flag to re-enable.
const publicRouter = express.Router();
publicRouter.post("/verify", requireOnboardingEnabled, ctrl.verifyOnboardingToken);
publicRouter.post("/complete", requireOnboardingEnabled, ctrl.completeOnboarding);

module.exports = { adminRouter, publicRouter };
