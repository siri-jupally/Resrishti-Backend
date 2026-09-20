/*
  managementDashboardRoutes.js — operational KPIs for the admin dashboard.

  Mounted at /api/admin/dashboard (see server.js), behind protectTriage so a
  coordinator-tagged manager sees the same picture as an admin.
*/
const express = require("express");
const router = express.Router();

const { protectTriage } = require("../middleware/authTriage");
const { getOverview } = require("../controllers/managementDashboardController");

router.get("/overview", protectTriage, getOverview);

module.exports = router;
