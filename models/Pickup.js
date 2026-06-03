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
        stream: {
            type: String,
            required: true,
            enum: [
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
            ],
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
        photo: { key: String, bucket: String, _id: false },
        gps: { lat: Number, lng: Number, _id: false },
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

const pickupSchema = new mongoose.Schema(
    {
        // Format: PU-YYYYMMDD-XXXXXX (6 hex chars). Generated in the controller
        // with a 3-attempt retry loop on rare collisions.
        pickupID: { type: String, required: true, unique: true },

        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            required: true,
        },

        // Denormalized snapshots — captured at create time so historical
        // records (cert PDFs, audit trails) stay stable if the client later
        // renames or relocates.
        clientNameSnapshot: String,
        pickupAddressSnapshot: String,

        // Request details (filled by client portal).
        requestedAt: { type: Date, default: Date.now },
        requestedDate: { type: Date }, // when the client wants the pickup
        requestedStreams: [String],
        clientNotes: String,

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
            ],
        },
        rejectionReason: String,
        cancelledReason: String,
        scheduledDate: Date,
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

        // Cert — populated as it moves draft → issued → sent. The `Certificate`
        // model doesn't exist yet (Phase 1 step 8). Mongoose resolves refs
        // lazily on populate, so declaring this here is safe.
        certificate: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Certificate",
        },
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

module.exports = mongoose.model("Pickup", pickupSchema);
