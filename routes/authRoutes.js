/*
  Unified staff auth — one door for admin / manager / employee.

  Mounted at /api/auth. Public (no session exists yet). Rate limiting lives in
  server.js: /api/auth/login shares loginLimiter with the per-portal logins, and
  /api/auth/forgot-password shares passwordResetLimiter. The per-portal /login
  and reset routes stay in place, so nothing existing breaks.
*/
const express = require("express");
const router = express.Router();
const { unifiedLogin, unifiedForgotPassword } = require("../controllers/authController");

router.post("/login", unifiedLogin);
router.post("/forgot-password", unifiedForgotPassword);

module.exports = router;
