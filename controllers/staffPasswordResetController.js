/*
  staffPasswordResetController.js — "forgot password" for organisation logins
  (Employee, Manager, Admin).

  Endpoints, one set per role (all public — no session exists yet):
    POST /api/<role>/forgot-password        { email }
    GET  /api/<role>/reset-password/:token   → validate before showing the form
    POST /api/<role>/reset-password         { token, password }

  where <role> is employee | manager | admin.

  Mirrors controllers/clientPasswordResetController.js and shares its
  PasswordResetToken model, so both flows have the same security properties:
  hashed-at-rest tokens, 15-minute lifetime, single use, and older links
  force-expired whenever a new one is issued.

  ── One deliberate difference from the client flow ─────────────────────────
  The client endpoint answers "no account exists with that email" so a customer
  who mistypes their address gets a useful reply. Staff accounts are internal,
  and confirming which addresses are staff would hand an attacker a roster of
  who works here and on which role — so these endpoints return the SAME
  "if that account exists, we've sent a link" response either way. Do not
  "align" the two without revisiting that.

  ── Why sessions end on reset ──────────────────────────────────────────────
  Staff JWTs last 30 days. Before this flow existed, nothing invalidated them,
  so resetting a compromised account left the attacker signed in for up to a
  month. The three staff models now stamp `passwordChangedAt` on save and their
  auth middlewares reject older tokens.
*/

const crypto = require("crypto");

const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");
const PasswordResetToken = require("../models/PasswordResetToken");
const { sendEmail } = require("../utils/emailService");

// Matches the client flow. Short on purpose — a reset link is a live
// account-takeover credential sitting in an inbox.
const RESET_TTL_MS = 15 * 60 * 1000;

const PASSWORD_RULE =
    "Password must be at least 8 characters and include a letter and a number.";

/**
 * Per-role wiring. `portalPath` is the front-end route the emailed link points
 * at; `label` appears in the email so the recipient knows which login it is for.
 */
const ROLES = {
    employee: { Model: Employee, userType: "Employee", portalPath: "employee", label: "Employee" },
    manager: { Model: Manager, userType: "Manager", portalPath: "manager", label: "Manager" },
    admin: { Model: Admin, userType: "Admin", portalPath: "admin", label: "Admin" },
};

const validatePassword = (raw) => {
    if (!raw) return "Password is required";
    const cleaned = String(raw).trim();
    if (cleaned.length < 8) return PASSWORD_RULE;
    if (!/[A-Za-z]/.test(cleaned) || !/[0-9]/.test(cleaned)) return PASSWORD_RULE;
    return null;
};

const hashToken = (raw) =>
    crypto.createHash("sha256").update(String(raw)).digest("hex");

const buildResetLink = (portalPath, token) => {
    const base = process.env.CLIENT_URL || "http://localhost:5173";
    return `${base.replace(/\/+$/, "")}/${portalPath}/reset-password/${token}`;
};

const buildResetEmail = (user, roleLabel, link) => {
    const subject = `Reset your Resrishti ${roleLabel.toLowerCase()} password`;
    const greeting = user.name || "there";

    const text =
        `Hello ${greeting},\n\n` +
        `We received a request to reset the password for your Resrishti ${roleLabel.toLowerCase()} account.\n\n` +
        `Reset your password: ${link}\n\n` +
        `This link expires in 15 minutes and can only be used once.\n\n` +
        `If you didn't request this, you can safely ignore this email — your password will not change. ` +
        `If you keep receiving these, please tell your administrator.\n\n` +
        `Resrishti / GreenEarth Integrated Facility Pvt Ltd`;

    const html = `
<!DOCTYPE html>
<html>
  <head><meta charset="UTF-8" /><title>${subject}</title></head>
  <body style="margin:0;padding:24px;background:#f6f8f7;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;">
      <div style="background:#059669;padding:20px 28px;">
        <h1 style="margin:0;color:#ffffff;font-size:18px;">Reset your password</h1>
      </div>
      <div style="padding:28px;color:#334155;font-size:15px;line-height:1.6;">
        <p style="margin-top:0;">Hello ${greeting},</p>
        <p>We received a request to reset the password for your Resrishti <strong>${roleLabel.toLowerCase()}</strong> account.</p>
        <p style="margin:24px 0;text-align:center;">
          <a href="${link}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 28px;border-radius:8px;">Reset password</a>
        </p>
        <p style="font-size:13px;color:#64748b;">
          This link expires in <strong>15 minutes</strong> and can only be used once.
          If it has expired, you can request a new one from the sign-in page.
        </p>
        <p style="font-size:13px;color:#64748b;">
          If you didn't request this, you can safely ignore this email — your password will not change.
          If you keep receiving these, please tell your administrator.
        </p>
      </div>
      <div style="padding:16px 28px;background:#f1f5f9;font-size:12px;color:#64748b;">
        Resrishti / GreenEarth Integrated Facility Pvt Ltd
      </div>
    </div>
  </body>
</html>`;

    return { subject, text, html };
};

// Identical whether or not the address belongs to a staff account — see header.
const SENT_OK = {
    ok: true,
    message:
        "If that account exists, we've sent a password reset link. Please check your inbox.",
};

