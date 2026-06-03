/*
  certificateController.js — Manager/Coordinator certificate workflow endpoints.

  Spec reference: clientmngmt.md §7.4, §8.2, §11.

  Endpoints (all mounted under /api/manager/certificates behind protectTriage):
  - GET    /                   listCertificates
  - GET    /:id                getCertificate
  - PATCH  /:id/issue          issueCertificate
  - POST   /:id/send           sendCertificate
  - POST   /:id/revise         reviseCertificate

  Authorization model:
  - protectTriage accepts Admin (req.admin) OR Manager with canCoordinate
    (req.manager). `canTriage()` here is a defensive final gate so that
    individual handlers stay self-contained even if the route layer changes.

  Coordination with parallel agents:
  - Backend G owns the auto-draft creation (waste-data → Certificate(draft))
    inside supervisorPickupController. This controller's `issueCertificate`
    handler reads that draft, renders the PDF, and uploads to S3.
  - Backend I owns the client-portal cert endpoints — they only READ this
    model. We're the only writer for `issued | sent | superseded` transitions.
  - Storage prefix `cods/<YYYY>/` deliberately has NO lifecycle rule (cf.
    clientmngmt.md §19 — CoDs are permanent legal records). We sidestep
    `uploadCheckinPhoto` / `uploadPickupEvidence` because both target prefixes
    that DO have expiry rules.

  State machine (cert):
        draft  ──issue──▶  issued  ──send──▶  sent  ──revise──▶  superseded
                                                                      │
                                                                      ▼
                                                              (new draft, rev+1)
*/

const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");
const Client = require("../models/Client");
const Pickup = require("../models/Pickup");
const Certificate = require("../models/Certificate");

const { uploadFile, getS3Client } = require("../utils/s3");
const { renderCertificatePdf } = require("../utils/certificatePdf");
const { sendEmail } = require("../utils/emailService");
const { notifyIfEnabled } = require("../utils/push");
const { getIo } = require("../socketHandler");

const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

// Friendly display labels for streams. Kept in sync with utils/certificatePdf.js
// and Pickup.wasteLineItemSchema.stream. If you add a stream here, mirror it in
// the PDF template so the legend stays consistent.
const STREAM_LABELS = {
    plastic: "Plastic",
    paper: "Paper",
    ewaste: "E-Waste",
    biomedical: "Biomedical Waste",
    "foam-thermocol": "Foam / Thermocol",
    "dry-waste": "Dry Waste",
    agr: "Agricultural Residue",
    battery: "Battery",
    "expired-food": "Expired Food / Organic",
    hazardous: "Hazardous Waste",
    other: "Other",
};

// Presigned URL expiry — 7 days is the S3 hard cap for SigV4. The cert email's
// portal link is the durable fallback; the presigned URL is the "click here to
// download instantly" path.
const PRESIGN_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

// ---------- helpers ----------------------------------------------------

/** Final auth gate per handler — see header. */
const canTriage = (req) => {
    if (req.admin) return true;
    if (req.manager && req.manager.canCoordinate) return true;
    return false;
};

/**
 * Returns the actor performing the cert action — used for `issuedBy` / `sentBy`
 * snapshots and pickup evidence stamps. Admin records may not have a `name`,
 * so we fall back to email.
 */
const actorFromReq = (req) => {
    if (req.admin) {
        return {
            userType: "Admin",
            userId: req.admin._id,
            name: req.admin.name || req.admin.email,
        };
    }
    if (req.manager) {
        return {
            userType: "Manager",
            userId: req.manager._id,
            name: req.manager.name || req.manager.email,
        };
    }
    return { userType: undefined, userId: undefined, name: "Unknown" };
};

const fmtDate = (d) => {
    if (!d) return "—";
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return "—";
    const day = String(date.getUTCDate()).padStart(2, "0");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${day} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
};

const fmtKg = (n) => {
    const num = Number(n);
    if (!Number.isFinite(num)) return "0.00";
    return num.toFixed(2);
};

