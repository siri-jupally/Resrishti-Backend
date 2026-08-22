/*
  Client portal controller — Client Management module (Phase 1)

  Purpose:
  - Auth-facing endpoints for the external client portal:
      - loginClient:           POST /api/client/login
      - getMe:                 GET  /api/client/me
      - getDashboard:          GET  /api/client/dashboard
      - listMyCertificates:    GET  /api/client/certificates
      - downloadMyCertificate: GET  /api/client/certificates/:id/download

  Notes:
  - JWT payload carries `kind: 'client'` so the matching authClient middleware
    can reject employee/manager/admin tokens being replayed against client routes
    (see clientmngmt.md §7.7, §10.3).
  - `passwordHash` is `select: false` on the Client schema, so login must opt-in
    via `.select('+passwordHash')`. Every other read path (including `req.client`
    populated by middleware) gets the field silently dropped.
  - Generic 400 `Invalid credentials` is returned for both "no such client" and
    "wrong password" to avoid email enumeration via response timing/wording.
  - Dashboard / certs endpoints (Chunk 3, Backend I) read Pickup + Certificate
    and ALWAYS scope to `req.client._id`. Ownership is the only privacy boundary
    here — there is no client-of-client sharing in P1.

  Env vars:
  - JWT_SECRET: signs the client portal JWT.
  - AWS_REGION, S3_BUCKET_NAME, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY:
    used by `downloadMyCertificate` to mint a presigned S3 GetObject URL.
*/
const jwt = require("jsonwebtoken");
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const mongoose = require("mongoose");
const Client = require("../models/Client");
const Pickup = require("../models/Pickup");
const Certificate = require("../models/Certificate");
const Report = require("../models/Report");
const Site = require("../models/Site");
const { getS3Client } = require("../utils/s3");
const { co2eForLineItems } = require("../utils/emissionFactors");

// The only certificate statuses an external client may ever see or download.
// `draft` = not rendered yet; `issued` = PDF exists but the manager has NOT
// pressed Send, so it is still internal. Both list + download read this, so a
// status can never be visible in one path and blocked in the other.
const CLIENT_VISIBLE_CERT_STATUSES = ["sent", "superseded"];

