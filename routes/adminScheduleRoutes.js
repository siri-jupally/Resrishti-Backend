/*
  adminScheduleRoutes.js — admin/coordinator review of recurring schedules.

  Mounted at /api/admin/schedules behind protectTriage (Admin OR
  Manager+canCoordinate). See controllers/adminScheduleController.
*/
const express = require("express");
const router = express.Router();

const { protectTriage } = require("../middleware/authTriage");
const {
    listSchedules,
    approveSchedule,
    rejectSchedule,
    pauseSchedule,
    resumeSchedule,
    cancelSchedule,
} = require("../controllers/adminScheduleController");

router.get("/", protectTriage, listSchedules);
router.patch("/:id/approve", protectTriage, approveSchedule);
router.patch("/:id/reject", protectTriage, rejectSchedule);
// Manage an already-approved schedule.
router.patch("/:id/pause", protectTriage, pauseSchedule);
router.patch("/:id/resume", protectTriage, resumeSchedule);
router.patch("/:id/cancel", protectTriage, cancelSchedule);

module.exports = router;
