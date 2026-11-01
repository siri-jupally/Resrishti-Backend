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

        status: {
            type: String,
            enum: ["active", "paused", "cancelled", "completed"],
            default: "active",
            index: true,
        },

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
