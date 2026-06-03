/*
  Supervisor Pickup Controller — Client Management module (Phase 1, Chunk 2)

  Purpose:
  - Field-execution endpoints used by any user with `canSupervise: true`
    (Employee / Manager / Admin) to advance a pickup through its status machine
    with photo + GPS evidence at each stage.

  Endpoints implemented:
  - GET   /api/{role}/my-pickups
        listMyPickups — pickups where the current user is the assigned supervisor.
        Supports ?status=<csv> (e.g. accepted,en-route,at-client), ?limit, ?offset.

  - PATCH /api/{role}/my-pickups/:id/status   (multipart, photo)
        updatePickupStatus — append an evidence entry, advance pickup.status, fan
        out socket + push notifications. Photo is mandatory for
        en-route|at-client|picked-up|at-facility|weighed transitions.

  State machine (subset enforced here — see clientmngmt.md §8.1):

       accepted ──▶ en-route ──▶ at-client ──▶ picked-up ──▶ at-facility ──▶ weighed
       scheduled ─▶ en-route
       accepted ──▶ postponed ──▶ scheduled
       scheduled ─▶ postponed

  Status transitions BEFORE 'en-route' (e.g. accept, schedule, postpone-from-coord)
  are not done here — Backend E (admin triage) owns those. After 'weighed', the
  waste-data endpoint takes over.

  Auth model:
  - This file is role-agnostic. The auth middleware (authEmployee / authManager /
    authMiddleware) runs first and sets req.employee / req.manager / req.admin.
    `getCurrentUser` normalizes whichever ran into a single shape.
  - The route layer (routes/supervisorPickupRoutes.js) mounts the SAME controller
    under three role prefixes, each guarded by its own auth middleware.

  Notes:
  - We DEFENSIVELY enforce `canSupervise: true` on the current user, in addition
    to the ownership check (`pickup.supervisor.userId === me`). A user could
    technically be assigned and then have the flag revoked — we refuse the call
    in that case.
  - Photo upload via multer (in-memory, 5 MB cap, image MIME only). Mirrors the
    `checkInUpload` pattern from controllers/attendanceController.js.
*/

const multer = require("multer");
const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");
const Certificate = require("../models/Certificate");
const { uploadPickupEvidence } = require("../utils/s3");
const { notifyIfEnabled, sendPush } = require("../utils/push");
const { generateCertNumber } = require("../utils/certNumber");
const { getIo } = require("../socketHandler");

// Stream enum mirror — kept in sync with Pickup.wasteLineItemSchema.stream.
// Duplicated here (rather than introspecting the schema) so a typo'd update
// fails noisily at this layer. If you add a new stream to Pickup.js, add it
// here too.
const VALID_STREAMS = new Set([
    "plastic",
    "paper",
    "ewaste",
    "biomedical",
    "foam-thermocol",
    "dry-waste",
    "agr",
    "battery",
    "expired-food",
    "hazardous",
    "other",
]);

// In-memory multer for pickup-evidence photos. Same constraints as check-in
// selfies (5 MB cap, image MIME only) so the supervisor camera component can be
// reused on the frontend.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype)) {
            return cb(new Error("Only image/jpeg, image/png, image/webp allowed"));
        }
        cb(null, true);
    },
}).single("photo");

// In-memory multer for the OPTIONAL weighbridge slip photo accompanying the
// waste-data submission. Field name `weighbridgePhoto`. Same 5 MB cap +
// image MIME filter as the status-evidence upload. Decoupled middleware so the
// route layer can wire it independently of `upload`.
const wasteDataUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype)) {
            return cb(new Error("Only image/jpeg, image/png, image/webp allowed"));
        }
        cb(null, true);
    },
}).single("weighbridgePhoto");

// Valid next-status transitions for the supervisor flow. Anything outside this
// map is rejected with 409. See clientmngmt.md §8.1 for the full state machine.
const ALLOWED_NEXT = {
    "accepted": ["en-route", "postponed"],
    "scheduled": ["en-route", "postponed"],
    "postponed": ["scheduled"],
    "en-route": ["at-client"],
    "at-client": ["picked-up"],
    "picked-up": ["at-facility"],
    "at-facility": ["weighed"],
    // After 'weighed', the waste-data endpoint takes over (out of scope here).
};

