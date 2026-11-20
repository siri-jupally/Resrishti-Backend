/*
  Device-facing ADMS endpoints for ZKTeco-style fingerprint terminals.

  Mounted at /iclock (outside /api, so no JWT and no /api rate limiter — the
  terminal polls frequently and can't authenticate). Trust is enforced in the
  controller by the device serial-number allowlist.

  The body is tab-delimited text/plain, not JSON, so these routes use their own
  text parser instead of the app's global express.json().
*/
const express = require("express");
const router = express.Router();
const bio = require("../controllers/biometricController");

// Capture the raw request body as a string for any content-type.
const rawText = express.text({ type: () => true, limit: "4mb" });

router.get("/cdata", bio.cdataHandshake);     // registry handshake
router.get("/getrequest", bio.getrequest);     // command poll
router.post("/cdata", rawText, bio.cdataPost); // punch logs (ATTLOG)
router.post("/fdata", rawText, (_req, res) => res.type("text/plain").send("OK")); // file data — ignore
router.get("/ping", (_req, res) => res.type("text/plain").send("OK"));

module.exports = router;
