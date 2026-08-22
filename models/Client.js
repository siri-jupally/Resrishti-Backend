/*
  Client model — Client Management module (Phase 1)

  Purpose:
  - Represents an external client/customer organization that engages Resrishti for
    waste pickup, processing, and certification services.
  - Owns the contact information used for portal onboarding, notifications, and billing.

  Phase 1 scope (per clientmngmt.md §6.1):
  - One client = one contact (multi-contact / multi-branch deferred to Phase 3).
  - Admin creates the Client record. A separate onboarding-token flow (Backend B's
    scope) emails the contact a magic link to set their password and complete onboarding.
  - `passwordHash` is `select: false` so it's never returned by default. It is only
    populated once onboarding completes; pre-save hashes it with bcrypt.
  - Status enum drives the client lifecycle state machine.

  Security/notes:
  - `contactEmail` is unique + lowercased + trimmed; Mongoose v9 setters apply to
    queries too, so admin lookups are case-insensitive without manual normalization.
  - Symmetric trim-on-hash and trim-on-compare mirrors the pattern fixed for Employee
    in commit 671f3af — prevents whitespace contamination from copy-paste / autofill
    locking the user out.
*/
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const clientSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        // Phase 1: one contact only. Keep it inline; promote to a `Contact` sub-array in Phase 3.
        contactName: { type: String, required: true, trim: true },
        contactEmail: {
            type: String,
            required: true,
            unique: true, // Phase 1 — one client per email
            lowercase: true,
            trim: true,
        },
        contactPhone: { type: String, required: true, trim: true },
        billingAddress: {
            line1: String,
            line2: String,
            city: String,
            state: String,
            postalCode: String,
            country: { type: String, default: "India" },
        },
        gstin: { type: String, trim: true },
        industry: {
            type: String,
            enum: [
                "Hospital",
                "FMCG",
                "IT",
                "Industrial",
                "Hospitality",
                "Education",
                "Government",
                "Retail",
                "Other",
            ],
        },
        // Auth — set after onboarding completed. select:false keeps it out of
        // every default query response. Onboarding flow (Backend B) sets it via
        // `client.passwordHash = plainPassword; await client.save();` so the
        // pre-save hook below hashes it.
        passwordHash: { type: String, select: false },

        // When the password was last set. Read by middleware/authClient to
        // reject JWTs minted BEFORE this moment, which is what makes a
        // password reset actually log the client out everywhere instead of
        // leaving old sessions alive for the rest of their 7-day token life.
        // Stamped automatically by the pre-save hook below.
        passwordChangedAt: { type: Date },

        isOnboardingComplete: { type: Boolean, default: false },
        // Owner inside Resrishti (account manager). Optional in P1.
        accountManager: { type: mongoose.Schema.Types.ObjectId, ref: "Manager" },
        status: {
            type: String,
            enum: ["active", "paused", "churned", "pending-onboarding"],
            default: "pending-onboarding",
        },
        tags: { type: [String], default: [] },
        // Push subscription (same pattern as Employee/Manager/Admin)
        pushSubscription: { type: Object },
    },
    { timestamps: true }
);

// Same trim-on-hash/compare pattern as Employee — see commit 671f3af.
// A stray trailing space introduced by copy-paste / autofill / autocorrect would
// otherwise get baked into the hash and lock the client out when they later type
// the "clean" version. Symmetric trim on both save and compare keeps it stable.
clientSchema.pre("save", async function () {
    if (!this.isModified("passwordHash")) return;
    const cleaned = String(this.passwordHash ?? "").trim();
    if (!cleaned) throw new Error("Password cannot be empty or whitespace-only");
    const salt = await bcrypt.genSalt(10);
    this.passwordHash = await bcrypt.hash(cleaned, salt);

    // Stamp one second in the PAST on purpose. A JWT's `iat` has whole-second
    // precision, so a token minted in the same second as this save would
    // otherwise compare as "issued before the password changed" and be
    // rejected the instant it was handed out. completeOnboarding sets the
    // password and immediately issues a JWT, so this is a live path — without
    // the buffer, a client would finish onboarding and be logged straight out.
    this.passwordChangedAt = new Date(Date.now() - 1000);
});

clientSchema.methods.comparePassword = async function (candidate) {
    if (!this.passwordHash) return false;
    const cleaned = String(candidate ?? "").trim();
    if (!cleaned) return false;
    return bcrypt.compare(cleaned, this.passwordHash);
};

// Note: the unique index on contactEmail is declared via `unique: true` on the
// field above; an explicit clientSchema.index({ contactEmail: 1 }, { unique: true })
// here would register a duplicate index and trigger a Mongoose warning.
clientSchema.index({ status: 1 });

module.exports = mongoose.model("Client", clientSchema);
