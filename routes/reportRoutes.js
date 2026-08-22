/*
  routes/reportRoutes.js — Manager/Coordinator monthly report workflow.

  Mounted at /api/manager/reports in server.js.

  Guarded by `protectTriage` (Admin OR Manager+canCoordinate) — the same gate
  as /api/manager/certificates, because the same people who review and release
  a Certificate of Disposal review and release the monthly reports.

  Route ordering note: `/preview` and `/generate` are declared BEFORE `/:id`.
  Express matches in declaration order, so a `/:id` declared first would
  swallow "preview" as an id and 400 on the ObjectId check.

  See controllers/reportController.js for handler bodies.
*/
const router = require("express").Router();
const { protectTriage } = require("../middleware/authTriage");
const ctrl = require("../controllers/reportController");

// Static paths first — see header.
router.get("/preview", protectTriage, ctrl.previewReport);
router.get("/clients", protectTriage, ctrl.listReportableClients);
router.post("/generate", protectTriage, ctrl.generateReport);

router.get("/", protectTriage, ctrl.listReports);
router.get("/:id", protectTriage, ctrl.getReport);
router.patch("/:id/issue", protectTriage, ctrl.issueReport);
router.post("/:id/send", protectTriage, ctrl.sendReport);
router.post("/:id/revise", protectTriage, ctrl.reviseReport);

module.exports = router;