// 7-day expiry mirrors clientmngmt.md §10.3.
const generateClientToken = (id) =>
  jwt.sign({ id, kind: "client" }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

// POST /api/client/login
const loginClient = async (req, res) => {
  const { email, password } = req.body;
  try {
    if (!email || !password) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // `+passwordHash` opt-in is required because the schema marks it select:false.
    const client = await Client.findOne({ contactEmail: email }).select(
      "+passwordHash"
    );

    // Same generic error for both "not found" and "wrong password" — no enumeration.
    if (!client || !(await client.comparePassword(password))) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // A client who hasn't completed the magic-link onboarding cannot log in yet —
    // they need to follow the welcome email link first.
    if (!client.isOnboardingComplete) {
      return res.status(403).json({
        message:
          "Onboarding not complete. Use the link in your welcome email.",
      });
    }

    // Mirror the account-state guard in middleware/authClient. Without it a
    // paused/churned client logs in successfully, then gets 403 'Account
    // inactive' on every subsequent portal request — a dead portal with no
    // explanation. Fail here instead, where we can say why.
    if (client.status !== "active") {
      return res.status(403).json({
        message:
          "This account is not active. Please contact your account manager.",
      });
    }

    return res.json({
      _id: client._id,
      name: client.name,
      contactEmail: client.contactEmail,
      token: generateClientToken(client._id),
    });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /api/client/me
// `req.client` is already loaded (and passwordHash-stripped via select:false)
// by protectClient middleware.
const getMe = async (req, res) => {
  return res.json(req.client);
};

// GET /api/client/dashboard
//
// Per-client KPIs for the client portal home screen (clientmngmt.md §7.5, §9.4):
//   - totalKgDiverted: sum of qtyKg across pickups whose certs are issued/sent
//   - certsReceived:   count of Certificates with status 'sent' (others aren't
//                      yet visible to the client, so they don't count)
//   - lastPickupAt:    most recent pickup.createdAt (any status — gives the
//                      client a "last contact" feel even if cert isn't out)
//   - co2eAvoided:     derived from the same per-stream totals
//   - upcomingPickups: next 3 by scheduledDate where the client expects the team
//
// Everything is filtered by `client: req.client._id` — that's the ownership
// boundary. No cross-client leakage possible.
const getDashboard = async (req, res) => {
  try {
    const clientId = req.client._id;

    // Pickups whose certs are issued or sent → these are the "diverted" totals
    // that the client portal mirrors from the public stats methodology.
    const eligiblePickups = await Pickup.find({
      client: clientId,
      status: { $in: ["cert-issued", "cert-sent"] },
    })
      .select("lineItems")
      .lean();

    // One pass to roll up kg per stream + a grand total, mirroring the stats job.
    const byStreamMap = new Map();
    let totalKgDiverted = 0;
    for (const p of eligiblePickups) {
      for (const li of p.lineItems || []) {
        const kg = Number(li.qtyKg) || 0;
        byStreamMap.set(
          li.stream,
          (byStreamMap.get(li.stream) || 0) + kg
        );
        totalKgDiverted += kg;
      }
    }
    const co2eAvoided = co2eForLineItems(
      Array.from(byStreamMap.entries()).map(([stream, kg]) => ({
        stream,
        qtyKg: kg,
      }))
    );

    // Only `sent` certs are visible to the client — issued-but-not-yet-sent
    // are still being reviewed by the manager and shouldn't show up here.
    const certsReceived = await Certificate.countDocuments({
      client: clientId,
      status: "sent",
    });

    // "Last contact" signal — any pickup, any status. Helps the client see
    // we're working even if the cert isn't out yet.
    const lastPickup = await Pickup.findOne({ client: clientId })
      .sort({ createdAt: -1 })
      .select("createdAt")
      .lean();

    // Next-3 schedule strip. We intentionally exclude `requested` (not yet
    // confirmed by coordinator) — only confirmed and in-flight pickups.
    const upcomingPickups = await Pickup.find({
      client: clientId,
      status: { $in: ["accepted", "scheduled", "en-route"] },
    })
      .sort({ scheduledDate: 1 })
      .limit(3)
      .select("pickupID status scheduledDate requestedStreams supervisor")
      .lean();

    return res.json({
      totalKgDiverted: Math.round(totalKgDiverted * 100) / 100,
      certsReceived,
      lastPickupAt: lastPickup?.createdAt || null,
      co2eAvoided: Math.round(co2eAvoided * 100) / 100,
      upcomingPickups,
    });
  } catch (err) {
    console.error("getDashboard error:", err.message);
    return res.status(500).json({ message: err.message });
  }
};

// GET /api/client/certificates?status=&limit=&offset=
//
// Lists the certificates owned by the logged-in client. Filters:
//   - Only `sent` and `superseded` are user-facing. `draft` AND `issued` are
//     manager-only: issuing renders the PDF but the cert is still under
//     manager review until they explicitly hit Send (clientmngmt.md §8.2,
//     §11.5). We hard-filter both out even if the caller passes ?status=issued.
//   - `superseded` stays visible because it is only reachable from `sent`
//     (see reviseCertificate's status guard), so the client already has it —
//     hiding it would make previously-delivered certs vanish from their history.
//   - Optional ?status=sent narrows further within the visible set.
//
// Pagination:
//   - limit defaults to 20, capped at 100. offset defaults to 0.
//
// Sort:
//   - issuedAt desc so newest legal records are top. Nulls (drafts) are
//     filtered out anyway, so the sort is stable.
const listMyCertificates = async (req, res) => {
  try {
    const clientId = req.client._id;

    // User-facing statuses only. Drafts and issued-but-unsent are excluded at
    // the query level so a malicious ?status=draft / ?status=issued can't leak
    // them. Keep in sync with CLIENT_VISIBLE_CERT_STATUSES below.
    const visibleStatuses = CLIENT_VISIBLE_CERT_STATUSES;
    let statusFilter = { $in: visibleStatuses };
    if (req.query.status && visibleStatuses.includes(req.query.status)) {
      statusFilter = req.query.status;
    }

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const filter = { client: clientId, status: statusFilter };

    // Count + page in parallel to keep latency low on big histories.
    const [total, items] = await Promise.all([
      Certificate.countDocuments(filter),
      Certificate.find(filter)
        .sort({ issuedAt: -1 })
        .skip(offset)
        .limit(limit)
        .populate("pickup", "pickupID scheduledDate")
        .lean(),
    ]);

    return res.json({ items, total, limit, offset });
  } catch (err) {
    console.error("listMyCertificates error:", err.message);
    return res.status(500).json({ message: err.message });
  }
};

// GET /api/client/certificates/:id/download
//
// Returns a 5-minute presigned S3 GetObject URL for the cert PDF. The
// frontend opens the URL directly (no proxy through this backend — keeps
// the response payload tiny and lets the browser stream the PDF).
//
// Guards:
//   - Ownership: cert.client must match req.client._id (404 otherwise to
//     avoid enumeration of cert IDs).
//   - PDF presence: drafts and never-rendered certs have no pdf.key → 404.
//
// Why 5 minutes:
//   - Long enough for any reasonable network hiccup on the client's link
//     click, short enough that a leaked URL from an email forward / log
//     becomes useless quickly. The portal re-generates a fresh URL on
//     every download click anyway (clientmngmt.md §18 → cert edge cases).
const downloadMyCertificate = async (req, res) => {
  try {
    const clientId = req.client._id;
    const certId = req.params.id;

    const cert = await Certificate.findOne({
      _id: certId,
      client: clientId,
    }).lean();

    if (!cert) {
      // Same 404 for both "doesn't exist" and "not yours" → no enumeration.
      return res.status(404).json({ message: "Certificate not found" });
    }

    // Ownership alone is NOT enough: a draft or issued-but-unsent cert belongs
    // to this client but is still under manager review. Without this guard a
    // client who learned an id (e.g. from a socket event or an earlier build
    // that listed issued certs) could pull the PDF before it was ever sent.
    // Same 404 as above so the endpoint never confirms the cert exists.
    if (!CLIENT_VISIBLE_CERT_STATUSES.includes(cert.status)) {
      return res.status(404).json({ message: "Certificate not found" });
    }

    if (!cert.pdf || !cert.pdf.key) {
      // Either a draft (no PDF rendered yet) or a rendering failure that left
      // the cert without an S3 object. Both are 404 from the client's POV.
      return res
        .status(404)
        .json({ message: "Certificate PDF not available" });
    }

    const s3 = getS3Client();
    const command = new GetObjectCommand({
      Bucket: cert.pdf.bucket,
      Key: cert.pdf.key,
    });

    // 300 seconds = 5 minutes. See header comment for rationale.
    const url = await getSignedUrl(s3, command, { expiresIn: 300 });

    return res.json({
      url,
      expiresIn: 300,
      fileName: `${cert.certNumber}.pdf`,
    });
  } catch (err) {
    console.error("downloadMyCertificate error:", err.message);
    return res.status(500).json({ message: err.message });
  }
};

// ---- Monthly reports (Environmental Impact + GHG) ------------------------
//
// Same two-endpoint shape as certificates — list, then presign on click — and
// crucially the SAME visibility rule: a report the manager has merely issued
// is still internal. `CLIENT_VISIBLE_REPORT_STATUSES` is a distinct constant
// from the certificate one so the two documents' rules can diverge later
// without one silently inheriting a change meant for the other.
const CLIENT_VISIBLE_REPORT_STATUSES = ["sent", "superseded"];

// GET /api/client/reports?type=impact|ghg&year=&limit=&offset=
const listMyReports = async (req, res) => {
  try {
    const clientId = req.client._id;

    let statusFilter = { $in: CLIENT_VISIBLE_REPORT_STATUSES };
    if (
      req.query.status &&
      CLIENT_VISIBLE_REPORT_STATUSES.includes(req.query.status)
    ) {
      statusFilter = req.query.status;
    }

    const filter = { client: clientId, status: statusFilter };
    if (["impact", "ghg"].includes(req.query.type)) filter.type = req.query.type;
    const year = parseInt(req.query.year, 10);
    if (Number.isInteger(year)) filter.periodYear = year;

    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const [total, items] = await Promise.all([
      Report.countDocuments(filter),
      Report.find(filter)
        // Newest reporting period first — not sentAt, so a late-sent report
        // for an old month still files under that month.
        .sort({ periodYear: -1, periodMonth: -1, revision: -1 })
        .skip(offset)
        .limit(limit)
        // Internal audit fields stay server-side.
        .select("-pickupIdsSnapshot -issuedBy -sentBy -pdf")
        .lean(),
    ]);

    return res.json({ items, total, limit, offset });
  } catch (err) {
    console.error("listMyReports error:", err.message);
    return res.status(500).json({ message: err.message });
  }
};

// GET /api/client/reports/:id/download
const downloadMyReport = async (req, res) => {
  try {
    const clientId = req.client._id;
    const reportId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(reportId)) {
      return res.status(404).json({ message: "Report not found" });
    }

    const report = await Report.findOne({
      _id: reportId,
      client: clientId,
    }).lean();

    // Same 404 for "doesn't exist" and "not yours" → no enumeration.
    if (!report) return res.status(404).json({ message: "Report not found" });

    // Ownership is not enough — a draft or issued-but-unsent report belongs to
    // this client but has not been released. Identical guard to
    // downloadMyCertificate; see that handler for the full rationale.
    if (!CLIENT_VISIBLE_REPORT_STATUSES.includes(report.status)) {
      return res.status(404).json({ message: "Report not found" });
    }

    if (!report.pdf || !report.pdf.key) {
      return res.status(404).json({ message: "Report PDF not available" });
    }

    const s3 = getS3Client();
    const command = new GetObjectCommand({
      Bucket: report.pdf.bucket,
      Key: report.pdf.key,
    });
    const url = await getSignedUrl(s3, command, { expiresIn: 300 });

    return res.json({
      url,
      expiresIn: 300,
      fileName: `${report.reportNumber}.pdf`,
    });
  } catch (err) {
    console.error("downloadMyReport error:", err.message);
    return res.status(500).json({ message: err.message });
  }
};

// GET /api/client/sites
//
// The client's own buildings, so the pickup request form can tag which site
// the waste is coming from. That tag is what the monthly GHG report groups by.
const listMySites = async (req, res) => {
  try {
    const sites = await Site.find({ client: req.client._id, isActive: true })
      .select("name description address")
      .sort({ name: 1 })
      .lean();
    return res.json({ items: sites, total: sites.length });
  } catch (err) {
    console.error("listMySites error:", err.message);
    return res.status(500).json({ message: err.message });
  }
};

module.exports = {
  loginClient,
  getMe,
  getDashboard,
  listMyCertificates,
  listMyReports,
  downloadMyReport,
  listMySites,
  downloadMyCertificate,
};
