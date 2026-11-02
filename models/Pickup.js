/*
  Pickup model — Client Management module (Phase 1)

  Purpose:
  - Represents a single waste-pickup job — from client request through field
    execution, weighing, processing, and finally certificate delivery.
  - Backbone of the Client Management module's pipeline (see clientmngmt.md §6.3,
    §8.1 for the state machine).

  Phase 1 scope:
  - One client → many pickups. Ad-hoc requests only (no recurring contracts).
  - Status enum drives the full state machine (`requested` → ... → `cert-sent`).
  - Evidence trail captures one entry per status change (photo, GPS, who, when).
  - Waste data (kg per stream) is entered AFTER the `processed` status; that
    triggers automatic certificate drafting (cert lives in `Certificate` model
    which doesn't exist yet — Mongoose resolves the ref lazily on populate).

  Polymorphic actor pattern:
  - `supervisor`, `acceptedBy`, `wasteDataEnteredBy`, and `evidence[].by` all
    carry `userType` ('Admin' | 'Manager' | 'Employee') + `userId` (ObjectId)
    + denormalized `name` so historical records remain readable even after the
    underlying user record changes role / leaves the org.
  - `evidence[].by.userType` ALSO accepts 'Client' so that client-driven
    cancellations are recordable in the same evidence stream (the supervisor
    surface filters these out by status / userType when rendering field timelines).

  Snapshots (denormalization for historical stability):
  - `clientNameSnapshot` + `pickupAddressSnapshot` are captured at create time
    so legal/audit records don't shift if the client later renames or moves.

  Coordination note for parallel agents:
  - Backend E (admin triage) will append evidence with userType='Admin' at the
    `accepted`, `rejected`, and `scheduled` transitions, and stamp `supervisor`
    on assignment.
  - Backend F (supervisor field flow) will append evidence with userType in
    {'Admin','Manager','Employee'} at `en-route`, `at-client`, `picked-up`,
    `at-facility`, `weighed`. The same userType is whoever is logged in driving
    that transition.
  - Both should mutate `status` directly and push a new evidence entry — no
    helper API on the schema in P1.
*/
const mongoose = require("mongoose");

// Each line item is one stream + qty (filled after weighing, per clientmngmt.md §6.3).
const wasteLineItemSchema = new mongoose.Schema(
    {
        // Streams are configurable (see models/WasteCategory.js), so this is a
        // lookup rather than a fixed enum. The check is async on purpose: a
        // category added seconds ago on another instance must be accepted
        // without waiting for this process's cache to catch up.
        stream: {
            type: String,
            required: true,
            validate: {
                validator: (value) =>
                    require("../utils/wasteCategories").isKnownStream(value),
                message: (props) => `'${props.value}' is not a configured waste category`,
            },
        },
        qtyKg: { type: Number, required: true, min: 0 },
        // S3 location of the weighbridge photo. `_id: false` keeps the sub-doc
        // from auto-creating an _id every time it serializes.
        weighbridgePhoto: {
            key: String,
            bucket: String,
            _id: false,
        },
        notes: String,
    },
    { _id: false }
);

// One evidence entry per status change — what happened, where, by whom.
// Note `by.userType` includes 'Client' so client-driven cancellation
// is recordable here too (see cancelMyPickup in clientPortalPickupController).
const evidenceSchema = new mongoose.Schema(
    {
        // Which pickup status this evidence corresponds to (e.g. 'en-route').
        status: String,

        // All images captured for this status change. A supervisor can shoot
        // several angles (load, weighbridge display, gate, damage) in one go.
        photos: [{ key: String, bucket: String, _id: false }],

        // DEPRECATED single-photo field, kept for backward compatibility:
        // evidence written before multi-photo shipped only has this, and older
        // installed app builds still POST a lone `photo` field. Writers now set
        // BOTH — `photos[]` in full and `photo` mirroring `photos[0]` — so any
        // reader that hasn't been updated keeps working. Read `photos` first
        // and fall back to `photo`; see photosOf() below.
        photo: { key: String, bucket: String, _id: false },

        gps: { lat: Number, lng: Number, _id: false },

        // Why this happened, in the actor's words: a rejection reason, a
        // cancellation, why a pickup moved, why weights were corrected. Nine
        // call sites were already writing this; without the field, Mongoose
        // dropped every one of them and the audit trail lost the reasons.
        notes: String,

        at: { type: Date, default: Date.now },
        by: {
            // 'Client' added beyond the spec's {Admin,Manager,Employee} so the
            // PATCH /api/client/pickups/:id/cancel handler can attribute the
            // cancellation in the evidence stream. See clientPortalPickupController.
            userType: {
                type: String,
                enum: ["Admin", "Manager", "Employee", "Client"],
            },
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },
    },
    { _id: false }
);

