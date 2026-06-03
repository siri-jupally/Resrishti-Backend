/*
  Supervisor Pickup Routes — Client Management module (Phase 1, Chunk 2)

  Purpose:
  - Mounts the supervisor field-execution endpoints under each of the three
    role prefixes (employee / manager / admin). Any user with `canSupervise:
    true` can advance pickups assigned to them — regardless of their base role.

  Pattern:
  - This module exports a FACTORY function that takes a role-specific auth
    middleware and returns a fresh Express router. server.js calls it three
    times with `protectEmployee`, `protectManager`, and `protect` (admin).
    The controller (`controllers/supervisorPickupController.js`) reads
    whichever of req.employee / req.manager / req.admin the middleware set.

  Routes returned by each factory call:
  - GET    /                 → listMyPickups (mine, by supervisor.userId)
  - PATCH  /:id/status       → updatePickupStatus (multipart 'photo' field)
  - POST   /:id/waste-data   → recordWasteData (multipart 'weighbridgePhoto'
                               optional; advances weighed → processed →
                               cert-draft and creates the draft Certificate).
*/

const express = require("express");
const ctrl = require("../controllers/supervisorPickupController");

/**
 * @param {Function} roleAuth - auth middleware that populates req.employee /
 *                              req.manager / req.admin on the request.
 * @returns {express.Router}
 */
const factory = (roleAuth) => {
    const r = express.Router();
    r.get("/", roleAuth, ctrl.listMyPickups);
    // The multer middleware (ctrl.upload) parses the multipart form before
    // updatePickupStatus runs. Photo field name must be 'photo'.
    r.patch("/:id/status", roleAuth, ctrl.upload, ctrl.updatePickupStatus);
    // Waste-data submission. Multer parses multipart and optionally lifts a
    // file off the `weighbridgePhoto` field. lineItems arrives as a JSON
    // string in req.body (multipart can't carry arrays natively).
    r.post("/:id/waste-data", roleAuth, ctrl.wasteDataUpload, ctrl.recordWasteData);
    return r;
};

module.exports = factory;
