/*
  Client routes — Admin CRUD for the Client Management module (Phase 1)

  Mounted at /api/admin/clients in server.js.
  All endpoints sit behind the admin `protect` JWT middleware.
*/
const router = require("express").Router();
const { protect } = require("../middleware/authMiddleware");
const c = require("../controllers/clientController");

router.post("/", protect, c.createClient);
router.get("/", protect, c.listClients);
router.get("/:id", protect, c.getClient);
router.patch("/:id", protect, c.updateClient);
router.delete("/:id", protect, c.deleteClient);
// Undo an archive. Restores to 'active', or 'pending-onboarding' if the
// client never finished onboarding — see restoreClient.
router.post("/:id/restore", protect, c.restoreClient);

module.exports = router;