// One entry per scheduling change. `scheduledDate` holds only the current
// date, so without this a moved pickup loses what it was booked for before.
const scheduleChangeSchema = new mongoose.Schema(
    {
        from: Date,
        to: Date,
        reason: String,
        at: { type: Date, default: Date.now },
        by: {
            userType: { type: String, enum: ["Admin", "Manager", "Employee"] },
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },
    },
    { _id: false }
);

// One entry per change to the recorded weights, including the first entry.
// Certificates are issued from these numbers, so every correction records who
// changed it, when, and why.
const wasteChangeSchema = new mongoose.Schema(
    {
        lineItems: [{ stream: String, qtyKg: Number, _id: false }],
        totalKg: Number,
        previousTotalKg: Number,
        reason: String,
        at: { type: Date, default: Date.now },
        by: {
            userType: { type: String, enum: ["Admin", "Manager", "Employee"] },
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },
    },
    { _id: false }
);

// Live GPS tracking of a pickup in the field, surfaced to the client ONLY while
// the pickup is active (see TRACKING_ACTIVE_STATUSES below). Two modes:
//   - 'link': the agent pastes an external share URL (e.g. a Google Maps "share
//     live location" link). The raw link is held here and NEVER returned in the
//     general pickup payload — the client reaches it only through the gated
//     /tracking endpoints, and only while the pickup is active.
//   - 'gps':  the agent's device streams points we store here, pickup-scoped
//     (not the agent's whole-day attendance trail), capped to the last N points.
// `endedAt` is stamped the moment the pickup leaves the active window (or the
// agent stops sharing); once set, the client can no longer read or open it.
const trackingPointSchema = new mongoose.Schema(
    { lat: Number, lng: Number, at: { type: Date, default: Date.now } },
    { _id: false }
);
const trackingSchema = new mongoose.Schema(
    {
        mode: { type: String, enum: ["link", "gps"] },
        link: String,
        startedAt: Date,
        endedAt: Date,
        by: {
            userType: { type: String, enum: ["Admin", "Manager", "Employee"] },
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },
        trail: { type: [trackingPointSchema], default: undefined },
    },
    { _id: false }
);

