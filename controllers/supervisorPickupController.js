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

  - PATCH /api/{role}/my-pickups/:id/status   (multipart, photos[])
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
const mongoose = require("mongoose");
const Pickup = require("../models/Pickup");
// Live-tracking window + cap live on the model so the client controller and
// this one agree on exactly when tracking is visible. V2_FIELD_STATUSES is the
// ordered list of the seven new pipeline stages.
const { TRACKING_ACTIVE_STATUSES, MAX_TRACKING_POINTS, V2_FIELD_STATUSES } = Pickup;
const Client = require("../models/Client");
// Shared pickup-creation path, so a staff-created pickup is identical to a
// client self-requested one (same validation, status, snapshots, notifications).
const {
    createPickupForClient,
    PickupCreationError,
} = require("../services/pickupCreation");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");
const Certificate = require("../models/Certificate");
const { uploadPickupEvidence } = require("../utils/s3");
const { notifyIfEnabled, sendPush } = require("../utils/push");
const { generateCertNumber } = require("../utils/certNumber");
const { getIo } = require("../socketHandler");

// The waste streams are configurable now (models/WasteCategory.js), so the
// old hard-coded mirror is gone. recordWasteData reads the registry on each
// call; this export stays for anything that wants the shipped default list.
const { CORE_CATEGORIES, activeCategories, refreshCache } =
    require("../utils/wasteCategories");
const VALID_STREAMS = new Set(CORE_CATEGORIES.map((c) => c.key));

// Maximum images per status change. Field staff shoot a handful of angles
// (load, weighbridge display, gate, damage); beyond this it's almost certainly
// a stuck finger on the shutter, and each image is a 5 MB upload over mobile
// data. Mirrored on the frontend as MAX_EVIDENCE_PHOTOS.
const MAX_EVIDENCE_PHOTOS = 8;

// In-memory multer for pickup-evidence photos. Same constraints as check-in
// selfies (5 MB cap each, image MIME only) so the supervisor camera component
// can be reused on the frontend.
//
// `.fields()` rather than `.array()` so BOTH shapes are accepted:
//   - photos[]  — current app, one or many images
//   - photo     — older installed builds that still send a single file
// A PWA user on a stale cached bundle would otherwise start getting "Photo
// evidence is required" the moment this deploys, and be unable to work.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: MAX_EVIDENCE_PHOTOS + 1 },
    fileFilter: (req, file, cb) => {
        if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype)) {
            return cb(new Error("Only image/jpeg, image/png, image/webp allowed"));
        }
        cb(null, true);
    },
}).fields([
    { name: "photos", maxCount: MAX_EVIDENCE_PHOTOS },
    { name: "photo", maxCount: 1 },
]);

/**
 * Wraps the multer middleware so upload failures become clear 400s instead of
 * falling through to the generic error handler.
 *
 * This matters much more now that a status change carries several images: with
 * one photo the limits were nearly unreachable, but a supervisor firing off a
 * burst can hit the count cap, and multer's raw wording for that is the deeply
 * unhelpful "Unexpected field". Field staff on a phone need to know whether to
 * remove a photo, retake a smaller one, or call the office.
 */
const uploadEvidence = (req, res, next) => {
    upload(req, res, (err) => {
        if (!err) return next();

        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({
                message: "Each photo must be 5 MB or smaller. Retake it at a lower resolution.",
            });
        }
        if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
            return res.status(400).json({
                message: `You can attach at most ${MAX_EVIDENCE_PHOTOS} photos to one status update.`,
            });
        }
        // fileFilter rejections arrive as a plain Error with our own message.
        return res.status(400).json({
            message: err.message || "Could not read the uploaded photos",
        });
    });
};

/**
 * Flatten multer's `.fields()` output into an ordered file list.
 *
 * `photos[]` comes first so that when a client sends both (belt-and-braces
 * during a rollout), the multi-photo set leads and the legacy single file is
 * appended only if it isn't a duplicate of the first.
 */
