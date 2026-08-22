/*
  clientPasswordResetController.js — "forgot password" for the client portal.

  Endpoints (all public — mounted before protectClient):
    POST /api/client/forgot-password        { email }
    GET  /api/client/reset-password/:token  → validate before showing the form
    POST /api/client/reset-password         { token, password }

  Mirrors the onboarding magic-link mechanics (crypto.randomBytes(32) → hex,
  single-use, prior tokens force-expired on re-request) with a 15-minute
  lifetime and a hashed-at-rest token. See models/PasswordResetToken.js.

  Unknown-address behaviour (product decision):
  - This endpoint tells the caller when an email is not registered, so a client
    who mistypes their address gets a useful answer instead of silently waiting
    for mail that will never arrive.
  - The trade-off, accepted deliberately: it confirms which addresses are
    customers, so anyone can probe for your client list. Note this differs from
    /login, which still returns a generic `Invalid credentials` for both "no
    such client" and "wrong password" — don't "align" the two without
    revisiting this decision.
  - Because that check is now free, the rate limiter is the only thing bounding
    bulk probing, so it is keyed on IP alone rather than IP+email (see
    passwordResetLimiter in server.js). Keying on the email would hand an
    attacker a fresh budget for every address they guessed.
*/

const crypto = require("crypto");

const Client = require("../models/Client");
const PasswordResetToken = require("../models/PasswordResetToken");
const { sendEmail } = require("../utils/emailService");

// Chosen deliberately short: a reset link is a live account-takeover
// credential sitting in an inbox. The UI offers a one-click "send me a new
// link" on the expired screen, since 15 minutes means expiry is a normal
// outcome rather than an edge case.
const RESET_TTL_MS = 15 * 60 * 1000;

const PASSWORD_RULE =
    "Password must be at least 8 characters and include a letter and a number.";

/** Same rule as onboarding (clientmngmt.md §10.4). */
const validatePassword = (raw) => {
    if (!raw) return "Password is required";
    const cleaned = String(raw).trim();
    if (cleaned.length < 8) return PASSWORD_RULE;
    if (!/[A-Za-z]/.test(cleaned) || !/[0-9]/.test(cleaned)) return PASSWORD_RULE;
    return null;
};

const hashToken = (raw) =>
    crypto.createHash("sha256").update(String(raw)).digest("hex");

const buildResetLink = (token) => {
    const base = process.env.CLIENT_URL || "http://localhost:5173";
    return `${base.replace(/\/+$/, "")}/client/reset-password/${token}`;
};

