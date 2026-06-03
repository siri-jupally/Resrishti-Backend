/*
  adminPickupRoutes.js — admin/coordinator pickup triage routes.

  Mounted at /api/admin/pickups (see server.js). All routes pass through
  `protectTriage`, which accepts either an Admin token or a Manager
  token whose user has `canCoordinate: true` — see middleware/authTriage.js.

  Spec: clientmngmt.md §7.2.
*/
const express = require("express");
const router = express.Router();

const { protectTriage } = require("../middleware/authTriage");
const {
    listPickups,
    getPickup,
    acceptPickup,
    rejectPickup,
    reassignSupervisor,
    cancelPickup,
    getSupervisorPool,
} = require("../controllers/adminPickupController");

// Supervisor pool — declared BEFORE the /:id routes so Express doesn't
// route a literal `supervisor-pool` segment into the :id param handler.
// Note: the pool is also reached at /api/admin/supervisor-pool via a
// dedicated mount line in server.js, but exposing it here too means a
// client only needs to know the /pickups base path.
router.get("/supervisor-pool", protectTriage, getSupervisorPool);

router.get("/", protectTriage, listPickups);
router.get("/:id", protectTriage, getPickup);

router.patch("/:id/accept", protectTriage, acceptPickup);
router.patch("/:id/reject", protectTriage, rejectPickup);
router.patch("/:id/reassign-supervisor", protectTriage, reassignSupervisor);
router.patch("/:id/cancel", protectTriage, cancelPickup);

module.exports = router;
