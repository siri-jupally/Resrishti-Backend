/*
  OnboardingToken model — Client Management module (Phase 1)

  Purpose:
  - Holds the single-use magic-link tokens used to onboard a new Client into
    the customer portal. The Admin creates the Client record; we generate a
    cryptographically random token, email the contact a link containing it,
    and the contact uses that link to set their password and activate.

  Spec reference: clientmngmt.md §6.2 + §10.

  Lifecycle:
  - Created with `expiresAt = now + 7 days` and `usedAt = null`.
  - On successful completion: `usedAt` is set; the row stays for audit.
  - On resend: prior unused tokens for the same client are invalidated by
    forcing `expiresAt = now`, then a fresh token row is inserted.
  - TTL index drops the row 7 days *after* it expires — gives operators a
    grace window to see "expired" rows in the DB before they vanish.

  Indexes:
  - `token` is unique (we use crypto.randomBytes(32) so collision is
    astronomically unlikely, but the index makes it impossible).
  - `expiresAt` carries a TTL of 7 days post-expiry.
*/
const mongoose = require("mongoose");

const onboardingTokenSchema = new mongoose.Schema(
    {
        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            required: true,
        },
        // 64-char hex string from crypto.randomBytes(32).toString('hex').
        // Uniqueness is enforced by the explicit schema.index() below rather
        // than `unique: true` here, to avoid Mongoose's duplicate-index
        // warning. Behaviour is identical.
        token: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        // Set once when the client completes onboarding; never cleared.
        usedAt: { type: Date },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    },
    { timestamps: true }
);

// TTL: drop the row 7 days after the token expires. Keeps the collection
// from growing unbounded while still letting ops investigate recently
// expired links.
onboardingTokenSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 * 7 }
);
onboardingTokenSchema.index({ token: 1 }, { unique: true });

module.exports = mongoose.model("OnboardingToken", onboardingTokenSchema);
