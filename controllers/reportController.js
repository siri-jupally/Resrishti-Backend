/*
  reportController.js — Manager/Coordinator monthly report workflow.

  Covers the two MONTHLY client documents that sit alongside the per-pickup
  Certificate of Disposal:
      impact — Environmental Impact Report
      ghg    — Green House Gases Emission Report

  Endpoints (mounted under /api/manager/reports behind protectTriage):
    GET    /preview      previewReport   compute figures WITHOUT persisting
    GET    /             listReports
    GET    /:id          getReport       (+ presigned preview URL once issued)
    POST   /generate     generateReport  create/refresh the draft
    PATCH  /:id/issue    issueReport     render PDF → S3 → status 'issued'
    POST   /:id/send     sendReport      email client   → status 'sent'
    POST   /:id/revise   reviseReport    supersede + new draft (rev+1)

  Deliberately mirrors certificateController's shape — same auth gate, same
  actor snapshots, same issue/send split, same revise-only-from-sent rule — so
  the manager UI can drive all three document types with one mental model.

  The generate → review → send split is the whole point of this feature: the
  manager sees the computed numbers (preview), commits them to a draft
  (generate), renders the real PDF and eyeballs it (issue), and only then
  releases it to the client (send). Nothing reaches the client before `send`;
  the client portal hard-filters anything that is not 'sent'/'superseded'.

  Storage:
  - `reports/<type>/<YYYY>/<reportNumber>.pdf`. Like `cods/`, this prefix has
    NO lifecycle expiry rule — these are records the client may re-download
    years later.
*/

const mongoose = require("mongoose");
const Client = require("../models/Client");
const Pickup = require("../models/Pickup");
const Report = require("../models/Report");

const { uploadFile, getS3Client } = require("../utils/s3");
const { calcImpact, calcGHG } = require("../utils/reportCalculations");
const { generateReportNumber } = require("../utils/reportNumber");
const { renderImpactReportPdf } = require("../utils/impactReportPdf");
const { renderGhgReportPdf } = require("../utils/ghgReportPdf");
const { sendEmail } = require("../utils/emailService");
const { notifyIfEnabled } = require("../utils/push");

const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const PRESIGN_EXPIRY_SECONDS = 7 * 24 * 60 * 60; // S3 SigV4 hard cap

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

const REPORT_TYPES = ["impact", "ghg"];

const TYPE_LABEL = {
    impact: "Environmental Impact Report",
    ghg: "Green House Gases Emission Report",
};

/*
  Which pickups feed a monthly report.

  Waste line items are only populated by recordWasteData, which runs at/after
  `processed` and creates the CoD draft. Anything earlier has no tonnage, so
  including it would contribute nothing but would misleadingly inflate the
  "pickups included" count the manager reviews.
*/
const ELIGIBLE_PICKUP_STATUSES = [
    "processed",
    "cert-draft",
    "cert-issued",
    "cert-sent",
];

// ---------- helpers ----------------------------------------------------

/** Final auth gate per handler — mirrors certificateController.canTriage. */
const canTriage = (req) => {
    if (req.admin) return true;
    if (req.manager && req.manager.canCoordinate) return true;
    return false;
};

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

/**
 * UTC month boundaries. UTC (not local) so a report generated from a machine
 * in a different timezone can never shift a pickup into the neighbouring month
 * and silently change a client's reported tonnage.
 */
const monthRange = (year, month) => {
    const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
    return { start, end };
};

const monthLabel = (year, month) => `${MONTHS[month - 1]} ${year}`;

/** Validate + normalise the (client, type, year, month) tuple from a request. */
const parseParams = (src) => {
    const clientId = src.clientId || src.client;
    const type = String(src.type || "").toLowerCase();
    const year = parseInt(src.year, 10);
    const month = parseInt(src.month, 10);

    if (!mongoose.Types.ObjectId.isValid(clientId)) {
        return { error: "Invalid or missing clientId" };
    }
    if (!REPORT_TYPES.includes(type)) {
        return { error: `type must be one of: ${REPORT_TYPES.join(", ")}` };
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2200) {
        return { error: "Invalid year" };
    }
    if (!Number.isInteger(month) || month < 1 || month > 12) {
        return { error: "month must be 1-12" };
    }
    return { clientId, type, year, month };
};

