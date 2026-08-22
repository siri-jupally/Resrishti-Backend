/*
  PasswordResetToken model — Client portal "forgot password" flow.

  Mirrors OnboardingToken deliberately (same magic-link mechanics, same TTL
  housekeeping) with two differences that matter for a RESET rather than an
  invite:

  1. Short lifetime. Onboarding links live 7 days because they're an
     invitation; a reset link is a live account-takeover credential sitting in
     an inbox, so it expires in 15 minutes.

  2. The token is stored HASHED (sha256), never in plaintext. An onboarding
     token only activates a brand-new account, but a reset token grants
     control of an existing one — so anyone with read access to this
     collection (a backup, a log, an aggregation pipeline) could otherwise
     take over any client account. We email the raw token and store only its
     digest; lookup hashes the incoming value and matches on that. sha256 with
     no salt is correct here: the input is already 256 bits of CSPRNG output,
     so there is nothing to brute-force and we need deterministic lookup.

  Lifecycle:
  - Created with `expiresAt = now + 15 min` and `usedAt = null`.
  - Requesting another link force-expires all prior unused tokens for that
    client, so only the newest link ever works.
  - On successful reset `usedAt` is set; the row stays briefly for audit.
  - TTL drops the row 24h after expiry — long enough to investigate "my link
    didn't work" reports, short enough to keep the collection small.
*/
const mongoose = require("mongoose");

const passwordResetTokenSchema = new mongoose.Schema(
    {
        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            required: true,
        },

        // sha256 hex digest of the token that was emailed. Never the raw value.
        tokenHash: { type: String, required: true },

        expiresAt: { type: Date, required: true },

        // Set once when the password is actually changed; never cleared.
        usedAt: { type: Date },

        // Coarse audit trail for "who asked for this?" investigations.
        requestedIp: { type: String },
    },
    { timestamps: true }
);

// Drop the row 24h after it expires — see header.
passwordResetTokenSchema.index(
    { expiresAt: 1 },
    { expireAfterSeconds: 60 * 60 * 24 }
);
passwordResetTokenSchema.index({ tokenHash: 1 }, { unique: true });
// Used by the "invalidate everything older" sweep on each new request.
passwordResetTokenSchema.index({ client: 1, usedAt: 1 });

module.exports = mongoose.model("PasswordResetToken", passwordResetTokenSchema);