/**
 * Fetch an S3 object's body as a Buffer. Used to re-fetch the rendered PDF
 * when sending it as an email attachment. Returns null on any failure so
 * the caller can fall back to the presigned-URL-only path.
 */
const fetchS3Buffer = async (bucket, key) => {
    try {
        const client = getS3Client();
        const out = await client.send(
            new GetObjectCommand({ Bucket: bucket, Key: key })
        );
        // Body is a Node Readable in the v3 SDK.
        const chunks = [];
        for await (const chunk of out.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (err) {
        console.error("fetchS3Buffer error:", err.message || err);
        return null;
    }
};

/**
 * Compose the cert-delivery email body. Mirrors the emerald-on-white branded
 * layout from controllers/onboardingController.js so the two transactional
 * emails feel like one product.
 */
const buildCertEmail = (cert, client, pickup, presignedUrl) => {
    const certNumber = cert.certNumber || "—";
    const revision = Number(cert.revision || 1);
    const revLine = revision > 1 ? ` (Rev ${revision})` : "";

    const portalUrl = `${process.env.CLIENT_URL || "http://localhost:5173"}/client/certificates`;
    const contactName = (client && client.contactName) || "there";
    const clientName = (cert.clientNameSnapshot || (client && client.name) || "your organization");

    const items = Array.isArray(cert.lineItemsSnapshot) ? cert.lineItemsSnapshot : [];
    const totalKg = cert.totalKgSnapshot ?? items.reduce((s, l) => s + Number(l.qtyKg || 0), 0);
    const pickupID = (pickup && pickup.pickupID) || "—";
    const scheduled = (pickup && pickup.scheduledDate) || cert.pickupDateSnapshot;

    const subject = `Your Certificate of Disposal — ${certNumber}${revLine}`;

    const text = [
        `Hi ${contactName},`,
        ``,
        `Your Certificate of Disposal ${certNumber}${revLine} for ${clientName} is now ready.`,
        ``,
        `Pickup: ${pickupID}`,
        `Date: ${fmtDate(scheduled)}`,
        `Total processed: ${fmtKg(totalKg)} kg`,
        ``,
        `Download the PDF directly:`,
        presignedUrl || "(see attachment)",
        ``,
        `Or view it in your portal:`,
        portalUrl,
        ``,
        `The PDF is also attached to this email.`,
        ``,
        `— The Resrishti Team`,
    ].join("\n");

    // Inline HTML preview rows for each stream.
    const rowsHtml = items
        .map(
            (li) => `
              <tr>
                <td style="padding:6px 0;font-size:13px;color:#334155;">${
                    STREAM_LABELS[li.stream] || li.stream || "—"
                }</td>
                <td style="padding:6px 0;font-size:13px;color:#334155;text-align:right;font-variant-numeric:tabular-nums;">${fmtKg(li.qtyKg)} kg</td>
              </tr>`
        )
        .join("");

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
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
            <tr>
              <td style="background:#059669;padding:24px 32px;color:#ffffff;">
                <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;">Resrishti</div>
                <div style="font-size:13px;opacity:0.85;margin-top:2px;">Certificate of Disposal</div>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 8px;font-size:22px;line-height:1.3;color:#0f172a;">Your certificate is ready</h1>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#334155;">
                  Hi ${contactName}, the Certificate of Disposal for
                  <strong>${clientName}</strong> covering pickup
                  <strong>${pickupID}</strong> is now available.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0 8px;">
                  <tr>
                    <td style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;padding-bottom:4px;">Certificate number</td>
                  </tr>
                  <tr>
                    <td style="font-size:16px;font-weight:700;color:#059669;">${certNumber}${revLine}</td>
                  </tr>
                </table>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;margin:16px 0;">
                  <tr>
                    <td style="padding:12px 16px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;">Waste processed</td>
                  </tr>
                  <tr>
                    <td style="padding:12px 16px;">
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                        ${rowsHtml || `<tr><td style="font-size:13px;color:#64748b;">No line items recorded</td></tr>`}
                        <tr>
                          <td style="padding-top:8px;border-top:1px solid #e2e8f0;font-size:13px;color:#0f172a;font-weight:700;">Total</td>
                          <td style="padding-top:8px;border-top:1px solid #e2e8f0;font-size:13px;color:#0f172a;font-weight:700;text-align:right;font-variant-numeric:tabular-nums;">${fmtKg(totalKg)} kg</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <p style="margin:24px 0 8px;text-align:center;">
                  <a href="${portalUrl}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 28px;border-radius:8px;">View in Portal</a>
                </p>

                ${
                    presignedUrl
                        ? `<p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:#94a3b8;word-break:break-all;text-align:center;">
                  Or download directly (link valid for 7 days):<br/>
                  <a href="${presignedUrl}" style="color:#059669;">${presignedUrl}</a>
                </p>`
                        : ""
                }

                <p style="margin:24px 0 0;font-size:12px;color:#64748b;">
                  The PDF is also attached to this email for your records. Keep it on file for compliance and audit purposes.
                </p>
              </td>
            </tr>
            <tr>
              <td style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;">
                Verify authenticity at resrishti.com/verify/${certNumber}.
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

// ---------- handlers ---------------------------------------------------

/**
 * GET /api/manager/certificates
 *
 * Query:
 *   - status: optional CSV (e.g. 'draft,issued')
 *   - clientId: optional Client _id filter
 *   - limit:  defaults to 50, clamped [1, 200]
 *   - offset: defaults to 0
 *
 * Returns { items, total, limit, offset }, sorted by createdAt desc.
 */
const listCertificates = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }

        const filter = {};

        const statusRaw = (req.query.status || "").toString().trim();
        if (statusRaw) {
            const statuses = statusRaw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            const ALLOWED = ["draft", "issued", "sent", "superseded"];
            const safe = statuses.filter((s) => ALLOWED.includes(s));
            if (safe.length) filter.status = { $in: safe };
        }

        if (req.query.clientId) {
            if (!mongoose.Types.ObjectId.isValid(req.query.clientId)) {
                return res.status(400).json({ message: "Invalid clientId" });
            }
            filter.client = req.query.clientId;
        }

        const limit = Math.max(
            1,
            Math.min(200, parseInt(req.query.limit, 10) || 50)
        );
        const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

        const [items, total] = await Promise.all([
            Certificate.find(filter)
                .populate({
                    path: "pickup",
                    select: "pickupID totalKg scheduledDate",
                })
                .populate({
                    path: "client",
                    select: "name contactEmail",
                })
                .sort({ createdAt: -1 })
                .skip(offset)
                .limit(limit)
                .lean(),
            Certificate.countDocuments(filter),
        ]);

        return res.json({ items, total, limit, offset });
    } catch (err) {
        console.error("listCertificates error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};

/**
 * GET /api/manager/certificates/:id — full populated cert + pickup + client.
 */
const getCertificate = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid certificate id" });
        }
        const cert = await Certificate.findById(id)
            .populate("pickup")
            .populate("client")
            .lean();
        if (!cert) return res.status(404).json({ message: "Certificate not found" });
        return res.json(cert);
    } catch (err) {
        console.error("getCertificate error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};

/**
 * PATCH /api/manager/certificates/:id/issue
 *
 * - Cert must be 'draft' → 409 otherwise.
 * - Renders the PDF (snapshot fields only — no live pickup/client mutations
 *   can affect the rendered output).
 * - Uploads under cods/<YYYY>/<certNumber>.pdf (no lifecycle rule — §19).
 * - Flips cert.status='issued', stamps issuedAt/issuedBy, attaches pdf {key,bucket}.
 * - Flips linked pickup.status='cert-issued' and appends an evidence entry.
 * - Emits pickup_<id> socket event so the client portal updates live.
 */
const issueCertificate = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid certificate id" });
        }

        const cert = await Certificate.findById(id);
        if (!cert) return res.status(404).json({ message: "Certificate not found" });
        if (cert.status !== "draft") {
            return res.status(409).json({
                message: `Cannot issue a certificate in '${cert.status}' status`,
            });
        }

        // Populate pickup + client for the PDF render. We pull from the live
        // documents so the PDF can use evidence timestamps + billing address,
        // but the cert's immutable snapshots (lineItemsSnapshot, totalKgSnapshot,
        // clientNameSnapshot) drive the legally-binding bits.
        const [pickup, client] = await Promise.all([
            Pickup.findById(cert.pickup).lean(),
            Client.findById(cert.client).lean(),
        ]);
        if (!pickup) {
            return res.status(409).json({
                message: "Linked pickup not found — cannot render certificate",
            });
        }
        if (!client) {
            return res.status(409).json({
                message: "Linked client not found — cannot render certificate",
            });
        }

        // Stamp issuedBy BEFORE rendering so the PDF picks up the signatory
        // name. issuedAt is set at the same instant so the PDF's "Date Issued"
        // matches the audit record exactly.
        const actor = actorFromReq(req);
        cert.issuedAt = new Date();
        cert.issuedBy = actor;

        // Render PDF.
        let buffer;
        try {
            buffer = await renderCertificatePdf(
                cert.toObject ? cert.toObject() : cert,
                pickup,
                client
            );
        } catch (renderErr) {
            console.error("PDF render error:", renderErr);
            return res.status(500).json({
                message: "Failed to render certificate PDF",
            });
        }

        // Upload to S3 under cods/<YYYY>/<certNumber>.pdf. We sidestep
        // uploadCheckinPhoto / uploadPickupEvidence because those target
        // lifecycle-managed prefixes; cods/ must be permanent (§19).
        const year = new Date(cert.issuedAt).getUTCFullYear();
        let pdfLocation;
        try {
            pdfLocation = await uploadFile({
                folder: `cods/${year}`,
                buffer,
                originalName: `${cert.certNumber}.pdf`,
                contentType: "application/pdf",
            });
        } catch (uploadErr) {
            console.error("S3 cert upload error:", uploadErr);
            return res.status(500).json({
                message: "Failed to upload certificate PDF",
            });
        }

        cert.pdf = { key: pdfLocation.key, bucket: pdfLocation.bucket };
        cert.status = "issued";
        await cert.save();

        // Flip linked pickup status + append evidence.
        try {
            const pkup = await Pickup.findById(cert.pickup);
            if (pkup) {
                pkup.status = "cert-issued";
                pkup.evidence = pkup.evidence || [];
                pkup.evidence.push({
                    status: "cert-issued",
                    at: new Date(),
                    by: actor,
                });
                await pkup.save();

                try {
                    const io = getIo();
                    io.to(`pickup_${pkup._id}`).emit("pickup:status-updated", {
                        pickupId: pkup._id,
                        status: "cert-issued",
                        certificateId: cert._id,
                    });
                } catch (socketErr) {
                    console.error(
                        "Socket emit error (cert-issued):",
                        socketErr.message || socketErr
                    );
                }
            }
        } catch (pkErr) {
            // Don't fail the whole request because the pickup mirror failed —
            // the cert itself is saved. Log and continue.
            console.error("pickup mirror error (issue):", pkErr);
        }

        const populated = await Certificate.findById(cert._id)
            .populate("pickup")
            .populate("client")
            .lean();

        return res.json(populated);
    } catch (err) {
        console.error("issueCertificate error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};

/**
 * POST /api/manager/certificates/:id/send
 *
 * Body: { confirmEmail? }
 *
 * - Cert must be 'issued' OR already 'sent' (idempotent re-send).
 * - Optional `confirmEmail` typo-guard (clientmngmt.md §17 Q11). If provided
 *   and doesn't match client.contactEmail exactly → 400.
 * - Re-fetches the PDF from S3, generates a 7-day presigned URL, sends
 *   email with the PDF attachment + presigned URL + portal link, push-notifies
 *   the client, and emits a socket event.
 * - Flips cert.status='sent', stamps sentAt/sentBy.
 * - Flips linked pickup.status='cert-sent' and appends evidence.
 */
const sendCertificate = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid certificate id" });
        }

        const cert = await Certificate.findById(id);
        if (!cert) return res.status(404).json({ message: "Certificate not found" });
        if (cert.status !== "issued" && cert.status !== "sent") {
            return res.status(409).json({
                message: `Cannot send a certificate in '${cert.status}' status`,
            });
        }
        if (!cert.pdf || !cert.pdf.key || !cert.pdf.bucket) {
            return res.status(409).json({
                message: "Certificate has no rendered PDF on file — issue it first",
            });
        }

        const [pickup, client] = await Promise.all([
            Pickup.findById(cert.pickup).lean(),
            Client.findById(cert.client).lean(),
        ]);
        if (!client) {
            return res.status(409).json({
                message: "Linked client not found",
            });
        }

        // Typo guard: spec §17 Q11. Strict equality after lowercase+trim mirrors
        // the Client model's stored form.
        if (req.body && typeof req.body.confirmEmail === "string") {
            const confirm = req.body.confirmEmail.trim().toLowerCase();
            if (confirm !== (client.contactEmail || "").trim().toLowerCase()) {
                return res.status(400).json({
                    message:
                        "Confirmation email does not match client's contact email",
                });
            }
        }

        // Presigned URL — 7-day expiry. Reused by the email AND the portal
        // download endpoint (Backend I) when the client clicks "Download PDF".
        let presignedUrl = null;
        try {
            const s3 = getS3Client();
            const cmd = new GetObjectCommand({
                Bucket: cert.pdf.bucket,
                Key: cert.pdf.key,
            });
            presignedUrl = await getSignedUrl(s3, cmd, {
                expiresIn: PRESIGN_EXPIRY_SECONDS,
            });
        } catch (signErr) {
            // Non-fatal — the email can still include the PDF as an attachment.
            console.error("Presign error:", signErr.message || signErr);
        }

        // Re-fetch the PDF buffer for the email attachment. If S3 fetch fails,
        // we still send the email with just the presigned URL as a fallback.
        const pdfBuffer = await fetchS3Buffer(cert.pdf.bucket, cert.pdf.key);
        const attachments = pdfBuffer
            ? [
                  {
                      filename: `${cert.certNumber}.pdf`,
                      content: pdfBuffer,
                      contentType: "application/pdf",
                  },
              ]
            : undefined;

        const { subject, text, html } = buildCertEmail(
            cert,
            client,
            pickup,
            presignedUrl
        );

        try {
            await sendEmail(
                client.contactEmail,
                subject,
                text,
                html,
                attachments
            );
        } catch (mailErr) {
            // sendEmail swallows internal failures and returns null — this
            // catch is just belt-and-braces for unexpected throws.
            console.error(
                "Cert email send error:",
                mailErr.message || mailErr
            );
        }

        // Flip cert state + audit stamp.
        const actor = actorFromReq(req);
        cert.status = "sent";
        cert.sentAt = new Date();
        cert.sentBy = actor;
        await cert.save();

        // Mirror onto pickup.
        try {
            const pkup = await Pickup.findById(cert.pickup);
            if (pkup) {
                pkup.status = "cert-sent";
                pkup.evidence = pkup.evidence || [];
                pkup.evidence.push({
                    status: "cert-sent",
                    at: new Date(),
                    by: actor,
                });
                await pkup.save();

                try {
                    const io = getIo();
                    io.to(`pickup_${pkup._id}`).emit("pickup:status-updated", {
                        pickupId: pkup._id,
                        status: "cert-sent",
                        certificateId: cert._id,
                    });
                } catch (socketErr) {
                    console.error(
                        "Socket emit error (cert-sent):",
                        socketErr.message || socketErr
                    );
                }
            }
        } catch (pkErr) {
            console.error("pickup mirror error (send):", pkErr);
        }

        // Push notification to the client (gated by global admin settings).
        try {
            const clientForPush = await Client.findById(cert.client)
                .select("pushSubscription")
                .lean();
            if (clientForPush && clientForPush.pushSubscription) {
                await notifyIfEnabled(
                    "pickup",
                    clientForPush.pushSubscription,
                    {
                        title: "Certificate ready",
                        body: `Your certificate ${cert.certNumber} is ready to download.`,
                        icon: "/android-chrome-512x512.png",
                        data: { url: `/client/certificates` },
                    }
                );
            }
        } catch (pushErr) {
            console.error(
                "Client push error (cert sent):",
                pushErr.message || pushErr
            );
        }

        const populated = await Certificate.findById(cert._id)
            .populate("pickup")
            .populate("client")
            .lean();

        return res.json(populated);
    } catch (err) {
        console.error("sendCertificate error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};

/**
 * POST /api/manager/certificates/:id/revise
 *
 * Spec §11.5: only a SENT certificate can be revised — that's the only state
 * where a correction would be visible to the client and worth tracking. The
 * old cert is marked 'superseded'; a new draft is created with the same
 * certNumber, incremented revision, and a `supersedes` pointer to the old _id.
 *
 * The new draft inherits the old snapshots so the manager can edit only what
 * was wrong (typically the line items). The frontend reopens the waste-data
 * form for the linked pickup so the supervisor / manager can re-enter data.
 */
const reviseCertificate = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid certificate id" });
        }

        const oldCert = await Certificate.findById(id);
        if (!oldCert) {
            return res.status(404).json({ message: "Certificate not found" });
        }
        if (oldCert.status !== "sent") {
            return res.status(409).json({
                message: `Only sent certificates can be revised (current: '${oldCert.status}')`,
            });
        }

        // Spin up the new draft FIRST so that if creation fails (e.g. unique
        // index violation) the old cert stays in 'sent' status and the user
        // can retry. Previously the old cert was flipped to 'superseded'
        // before the create, which left it stranded on failure.
        //
        // Design choice: keep `certNumber` identical so the legal number for
        // this pickup never changes — the `revision` field disambiguates.
        // The schema's compound unique index on (certNumber, revision) makes
        // this safe; field-level unique on certNumber alone would block it.
        const newCert = await Certificate.create({
            certNumber: oldCert.certNumber,
            revision: (oldCert.revision || 1) + 1,
            supersedes: oldCert._id,
            pickup: oldCert.pickup,
            client: oldCert.client,
            status: "draft",
            // Snapshots carry forward — manager edits the underlying pickup
            // line items, then the issue handler re-snapshots at PDF render.
            lineItemsSnapshot: oldCert.lineItemsSnapshot,
            totalKgSnapshot: oldCert.totalKgSnapshot,
            clientNameSnapshot: oldCert.clientNameSnapshot,
            pickupDateSnapshot: oldCert.pickupDateSnapshot,
        });

        // New cert exists — now safely mark the old one superseded.
        oldCert.status = "superseded";
        await oldCert.save();

        // Repoint the pickup at the new draft and roll its status back to
        // 'cert-draft' so the manager's review queue picks it up cleanly.
        try {
            const pkup = await Pickup.findById(oldCert.pickup);
            if (pkup) {
                pkup.certificate = newCert._id;
                pkup.status = "cert-draft";
                pkup.evidence = pkup.evidence || [];
                pkup.evidence.push({
                    status: "cert-draft",
                    at: new Date(),
                    by: actorFromReq(req),
                });
                await pkup.save();

                try {
                    const io = getIo();
                    io.to(`pickup_${pkup._id}`).emit("pickup:status-updated", {
                        pickupId: pkup._id,
                        status: "cert-draft",
                        certificateId: newCert._id,
                        supersededId: oldCert._id,
                    });
                } catch (socketErr) {
                    console.error(
                        "Socket emit error (cert revise):",
                        socketErr.message || socketErr
                    );
                }
            }
        } catch (pkErr) {
            console.error("pickup mirror error (revise):", pkErr);
        }

        return res.json(newCert);
    } catch (err) {
        console.error("reviseCertificate error:", err);
        return res.status(500).json({ message: "Server error" });
    }
};

module.exports = {
    listCertificates,
    getCertificate,
    issueCertificate,
    sendCertificate,
    reviseCertificate,
    // Exported for testing / smoke checks — not wired into a route.
    buildCertEmail,
};