/**
 * Pickups for a client in a reporting month.
 *
 * Month attribution uses `scheduledDate` — the day the waste was actually
 * collected — falling back to `requestedAt` for pickups that completed without
 * ever being formally scheduled. Without the fallback those pickups would
 * vanish from the client's totals entirely.
 */
const findEligiblePickups = async (clientId, year, month) => {
    const { start, end } = monthRange(year, month);
    return Pickup.find({
        client: clientId,
        status: { $in: ELIGIBLE_PICKUP_STATUSES },
        "lineItems.0": { $exists: true },
        $or: [
            { scheduledDate: { $gte: start, $lt: end } },
            {
                scheduledDate: null,
                requestedAt: { $gte: start, $lt: end },
            },
        ],
    })
        .select("pickupID lineItems site siteNameSnapshot scheduledDate requestedAt")
        .populate("site", "name")
        .lean();
};

/** Compute the type-specific snapshot from a set of pickups. */
const buildSnapshot = (type, pickups) => {
    if (type === "impact") {
        const impactSnapshot = calcImpact(pickups);
        return {
            impactSnapshot,
            totalKgSnapshot: impactSnapshot.totalWasteKg,
            isEmpty: impactSnapshot.totalWasteKg <= 0,
        };
    }
    const ghgSnapshot = calcGHG(pickups);
    return {
        ghgSnapshot,
        totalKgSnapshot: (ghgSnapshot.totals.foodWasteTons || 0) * 1000,
        isEmpty: !ghgSnapshot.hasData,
    };
};

const fetchS3Buffer = async (bucket, key) => {
    try {
        const s3 = getS3Client();
        const out = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: key })
        );
        const chunks = [];
        for await (const chunk of out.Body) chunks.push(chunk);
        return Buffer.concat(chunks);
    } catch (err) {
        console.error("Report S3 fetch error:", err.message || err);
        return null;
    }
};

const presignFor = async (pdf) => {
    if (!pdf || !pdf.bucket || !pdf.key) return null;
    try {
        const s3 = getS3Client();
        return await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: pdf.bucket, Key: pdf.key }),
            { expiresIn: PRESIGN_EXPIRY_SECONDS }
        );
    } catch (err) {
        console.error("Report presign error:", err.message || err);
        return null;
    }
};

const renderFor = (report, client) =>
    report.type === "impact"
        ? renderImpactReportPdf(report, client)
        : renderGhgReportPdf(report, client);

// No presigned S3 URL here — it would expose the bucket, region and access-key
// ID in the mail body and stay live for its full expiry to anyone it's
// forwarded to. The PDF ships as an attachment; the portal holds the durable copy.
const buildReportEmail = (report, client) => {
    const label = TYPE_LABEL[report.type];
    const period = monthLabel(report.periodYear, report.periodMonth);
    const subject = `${label} — ${period} — ${report.reportNumber}`;

    const revisionNote =
        report.revision > 1
            ? `\n\nThis is a revised version (Revision ${report.revision}) and supersedes the copy issued previously for the same period.`
            : "";

    const text =
        `Dear ${client.contactName || client.name},\n\n` +
        `Please find attached your ${label} for ${period}.\n\n` +
        `Reference: ${report.reportNumber}` +
        revisionNote +
        `\n\nYou can also access this and all previous documents any time from your client portal.\n\n` +
        `Warm regards,\nGreenEarth Integrated Facility Pvt Ltd`;

    const html =
        `<p>Dear ${client.contactName || client.name},</p>` +
        `<p>Please find attached your <strong>${label}</strong> for <strong>${period}</strong>.</p>` +
        `<p>Reference: <strong>${report.reportNumber}</strong></p>` +
        (report.revision > 1
            ? `<p><em>This is a revised version (Revision ${report.revision}) and supersedes the copy issued previously for the same period.</em></p>`
            : "") +
        `<p>You can also access this and all previous documents any time from your client portal.</p>` +
        `<p>Warm regards,<br/>GreenEarth Integrated Facility Pvt Ltd</p>`;

    return { subject, text, html };
};

// ---------- handlers ---------------------------------------------------

/**
 * GET /api/manager/reports/preview?clientId=&type=&year=&month=
 *
 * Computes the figures for a period WITHOUT touching the database. This is the
 * "review before you commit" step — the manager can flip through months and
 * see what a report would say before creating anything.
 */
