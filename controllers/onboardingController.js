/*
  onboardingController — Client Management module (Phase 1)

  Three handlers:
    - resendOnboarding         POST /api/admin/clients/:id/resend-onboarding
    - verifyOnboardingToken    POST /api/client/onboarding/verify
    - completeOnboarding       POST /api/client/onboarding/complete

  Spec: clientmngmt.md §7.1, §7.5, §10.

  Token mechanics (§10.1):
    - 32 bytes of crypto-random hex → 64-char URL-safe token.
    - 7-day expiry. Single-use (`usedAt` flips the moment the client picks
      a password).
    - Resend invalidates all prior unused tokens for the client by force-
      expiring them; we never delete rows synchronously — the TTL index on
      OnboardingToken (§6.2) cleans them up 7 days post-expiry.

  Security (§10.4):
    - Token is the auth on /verify and /complete endpoints — no admin JWT,
      no client JWT, just the link.
    - Returned client snapshot on /verify is intentionally minimal
      (name + contactName + contactEmail) so the user can confirm "yes,
      this is my account" before typing a password.
    - Password rule: ≥8 chars, ≥1 letter, ≥1 number. Whitespace-only is
      rejected; the Client model's pre-save also trims before hashing.
    - On /complete we issue a JWT with `kind: 'client'` so the frontend
      can log the client straight into the portal — no second redirect.

  Email:
    - Inline HTML template (no template engine). Subject + plain-text
      fallback live next to the HTML so future edits keep them in sync.
    - emerald-600 (#059669) on white — matches the brand the marketing
      site already uses.
*/
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const Client = require("../models/Client");
const OnboardingToken = require("../models/OnboardingToken");
const { sendEmail } = require("../utils/emailService");

// 7 days in milliseconds. Used in two places below, so factored out.
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Build the customer-facing onboarding URL.
 * Falls back to localhost so dev environments without CLIENT_URL still work.
 */
const buildOnboardingLink = (token) => {
    const base = process.env.CLIENT_URL || "http://localhost:5173";
    return `${base}/client/onboarding/${token}`;
};

/**
 * Render the welcome email body. Returns { subject, text, html }.
 *
 * Kept simple and inline rather than templated — the email is short and
 * brand-stable enough that pulling in a template engine would be overkill
 * for one message. If we add more transactional emails, factor this into
 * a shared helper.
 */
const buildOnboardingEmail = (client, link) => {
    const subject = "Welcome to Resrishti — finish setting up your account";

    const text = [
        `Hi ${client.contactName || "there"},`,
        ``,
        `Welcome to Resrishti! Click the link below to activate your account and set your password:`,
        link,
        ``,
        `This link is valid for 7 days. If you weren't expecting this email, you can safely ignore it.`,
        ``,
        `— The Resrishti Team`,
    ].join("\n");

    const html = `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:#f6f8f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
            <tr>
              <td style="background:#059669;padding:24px 32px;color:#ffffff;">
                <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;">Resrishti</div>
                <div style="font-size:13px;opacity:0.85;margin-top:2px;">Sustainable waste management</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#0f172a;">Welcome, ${client.contactName || "there"}!</h1>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  Your account for <strong>${client.name}</strong> has been created on the Resrishti client portal.
                  One more step — activate your account and choose a password to get started.
                </p>
                <p style="margin:24px 0;text-align:center;">
                  <a href="${link}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 28px;border-radius:8px;">Activate Account</a>
                </p>
                <p style="margin:0 0 8px;font-size:13px;line-height:1.6;color:#64748b;">
                  This link is valid for <strong>7 days</strong>. After that, ask your Resrishti contact to resend it.
                </p>
                <p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#94a3b8;word-break:break-all;">
                  Button not working? Paste this URL into your browser:<br/>
                  <a href="${link}" style="color:#059669;">${link}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;">
                If you weren't expecting this email, you can safely ignore it. No account will be created without your action.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`.trim();

    return { subject, text, html };
};

