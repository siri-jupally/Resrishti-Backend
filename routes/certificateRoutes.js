/*
  routes/certificateRoutes.js — Manager/Coordinator certificate workflow.

  Mounted at /api/manager/certificates in server.js.

  All routes are guarded by `protectTriage` (Admin OR Manager+canCoordinate),
  the same composite middleware used by /api/admin/pickups. The reasoning
  (see clientmngmt.md §4 permission matrix) is that Admins and Coordinator-
  tagged Managers BOTH have cert review/issue/send authority. Re-using the
  middleware avoids parallel route trees.

  See controllers/certificateController.js for handler bodies.
*/
const router = require("express").Router();
const { protectTriage } = require("../middleware/authTriage");
const ctrl = require("../controllers/certificateController");

router.get("/", protectTriage, ctrl.listCertificates);
router.get("/:id", protectTriage, ctrl.getCertificate);
router.patch("/:id/issue", protectTriage, ctrl.issueCertificate);
router.post("/:id/send", protectTriage, ctrl.sendCertificate);
router.post("/:id/revise", protectTriage, ctrl.reviseCertificate);

module.exports = router;
