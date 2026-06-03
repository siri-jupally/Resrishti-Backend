const nodemailer = require("nodemailer");

let transporter;

if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === "true",
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
} else {
    // Lazy init for ethereal? Or just init on load.
    // Ideally async init is better, but for module simplicity we'll handle test account inside sendEmail id needed or init here.
    // To keep it simple and non-blocking at startup, we'll create test account on first send if needed, or just warn.
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
        if (!transporter) {
            // Create Ethereal account for development if not already created
            const testAccount = await nodemailer.createTestAccount();
            transporter = nodemailer.createTransport({
                host: "smtp.ethereal.email",
                port: 587,
                secure: false,
                auth: {
                    user: testAccount.user,
                    pass: testAccount.pass,
                },
            });
        }

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
        // Don't throw, just log. We don't want to fail requests because email service is down.
        return null;
    }
};

module.exports = { sendEmail };