const evidenceFilesFrom = (req) => {
    const f = req.files || {};
    const many = Array.isArray(f.photos) ? f.photos : [];
    const single = Array.isArray(f.photo) ? f.photo : [];
    const all = [...many, ...single].filter((x) => x && x.buffer && x.buffer.length);
    return all.slice(0, MAX_EVIDENCE_PHOTOS);
};

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
    // failed / no-show are only offered while the waste is still with the
    // client. Once it is 'picked-up' the collection has happened, so the right
    // correction is the weights, not a failure.
    "accepted": ["en-route", "postponed", "failed", "no-show"],
    "scheduled": ["en-route", "postponed", "failed", "no-show"],
    "postponed": ["scheduled"],
    "en-route": ["at-client", "failed", "no-show"],
    "at-client": ["picked-up", "failed", "no-show"],
    "picked-up": ["at-facility"],
    "at-facility": ["weighed"],
    // After 'weighed', the waste-data endpoint takes over (out of scope here).
};

// Statuses that REQUIRE a photo evidence on transition. Other statuses
// (postponed, scheduled) accept the call with no photo.
// Simplified to the three operational captures (Empty Truck / Fully Loaded /
// Weight Slip). en-route and at-facility are now photo-OPTIONAL confirm steps —
// the backend still accepts photo-less transitions for anything not listed here.
// Mirrored on the frontend by PHOTO_REQUIRED in lib/pickupStatus.js.
const PHOTO_REQUIRED_FOR = new Set([
    "at-client",   // Empty Truck
    "picked-up",   // Fully Loaded Truck
    "weighed",     // Weight Slip
]);

// Outcomes that end the pickup in the field. There is no photo and no weight
// for these, so the reason is the only record of what happened — hence required.
const FIELD_TERMINAL = new Set(["failed", "no-show"]);

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
    // v2 client-meaningful stages (intermediate v2 stages stay quiet).
    "v2-departed": {
        title: "Pickup on the way",
        body: "Your pickup team is on the way.",
    },
    "v2-at-client": {
        title: "Pickup team arrived",
        body: "Your pickup team has arrived at your location.",
    },
    "v2-loaded": {
        title: "Waste collected",
        body: "Your waste has been collected. It is on its way to our facility.",
    },
    "v2-at-facility": {
        title: "Arrived at facility",
        body: "Your waste has arrived at the Resrishti facility.",
    },
    "failed": {
        title: "Pickup could not be completed",
        body: "We couldn't complete your pickup. Our team will be in touch.",
    },
    "no-show": {
        title: "Pickup could not be completed",
        body: "Our team couldn't collect your waste. Our team will be in touch.",
    },
};

// --- v2 (7-stage) state machine — used when pipelineVersion === 2 ---
// Order: departed → empty-weighed → at-client → loading → loaded →
// loaded-weighed → at-facility. Closure (→ 'closed') is a separate P2 endpoint.
const ALLOWED_NEXT_V2 = {
    "accepted": ["v2-departed", "postponed", "failed", "no-show"],
    "scheduled": ["v2-departed", "postponed", "failed", "no-show"],
    "postponed": ["scheduled"],
    "v2-departed": ["v2-empty-weighed", "failed", "no-show"],
    "v2-empty-weighed": ["v2-at-client", "failed", "no-show"],
    "v2-at-client": ["v2-loading", "failed", "no-show"],
    "v2-loading": ["v2-loaded", "failed", "no-show"],
    "v2-loaded": ["v2-loaded-weighed", "failed", "no-show"],
    "v2-loaded-weighed": ["v2-at-facility", "failed", "no-show"],
    "v2-at-facility": [], // Closure handled by the P2 closure endpoint, not here.
};

// Every v2 field stage requires a photo (vs the 3 operational captures in v1).
const PHOTO_REQUIRED_FOR_V2 = new Set(V2_FIELD_STATUSES);