const pickupSchema = new mongoose.Schema(
    {
        // Format: PU-YYYYMMDD-XXXXXX (6 hex chars). Generated in the controller
        // with a 3-attempt retry loop on rare collisions.
        pickupID: { type: String, required: true, unique: true },

        // --- Pickup pipeline revamp (additive migration, Phase 0) ---
        // Which stage model this pickup follows:
        //   1 = legacy flow (requested → … → cert-sent), the only flow before the
        //       7-stage revamp. Existing rows are backfilled to 1; a MISSING value
        //       is also treated as 1 (see isLegacyPipeline + migrations/0001).
        //   2 = new 7-stage flow + explicit Closure (lands in Phase 1).
        // The default is 1 on PURPOSE: a hydrated (non-lean) doc with no
        // pipelineVersion field — i.e. every pickup created before this field
        // existed — must read as legacy/v1 and stay on the old flow. (Mongoose
        // applies the schema default on hydration, so a default of 2 would
        // silently mis-route every existing pickup into the v2 state machine.)
        // NEW pickups are set to 2 EXPLICITLY at creation (services/pickupCreation).
        pipelineVersion: { type: Number, default: 1, enum: [1, 2], index: true },

        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            required: true,
        },

        // Which of the client's buildings/branches this pickup came from.
        // Optional: clients onboarded before multi-branch shipped have no Sites,
        // and single-location clients never need one. The monthly GHG report
        // groups by this — pickups without a site roll up into an
        // "Unassigned" row rather than being dropped (see reportCalculations).
        site: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Site",
            default: null,
        },

        // Denormalized snapshots — captured at create time so historical
        // records (cert PDFs, audit trails) stay stable if the client later
        // renames or relocates.
        clientNameSnapshot: String,
        pickupAddressSnapshot: String,
        // Frozen site name for the same reason: renaming "HDC2" later must not
        // rewrite the row labels on an already-issued GHG report.
        siteNameSnapshot: String,

        // Request details (filled by client portal).
        requestedAt: { type: Date, default: Date.now },
        requestedDate: { type: Date }, // when the client wants the pickup
        requestedStreams: [String],
        clientNotes: String,
        // Set when this pickup was materialised from a recurring schedule
        // (models/PickupSchedule) rather than requested one-off.
        recurringScheduleId: { type: mongoose.Schema.Types.ObjectId, ref: "PickupSchedule", default: null, index: true },

        // Triage / lifecycle.
        status: {
            type: String,
            required: true,
            default: "requested",
            enum: [
                "requested",
                "accepted",
                "rejected",
                "scheduled",
                "en-route",
                "at-client",
                "picked-up",
                "at-facility",
                "weighed",
                "processed",
                "cert-draft",
                "cert-issued",
                "cert-sent",
                "cancelled",
                "postponed",
                // Could not be completed. 'failed' covers anything that stopped
                // the collection (access denied, vehicle breakdown, waste not
                // ready); 'no-show' is specifically nobody there to hand it over.
                // Both are terminal and both carry failureReason.
                "failed",
                "no-show",

                // --- v2 pipeline (7-stage revamp; only pipelineVersion:2) ---
                // Each is a photo-gated stage; order is departed → empty-weighed
                // → at-client → loading → loaded → loaded-weighed → at-facility,
                // then the explicit Closure (P2) sets 'closed'. Added additively;
                // legacy (v1) pickups never use these.
                "v2-departed",        // 1 vehicle started towards client
                "v2-empty-weighed",   // 2 empty vehicle photo
                "v2-at-client",       // 3 empty vehicle at client location
                "v2-loading",         // 4 loading started at client
                "v2-loaded",          // 5 fully loaded vehicle at client
                "v2-loaded-weighed",  // 6 stream-wise weights recorded (preliminary)
                "v2-at-facility",     // 7 vehicle reached ReSrishti facility
                "closed",             // Pickup Closed (Closure stage, P2)
            ],
        },
        rejectionReason: String,
        cancelledReason: String,
        // Why a pickup could not be completed (failed / no-show).
        failureReason: String,

        // Partial collection — only some of the requested waste was taken.
        // Deliberately a flag and not a status: the pickup still goes through
        // weighing and certification for what WAS collected, which a terminal
        // "partial" status would prevent.
        isPartial: { type: Boolean, default: false },
        partialReason: String,

        scheduledDate: Date,
        // Previous scheduled dates, oldest first — see scheduleChangeSchema.
        scheduleHistory: [scheduleChangeSchema],
        acceptedAt: Date,
        acceptedBy: {
            userType: String,
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },

        // Supervisor — polymorphic ref + denormalized snapshot. The userId
        // resolves against whichever collection matches `userType`.
        supervisor: {
            userType: {
                type: String,
                enum: ["Admin", "Manager", "Employee"],
            },
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            phone: String,
            assignedAt: Date,
            assignedBy: mongoose.Schema.Types.ObjectId,
            _id: false,
        },

        // One entry per status change — photo, GPS, who, when.
        evidence: [evidenceSchema],

        // Waste data — populated after the `processed` status.
        lineItems: [wasteLineItemSchema],
        totalKg: { type: Number, default: 0 },
        wasteDataEnteredAt: Date,
        wasteDataEnteredBy: {
            userType: String,
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },
        // Audit of the weights: the first entry plus every later correction.
        wasteDataHistory: [wasteChangeSchema],

        // Preliminary vs final confirmed weights (v2 pipeline).
        //   'none'        — no stream weights yet.
        //   'preliminary' — entered in the field at the loaded-weighbridge stage
        //                   (an estimate; segregation may change it).
        //   'confirmed'   — reviewed, corrected and confirmed at Closure (final;
        //                   this is what certificates and impact use).
        // v1 pickups leave this 'none' (their lineItems have always been final).
        weightsStatus: {
            type: String,
            enum: ["none", "preliminary", "confirmed"],
            default: "none",
        },
        weightsConfirmedAt: Date,
        weightsConfirmedBy: {
            userType: String,
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },

        // Cert — populated as it moves draft → issued → sent. The `Certificate`
        // model doesn't exist yet (Phase 1 step 8). Mongoose resolves refs
        // lazily on populate, so declaring this here is safe.
        certificate: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Certificate",
        },

        // Live GPS tracking shared with the client while the pickup is in the
        // field. See trackingSchema above and isTrackingLive() below.
        tracking: { type: trackingSchema, default: undefined },
    },
    { timestamps: true }
);