const buildResetEmail = (client, link) => {
    const subject = "Reset your Resrishti client portal password";
    const text =
        `Hello ${client.contactName || client.name},\n\n` +
        `We received a request to reset the password for your Resrishti client portal account.\n\n` +
        `Reset your password: ${link}\n\n` +
        `This link expires in 15 minutes and can only be used once.\n\n` +
        `If you didn't request this, you can safely ignore this email — your password will not change.\n\n` +
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
        <p style="margin-top:0;">Hello ${client.contactName || client.name},</p>
        <p>We received a request to reset the password for your Resrishti client portal account.</p>
        <p style="margin:24px 0;text-align:center;">
          <a href="${link}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 28px;border-radius:8px;">Reset password</a>
        </p>
        <p style="font-size:13px;color:#64748b;">
          This link expires in <strong>15 minutes</strong> and can only be used once.
          If it has expired, you can request a new one from the sign-in page.
        </p>
        <p style="font-size:13px;color:#64748b;">
          If you didn't request this, you can safely ignore this email — your password will not change.
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

const SENT_OK = {
    ok: true,
    message: "We've sent a password reset link. Please check your inbox.",
};

/**
 * POST /api/client/forgot-password
 * body: { email }
 */
const forgotPassword = async (req, res) => {
    try {
        const email = String((req.body && req.body.email) || "").trim().toLowerCase();
        if (!email) {
            // The one case we DO reject outright: an empty field is a client-side
            // mistake, not an enumeration probe.
            return res.status(400).json({ message: "Email is required" });
        }

        const client = await Client.findOne({ contactEmail: email });

        if (!client) {
            return res.status(404).json({
                code: "not_registered",
                message:
                    "No account exists with that email address. Please check the spelling, or contact us if you think this is a mistake.",
            });
        }

        // An archived client keeps their record and password but must not be
        // able to get back in. Treated as not registered rather than given a
        // reset link that would land them on "Account inactive" after signing
        // in — and deliberately NOT told they were archived.
        if (client.status === "churned") {
            return res.status(404).json({
                code: "not_registered",
                message:
                    "No account exists with that email address. Please check the spelling, or contact us if you think this is a mistake.",
            });
        }

        // The account exists but has no password yet — they never completed
        // onboarding. A reset link would be useless; the invite link is what
        // they actually need, so say so.
        if (!client.isOnboardingComplete) {
            return res.status(409).json({
                code: "not_onboarded",
                message:
                    "This account hasn't been set up yet. Please use the link in your welcome email to choose a password, or contact us to have it resent.",
            });
        }

        // Only the newest link may ever work.
        await PasswordResetToken.updateMany(
            { client: client._id, usedAt: null },
            { expiresAt: new Date() }
        );

        const rawToken = crypto.randomBytes(32).toString("hex");
        await PasswordResetToken.create({
            client: client._id,
            tokenHash: hashToken(rawToken),
            expiresAt: new Date(Date.now() + RESET_TTL_MS),
            requestedIp: req.ip,
        });

        const { subject, text, html } = buildResetEmail(
            client,
            buildResetLink(rawToken)
        );
        // sendEmail swallows its own failures and returns null, so an SMTP
        // outage surfaces as "sent" here. Acceptable: the client can retry, and
        // the failure is logged by emailService.
        await sendEmail(client.contactEmail, subject, text, html);

        return res.json(SENT_OK);
    } catch (err) {
        console.error("forgotPassword error:", err.message);
        return res.status(500).json({
            message: "Could not send the reset link. Please try again.",
        });
    }
};

/**
 * Resolve a raw token to its live record.
 * @returns {{record?: Object, status?: number, message?: string}}
 */
const resolveToken = async (rawToken) => {
    if (!rawToken || typeof rawToken !== "string") {
        return { status: 404, message: "Invalid reset link" };
    }
    const record = await PasswordResetToken.findOne({
        tokenHash: hashToken(rawToken),
    });
    if (!record) return { status: 404, message: "Invalid reset link" };

    // 410 rather than 404 so the UI can distinguish "expired, offer a new
    // link" from "this was never a real link".
    if (record.usedAt) {
        return { status: 410, message: "This reset link has already been used" };
    }
    if (record.expiresAt < new Date()) {
        return { status: 410, message: "This reset link has expired" };
    }
    return { record };
};

/**
 * GET /api/client/reset-password/:token
 *
 * Lets the page check the link BEFORE showing a password form, so an expired
 * link doesn't waste the client's time typing a password twice first.
 */
const verifyResetToken = async (req, res) => {
    try {
        const { record, status, message } = await resolveToken(req.params.token);
        if (!record) return res.status(status).json({ message });

        const client = await Client.findById(record.client).select("contactEmail name");
        if (!client) return res.status(404).json({ message: "Invalid reset link" });

        return res.json({
            ok: true,
            // Shown as a "you're resetting the password for…" confirmation.
            // Safe to return: holding the token already proves inbox control.
            email: client.contactEmail,
            expiresAt: record.expiresAt,
        });
    } catch (err) {
        console.error("verifyResetToken error:", err.message);
        return res.status(500).json({ message: "Could not verify the reset link" });
    }
};

/**
 * POST /api/client/reset-password
 * body: { token, password }
 */
const resetPassword = async (req, res) => {
    try {
        const { token, password } = req.body || {};

        const pwError = validatePassword(password);
        if (pwError) return res.status(400).json({ message: pwError });

        const { record, status, message } = await resolveToken(token);
        if (!record) return res.status(status).json({ message });

        const client = await Client.findById(record.client);
        if (!client) return res.status(404).json({ message: "Invalid reset link" });

        // Assigning the plaintext is correct — the Client pre-save hook trims,
        // hashes, and stamps passwordChangedAt (which is what invalidates
        // sessions on other devices).
        client.passwordHash = String(password).trim();
        await client.save();

        // Burn the token only after the password actually saved, so a failure
        // above leaves the link usable for a retry.
        record.usedAt = new Date();
        await record.save();

        // Any other outstanding links are now stale.
        await PasswordResetToken.updateMany(
            { client: client._id, usedAt: null },
            { expiresAt: new Date() }
        );

        // No JWT is issued here on purpose: the client is sent back to sign in
        // with the new password. That proves the password works, and avoids
        // handing a session to whoever opened the link.
        return res.json({
            ok: true,
            message: "Password updated. Please sign in with your new password.",
        });
    } catch (err) {
        console.error("resetPassword error:", err.message);
        return res.status(500).json({ message: "Could not reset your password" });
    }
};

module.exports = { forgotPassword, verifyResetToken, resetPassword };