/**
 * POST /api/admin/clients/:id/resend-onboarding
 *
 * Generates a fresh onboarding token, invalidates any prior unused ones,
 * and emails the link to the client contact.
 *
 * Refuses to resend if the client is already onboarded — the magic-link
 * flow is only for `pending-onboarding` state. Onboarded clients who lose
 * their password should use the (future) /forgot-password flow.
 */
const resendOnboarding = async (req, res) => {
    try {
        const { id } = req.params;
        const client = await Client.findById(id);
        if (!client) {
            return res.status(404).json({ message: "Client not found" });
        }
        if (client.status !== "pending-onboarding") {
            return res.status(400).json({
                message:
                    "Client has already completed onboarding. Use the password reset flow instead.",
            });
        }

        // Invalidate any prior unused tokens for this client. We force-expire
        // rather than delete so the TTL index can clean up uniformly and any
        // race with an in-flight /verify request will treat the old token as
        // expired (410), not as missing (404).
        await OnboardingToken.updateMany(
            { client: client._id, usedAt: null },
            { expiresAt: new Date() }
        );

        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS);

        await OnboardingToken.create({
            client: client._id,
            token,
            expiresAt,
            createdBy: req.admin && req.admin._id,
        });

        const link = buildOnboardingLink(token);
        const { subject, text, html } = buildOnboardingEmail(client, link);
        // sendEmail swallows its own errors and returns null on failure, so
        // even an SMTP outage won't block the admin from re-clicking later.
        await sendEmail(client.contactEmail, subject, text, html);

        return res.json({ ok: true, expiresAt });
    } catch (err) {
        console.error("resendOnboarding error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};

/**
 * POST /api/client/onboarding/verify
 *
 * Public endpoint (the token IS the auth). Confirms the token is valid and
 * returns a tiny client snapshot so the welcome screen can show
 * "Welcome, <contactName> from <name>" before asking for a password.
 *
 * 404 → token doesn't exist (typo, deleted client).
 * 410 → token exists but is expired or already used.
 */
const verifyOnboardingToken = async (req, res) => {
    try {
        const { token } = req.body || {};
        if (!token || typeof token !== "string") {
            return res.status(400).json({ message: "Token is required" });
        }

        const record = await OnboardingToken.findOne({ token });
        if (!record) {
            return res.status(404).json({ message: "Invalid token" });
        }
        if (record.usedAt || record.expiresAt < new Date()) {
            return res.status(410).json({ message: "Link expired" });
        }

        const client = await Client.findById(record.client).select(
            "name contactName contactEmail"
        );
        if (!client) {
            // Client was deleted after the token was issued.
            return res.status(404).json({ message: "Invalid token" });
        }

        return res.json({
            ok: true,
            client: {
                name: client.name,
                contactName: client.contactName,
                contactEmail: client.contactEmail,
            },
        });
    } catch (err) {
        console.error("verifyOnboardingToken error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};

/**
 * POST /api/client/onboarding/complete
 *
 * Body: { token, password, contactPhone?, gstin?, billingAddress? }
 *
 * Sets the client password, flips status to 'active', optionally updates
 * profile fields the client wanted to tweak, marks the token as used, and
 * issues a JWT so the frontend can drop them straight into the portal.
 *
 * Password rule (§10.4): ≥8 chars, ≥1 letter, ≥1 number. The Client model
 * also trims-before-hash so leading/trailing whitespace can't lock the
 * user out later.
 */
const completeOnboarding = async (req, res) => {
    try {
        const { token, password, contactPhone, gstin, billingAddress } =
            req.body || {};

        if (!token || typeof token !== "string") {
            return res.status(400).json({ message: "Token is required" });
        }
        if (!password || typeof password !== "string") {
            return res.status(400).json({ message: "Password is required" });
        }
        const cleaned = password.trim();
        if (cleaned.length < 8) {
            return res
                .status(400)
                .json({ message: "Password must be at least 8 characters" });
        }
        if (!/[A-Za-z]/.test(cleaned) || !/[0-9]/.test(cleaned)) {
            return res.status(400).json({
                message:
                    "Password must contain at least one letter and one number",
            });
        }

        const record = await OnboardingToken.findOne({ token });
        if (!record) {
            return res.status(404).json({ message: "Invalid token" });
        }
        if (record.usedAt || record.expiresAt < new Date()) {
            return res.status(410).json({ message: "Link expired" });
        }

        // passwordHash is select:false, so we have to ask for it explicitly
        // — Mongoose's pre-save hook needs the doc to have been hydrated with
        // a passwordHash field for the isModified check to work cleanly.
        const client = await Client.findById(record.client).select(
            "+passwordHash"
        );
        if (!client) {
            return res.status(404).json({ message: "Invalid token" });
        }

        // Only a client still awaiting onboarding may complete it. Guards the
        // case where the admin archived (or paused) the client after the invite
        // was sent — without this, finishing onboarding would flip status back
        // to 'active' and undo the admin's action. deleteClient force-expires
        // outstanding tokens too; this covers tokens issued before that existed.
        // 410 (not 403) so the portal's existing dead-link handling applies.
        if (client.status !== "pending-onboarding") {
            return res.status(410).json({ message: "Link expired" });
        }

        // Pre-save hook (Client model) hashes the plain value.
        client.passwordHash = cleaned;
        client.status = "active";
        client.isOnboardingComplete = true;

        if (contactPhone && typeof contactPhone === "string") {
            client.contactPhone = contactPhone.trim();
        }
        if (gstin && typeof gstin === "string") {
            client.gstin = gstin.trim();
        }
        if (billingAddress && typeof billingAddress === "object") {
            // Spread so partial updates are allowed (e.g. just city).
            client.billingAddress = {
                ...(client.billingAddress?.toObject?.() ||
                    client.billingAddress ||
                    {}),
                ...billingAddress,
            };
        }

        await client.save();

        record.usedAt = new Date();
        await record.save();

        const jwtToken = jwt.sign(
            { id: client._id, kind: "client" },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        return res.json({
            ok: true,
            token: jwtToken,
            client: {
                _id: client._id,
                name: client.name,
                contactEmail: client.contactEmail,
            },
        });
    } catch (err) {
        console.error("completeOnboarding error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};

/**
 * Helper: generate a fresh onboarding token for a client and email the magic
 * link. Used by createClient (auto-fires on create) and resendOnboarding.
 *
 * @param {Document} client - hydrated Client mongoose document
 * @param {ObjectId} [adminId] - admin who triggered (for audit trail)
 * @returns {Promise<{ expiresAt: Date, emailSent: boolean }>}
 */
const issueOnboardingToken = async (client, adminId) => {
    await OnboardingToken.updateMany(
        { client: client._id, usedAt: null },
        { expiresAt: new Date() }
    );
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SEVEN_DAYS_MS);
    await OnboardingToken.create({
        client: client._id,
        token,
        expiresAt,
        createdBy: adminId,
    });
    const link = buildOnboardingLink(token);
    const { subject, text, html } = buildOnboardingEmail(client, link);
    const sent = await sendEmail(client.contactEmail, subject, text, html);

    // Dev convenience: print the link so you can complete onboarding without
    // having SMTP configured. Remove or gate by NODE_ENV before production.
    console.log("\n========================================");
    console.log("ONBOARDING LINK (dev) for", client.contactEmail);
    console.log(link);
    console.log("Expires:", expiresAt.toISOString());
    console.log("========================================\n");

    return { expiresAt, emailSent: !!sent };
};

module.exports = {
    resendOnboarding,
    verifyOnboardingToken,
    completeOnboarding,
    issueOnboardingToken,
};