/** POST /api/<role>/forgot-password  body: { email } */
const forgotPassword = (roleKey) => async (req, res) => {
    const { Model, userType, portalPath, label } = ROLES[roleKey];
    try {
        const email = String((req.body && req.body.email) || "").trim().toLowerCase();
        if (!email) {
            // An empty field is a client-side mistake, not an enumeration probe.
            return res.status(400).json({ message: "Email is required" });
        }

        const user = await Model.findOne({ email });

        // Unknown address: answer exactly as if it had worked, and send nothing.
        // Returning early here (rather than after a fake delay) is fine because
        // the rate limiter, not response timing, is what bounds probing.
        if (!user) return res.json(SENT_OK);

        // Only the newest link may ever work.
        await PasswordResetToken.updateMany(
            { userType, userId: user._id, usedAt: null },
            { expiresAt: new Date() }
        );

        const rawToken = crypto.randomBytes(32).toString("hex");
        await PasswordResetToken.create({
            userType,
            userId: user._id,
            tokenHash: hashToken(rawToken),
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
            requestedIp: req.ip,
        });

        const { subject, text, html } = buildResetEmail(
            user,
            label,
            buildResetLink(portalPath, rawToken)
        );
        // sendEmail swallows its own failures and returns null, so an SMTP
        // outage surfaces as "sent" here. Acceptable: the user can retry, and
        // the failure is logged by emailService.
        await sendEmail(user.email, subject, text, html);

        return res.json(SENT_OK);
    } catch (err) {
        console.error(`forgotPassword(${roleKey}) error:`, err.message);
        return res.status(500).json({
            message: "Could not send the reset link. Please try again.",
        });
    }
};

/**
 * Resolve a raw token to its live record for this role.
 *
 * Scoped by userType so an employee's token cannot be replayed against the
 * manager or admin reset endpoint.
 */
const resolveToken = async (rawToken, userType) => {
    if (!rawToken || typeof rawToken !== "string") {
        return { status: 404, message: "Invalid reset link" };
    }
    const record = await PasswordResetToken.findOne({
        tokenHash: hashToken(rawToken),
        userType,
    });
    if (!record) return { status: 404, message: "Invalid reset link" };

    // 410 rather than 404 so the UI can distinguish "expired, offer a new link"
    // from "this was never a real link".
    if (record.usedAt) {
        return { status: 410, message: "This reset link has already been used" };
    }
    if (record.expiresAt < new Date()) {
        return { status: 410, message: "This reset link has expired" };
    }
    return { record };
};

/** GET /api/<role>/reset-password/:token */
const verifyResetToken = (roleKey) => async (req, res) => {
    const { Model, userType } = ROLES[roleKey];
    try {
        const { record, status, message } = await resolveToken(req.params.token, userType);
        if (!record) return res.status(status).json({ message });

        const user = await Model.findById(record.userId).select("email name");
        if (!user) return res.status(404).json({ message: "Invalid reset link" });

        return res.json({
            ok: true,
            // Safe to return: holding the token already proves inbox control.
            email: user.email,
            name: user.name,
            expiresAt: record.expiresAt,
        });
    } catch (err) {
        console.error(`verifyResetToken(${roleKey}) error:`, err.message);
        return res.status(500).json({ message: "Could not verify the reset link" });
    }
};

/** POST /api/<role>/reset-password  body: { token, password } */
const resetPassword = (roleKey) => async (req, res) => {
    const { Model, userType } = ROLES[roleKey];
    try {
        const { token, password } = req.body || {};

        const pwError = validatePassword(password);
        if (pwError) return res.status(400).json({ message: pwError });

        const { record, status, message } = await resolveToken(token, userType);
        if (!record) return res.status(status).json({ message });

        const user = await Model.findById(record.userId);
        if (!user) return res.status(404).json({ message: "Invalid reset link" });

        // Assigning the plaintext is correct — the model's pre-save hook trims,
        // hashes, and stamps passwordChangedAt (which is what invalidates
        // sessions on other devices).
        user.password = String(password).trim();
        // Someone who has just chosen their own password is past first-login
        // setup; leaving this true would send them back through the wizard.
        if (user.isFirstLogin === true) user.isFirstLogin = false;
        await user.save();

        // Burn the token only after the password actually saved, so a failure
        // above leaves the link usable for a retry.
        record.usedAt = new Date();
        await record.save();

        // Any other outstanding links are now stale.
        await PasswordResetToken.updateMany(
            { userType, userId: user._id, usedAt: null },
            { expiresAt: new Date() }
        );

        // No JWT is issued here on purpose: the user signs in with the new
        // password, which proves it works and avoids handing a session to
        // whoever opened the link.
        return res.json({
            ok: true,
            message: "Password updated. Please sign in with your new password.",
        });
    } catch (err) {
        console.error(`resetPassword(${roleKey}) error:`, err.message);
        return res.status(500).json({ message: "Could not reset your password" });
    }
};

module.exports = {
    ROLES,
    forgotPassword,
    verifyResetToken,
    resetPassword,
};