// Statuses that REQUIRE a photo evidence on transition. Other statuses
// (postponed, scheduled) accept the call with no photo.
const PHOTO_REQUIRED_FOR = new Set([
    "en-route",
    "at-client",
    "picked-up",
    "at-facility",
    "weighed",
]);

// User-facing notification copy per status (sent to the client's push
// subscription if they have one). Quiet statuses are intentionally absent.
const CLIENT_NOTIFICATION = {
    "en-route": {
        title: "Pickup on the way",
        body: "Your pickup team is on the way.",
    },
    "at-client": {
        title: "Pickup team arrived",
        body: "Your pickup team has arrived at your location.",
    },
    "picked-up": {
        title: "Waste collected",
        body: "Your waste has been collected. It is on its way to our facility.",
    },
    "at-facility": {
        title: "Arrived at facility",
        body: "Your waste has arrived at the Resrishti facility.",
    },
    "weighed": {
        title: "Waste weighed",
        body: "Your waste has been weighed. Certificate coming soon.",
    },
};

/**
 * Normalize the authenticated principal regardless of which auth middleware ran.
 * Returns null when no role is set (defensive — shouldn't happen since the
 * route is always behind one of the three protect middlewares).
 */
const getCurrentUser = (req) => {
    if (req.admin) {
        return {
            userType: "Admin",
            userId: req.admin._id,
            name: req.admin.email,
            doc: req.admin,
            Model: Admin,
        };
    }
    if (req.manager) {
        return {
            userType: "Manager",
            userId: req.manager._id,
            name: req.manager.name || req.manager.email,
            doc: req.manager,
            Model: Manager,
        };
    }
    if (req.employee) {
        return {
            userType: "Employee",
            userId: req.employee._id,
            name: req.employee.name || req.employee.email,
            doc: req.employee,
            Model: Employee,
        };
    }
    return null;
};

/**
 * Re-fetch the user from its model to confirm `canSupervise: true`. The token's
 * payload doesn't carry flags, and the `protect*` middlewares strip the
 * password but otherwise return the doc — `canSupervise` should already be on
 * `me.doc`, but we re-check from the DB to honor a freshly-revoked flag.
 */
const assertCanSupervise = async (me) => {
    if (!me || !me.Model || !me.userId) return false;
    // If the protect middleware loaded the full doc, prefer it (no extra round trip).
    if (typeof me.doc?.canSupervise === "boolean") return me.doc.canSupervise === true;
    const fresh = await me.Model.findById(me.userId).select("canSupervise").lean();
    return !!(fresh && fresh.canSupervise === true);
};

