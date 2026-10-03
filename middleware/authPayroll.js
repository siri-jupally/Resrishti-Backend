/*
  authPayroll.js — who may touch payroll.

  Three middlewares, because the module's whole control model is that
  preparing and approving are different jobs:

    protectPayroll   — an accountant or an admin. Reading a register, listing
                       profiles, seeing a draft run.
    protectPreparer  — whoever may prepare and calculate. The accountant, and
                       the admin when the office runs single-approver.
    protectApprover  — admin only. Approving, locking and reopening a run, and
                       setting people's pay.

  A payroll token carries `kind: "accountant"` so it can never be replayed
  against an admin endpoint, and vice versa — the same defence the client
  portal uses.
*/
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Accountant = require("../models/Accountant");
const { getSettings } = require("../utils/payrollDefaults");

const bearer = (req) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    return header.split(" ")[1];
};

const stale = (user, decoded) =>
    user.passwordChangedAt &&
    decoded.iat &&
    decoded.iat * 1000 < user.passwordChangedAt.getTime();

/**
 * Resolve whoever is calling into req.admin or req.accountant.
 * Returns null when the token is no good.
 */
const resolveActor = async (req) => {
    const token = bearer(req);
    if (!token) return null;

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return null;
    }
    if (!decoded?.id) return null;

    // A client-portal token must never reach payroll.
    if (decoded.kind === "client") return null;

    if (decoded.kind === "accountant") {
        const accountant = await Accountant.findById(decoded.id).select("-password");
        if (!accountant || !accountant.isActive) return null;
        if (stale(accountant, decoded)) return { expired: true };
        req.accountant = accountant;
        return { role: "accountant" };
    }

    const admin = await Admin.findById(decoded.id).select("-password");
    if (!admin) return null;
    if (stale(admin, decoded)) return { expired: true };
    req.admin = admin;
    return { role: "admin" };
};

const deny = (res, actor) =>
    actor?.expired
        ? res.status(401).json({
              message:
                  "Session expired because the password was changed. Please sign in again.",
          })
        : res.status(401).json({ message: "Not authorized" });

/** Anyone with payroll access: accountant or admin. */
const protectPayroll = async (req, res, next) => {
    const actor = await resolveActor(req);
    if (!actor?.role) return deny(res, actor);
    return next();
};

/**
 * Whoever may prepare a run. Always the accountant. The admin too, but only
 * when the office has chosen single-approver — under maker–checker the admin
 * approves, and letting them also prepare would collapse the control.
 */
const protectPreparer = async (req, res, next) => {
    const actor = await resolveActor(req);
    if (!actor?.role) return deny(res, actor);
    if (actor.role === "accountant") return next();

    const settings = await getSettings();
    if (settings.approvalDepth === "single") return next();

    return res.status(403).json({
        message:
            "Under maker–checker an admin approves payroll rather than preparing it. Ask the accountant to prepare this run, or switch payroll to single-approver in settings.",
    });
};

/** Approving, locking, reopening, and setting what people are paid. */
const protectApprover = async (req, res, next) => {
    const actor = await resolveActor(req);
    if (!actor?.role) return deny(res, actor);
    if (actor.role === "admin") return next();
    return res.status(403).json({
        message: "Only an admin can approve or lock payroll.",
    });
};

module.exports = { protectPayroll, protectPreparer, protectApprover, resolveActor };
