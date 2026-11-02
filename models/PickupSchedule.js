/*
  PickupSchedule — a client's RECURRING pickup contract.

  Instead of requesting a pickup every time, a client sets up a schedule
  (cadence + streams + optional site). A daily job (services/recurringPickupJob)
  materialises the next occurrence a few days ahead as a normal "requested"
  Pickup the coordinator still accepts — so recurring pickups flow through the
  exact same path as ad-hoc ones (see services/pickupCreation).

  The series is anchored to startDate; pausing/resuming never shifts its rhythm.
  A schedule runs indefinitely until the client pauses or cancels it, or an
  optional endDate passes (then it auto-completes).
*/
const mongoose = require("mongoose");
const { CADENCE_TYPES } = require("../utils/recurrence");

const cadenceSchema = new mongoose.Schema(
    {
        type: { type: String, enum: CADENCE_TYPES, required: true },
        weekday: { type: Number, min: 0, max: 6 },        // weekly / biweekly (0=Sun)
        dayOfMonth: { type: Number, min: 1, max: 31 },    // monthly
        intervalDays: { type: Number, min: 1, max: 365 }, // everyNDays
    },
    { _id: false }
);

const pickupScheduleSchema = new mongoose.Schema(
    {
        client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", required: true, index: true },
        // Optional pickup location; null = the client's registered address.
        site: { type: mongoose.Schema.Types.ObjectId, ref: "Site", default: null },

        requestedStreams: { type: [String], required: true },
        clientNotes: { type: String, trim: true, maxlength: 1000 },

        cadence: { type: cadenceSchema, required: true },

        startDate: { type: Date, required: true },
        endDate: { type: Date, default: null },

        // Lifecycle:
        //   pending   — created by a client, awaiting admin approval. Generates
        //               NO pickups until approved.
        //   active    — approved and running; the job materialises occurrences.
        //   rejected  — admin declined the recurring request (terminal).
        //   paused    — temporarily stopped by the client.
        //   cancelled — stopped for good by the client.
        //   completed — endDate passed.
        // Default is `pending`: new client schedules must be approved before any
        // pickup is generated. (Schedules created before this field existed, and
        // staff-created ones, may be seeded `active` explicitly.)
        status: {
            type: String,
            enum: ["pending", "active", "paused", "cancelled", "completed", "rejected"],
            default: "pending",
            index: true,
        },

        // Admin approval (clientmngmt — recurring approval workflow).
        // The default supervisor chosen at approval: every occurrence this
        // schedule generates is auto-accepted and assigned to them, so there is
        // no per-pickup triage. A schedule with no defaultSupervisor (e.g. a
        // legacy active one) falls back to generating plain "requested" pickups.
        defaultSupervisor: {
            userType: { type: String, enum: ["Admin", "Manager", "Employee"] },
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            phone: String,
        },
        reviewedBy: {
            userType: String,
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
        },
        reviewedAt: { type: Date, default: null },
        rejectionReason: { type: String, trim: true, maxlength: 1000 },

        // Generation bookkeeping (see recurringPickupJob).
        lastGeneratedDate: { type: Date, default: null }, // occurrence date of the last pickup made
        nextOccurrence: { type: Date, default: null },    // for display; recomputed on write
        generatedCount: { type: Number, default: 0 },

        // Who created it (a client, or staff on their behalf).
        createdByType: String, // "Client" | "Admin" | "Manager" | "Employee"
        createdById: mongoose.Schema.Types.ObjectId,
        createdByName: String,
    },
    { timestamps: true }
);

pickupScheduleSchema.index({ status: 1, startDate: 1 });

module.exports = mongoose.model("PickupSchedule", pickupScheduleSchema);