// GET /api/{role}/my-pickups
//
// Query params:
//   - status: optional CSV of statuses to filter (e.g. 'accepted,en-route').
//   - limit:  optional, defaults to 50, clamped to [1, 200].
//   - offset: optional, defaults to 0.
//
// Sorted by scheduledDate ascending (next pickup first), tiebroken by createdAt.
const listMyPickups = async (req, res) => {
    try {
        const me = getCurrentUser(req);
        if (!me) return res.status(401).json({ message: "Not authorized" });

        const filter = { "supervisor.userId": me.userId };

        // Multi-status filter: ?status=accepted,en-route,at-client
        const statusRaw = (req.query.status || "").toString().trim();
        if (statusRaw) {
            const statuses = statusRaw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            if (statuses.length === 1) {
                filter.status = statuses[0];
            } else if (statuses.length > 1) {
                filter.status = { $in: statuses };
            }
        }

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const [items, total] = await Promise.all([
            Pickup.find(filter)
                .populate("client", "name contactName billingAddress")
                .sort({ scheduledDate: 1, createdAt: 1 })
                .skip(offset)
                .limit(limit),
            Pickup.countDocuments(filter),
        ]);

        return res.json({ items, total, limit, offset });
    } catch (err) {
        console.error("listMyPickups error:", err);
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/{role}/my-pickups/:id/status   (multipart)
//
// Body (multipart fields):
//   - status: required, the next status.
//   - lat:    optional, but recommended.
//   - lng:    optional.
//   - notes:  optional.
// File field:
//   - photo:  MANDATORY for transitions in PHOTO_REQUIRED_FOR.
const updatePickupStatus = async (req, res) => {
    try {
        const me = getCurrentUser(req);
        if (!me) return res.status(401).json({ message: "Not authorized" });

        // Defensive supervisor capability check — even an assigned user could
        // have had the flag revoked after assignment.
        const canSup = await assertCanSupervise(me);
        if (!canSup) {
            return res.status(403).json({ message: "You do not have supervisor permission" });
        }

        const { id } = req.params;
        const newStatus = (req.body.status || "").toString().trim();
        if (!newStatus) {
            return res.status(400).json({ message: "status is required" });
        }

        const pickup = await Pickup.findById(id);
        if (!pickup) return res.status(404).json({ message: "Pickup not found" });

        // Ownership check — only the assigned supervisor (or no other role) can
        // advance the pickup. Compare ObjectIds via .toString() to dodge type
        // mismatch issues.
        const assignedId = pickup.supervisor && pickup.supervisor.userId;
        if (!assignedId || assignedId.toString() !== me.userId.toString()) {
            return res.status(403).json({ message: "You are not the assigned supervisor for this pickup" });
        }

        // State-machine guard.
        const allowed = ALLOWED_NEXT[pickup.status] || [];
        if (!allowed.includes(newStatus)) {
            return res.status(409).json({
                message: `Invalid transition from ${pickup.status} to ${newStatus}`,
                allowed,
            });
        }

        // Photo requirement — for the field-evidence statuses we need a buffer.
        const needsPhoto = PHOTO_REQUIRED_FOR.has(newStatus);
        if (needsPhoto && (!req.file || !req.file.buffer)) {
            return res.status(400).json({ message: `Photo evidence is required for status '${newStatus}'` });
        }

        // Upload to S3 (only when we have a photo — postponed/scheduled may skip).
        let photo;
        if (req.file && req.file.buffer) {
            try {
                photo = await uploadPickupEvidence({
                    pickupID: pickup.pickupID || String(pickup._id),
                    status: newStatus,
                    buffer: req.file.buffer,
                    contentType: req.file.mimetype || "image/jpeg",
                });
            } catch (uploadErr) {
                console.error("Pickup evidence upload failed:", uploadErr);
                return res.status(500).json({ message: "Failed to store pickup evidence photo" });
            }
        }

        // Parse GPS — both fields must be valid numbers to be recorded.
        const lat = req.body.lat !== undefined ? Number(req.body.lat) : undefined;
        const lng = req.body.lng !== undefined ? Number(req.body.lng) : undefined;
        const gpsValid = Number.isFinite(lat) && Number.isFinite(lng);

        const evidenceEntry = {
            status: newStatus,
            photo: photo || undefined,
            gps: gpsValid ? { lat, lng } : undefined,
            at: new Date(),
            by: {
                userType: me.userType,
                userId: me.userId,
                name: me.name,
            },
        };

        pickup.evidence = pickup.evidence || [];
        pickup.evidence.push(evidenceEntry);
        pickup.status = newStatus;
        if (req.body.notes) {
            // Append to clientNotes-adjacent supervisor log if model has one;
            // otherwise stash on the evidence entry. We don't want to silently
            // drop the field — store it as part of evidence.notes if shape allows.
            evidenceEntry.notes = req.body.notes;
        }

        await pickup.save();

        // Fan out: socket → live pickup room (client portal listens for status updates).
        try {
            const io = getIo();
            io.to(`pickup_${pickup._id}`).emit("pickup:status-updated", {
                pickupId: pickup._id,
                status: newStatus,
                evidence: evidenceEntry,
            });
        } catch (socketErr) {
            // Socket failures are non-fatal — log and continue.
            console.error("Socket emit error (pickup status):", socketErr.message || socketErr);
        }

        // Push notification to the client (best-effort, gated by admin toggle).
        const notif = CLIENT_NOTIFICATION[newStatus];
        if (notif) {
            try {
                const client = await Client.findById(pickup.client).select("pushSubscription").lean();
                if (client && client.pushSubscription) {
                    await notifyIfEnabled("pickup", client.pushSubscription, {
                        title: notif.title,
                        body: notif.body,
                        icon: "/android-chrome-512x512.png",
                        data: { url: `/client/pickups/${pickup._id}` },
                    });
                }
            } catch (pushErr) {
                console.error("Client push error (pickup status):", pushErr.message || pushErr);
            }
        }

        return res.json(pickup);
    } catch (err) {
        console.error("updatePickupStatus error:", err);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/{role}/my-pickups/:id/waste-data   (multipart, optional photo)
//
// This is the SOLE entry point for advancing a pickup from `weighed` to
// `processed`. The generic status endpoint rejects that transition (it isn't
// in ALLOWED_NEXT) — supervisors must submit line-item data here.
//
// On success this endpoint:
//   1. Validates + dedupes line items.
//   2. Optionally uploads a single shared weighbridge photo and stamps it
//      on every line item.
//   3. Updates the pickup: lineItems, totalKg, wasteDataEnteredAt/By,
//      status → 'processed' (with an evidence entry).
//   4. Auto-creates a draft Certificate (fresh certNumber, snapshots populated).
//   5. Links pickup.certificate, flips status → 'cert-draft' (with a 2nd
//      evidence entry).
//   6. Emits Socket.IO 'pickup:status-updated' to pickup_<id>.
//   7. Push-notifies coordinators (Admins + Managers w/ canCoordinate=true).
//
// Body (multipart fields):
//   - lineItems: REQUIRED. Sent as a JSON-stringified array because multipart
//     can't carry arrays natively. Shape: [{ stream, qtyKg, notes? }, ...].
// File field:
//   - weighbridgePhoto: OPTIONAL. One shared photo applied to all line items.
const recordWasteData = async (req, res) => {
    try {
        const me = getCurrentUser(req);
        if (!me) return res.status(401).json({ message: "Not authorized" });

        // Same defensive supervisor gate as updatePickupStatus — a flag could
        // have been revoked after assignment.
        const canSup = await assertCanSupervise(me);
        if (!canSup) {
            return res.status(403).json({ message: "You do not have supervisor permission" });
        }

        const { id } = req.params;
        const pickup = await Pickup.findById(id);
        if (!pickup) return res.status(404).json({ message: "Pickup not found" });

        // Ownership check — only the assigned supervisor can submit waste data.
        const assignedId = pickup.supervisor && pickup.supervisor.userId;
        if (!assignedId || assignedId.toString() !== me.userId.toString()) {
            return res.status(403).json({ message: "You are not the assigned supervisor for this pickup" });
        }

        // State check — waste data is only meaningful from the `weighed` state.
        // We expose the allowed list so the frontend can render an informative
        // error rather than just a 409.
        if (pickup.status !== "weighed") {
            return res.status(409).json({
                message: `Waste data can only be recorded when pickup status is 'weighed' (current: '${pickup.status}')`,
                allowedFromStatus: ["weighed"],
            });
        }

        // --- Parse line items ---------------------------------------------
        // multipart/form-data carries strings only — `lineItems` must arrive
        // as a JSON-stringified array. We tolerate the (unlikely) case where
        // express body parsing somehow handed us an actual array directly.
        let rawLineItems = req.body.lineItems;
        if (typeof rawLineItems === "string") {
            try {
                rawLineItems = JSON.parse(rawLineItems);
            } catch (parseErr) {
                return res.status(400).json({
                    message: "lineItems must be a JSON-stringified array",
                });
            }
        }
        if (!Array.isArray(rawLineItems) || rawLineItems.length === 0) {
            return res.status(400).json({ message: "lineItems must be a non-empty array" });
        }

        // --- Validate + dedupe --------------------------------------------
        // Per spec: duplicate streams are merged (qty summed) with a warning
        // surfaced in the response, NOT a rejection. This is forgiving for
        // supervisors typing on a phone keypad.
        const merged = new Map();   // stream -> { stream, qtyKg, notes }
        const warnings = [];
        for (let i = 0; i < rawLineItems.length; i += 1) {
            const item = rawLineItems[i] || {};
            const stream = String(item.stream || "").trim();
            const qtyKg = Number(item.qtyKg);

            if (!stream || !VALID_STREAMS.has(stream)) {
                return res.status(400).json({
                    message: `lineItems[${i}].stream is required and must be one of: ${Array.from(VALID_STREAMS).join(", ")}`,
                });
            }
            if (!Number.isFinite(qtyKg) || qtyKg <= 0) {
                return res.status(400).json({
                    message: `lineItems[${i}].qtyKg must be a positive number (got ${item.qtyKg})`,
                });
            }

            if (merged.has(stream)) {
                const existing = merged.get(stream);
                existing.qtyKg += qtyKg;
                // Concat notes if both have them; useful breadcrumb for audit.
                if (item.notes) {
                    existing.notes = existing.notes
                        ? `${existing.notes} | ${item.notes}`
                        : String(item.notes);
                }
                warnings.push(`Merged duplicate stream '${stream}'`);
            } else {
                merged.set(stream, {
                    stream,
                    qtyKg,
                    notes: item.notes ? String(item.notes) : undefined,
                });
            }
        }

        const parsedLineItems = Array.from(merged.values());
        const totalKg = parsedLineItems.reduce((acc, li) => acc + li.qtyKg, 0);

        // Zero-weight guard — clientmngmt.md Open Q #15 says skip cert and
        // direct supervisor to cancel the pickup instead.
        if (totalKg === 0) {
            return res.status(400).json({
                message: "Total waste cannot be zero. Mark the pickup as cancelled if nothing was collected.",
            });
        }

        // --- Optional weighbridge photo upload ----------------------------
        // One shared S3 object, attached by reference to every line item.
        // Failures here are non-fatal in spirit but we surface a 500 because
        // the field-team needs to know to retry — silently losing the photo
        // erodes audit trust.
        let sharedPhoto;
        if (req.file && req.file.buffer) {
            try {
                sharedPhoto = await uploadPickupEvidence({
                    pickupID: pickup.pickupID || String(pickup._id),
                    status: "weighbridge",
                    buffer: req.file.buffer,
                    contentType: req.file.mimetype || "image/jpeg",
                });
            } catch (uploadErr) {
                console.error("Weighbridge photo upload failed:", uploadErr);
                return res.status(500).json({ message: "Failed to store weighbridge photo" });
            }
        }
        if (sharedPhoto) {
            for (const li of parsedLineItems) {
                li.weighbridgePhoto = sharedPhoto;
            }
        }

        // --- Mutate pickup ------------------------------------------------
        const now = new Date();
        const actorSnapshot = {
            userType: me.userType,
            userId: me.userId,
            name: me.name,
        };

        pickup.lineItems = parsedLineItems;
        pickup.totalKg = totalKg;
        pickup.wasteDataEnteredAt = now;
        pickup.wasteDataEnteredBy = actorSnapshot;
        pickup.status = "processed";
        pickup.evidence = pickup.evidence || [];
        pickup.evidence.push({
            status: "processed",
            at: now,
            by: actorSnapshot,
            notes: "Waste data entered",
        });
        await pickup.save();

        // --- Auto-create draft Certificate --------------------------------
        // Fetch client name for snapshot. We tolerate a missing client doc
        // (extremely unlikely once a pickup exists) by falling back to the
        // pickup's existing clientNameSnapshot.
        const clientDoc = await Client.findById(pickup.client).select("name").lean();
        const clientName =
            (clientDoc && clientDoc.name) || pickup.clientNameSnapshot || "";

        // Cert numbering — atomic via the Counter model.
        let certNumber;
        try {
            certNumber = await generateCertNumber();
        } catch (numErr) {
            console.error("Cert number generation failed:", numErr);
            return res.status(500).json({ message: "Failed to generate certificate number" });
        }

        let cert;
        try {
            cert = await Certificate.create({
                certNumber,
                revision: 1,
                pickup: pickup._id,
                client: pickup.client,
                status: "draft",
                lineItemsSnapshot: parsedLineItems.map((li) => ({
                    stream: li.stream,
                    qtyKg: li.qtyKg,
                })),
                totalKgSnapshot: totalKg,
                clientNameSnapshot: clientName,
                // Prefer the scheduled date; fall back to the time waste was
                // entered, then to creation. This is "when the pickup
                // happened" for the CoD body.
                pickupDateSnapshot:
                    pickup.scheduledDate || pickup.wasteDataEnteredAt || now,
            });
        } catch (certErr) {
            // The cert number was already consumed by the Counter (it's a
            // monotonic sequence — we never reuse). The next call will get a
            // higher number. Leave the pickup in 'processed' so a retry hits
            // the state-machine guard cleanly; the field-team can resubmit
            // after the underlying problem is fixed.
            console.error("Certificate draft creation failed:", certErr);
            return res.status(500).json({
                message: "Failed to draft certificate. Pickup recorded as 'processed' — retry from waste-data form.",
                pickup,
            });
        }

        // Link cert back onto pickup and advance status. Second evidence row
        // captures the cert-draft transition for the audit trail.
        pickup.certificate = cert._id;
        pickup.status = "cert-draft";
        pickup.evidence.push({
            status: "cert-draft",
            at: new Date(),
            by: actorSnapshot,
            notes: "Certificate drafted",
        });
        await pickup.save();

        // --- Socket.IO fanout --------------------------------------------
        // Two events would be technically more correct (processed THEN
        // cert-draft) but the client portal only cares about the latest
        // status — one emission with the terminal status suffices.
        try {
            const io = getIo();
            io.to(`pickup_${pickup._id}`).emit("pickup:status-updated", {
                pickupId: pickup._id,
                status: pickup.status,
                evidence: pickup.evidence[pickup.evidence.length - 1],
            });
        } catch (socketErr) {
            console.error("Socket emit error (waste-data):", socketErr.message || socketErr);
        }

        // --- Push notification to coordinators ---------------------------
        // Same recipient set as the new-request notification — Admins +
        // Managers with canCoordinate=true AND a stored push subscription.
        // sendPush is fire-and-forget per recipient.
        try {
            const [admins, managers] = await Promise.all([
                Admin.find({
                    canCoordinate: true,
                    pushSubscription: { $exists: true, $ne: null },
                })
                    .select("pushSubscription")
                    .lean(),
                Manager.find({
                    canCoordinate: true,
                    pushSubscription: { $exists: true, $ne: null },
                })
                    .select("pushSubscription")
                    .lean(),
            ]);
            const recipients = [...admins, ...managers];
            const payload = {
                title: "Certificate ready for review",
                body: `${clientName} — ${pickup.pickupID} (${totalKg.toFixed(1)} kg)`,
                icon: "/android-chrome-512x512.png",
                tag: `cert-draft-${cert._id}`,
                data: {
                    url: `/manager/dashboard?tab=certificates&id=${cert._id}`,
                },
            };
            await Promise.all(
                recipients
                    .filter((r) => r.pushSubscription)
                    .map((r) => sendPush(r.pushSubscription, payload))
            );
        } catch (pushErr) {
            console.error("Coordinator push notify failed (cert-draft):", pushErr.message || pushErr);
        }

        return res.json({ pickup, certificate: cert, warnings });
    } catch (err) {
        console.error("recordWasteData error:", err);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    listMyPickups,
    updatePickupStatus,
    recordWasteData,
    upload,
    wasteDataUpload,
    // Exported for tests / introspection.
    ALLOWED_NEXT,
    PHOTO_REQUIRED_FOR,
    VALID_STREAMS,
};
