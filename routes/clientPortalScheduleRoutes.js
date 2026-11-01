/*
  routes/clientPortalScheduleRoutes.js — client recurring pickup schedules.
  Mounted at /api/client/schedules behind protectClient.
*/
const router = require("express").Router();
const { protectClient } = require("../middleware/authClient");
const ctrl = require("../controllers/clientPortalScheduleController");

router.post("/", protectClient, ctrl.createSchedule);
router.get("/", protectClient, ctrl.listMySchedules);
router.patch("/:id/pause", protectClient, ctrl.pauseSchedule);
router.patch("/:id/resume", protectClient, ctrl.resumeSchedule);
router.patch("/:id/cancel", protectClient, ctrl.cancelSchedule);

module.exports = router;
