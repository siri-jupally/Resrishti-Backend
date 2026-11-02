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
} = require("../controllers/adminScheduleController");

router.get("/", protectTriage, listSchedules);
router.patch("/:id/approve", protectTriage, approveSchedule);
router.patch("/:id/reject", protectTriage, rejectSchedule);

module.exports = router;
