const nodemailer = require("nodemailer");

/*
  Auth modes, resolved per send in getTransporter():

  1. OAuth2 (client credentials) — used when M365_TENANT_ID / M365_CLIENT_ID /
     M365_CLIENT_SECRET are all set. Required for Microsoft 365 tenants with
     Security Defaults enabled, which blocks basic SMTP auth outright and hides
     app-password creation. Also outlives the Dec 2026 basic-auth retirement.
  2. Basic auth — SMTP_HOST + SMTP_USER + SMTP_PASS. Kept for local dev and for
     any non-M365 provider.
  3. Ethereal — no config at all; creates a throwaway test account on first send.
*/

const TOKEN_ENDPOINT = (tenantId) =>
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

// Scope for SMTP client submission. NOT a Graph scope — using
// https://graph.microsoft.com/.default here yields a token that authenticates
// against Graph and is rejected by smtp.office365.com.
const SMTP_SCOPE = "https://outlook.office365.com/.default";

const useOAuth = () =>
    Boolean(
        process.env.M365_TENANT_ID &&
        process.env.M365_CLIENT_ID &&
        process.env.M365_CLIENT_SECRET
    );

// Tokens last ~1h. Cached and refreshed two minutes early so a send never races
// an expiry mid-handshake.
let tokenCache = null; // { value, expiresAt }

const getAccessToken = async () => {
    if (tokenCache && tokenCache.expiresAt > Date.now() + 120000) {
        return tokenCache.value;
    }

    const body = new URLSearchParams({
        client_id: process.env.M365_CLIENT_ID,
        client_secret: process.env.M365_CLIENT_SECRET,
        scope: SMTP_SCOPE,
        grant_type: "client_credentials",
    });

    const res = await fetch(TOKEN_ENDPOINT(process.env.M365_TENANT_ID), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok || !json.access_token) {
        throw new Error(
            `M365 token request failed (${res.status}): ` +
            `${json.error || "unknown"} — ${json.error_description || "no detail"}`
        );
    }

    tokenCache = {
        value: json.access_token,
        expiresAt: Date.now() + Number(json.expires_in || 3600) * 1000,
    };
    return tokenCache.value;
};

// Rebuilt whenever the access token rotates; nodemailer bakes the token into the
// transport at construction time, so a cached transporter would keep presenting
// a stale one after refresh.
let cachedTransporter = null;
let cachedTransporterKey = null;

const getTransporter = async () => {
    if (useOAuth()) {
        const accessToken = await getAccessToken();
        if (!cachedTransporter || cachedTransporterKey !== accessToken) {
            cachedTransporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST || "smtp.office365.com",
                port: Number(process.env.SMTP_PORT) || 587,
                secure: process.env.SMTP_SECURE === "true",
                auth: {
                    type: "OAuth2",
                    user: process.env.SMTP_USER,
                    accessToken,
                },
            });
            cachedTransporterKey = accessToken;
        }
        return cachedTransporter;
    }

    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
        if (!cachedTransporter || cachedTransporterKey !== "basic") {
            cachedTransporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST,
                port: Number(process.env.SMTP_PORT) || 587,
                secure: process.env.SMTP_SECURE === "true",
                auth: {
                    user: process.env.SMTP_USER,
                    pass: process.env.SMTP_PASS,
                },
            });
            cachedTransporterKey = "basic";
        }
        return cachedTransporter;
    }

    if (!cachedTransporter || cachedTransporterKey !== "ethereal") {
        const testAccount = await nodemailer.createTestAccount();
        cachedTransporter = nodemailer.createTransport({
            host: "smtp.ethereal.email",
            port: 587,
            secure: false,
            auth: { user: testAccount.user, pass: testAccount.pass },
        });
        cachedTransporterKey = "ethereal";
    }
    return cachedTransporter;
};

if (!useOAuth() && !(process.env.SMTP_HOST && process.env.SMTP_USER)) {
    console.log("No SMTP config found. Emails will be logged or use Ethereal if configured.");
}

/**
 * Send an email.
 *
 * The 5th `attachments` parameter is OPTIONAL and additive — existing 4-arg
 * callers are unaffected. When provided, it's passed through to nodemailer's
 * `sendMail` as-is, so each entry should follow the nodemailer attachment
 * shape: `{ filename, content, contentType, ...nodemailerOpts }`.
 *
 * Added in Phase 1, Chunk 3 for certificate-of-disposal PDF delivery.
 *
 * @param {string|string[]} to - Recipient email(s)
 * @param {string} subject - Email subject
 * @param {string} text - Plain text body
 * @param {string} html - HTML body
 * @param {Array<{filename:string,content:Buffer|string,contentType?:string}>} [attachments]
 */
const sendEmail = async (to, subject, text, html, attachments) => {
    try {
        const transporter = await getTransporter();

        const info = await transporter.sendMail({
            from: process.env.FROM_EMAIL || process.env.SMTP_USER || "no-reply@resrishti.com",
            to: Array.isArray(to) ? to.join(",") : to,
            subject,
            text,
            html,
            // Only spread the attachments key when callers passed a non-empty
            // array — nodemailer is fine with omitted `attachments` but this
            // keeps the call-site logs cleaner and avoids `attachments: undefined`.
            ...(Array.isArray(attachments) && attachments.length
                ? { attachments }
                : {}),
        });

        if (nodemailer.getTestMessageUrl && info) {
            console.log("Preview URL: %s", nodemailer.getTestMessageUrl(info));
        }

        return info;
    } catch (error) {
        console.error("Error sending email:", error);
        // A rotated/revoked secret surfaces here as a token error. Drop the
        // cached token so the next send re-fetches rather than replaying a
        // known-bad one for the rest of the process lifetime.
        tokenCache = null;
        cachedTransporter = null;
        cachedTransporterKey = null;
        // Don't throw, just log. We don't want to fail requests because email service is down.
        return null;
    }
};

module.exports = { sendEmail };