// Indexes — see clientmngmt.md §6.3.
// Note: the unique index on `pickupID` is declared via `unique: true` on the
// field itself; an explicit pickupSchema.index({ pickupID: 1 }, { unique: true })
// here would register a duplicate index and trigger a Mongoose warning (same
// pattern as Client.contactEmail).
pickupSchema.index({ client: 1, status: 1 });
pickupSchema.index({ status: 1, scheduledDate: 1 });
pickupSchema.index({ "supervisor.userId": 1, status: 1 });
// At most ONE pickup per (recurring schedule, occurrence date) — the DB-level
// guarantee behind the generation job's idempotency, so overlapping runs
// (create-on-create vs the daily job, resume races, multiple instances) can't
// double-create. Partial so it never constrains one-off (non-recurring) pickups,
// which all carry recurringScheduleId = null.
pickupSchema.index(
    { recurringScheduleId: 1, requestedDate: 1 },
    { unique: true, partialFilterExpression: { recurringScheduleId: { $type: "objectId" } } }
);

const Pickup = mongoose.model("Pickup", pickupSchema);

/**
 * Every photo on an evidence entry, regardless of which era wrote it.
 *
 * Multi-photo evidence stores `photos[]`; entries written before that shipped
 * only have the singular `photo`. Callers that just want "the images for this
 * step" should use this rather than reaching into either field, so neither
 * old records nor new ones get silently dropped from a timeline or an audit.
 *
 * @param {Object} evidenceEntry
 * @returns {Array<{key: string, bucket: string}>} possibly empty, never null
 */
const photosOf = (evidenceEntry) => {
    if (!evidenceEntry) return [];
    const many = Array.isArray(evidenceEntry.photos) ? evidenceEntry.photos : [];
    if (many.length > 0) return many.filter((p) => p && p.key);
    return evidenceEntry.photo && evidenceEntry.photo.key
        ? [evidenceEntry.photo]
        : [];
};

/**
 * The seven in-field v2 stages, in order (pipelineVersion:2). Shared by the
 * state machine, photo-gating and tracking so they can't drift apart.
 */
const V2_FIELD_STATUSES = [
    "v2-departed", "v2-empty-weighed", "v2-at-client", "v2-loading",
    "v2-loaded", "v2-loaded-weighed", "v2-at-facility",
];

