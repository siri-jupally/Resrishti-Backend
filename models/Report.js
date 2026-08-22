/*
  Report model — Client Management module (monthly client documents)

  Purpose:
  - Represents the two MONTHLY documents issued to a client, alongside the
    per-pickup Certificate of Disposal:
      * `impact` — "Environmental Impact Report" (water/energy/trees/air saved)
      * `ghg`    — "Green House Gases Emission Report" (per-site MTCO2E table)

  Why a separate model from Certificate:
  - Certificate is per-PICKUP and legally numbered CoD-YYYY-####. These two are
    per-CLIENT-per-MONTH and aggregate every eligible pickup in that window.
    The client's own sample documents carry "Reporting Month" and, for GHG, a
    per-building breakdown — neither of which a single pickup can produce.
  - Keeping them apart means the CoD's legal numbering, revision rules and
    audit trail stay untouched by this feature.

  Lifecycle — deliberately identical to Certificate so the manager UI, the
  client portal visibility rule, and the revise semantics all behave the same:

      draft ──generate──▶ draft ──issue──▶ issued ──send──▶ sent ──revise──▶ superseded
                                                                                │
                                                                                ▼
                                                                    new draft (revision+1)

  Visibility:
  - Clients may ONLY see `sent` and `superseded` (same rule as certificates —
    `issued` means the PDF exists but the manager has not released it yet).
    See CLIENT_VISIBLE_REPORT_STATUSES in clientPortalController.

  Snapshots:
  - Everything needed to re-render the PDF byte-identically lives on the doc:
    the computed figures, the per-site rows, the contributing pickup ids, and
    the client name. Editing a pickup after issuance must never silently change
    a document the client already holds.

  Indexes:
  - `{ client, type, periodYear, periodMonth, revision }` unique — one live
    document per client per type per month; revisions disambiguate re-issues.
  - `{ client, status }` for the client portal list.
  - `{ status, type }` for the manager review queue.
*/

const mongoose = require("mongoose");

// Per-site row of the GHG emissions table (sample doc page 4).
const ghgRowSchema = new mongoose.Schema(
    {
        siteName: String,
        foodWasteTons: Number,
        composted: Number,
        totalGHG: Number,        // MTCO2E — negative in the sample (composting)
        production: Number,      // MTCO2E avoided vs virgin production
        prodEndOfLife: Number,   // MTCO2E production + end-of-life avoided
        _id: false,
    },
    { _id: false }
);

// Per-material row of the impact breakdown.
const impactRowSchema = new mongoose.Schema(
    {
        material: String,
        qtyKg: Number,
        energy: Number,
        oil: Number,
        landfill: Number,
        air: Number,
        water: Number,
        trees: Number,
        _id: false,
    },
    { _id: false }
);

const reportSchema = new mongoose.Schema(
    {
        // `IMP-YYYY-####` or `GHG-YYYY-####` — see utils/reportNumber.js.
        // Not field-level unique: revisions share the number, exactly like
        // Certificate.certNumber.
        reportNumber: { type: String, required: true },

        type: {
            type: String,
            enum: ["impact", "ghg"],
            required: true,
        },

        revision: { type: Number, default: 1 },
        supersedes: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Report",
            default: null,
        },

        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            required: true,
        },

        // Reporting window. Stored as discrete year/month rather than a Date
        // range so the unique index can enforce "one per client per month"
        // without timezone ambiguity at month boundaries.
        periodYear: { type: Number, required: true },
        periodMonth: { type: Number, required: true, min: 1, max: 12 },

        status: {
            type: String,
            enum: ["draft", "issued", "sent", "superseded"],
            default: "draft",
        },

        // --- Immutable snapshots (frozen at generation, re-frozen on issue) --
        clientNameSnapshot: String,

        // Which pickups fed this report. Kept for audit ("why is the number
        // 4.33 tons?") and so a revision can show what changed.
        pickupIdsSnapshot: [
            { type: mongoose.Schema.Types.ObjectId, ref: "Pickup" },
        ],

        totalKgSnapshot: Number,

        // Populated for type === 'impact'.
        impactSnapshot: {
            totalWasteKg: Number,
            waterSaved: Number,
            energySaved: Number,
            treesSaved: Number,
            airPollutants: Number,
            oilSaved: Number,
            landfillSaved: Number,
            rows: [impactRowSchema],
            _id: false,
        },

        // Populated for type === 'ghg'.
        ghgSnapshot: {
            rows: [ghgRowSchema],
            totals: {
                foodWasteTons: Number,
                composted: Number,
                totalGHG: Number,
                production: Number,
                prodEndOfLife: Number,
                _id: false,
            },
            netGHGSavings: Number,
            _id: false,
        },

        // S3 location of the rendered PDF, filled at issue time.
        // `reports/<type>/<YYYY>/<reportNumber>.pdf`
        pdf: {
            key: String,
            bucket: String,
            _id: false,
        },

        // Audit — actor snapshots so the record stays readable after staff churn.
        generatedAt: Date,
        issuedAt: Date,
        issuedBy: {
            userType: String,
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },
        sentAt: Date,
        sentBy: {
            userType: String,
            userId: mongoose.Schema.Types.ObjectId,
            name: String,
            _id: false,
        },
    },
    { timestamps: true }
);

// One live document per (client, type, month) — revisions disambiguate.
reportSchema.index(
    { client: 1, type: 1, periodYear: 1, periodMonth: 1, revision: 1 },
    { unique: true }
);
reportSchema.index({ client: 1, status: 1 });
reportSchema.index({ status: 1, type: 1 });

module.exports = mongoose.model("Report", reportSchema);
