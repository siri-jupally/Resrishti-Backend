/*
  Client portal — Pickup routes (Phase 1, §7.5)

  Mounted in server.js at /api/client/pickups. All routes are protected by
  protectClient (middleware/authClient.js), which:
   - rejects non-client JWTs (kind !== 'client'),
   - rejects inactive clients (status !== 'active'),
   - attaches `req.client`.

  Note this mount path is more specific than `/api/client` (where the portal
  shell — login, me — is mounted). Express matches longer prefixes first, so
  the two routers coexist without conflict, same arrangement as the
  /api/client/onboarding sub-router from Backend B.
*/
const router = require("express").Router();
const { protectClient } = require("../middleware/authClient");
const ctrl = require("../controllers/clientPortalPickupController");

router.post("/", protectClient, ctrl.requestPickup);
router.get("/", protectClient, ctrl.listMyPickups);
router.get("/:id", protectClient, ctrl.getMyPickup);
router.patch("/:id/cancel", protectClient, ctrl.cancelMyPickup);

module.exports = router;
