/*
  test-email.js

  Purpose:
  - Verify the mail config in .env actually authenticates, and optionally send a
    real test message.

  Why this exists separately from utils/emailService.js:
  - sendEmail() deliberately swallows its errors so an SMTP outage never fails a
    request. That is right for production, but it means a misconfiguration looks
    identical to a successful send. This script does NOT swallow anything, so
    failures surface with the provider's actual error text.

  In OAuth2 mode the two failure points are checked separately — token
  acquisition (Entra) and SMTP handshake (Exchange) fail for entirely different
  reasons, and collapsing them into one error makes the fix much harder to find.

  Usage:
  - Connection/auth check only:  node test-email.js
  - Also send a real message:    node test-email.js you@example.com

  Must be run from the Resrishti-Backend directory — dotenv resolves .env
  relative to the working directory.
*/
require("dotenv").config();
const nodemailer = require("nodemailer");

const recipient = process.argv[2];
const SMTP_SCOPE = "https://outlook.office365.com/.default";

const run = async () => {
    const {
        SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_SECURE, FROM_EMAIL,
        M365_TENANT_ID, M365_CLIENT_ID, M365_CLIENT_SECRET,
    } = process.env;

    const oauth = Boolean(M365_TENANT_ID && M365_CLIENT_ID && M365_CLIENT_SECRET);

    if (!SMTP_HOST || !SMTP_USER) {
        console.error("Missing SMTP_HOST or SMTP_USER in .env — emailService would fall back to Ethereal.");
        process.exit(1);
    }

    console.log(`Mode:    ${oauth ? "OAuth2 (client credentials)" : "basic auth"}`);
    console.log(`Host:    ${SMTP_HOST}:${SMTP_PORT || 587} (secure=${SMTP_SECURE === "true"})`);
    console.log(`Mailbox: ${SMTP_USER}`);
    console.log(`From:    ${FROM_EMAIL || SMTP_USER}`);

    let auth;

    if (oauth) {
        // --- Step 1: token from Entra ---
        console.log("\n[1/2] Requesting access token from Entra...");
        const body = new URLSearchParams({
            client_id: M365_CLIENT_ID,
            client_secret: M365_CLIENT_SECRET,
            scope: SMTP_SCOPE,
            grant_type: "client_credentials",
        });

        const res = await fetch(
            `https://login.microsoftonline.com/${M365_TENANT_ID}/oauth2/v2.0/token`,
            {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body,
            }
        );
        const json = await res.json().catch(() => ({}));

        if (!res.ok || !json.access_token) {
            console.error(`\nTOKEN REQUEST FAILED (HTTP ${res.status})`);
            console.error(`  error:       ${json.error || "unknown"}`);
            console.error(`  description: ${json.error_description || "none"}`);
            console.error("\nThis is an Entra problem, not an Exchange one — check tenant ID,");
            console.error("client ID, and that the secret has not expired.");
            process.exit(1);
        }

        console.log(`      OK — token acquired, expires in ${json.expires_in}s`);
        auth = { type: "OAuth2", user: SMTP_USER, accessToken: json.access_token };
    } else {
        if (!SMTP_PASS) {
            console.error("\nSMTP_PASS is empty and no M365_* OAuth vars are set — nothing to authenticate with.");
            process.exit(1);
        }
        auth = { user: SMTP_USER, pass: SMTP_PASS };
    }

    // --- Step 2: SMTP handshake ---
    console.log(`${oauth ? "[2/2] " : ""}Verifying SMTP connection...`);

    const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT) || 587,
        secure: SMTP_SECURE === "true",
        auth,
    });

    await transporter.verify();
    console.log("      OK — SMTP authenticated.");

    if (!recipient) {
        console.log("\nPass a recipient to also send a test message:  node test-email.js you@example.com");
        return;
    }

    const info = await transporter.sendMail({
        from: FROM_EMAIL || SMTP_USER,
        to: recipient,
        subject: "Resrishti SMTP test",
        text: `Test message sent from ${FROM_EMAIL || SMTP_USER} via ${SMTP_HOST}.`,
        html: `<p>Test message sent from <strong>${FROM_EMAIL || SMTP_USER}</strong> via ${SMTP_HOST}.</p>`,
    });

    console.log(`\nSent. Message ID: ${info.messageId}`);
    console.log(`Accepted: ${info.accepted.join(", ") || "none"}`);
    if (info.rejected && info.rejected.length) {
        console.log(`Rejected: ${info.rejected.join(", ")}`);
    }
    console.log(`\nCheck the received message's From header — if it shows anything other than ` +
        `${FROM_EMAIL || SMTP_USER}, the provider rewrote it.`);
};

run().catch((err) => {
    console.error("\nMAIL CHECK FAILED:");
    console.error(err.message);
    if (err.code) console.error(`Code: ${err.code}`);
    if (err.response) console.error(`Server response: ${err.response}`);
    process.exit(1);
});