/**
 * Statuses during which live tracking is shown to the client. v1 window:
 * en-route through at-facility; v2 window: every in-field stage. It goes dark
 * once the pickup is weighed/closed or at any terminal state. Mirrored on the
 * frontend (lib/pickupStatus.js TRACKING_ACTIVE_STATUSES).
 */
// Live tracking is active only while the vehicle is in transit or at the
// client, and STOPS the moment it reaches the facility — the journey is over,
// there's nothing left to track, and the agent is back at the company site.
// So 'at-facility' (v1) and 'v2-at-facility' are deliberately excluded; once a
// pickup hits either, isTrackingLive() returns false and updatePickupStatus
// stamps tracking.endedAt, so the client card disappears and agent pings stop.
const TRACKING_ACTIVE_STATUSES = [
    "en-route", "at-client", "picked-up",
    ...V2_FIELD_STATUSES.filter((s) => s !== "v2-at-facility"),
];

// Most GPS points we keep per pickup. At one point every ~10-15s a long pickup
// stays well under this; the cap just bounds a stuck-sharing session.
const MAX_TRACKING_POINTS = 500;

/**
 * True when this pickup's live tracking is currently visible to the client:
 * tracking is set up, has not been ended, and the pickup is in the active
 * window. Every client-facing tracking read gates on this — once it returns
 * false the link/trail is no longer reachable or copyable.
 *
 * @param {Object} pickup - a Pickup document or lean object (needs status + tracking)
 * @returns {boolean}
 */
const isTrackingLive = (pickup) => {
    if (!pickup || !pickup.tracking || !pickup.tracking.mode) return false;
    if (pickup.tracking.endedAt) return false;
    return TRACKING_ACTIVE_STATUSES.includes(pickup.status);
};

// --- Pickup pipeline revamp helpers (Phase 0) ---

/**
 * A pickup created before the 7-stage revamp (or any row whose version is unset)
 * follows the legacy flow and is grandfathered — it is never forced into the new
 * pipeline. Branch on this wherever v1 and v2 behave differently.
 * @param {Object} pickup - Pickup doc or lean object
 * @returns {boolean} true for legacy (v1 / missing), false for v2
 */
const isLegacyPipeline = (pickup) => !pickup || (pickup.pipelineVersion ?? 1) !== 2;

/**
 * Statuses that mean "the collection is effectively complete — waste has been
 * recorded." This is the SINGLE SOURCE OF TRUTH for what counts as a closed /
 * completed pickup across reports, dashboards and public impact, and is NOT
 * gated on certificate issuance. It stays equal to
 * reportController.ELIGIBLE_PICKUP_STATUSES (a drift-guard test enforces this).
 *
 * v1 completes at `processed` (and the cert-* stages that follow); v2 completes
 * at `closed` (Closure confirms the final weights). As of P3 the client
 * dashboard and public-stats job both count this set — impact reflects every
 * completed pickup, whether or not a certificate was ever issued.
 */
const CLOSED_EQUIVALENT_STATUSES = ["processed", "cert-draft", "cert-issued", "cert-sent", "closed"];

/** True when a pickup is complete enough to count toward impact / reports. */
const isClosedEquivalent = (statusOrPickup) => {
    const status = typeof statusOrPickup === "string" ? statusOrPickup : statusOrPickup?.status;
    return CLOSED_EQUIVALENT_STATUSES.includes(status);
};

module.exports = Pickup;
module.exports.photosOf = photosOf;
module.exports.TRACKING_ACTIVE_STATUSES = TRACKING_ACTIVE_STATUSES;
module.exports.V2_FIELD_STATUSES = V2_FIELD_STATUSES;
module.exports.MAX_TRACKING_POINTS = MAX_TRACKING_POINTS;
module.exports.isTrackingLive = isTrackingLive;
module.exports.isLegacyPipeline = isLegacyPipeline;
module.exports.CLOSED_EQUIVALENT_STATUSES = CLOSED_EQUIVALENT_STATUSES;
module.exports.isClosedEquivalent = isClosedEquivalent;
