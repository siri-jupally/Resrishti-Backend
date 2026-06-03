/*
  authTriage.js — composite auth middleware for pickup triage endpoints.

  Purpose:
  - The Client Management module (spec §4) gives BOTH Admins and Managers
    with `canCoordinate: true` access to the pickup triage endpoints.
  - Rather than mounting each route twice (once under `/api/admin`, once
    under `/api/manager`) with parallel controllers, we expose a single
    `/api/admin/pickups` surface and accept either credential here.

  Behavior:
  - Verifies a Bearer JWT against `process.env.JWT_SECRET`.
  - Rejects client-portal tokens (kind === 'client') immediately.
  - Tries to resolve the token's `id` first against the Admin collection;
    if no Admin matches, falls back to Manager and requires `canCoordinate`.
  - On success, exposes `req.admin` OR `req.manager` (mirroring the
    existing `protect` / `protectManager` shape so downstream controllers
    can use the same patterns).
  - On failure: 401 for bad/missing/expired token, 403 when the user
    exists but lacks triage permission.
*/
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");

const protectTriage = async (req, res, next) => {
    const bearer = req.headers.authorization;
    if (!bearer || !bearer.startsWith("Bearer ")) {
        return res.status(401).json({ message: "Not authorized, no token" });
    }

    const token = bearer.split(" ")[1];
    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        return res.status(401).json({ message: "Not authorized" });
    }

    // Defense-in-depth: client-portal tokens MUST NOT cross over into
    // internal endpoints, even if a client's _id collided with an admin's.
    if (decoded && decoded.kind === "client") {
        return res.status(401).json({ message: "Not authorized" });
    }

    if (!decoded || !decoded.id) {
        return res.status(401).json({ message: "Not authorized" });
    }

    try {
        // Admins first — they unconditionally have triage rights.
        const admin = await Admin.findById(decoded.id).select("-password");
        if (admin) {
            req.admin = admin;
            return next();
        }

        // Fall back to Manager, but only if they're coordinator-tagged.
        const manager = await Manager.findById(decoded.id).select("-password");
        if (manager) {
            if (!manager.canCoordinate) {
                return res.status(403).json({
                    message: "Not authorized to triage pickups",
                });
            }
            req.manager = manager;
            return next();
        }

        return res.status(401).json({ message: "Not authorized" });
    } catch (err) {
        console.error("protectTriage error:", err);
        return res.status(401).json({ message: "Not authorized" });
    }
};

module.exports = { protectTriage };