const previewReport = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const parsed = parseParams(req.query);
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        const { clientId, type, year, month } = parsed;

        const client = await Client.findById(clientId).lean();
        if (!client) return res.status(404).json({ message: "Client not found" });

        const pickups = await findEligiblePickups(clientId, year, month);
        const snap = buildSnapshot(type, pickups);

        // Is there already a report on file for this slot?
        const existing = await Report.findOne({
            client: clientId,
            type,
            periodYear: year,
            periodMonth: month,
            status: { $ne: "superseded" },
        })
            .sort({ revision: -1 })
            .lean();

        return res.json({
            type,
            period: { year, month, label: monthLabel(year, month) },
            client: { _id: client._id, name: client.name },
            pickupCount: pickups.length,
            pickups: pickups.map((p) => ({
                _id: p._id,
                pickupID: p.pickupID,
                siteName: p.siteNameSnapshot || (p.site && p.site.name) || null,
                date: p.scheduledDate || p.requestedAt,
            })),
            isEmpty: snap.isEmpty,
            totalKg: snap.totalKgSnapshot,
            impactSnapshot: snap.impactSnapshot || null,
            ghgSnapshot: snap.ghgSnapshot || null,
            existing: existing
                ? {
                      _id: existing._id,
                      reportNumber: existing.reportNumber,
                      status: existing.status,
                      revision: existing.revision,
                  }
                : null,
        });
    } catch (err) {
        console.error("previewReport error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * POST /api/manager/reports/generate
 * body: { clientId, type, year, month }
 *
 * Creates the draft, or refreshes an existing draft's figures in place (the
 * manager may add a late pickup and re-generate). Refuses to silently
 * overwrite anything already issued or sent — that path is `revise`.
 */
const generateReport = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const parsed = parseParams(req.body || {});
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        const { clientId, type, year, month } = parsed;

        const client = await Client.findById(clientId).lean();
        if (!client) return res.status(404).json({ message: "Client not found" });

        const pickups = await findEligiblePickups(clientId, year, month);
        const snap = buildSnapshot(type, pickups);

        if (snap.isEmpty) {
            return res.status(409).json({
                message: `No ${
                    type === "ghg" ? "organic/food waste" : "processed waste"
                } recorded for ${client.name} in ${monthLabel(
                    year,
                    month
                )} — nothing to report on.`,
            });
        }

        // Latest non-superseded doc for this slot decides create-vs-refresh.
        const existing = await Report.findOne({
            client: clientId,
            type,
            periodYear: year,
            periodMonth: month,
            status: { $ne: "superseded" },
        }).sort({ revision: -1 });

        if (existing && existing.status !== "draft") {
            return res.status(409).json({
                message: `A ${TYPE_LABEL[type]} for ${monthLabel(
                    year,
                    month
                )} already exists in '${existing.status}' status (${
                    existing.reportNumber
                }). Use Revise to supersede it.`,
                reportId: existing._id,
            });
        }

        const common = {
            clientNameSnapshot: client.name,
            pickupIdsSnapshot: pickups.map((p) => p._id),
            totalKgSnapshot: snap.totalKgSnapshot,
            impactSnapshot: snap.impactSnapshot,
            ghgSnapshot: snap.ghgSnapshot,
            generatedAt: new Date(),
        };

        let report;
        if (existing) {
            Object.assign(existing, common);
            report = await existing.save();
        } else {
            report = await Report.create({
                reportNumber: await generateReportNumber(type, year),
                type,
                client: clientId,
                periodYear: year,
                periodMonth: month,
                status: "draft",
                ...common,
            });
        }

        return res.status(existing ? 200 : 201).json({
            report,
            refreshed: Boolean(existing),
            pickupCount: pickups.length,
        });
    } catch (err) {
        // Duplicate key = two managers generating the same slot concurrently.
        if (err && err.code === 11000) {
            return res.status(409).json({
                message:
                    "A report for this client, type and month was just created by someone else. Reload and try again.",
            });
        }
        console.error("generateReport error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * GET /api/manager/reports/clients
 *
 * Minimal client picker feed for the reports UI.
 *
 * Why this exists rather than reusing /api/admin/clients: that route is behind
 * the admin-only `protect` middleware, so a Coordinator manager — who is fully
 * authorised to generate and send reports — cannot call it. This returns only
 * the three fields the picker needs, under the same protectTriage gate as the
 * rest of this controller.
 */
const listReportableClients = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const clients = await Client.find({ status: { $ne: "churned" } })
            .select("name contactEmail status")
            .sort({ name: 1 })
            .lean();
        return res.json({ items: clients, total: clients.length });
    } catch (err) {
        console.error("listReportableClients error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * GET /api/manager/reports?clientId=&type=&status=&year=&month=&limit=&offset=
 */
const listReports = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const filter = {};
        if (req.query.clientId && mongoose.Types.ObjectId.isValid(req.query.clientId)) {
            filter.client = req.query.clientId;
        }
        if (REPORT_TYPES.includes(req.query.type)) filter.type = req.query.type;
        if (["draft", "issued", "sent", "superseded"].includes(req.query.status)) {
            filter.status = req.query.status;
        }
        const year = parseInt(req.query.year, 10);
        if (Number.isInteger(year)) filter.periodYear = year;
        const month = parseInt(req.query.month, 10);
        if (Number.isInteger(month) && month >= 1 && month <= 12) {
            filter.periodMonth = month;
        }

        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const [total, items] = await Promise.all([
            Report.countDocuments(filter),
            Report.find(filter)
                .sort({ periodYear: -1, periodMonth: -1, createdAt: -1 })
                .skip(offset)
                .limit(limit)
                .populate("client", "name contactEmail")
                .lean(),
        ]);

        return res.json({ items, total, limit, offset });
    } catch (err) {
        console.error("listReports error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * GET /api/manager/reports/:id
 * Includes a presigned URL so the manager can eyeball the real PDF at review
 * time, before it is ever sent.
 */
const getReport = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid report id" });
        }
        const report = await Report.findById(id)
            .populate("client", "name contactName contactEmail billingAddress")
            .lean();
        if (!report) return res.status(404).json({ message: "Report not found" });

        const previewUrl = await presignFor(report.pdf);
        return res.json({ report, previewUrl });
    } catch (err) {
        console.error("getReport error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * PATCH /api/manager/reports/:id/issue
 *
 * Renders the PDF from the FROZEN snapshot (never from live pickups), uploads
 * it, and flips to 'issued'. The client still cannot see it — that needs send.
 */
const issueReport = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid report id" });
        }

        const report = await Report.findById(id);
        if (!report) return res.status(404).json({ message: "Report not found" });
        if (report.status !== "draft") {
            return res.status(409).json({
                message: `Only a draft can be issued (current: '${report.status}')`,
            });
        }

        const client = await Client.findById(report.client).lean();
        if (!client) {
            return res.status(409).json({ message: "Linked client not found" });
        }

        // Stamp the actor BEFORE rendering so anything printed on the document
        // matches the audit record exactly.
        const actor = actorFromReq(req);
        report.issuedAt = new Date();
        report.issuedBy = actor;

        let buffer;
        try {
            buffer = await renderFor(report, client);
        } catch (renderErr) {
            console.error("Report render error:", renderErr);
            return res.status(500).json({
                message: `Failed to render the report PDF: ${renderErr.message}`,
            });
        }

        let pdfLocation;
        try {
            pdfLocation = await uploadFile({
                folder: `reports/${report.type}/${report.periodYear}`,
                buffer,
                originalName: `${report.reportNumber}.pdf`,
                contentType: "application/pdf",
            });
        } catch (upErr) {
            console.error("Report upload error:", upErr);
            return res.status(500).json({
                message: `Failed to store the report PDF: ${upErr.message}`,
            });
        }

        report.pdf = { key: pdfLocation.key, bucket: pdfLocation.bucket };
        report.status = "issued";
        await report.save();

        const previewUrl = await presignFor(report.pdf);
        return res.json({ report, previewUrl });
    } catch (err) {
        console.error("issueReport error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * POST /api/manager/reports/:id/send
 * body: { confirmEmail? }
 *
 * Emails the client with the PDF attached, then flips to 'sent' — the point at
 * which the client portal will surface it.
 */
const sendReport = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid report id" });
        }

        const report = await Report.findById(id);
        if (!report) return res.status(404).json({ message: "Report not found" });
        if (report.status !== "issued" && report.status !== "sent") {
            return res.status(409).json({
                message: `Cannot send a report in '${report.status}' status — issue it first`,
            });
        }
        if (!report.pdf || !report.pdf.key || !report.pdf.bucket) {
            return res.status(409).json({
                message: "Report has no rendered PDF on file — issue it first",
            });
        }

        const client = await Client.findById(report.client).lean();
        if (!client) {
            return res.status(409).json({ message: "Linked client not found" });
        }

        // Same typo guard as certificates: the caller may echo the address back
        // to prove they know who this is going to.
        if (req.body && typeof req.body.confirmEmail === "string") {
            const confirm = req.body.confirmEmail.trim().toLowerCase();
            if (confirm !== (client.contactEmail || "").trim().toLowerCase()) {
                return res.status(400).json({
                    message: "Confirmation email does not match client's contact email",
                });
            }
        }

        const pdfBuffer = await fetchS3Buffer(report.pdf.bucket, report.pdf.key);
        const attachments = pdfBuffer
            ? [
                  {
                      filename: `${report.reportNumber}.pdf`,
                      content: pdfBuffer,
                      contentType: "application/pdf",
                  },
              ]
            : undefined;

        const { subject, text, html } = buildReportEmail(report, client);

        try {
            await sendEmail(client.contactEmail, subject, text, html, attachments);
        } catch (mailErr) {
            console.error("Report email send error:", mailErr.message || mailErr);
        }

        const actor = actorFromReq(req);
        report.status = "sent";
        report.sentAt = new Date();
        report.sentBy = actor;
        await report.save();

        // Best-effort client push — never fail the send over a notification.
        // Group "pickup" matches certificateController; unknown groups default
        // to enabled in utils/push.isEnabled, so this is not silently dropped.
        try {
            await notifyIfEnabled("pickup", client.pushSubscription, {
                title: TYPE_LABEL[report.type],
                body: `Your ${monthLabel(
                    report.periodYear,
                    report.periodMonth
                )} report is now available.`,
                icon: "/android-chrome-512x512.png",
                data: { url: "/client/reports" },
            });
        } catch (pushErr) {
            console.error("Report push error:", pushErr.message || pushErr);
        }

        // NOTE: no socket emit here on purpose. socketHandler only registers
        // joinTaskRoom/leaveTaskRoom — nothing ever joins a per-client or
        // per-pickup room, so an emit would be dead code. (The equivalent
        // emits in certificateController are already no-ops for this reason.)
        // Email + push are the live delivery channels.

        return res.json({ report });
    } catch (err) {
        console.error("sendReport error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * POST /api/manager/reports/:id/revise
 *
 * Only a SENT report can be revised — that is the only state where the client
 * already holds a copy worth correcting. Creates the replacement draft FIRST
 * so a failure can't strand the original in 'superseded'.
 */
const reviseReport = async (req, res) => {
    try {
        if (!canTriage(req)) {
            return res.status(403).json({ message: "Not authorized" });
        }
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid report id" });
        }

        const oldReport = await Report.findById(id);
        if (!oldReport) return res.status(404).json({ message: "Report not found" });
        if (oldReport.status !== "sent") {
            return res.status(409).json({
                message: `Only sent reports can be revised (current: '${oldReport.status}')`,
            });
        }

        // Recompute from current data — the whole point of a revision is that
        // the underlying pickups changed.
        const pickups = await findEligiblePickups(
            oldReport.client,
            oldReport.periodYear,
            oldReport.periodMonth
        );
        const snap = buildSnapshot(oldReport.type, pickups);

        const newReport = await Report.create({
            reportNumber: oldReport.reportNumber, // number is stable across revisions
            revision: (oldReport.revision || 1) + 1,
            supersedes: oldReport._id,
            type: oldReport.type,
            client: oldReport.client,
            periodYear: oldReport.periodYear,
            periodMonth: oldReport.periodMonth,
            status: "draft",
            clientNameSnapshot: oldReport.clientNameSnapshot,
            pickupIdsSnapshot: pickups.map((p) => p._id),
            totalKgSnapshot: snap.totalKgSnapshot,
            impactSnapshot: snap.impactSnapshot,
            ghgSnapshot: snap.ghgSnapshot,
            generatedAt: new Date(),
        });

        // Only now is it safe to retire the old one.
        oldReport.status = "superseded";
        await oldReport.save();

        return res.status(201).json({ report: newReport, supersededId: oldReport._id });
    } catch (err) {
        if (err && err.code === 11000) {
            return res.status(409).json({
                message: "A revision for this report already exists.",
            });
        }
        console.error("reviseReport error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    previewReport,
    generateReport,
    listReportableClients,
    listReports,
    getReport,
    issueReport,
    sendReport,
    reviseReport,
    // exported for tests
    monthRange,
    ELIGIBLE_PICKUP_STATUSES,
};
