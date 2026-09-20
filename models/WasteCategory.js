/*
  WasteCategory — the configurable list of waste streams (Phase 2).

  Until now the eleven streams were a hard-coded enum in four places. The
  operations team needs to rename them, switch off ones they no longer take,
  correct a CO2e factor when a better source turns up, and add a new stream
  without a deploy. This collection is that list.

  Design notes:
  - `key` is what is written onto every pickup line item and is immutable once
    created. Renaming is done through `label`; the key stays put so historical
    pickups, certificates and reports keep resolving.
  - `isCore: true` marks the eleven original streams. They can be edited and
    deactivated but never removed, because existing documents reference them.
  - `certificateBucket` decides which row of the Certificate of Disposal a
    stream is counted under. Without it a new stream would be silently dropped
    from the certificate (see aggregateByBucket in utils/certificatePdf.js).
  - Deactivating never deletes: `isActive: false` only hides the stream from
    new pickup requests. Everything already recorded keeps working.
*/
const mongoose = require("mongoose");

// The seven fixed rows of the Certificate of Disposal template.
const CERTIFICATE_BUCKETS = [
    "wet",
    "plastic",
    "paper",
    "ewaste",
    "other-dry",
    "hazardous",
    "recycled",
];

const wasteCategorySchema = new mongoose.Schema(
    {
        key: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true,
            match: [
                /^[a-z0-9][a-z0-9-]{1,39}$/,
                "key must be lowercase letters, numbers and hyphens",
            ],
        },
        label: { type: String, required: true, trim: true, maxlength: 60 },
        description: { type: String, trim: true, maxlength: 300 },

        // kg CO2e avoided per kg recycled. Drives the public impact counter and
        // the client dashboard.
        co2eFactorKgPerKg: { type: Number, default: 0.5, min: 0, max: 100 },

        certificateBucket: {
            type: String,
            enum: CERTIFICATE_BUCKETS,
            default: "other-dry",
        },

        isActive: { type: Boolean, default: true },
        isCore: { type: Boolean, default: false },
        sortOrder: { type: Number, default: 100 },

        updatedByName: String,
        updatedByRole: String,
    },
    { timestamps: true }
);

wasteCategorySchema.index({ isActive: 1, sortOrder: 1 });

module.exports = mongoose.model("WasteCategory", wasteCategorySchema);
module.exports.CERTIFICATE_BUCKETS = CERTIFICATE_BUCKETS;