// v2 stages that also capture a weighbridge vehicle weight.
const V2_EMPTY_WEIGH = "v2-empty-weighed";   // body.emptyKg
const V2_LOADED_WEIGH = "v2-loaded-weighed"; // body.loadedKg → net = loaded − empty

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
// File fields:
//   - photos[]: one or more images (up to MAX_EVIDENCE_PHOTOS). At least one is
//               MANDATORY for transitions in PHOTO_REQUIRED_FOR.
//   - photo:    legacy single-file field, still accepted so older installed app
//               builds keep working after this deploys. See `upload` above.
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

        // State machine + photo rules depend on the pipeline version. Legacy
        // (v1) pickups keep the 3-photo flow; v2 pickups run the 7-stage flow
        // where every field stage requires a photo. Grandfathering = we branch
        // here, never rewrite a pickup's version.
        const legacy = Pickup.isLegacyPipeline(pickup);
        const allowedMap = legacy ? ALLOWED_NEXT : ALLOWED_NEXT_V2;
        const photoRequired = legacy ? PHOTO_REQUIRED_FOR : PHOTO_REQUIRED_FOR_V2;

        // State-machine guard.
        const allowed = allowedMap[pickup.status] || [];
        if (!allowed.includes(newStatus)) {
            return res.status(409).json({
                message: `Invalid transition from ${pickup.status} to ${newStatus}`,
                allowed,
            });
        }

        // A failed / no-show pickup must say why.
        const failureReason = String(req.body.reason || "").trim();
        if (FIELD_TERMINAL.has(newStatus) && !failureReason) {
            return res.status(400).json({
                message: `A reason is required when marking a pickup '${newStatus}'`,
            });
        }

        // Photo requirement — for the field-evidence statuses we need at least
        // one image. Accepts `photos[]` (current) or `photo` (older builds).
        const files = evidenceFilesFrom(req);
        const needsPhoto = photoRequired.has(newStatus);
        if (needsPhoto && files.length === 0) {
            return res.status(400).json({
                message: `Photo evidence is required for status '${newStatus}'`,
            });
        }

        // v2 weighbridge stages capture a vehicle weight (cross-check only, not
        // the per-stream source of truth). Validate BEFORE uploading photos so a
        // bad/missing weight fails fast without leaving an orphan image.
        let weightUpdate = null;
        if (!legacy && (newStatus === V2_EMPTY_WEIGH || newStatus === V2_LOADED_WEIGH)) {
            const key = newStatus === V2_EMPTY_WEIGH ? "emptyKg" : "loadedKg";
            const val = Number(req.body[key]);
            if (!Number.isFinite(val) || val <= 0) {
                return res.status(400).json({
                    message: `${key} (a positive number) is required for '${newStatus}'.`,
                });
            }
            const existing = (pickup.vehicleWeights && pickup.vehicleWeights.toObject
                ? pickup.vehicleWeights.toObject() : pickup.vehicleWeights) || {};
            weightUpdate = { ...existing, [key]: val };
            if (newStatus === V2_LOADED_WEIGH) {
                const empty = Number(existing.emptyKg);
                if (!Number.isFinite(empty)) {
                    return res.status(409).json({
                        message: "Empty vehicle weight wasn't recorded at the empty-weighbridge stage; cannot compute net weight.",
                    });
                }
                const net = val - empty;
                if (net <= 0) {
                    return res.status(400).json({
                        message: `Loaded weight (${val}kg) must be greater than empty weight (${empty}kg).`,
                    });
                }
                weightUpdate.netKg = Math.round(net * 100) / 100;
            }
        }

        // v2 loaded-weighbridge stage ALSO captures PRELIMINARY stream-wise
        // weights (the familiar per-stream entry). These are an estimate — the
        // facility re-segregates and the final weights are confirmed at Closure.
        let prelimLineItems = null;
        if (!legacy && newStatus === V2_LOADED_WEIGH) {
            let raw = req.body.lineItems;
            if (typeof raw === "string") {
                try { raw = JSON.parse(raw); }
                catch { return res.status(400).json({ message: "lineItems must be a JSON-stringified array" }); }
            }
            if (!Array.isArray(raw) || raw.length === 0) {
                return res.status(400).json({ message: "Enter at least one waste stream weight at the loaded-weighbridge stage." });
            }
            const validStreams = new Set(await require("../utils/wasteCategories").allStreamKeys());
            const merged = new Map();
            for (let i = 0; i < raw.length; i += 1) {
                const item = raw[i] || {};
                const stream = String(item.stream || "").trim();
                const qtyKg = Number(item.qtyKg);
                if (!stream || !validStreams.has(stream)) {
                    return res.status(400).json({ message: `lineItems[${i}].stream must be one of: ${[...validStreams].join(", ")}` });
                }
                if (!Number.isFinite(qtyKg) || qtyKg <= 0) {
                    return res.status(400).json({ message: `lineItems[${i}].qtyKg must be a positive number` });
                }
                if (merged.has(stream)) merged.get(stream).qtyKg += qtyKg;
                else merged.set(stream, { stream, qtyKg, notes: item.notes ? String(item.notes) : undefined });
            }
            const items = [...merged.values()];
            const total = Math.round(items.reduce((a, li) => a + li.qtyKg, 0) * 100) / 100;
            if (total <= 0) return res.status(400).json({ message: "Total stream weight must be greater than zero." });
            prelimLineItems = { items, total };
        }

        // Upload every image (postponed/scheduled may legitimately send none).
        //
        // All-or-nothing on purpose: if any one image fails we abort BEFORE
        // touching pickup.status. A partial success would advance the pickup
        // while quietly dropping evidence, and the supervisor — already back in
        // the truck — has no way to re-attach it to a status they've passed.
        let photos = [];
        if (files.length > 0) {
            try {
                photos = await Promise.all(
                    files.map((file, index) =>
                        uploadPickupEvidence({
                            pickupID: pickup.pickupID || String(pickup._id),
                            status: newStatus,
                            buffer: file.buffer,
                            contentType: file.mimetype || "image/jpeg",
                            index,
                        })
                    )
                );
            } catch (uploadErr) {
                console.error("Pickup evidence upload failed:", uploadErr);
                return res.status(500).json({
                    message:
                        files.length > 1
                            ? "Failed to store one or more evidence photos — nothing was saved, please retry"
                            : "Failed to store pickup evidence photo",
                });
            }
        }

        // Parse GPS — both fields must be valid numbers to be recorded.
        const lat = req.body.lat !== undefined ? Number(req.body.lat) : undefined;
        const lng = req.body.lng !== undefined ? Number(req.body.lng) : undefined;
        const gpsValid = Number.isFinite(lat) && Number.isFinite(lng);

        const evidenceEntry = {
            status: newStatus,
            photos,
            // Mirror the first image onto the deprecated singular field so any
            // reader not yet updated for `photos[]` still shows something.
            // See the note on evidenceSchema in models/Pickup.js.
            photo: photos[0] || undefined,
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
        if (weightUpdate) pickup.vehicleWeights = weightUpdate;
        if (prelimLineItems) {
            const now = new Date();
            const actor = { userType: me.userType, userId: me.userId, name: me.name };
            const prevTotal = pickup.totalKg || 0;
            pickup.lineItems = prelimLineItems.items;
            pickup.totalKg = prelimLineItems.total;
            pickup.weightsStatus = "preliminary";
            pickup.wasteDataEnteredAt = now;
            pickup.wasteDataEnteredBy = actor;
            pickup.wasteDataHistory = pickup.wasteDataHistory || [];
            pickup.wasteDataHistory.push({
                lineItems: prelimLineItems.items.map((li) => ({ stream: li.stream, qtyKg: li.qtyKg })),
                totalKg: prelimLineItems.total,
                previousTotalKg: prevTotal,
                reason: "Preliminary weights recorded in the field (loaded weighbridge)",
                at: now,
                by: actor,
            });
        }
        if (FIELD_TERMINAL.has(newStatus)) {
            pickup.failureReason = failureReason;
            evidenceEntry.notes = failureReason;
        }
        if (req.body.notes) {
            // Append to clientNotes-adjacent supervisor log if model has one;
            // otherwise stash on the evidence entry. We don't want to silently
            // drop the field — store it as part of evidence.notes if shape allows.
            evidenceEntry.notes = req.body.notes;
        }

        // Live tracking goes dark the moment the pickup leaves the active window
        // (weighed / failed / no-show / postponed). Stamping endedAt here is what
        // makes the client-facing tracking endpoints stop serving the link/trail
        // — the client can no longer view or copy it once the pickup moves on.
        if (
            pickup.tracking &&
            pickup.tracking.mode &&
            !pickup.tracking.endedAt &&
            !TRACKING_ACTIVE_STATUSES.includes(newStatus)
        ) {
            pickup.tracking.endedAt = new Date();
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
        // Streams come from the admin-editable registry. Corrections to an old
        // pickup may reference a stream since switched off, so every configured
        // key is accepted here — switching one off only hides it from the
        // client's request form.
        const validStreams = new Set(await require("../utils/wasteCategories").allStreamKeys());
        const merged = new Map();   // stream -> { stream, qtyKg, notes }
        const warnings = [];
        for (let i = 0; i < rawLineItems.length; i += 1) {
            const item = rawLineItems[i] || {};
            const stream = String(item.stream || "").trim();
            const qtyKg = Number(item.qtyKg);

            if (!stream || !validStreams.has(stream)) {
                return res.status(400).json({
                    message: `lineItems[${i}].stream is required and must be one of: ${Array.from(validStreams).join(", ")}`,
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

        // Partial collection — only some of the waste was taken. A flag rather
        // than a status, so the pickup still certifies what WAS collected.
        const isPartial = req.body.isPartial === true || String(req.body.isPartial) === "true";
        const partialReason = String(req.body.partialReason || "").trim();
        if (isPartial && !partialReason) {
            return res.status(400).json({
                message: "partialReason is required when marking a pickup as a partial collection",
            });
        }

        const previousTotalKg = pickup.totalKg || 0;
        pickup.lineItems = parsedLineItems;
        pickup.totalKg = totalKg;
        pickup.isPartial = isPartial;
        pickup.partialReason = isPartial ? partialReason : undefined;
        pickup.wasteDataEnteredAt = now;
        pickup.wasteDataEnteredBy = actorSnapshot;
        // First entry in the weight audit trail; corrections append to it.
        pickup.wasteDataHistory = pickup.wasteDataHistory || [];
        pickup.wasteDataHistory.push({
            lineItems: parsedLineItems.map((li) => ({ stream: li.stream, qtyKg: li.qtyKg })),
            totalKg,
            previousTotalKg,
            reason: isPartial ? `Recorded in the field — partial: ${partialReason}` : "Recorded in the field",
            at: now,
            by: actorSnapshot,
        });
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

/**
 * GET /api/{employee|manager|admin}/my-pickups/waste-categories
 *
 * The streams a supervisor may record weights against, so the waste-data form
 * shows the same list the office configured instead of a bundled copy.
 */
const listWasteCategories = async (req, res) => {
    try {
        await refreshCache();
        const items = activeCategories().map((c) => ({ key: c.key, label: c.label }));
        return res.json({ items, total: items.length });
    } catch (err) {
        console.error("listWasteCategories error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// ==================== CREATE ON BEHALF OF CLIENT ====================
//
// Lets an authorized Pickup Agent (canSupervise:true) originate a pickup for an
// existing client — the temporary workaround while client self-onboarding is
// off. Reuses the shared createPickupForClient service so the result is
// indistinguishable from a client-requested pickup (status "requested", no
// supervisor, appears in the client's portal, flows through normal triage).

// GET /api/{role}/my-pickups/clients?search=&limit=
// Slim client list for the "select existing client" picker. Pickup-agent gated.
const listClientsForPickup = async (req, res) => {
    try {
        const me = getCurrentUser(req);
        if (!me || !me.doc || me.doc.canSupervise !== true) {
            return res.status(403).json({ message: "Pickup agent access required" });
        }
        const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
        const filter = { status: { $ne: "churned" } };
        if (req.query.search) {
            const safe = String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const rx = new RegExp(safe, "i");
            filter.$or = [
                { name: rx },
                { contactName: rx },
                { contactEmail: rx },
                { contactPhone: rx },
            ];
        }
        const items = await Client.find(filter)
            .select("name contactName contactEmail contactPhone status")
            .sort({ name: 1 })
            .limit(limit)
            .lean();
        return res.json({ items });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/{role}/my-pickups  { clientId, requestedDate, requestedStreams, clientNotes?, siteId? }
const createPickupOnBehalf = async (req, res) => {
    try {
        const me = getCurrentUser(req);
        if (!me || !me.doc || me.doc.canSupervise !== true) {
            return res.status(403).json({ message: "Pickup agent access required" });
        }
        const { clientId } = req.body;
        if (!clientId || !mongoose.Types.ObjectId.isValid(clientId)) {
            return res.status(400).json({ message: "A valid clientId is required" });
        }
        const client = await Client.findById(clientId);
        if (!client) {
            return res.status(404).json({ message: "Client not found" });
        }
        if (client.status === "churned") {
            return res.status(409).json({ message: "Cannot create a pickup for an archived client" });
        }

        const pickup = await createPickupForClient({
            client,
            requestedDate: req.body.requestedDate,
            requestedStreams: req.body.requestedStreams,
            clientNotes: req.body.clientNotes,
            siteId: req.body.siteId,
            createdByActor: {
                userType: me.userType,
                userId: me.userId,
                name: me.name,
                phone: me.doc && me.doc.phone,
            },
            // Auto-accept + self-assign to the creating Pickup Agent so it lands
            // straight in their My Pickups, ready to execute (no triage step).
            assignToActor: true,
            // Recording a collection that already happened. The service only
            // honours this because createdByActor is set above.
            allowPastDate:
                req.body.allowPastDate === true || String(req.body.allowPastDate) === "true",
        });
        return res.status(201).json(pickup);
    } catch (err) {
        if (err instanceof PickupCreationError) {
            return res.status(err.status).json({ message: err.message });
        }
        console.error("createPickupOnBehalf error:", err);
        return res.status(500).json({ message: err.message });
    }
};

// ==================== LIVE TRACKING (agent side) ====================
//
// The agent shares their live location with the client when the pickup is
// active. Two modes: 'link' (paste an external share URL) or 'gps' (stream
// device points we store on the pickup). The client sees it through the gated
// /api/client/pickups/:id/tracking endpoints, and only while active.

/**
 * Resolve the pickup for a tracking mutation, enforcing: authenticated, has
 * supervisor permission, is the assigned supervisor. Returns { pickup } or
 * sends the error response and returns null.
 */
const resolveOwnedPickup = async (req, res) => {
    const me = getCurrentUser(req);
    if (!me) { res.status(401).json({ message: "Not authorized" }); return null; }
    const canSup = await assertCanSupervise(me);
    if (!canSup) { res.status(403).json({ message: "You do not have supervisor permission" }); return null; }
    const pickup = await Pickup.findById(req.params.id);
    if (!pickup) { res.status(404).json({ message: "Pickup not found" }); return null; }
    const assignedId = pickup.supervisor && pickup.supervisor.userId;
    if (!assignedId || assignedId.toString() !== me.userId.toString()) {
        res.status(403).json({ message: "You are not the assigned supervisor for this pickup" });
        return null;
    }
    return { me, pickup };
};

/** A tracking summary safe to hand back to the agent (they may see their own link). */
const trackingForAgent = (pickup) => {
    const t = pickup.tracking;
    if (!t || !t.mode) return { active: false };
    return {
        active: Pickup.isTrackingLive(pickup),
        mode: t.mode,
        link: t.mode === "link" ? t.link : undefined,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        points: Array.isArray(t.trail) ? t.trail.length : 0,
    };
};

// Nudge the client's open pickup view so the live map/button appears (or clears)
// promptly, without waiting for a status change. Best-effort.
const emitTracking = (pickup) => {
    try {
        getIo().to(`pickup_${pickup._id}`).emit("pickup:tracking", { pickupId: pickup._id });
    } catch (e) {
        console.error("Socket emit error (pickup tracking):", e.message || e);
    }
};

// PUT /api/{role}/my-pickups/:id/tracking   { mode: "link"|"gps", link? }
// Start (or switch) live tracking. Only allowed while the pickup is active.
const setTracking = async (req, res) => {
    try {
        const got = await resolveOwnedPickup(req, res);
        if (!got) return;
        const { me, pickup } = got;

        if (!TRACKING_ACTIVE_STATUSES.includes(pickup.status)) {
            return res.status(409).json({
                message: `Live tracking can only be shared while the pickup is active (en-route to at-facility). Current status: '${pickup.status}'.`,
            });
        }

        const mode = String(req.body.mode || "").trim();
        const by = { userType: me.userType, userId: me.userId, name: me.name };

        if (mode === "link") {
            const link = String(req.body.link || "").trim();
            if (!/^https?:\/\/.+/i.test(link)) {
                return res.status(400).json({
                    message: "Enter a valid tracking link — it must start with http:// or https://.",
                });
            }
            pickup.tracking = { mode: "link", link, startedAt: new Date(), endedAt: undefined, by, trail: undefined };
        } else if (mode === "gps") {
            pickup.tracking = { mode: "gps", startedAt: new Date(), endedAt: undefined, by, trail: [] };
        } else {
            return res.status(400).json({ message: "mode must be 'link' or 'gps'" });
        }

        await pickup.save();
        emitTracking(pickup);
        return res.json({ tracking: trackingForAgent(pickup) });
    } catch (err) {
        console.error("setTracking error:", err);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/{role}/my-pickups/:id/tracking/ping   { lat, lng }
// Append one live GPS point (mode 'gps' only). Called on an interval by the
// agent's run screen while the pickup is active.
const pingTracking = async (req, res) => {
    try {
        const got = await resolveOwnedPickup(req, res);
        if (!got) return;
        const { pickup } = got;

        if (!pickup.tracking || pickup.tracking.mode !== "gps") {
            return res.status(409).json({ message: "GPS tracking is not active for this pickup." });
        }
        if (pickup.tracking.endedAt || !TRACKING_ACTIVE_STATUSES.includes(pickup.status)) {
            return res.status(409).json({ message: "The live tracking window for this pickup has ended." });
        }

        const lat = Number(req.body.lat);
        const lng = Number(req.body.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            return res.status(400).json({ message: "lat and lng are required numbers" });
        }

        pickup.tracking.trail = pickup.tracking.trail || [];
        pickup.tracking.trail.push({ lat, lng, at: new Date() });
        if (pickup.tracking.trail.length > MAX_TRACKING_POINTS) {
            pickup.tracking.trail = pickup.tracking.trail.slice(-MAX_TRACKING_POINTS);
        }
        await pickup.save();
        emitTracking(pickup);
        return res.json({ ok: true, points: pickup.tracking.trail.length });
    } catch (err) {
        console.error("pingTracking error:", err);
        return res.status(500).json({ message: err.message });
    }
};

// DELETE /api/{role}/my-pickups/:id/tracking
// Agent stops sharing before the pickup moves on. Idempotent.
const stopTracking = async (req, res) => {
    try {
        const got = await resolveOwnedPickup(req, res);
        if (!got) return;
        const { pickup } = got;

        if (!pickup.tracking || !pickup.tracking.mode) {
            return res.json({ ok: true });
        }
        if (!pickup.tracking.endedAt) {
            pickup.tracking.endedAt = new Date();
            await pickup.save();
            emitTracking(pickup);
        }
        return res.json({ ok: true });
    } catch (err) {
        console.error("stopTracking error:", err);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    listMyPickups,
    listWasteCategories,
    updatePickupStatus,
    recordWasteData,
    listClientsForPickup,
    createPickupOnBehalf,
    setTracking,
    pingTracking,
    stopTracking,
    // Prefer `uploadEvidence` in routes — it turns multer failures into clear
    // 400s. `upload` stays exported for anything that wants the raw middleware.
    uploadEvidence,
    upload,
    wasteDataUpload,
    // Exported for tests / introspection.
    ALLOWED_NEXT,
    PHOTO_REQUIRED_FOR,
    VALID_STREAMS,
    MAX_EVIDENCE_PHOTOS,
    evidenceFilesFrom,
};
