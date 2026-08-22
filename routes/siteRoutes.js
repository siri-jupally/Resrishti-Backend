/*
  routes/siteRoutes.js — Admin CRUD for client Sites (buildings / branches).

  Mounted at /api/admin/sites in server.js, behind the admin `protect` JWT
  middleware. Sites are org-structure data, so this stays admin-only rather
  than using protectTriage.

  See controllers/siteController.js for handler bodies.
*/
const router = require("express").Router();
const { protect } = require("../middleware/authMiddleware");
const c = require("../controllers/siteController");

router.get("/", protect, c.listSites);
router.post("/", protect, c.createSite);
router.get("/:id", protect, c.getSite);
router.patch("/:id", protect, c.updateSite);
router.delete("/:id", protect, c.deleteSite);

module.exports = router;
