/*
  Client controller — Admin CRUD for the Client Management module (Phase 1)

  Endpoints (mounted at /api/admin/clients via routes/clientRoutes.js):
    POST   /                 createClient   — create a new client record
    GET    /                 listClients    — list with filter/search/pagination
    GET    /:id              getClient      — single client detail
    PATCH  /:id              updateClient   — partial update (whitelisted fields)
    DELETE /:id              deleteClient   — soft-delete (status='churned')

  Mirrors the error-handling/response shape used in controllers/adminOrgController.js.

  NOT IN THIS FILE (other agents' scope):
  - Onboarding-token generation + email (Backend B). createClient leaves a TODO
    hook where that integration will fire after the record is created.
  - resend-onboarding endpoint (Backend B).
  - Client portal endpoints (Backend C — /api/client/*).
*/
const mongoose = require("mongoose");
const Client = require("../models/Client");
const OnboardingToken = require("../models/OnboardingToken");
const { issueOnboardingToken } = require("./onboardingController");
const { isClientOnboardingEnabled } = require("../utils/onboardingFlag");

// ==================== CREATE ====================

// POST /api/admin/clients
const createClient = async (req, res) => {
    try {
        const {
            name,
            contactName,
            contactEmail,
            contactPhone,
            billingAddress,
            gstin,
            industry,
            accountManager,
            tags,
        } = req.body;

        // Required-field validation (mirror adminOrgController style).
        if (!name || !contactName || !contactEmail || !contactPhone) {
            return res.status(400).json({
                message:
                    "name, contactName, contactEmail, and contactPhone are required",
            });
        }

        // Pre-check for duplicate email so we return a clean 409 instead of a
        // raw Mongo E11000. The schema's unique index is still the source of truth.
        const normalizedEmail = String(contactEmail).toLowerCase().trim();
        const existing = await Client.findOne({ contactEmail: normalizedEmail });
        if (existing) {
            return res.status(409).json({
                message: "A client with this contact email already exists",
            });
        }

        const client = await Client.create({
            name,
            contactName,
            contactEmail: normalizedEmail,
            contactPhone,
            billingAddress: billingAddress || undefined,
            gstin: gstin || undefined,
            industry: industry || undefined,
            accountManager: accountManager || undefined,
            tags: Array.isArray(tags) ? tags : undefined,
            status: "pending-onboarding",
        });

        // Fire-and-handle: generate onboarding token + email the magic link.
        // We wrap in its own try so an SMTP outage doesn't fail the create —
        // admin can always click "Resend Onboarding" if the email didn't go.
        // Skipped entirely while client onboarding is temporarily disabled, so
        // no dead magic-link emails go out; admins activate clients via
        // setClientPassword instead. Re-enabling the flag restores this.
        let onboarding = { emailSent: false, expiresAt: null };
        if (isClientOnboardingEnabled()) {
            try {
                onboarding = await issueOnboardingToken(
                    client,
                    req.admin && req.admin._id
                );
            } catch (onboardErr) {
                console.error("Onboarding email error (non-fatal):", onboardErr.message);
            }
        }

        return res.status(201).json({
            _id: client._id,
            name: client.name,
            contactEmail: client.contactEmail,
            status: client.status,
            createdAt: client.createdAt,
            onboardingEmailSent: onboarding.emailSent,
            onboardingExpiresAt: onboarding.expiresAt,
        });
    } catch (err) {
        // Defensive duplicate-key handler in case a race slipped past the pre-check.
        if (err && err.code === 11000) {
            return res.status(409).json({
                message: "A client with this contact email already exists",
            });
        }
        return res.status(500).json({ message: err.message });
    }
};

// ==================== LIST ====================

// GET /api/admin/clients?status=&search=&limit=50&offset=0
const listClients = async (req, res) => {
    try {
        const { status, search } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const filter = {};
        if (status) {
            filter.status = status;
        } else {
            // Archived clients are hidden unless they are asked for by name
            // (status=churned). Deleting a client and still seeing it in the
            // list reads as the delete having failed, which is what admins
            // were reporting. They remain reachable through the status filter
            // and restorable, because archiving is reversible and a hard
            // delete of a client with history is not.
            filter.status = { $ne: "churned" };
        }

        if (search) {
            // Case-insensitive partial match across name / contactEmail / contactPhone.
            // Escape regex metacharacters so a stray '.' or '+' in user input doesn't
            // blow up the query.
            const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const rx = new RegExp(safe, "i");
            filter.$or = [
                { name: rx },
                { contactEmail: rx },
                { contactPhone: rx },
            ];
        }

        const [items, total] = await Promise.all([
            Client.find(filter)
                .select("-passwordHash")
                .sort({ createdAt: -1 })
                .skip(offset)
                .limit(limit),
            Client.countDocuments(filter),
        ]);

        return res.json({ items, total, limit, offset });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== READ ONE ====================

// GET /api/admin/clients/:id
const getClient = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid client id" });
        }

        const client = await Client.findById(req.params.id)
            .select("-passwordHash")
            .populate("accountManager", "name email");

        if (!client) {
            return res.status(404).json({ message: "Client not found" });
        }
        return res.json(client);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== UPDATE ====================

// PATCH /api/admin/clients/:id
const updateClient = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid client id" });
        }

        // Reject attempts to change auth/identity fields through this endpoint.
        // - passwordHash: only ever set via the onboarding flow (Backend B).
        // - contactEmail: changing the login email needs a verification step we
        //   haven't built yet; explicit 400 is safer than silently ignoring.
        if (
            Object.prototype.hasOwnProperty.call(req.body, "passwordHash") ||
            Object.prototype.hasOwnProperty.call(req.body, "contactEmail")
        ) {
            return res.status(400).json({
                message:
                    "passwordHash and contactEmail cannot be updated via this endpoint",
            });
        }

        // Whitelist of fields the admin is allowed to patch.
        const ALLOWED = [
            "name",
            "contactName",
            "contactPhone",
            "billingAddress",
            "gstin",
            "industry",
            "accountManager",
            "status",
            "tags",
        ];

        const updates = {};
        for (const key of ALLOWED) {
            if (Object.prototype.hasOwnProperty.call(req.body, key)) {
                updates[key] = req.body[key];
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "No updatable fields supplied" });
        }

        const client = await Client.findByIdAndUpdate(
            req.params.id,
            { $set: updates },
            { new: true, runValidators: true }
        )
            .select("-passwordHash")
            .populate("accountManager", "name email");

        if (!client) {
            return res.status(404).json({ message: "Client not found" });
        }

        return res.json(client);
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== DELETE ====================

// DELETE /api/admin/clients/:id
//
// Deletes the client outright when there is nothing of record attached to it,
// and archives it (status='churned') when there is.
//
// The split exists because the two cases are genuinely different. A client
// created by mistake, or to try something out, has no pickups and no
// certificates — nothing refers to it, so removing it is clean and an admin who
// pressed Delete should get a delete. A client with pickups, certificates or
// reports behind it cannot be removed: certificates are documents the client
// has already been sent, and reports and the GHG figures are computed from
// those pickups. Deleting the row would leave those pointing at nothing, so
// that client is archived instead — and, since this change, hidden from the
// list, which is the part that made archiving look broken.
//
// Sites and the client's own invite / reset tokens are not history; they belong
// to the client and go with it.
//
// Responses: { ok: true, mode: 'deleted' } or
//            { ok: true, mode: 'archived', references: { pickups, certificates, reports } }
const deleteClient = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid client id" });
        }

        const client = await Client.findById(req.params.id);
        if (!client) {
            return res.status(404).json({ message: "Client not found" });
        }

        // Anything here makes the client un-deletable. Required lazily, in step
        // with the rest of this controller, to keep the model graph from
        // becoming load-order sensitive.
        const Pickup = require("../models/Pickup");
        const Certificate = require("../models/Certificate");
        const Report = require("../models/Report");
        const [pickups, certificates, reports] = await Promise.all([
            Pickup.countDocuments({ client: client._id }),
            Certificate.countDocuments({ client: client._id }),
            Report.countDocuments({ client: client._id }),
        ]);

        if (pickups === 0 && certificates === 0 && reports === 0) {
            const Site = require("../models/Site");
            const PasswordResetToken = require("../models/PasswordResetToken");
            // The client's own subordinate records. Removed first so a failure
            // part-way through leaves the client in place rather than leaving
            // orphans with no client to find them from.
            await Promise.all([
                Site.deleteMany({ client: client._id }),
                OnboardingToken.deleteMany({ client: client._id }),
                PasswordResetToken.deleteMany({ client: client._id }),
            ]);
            await Client.deleteOne({ _id: client._id });
            return res.json({ ok: true, mode: "deleted" });
        }

        client.status = "churned";
        await client.save();

        // Kill any outstanding onboarding invite. Without this, a client
        // archived before they onboarded could still click the link sitting in
        // their inbox — completeOnboarding sets status='active', which would
        // silently undo the archive with no admin action. Force-expire rather
        // than delete, matching resendOnboarding, so an in-flight /verify sees
        // 410 (expired) instead of 404 (missing) and the TTL index still cleans up.
        await OnboardingToken.updateMany(
            { client: client._id, usedAt: null },
            { expiresAt: new Date() }
        );

        return res.json({
            ok: true,
            mode: "archived",
            references: { pickups, certificates, reports },
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== RESTORE (undo archive) ====================

// POST /api/admin/clients/:id/restore  — reverses deleteClient.
//
// A dedicated endpoint rather than PATCH { status: 'active' }, because the
// correct target status is NOT always 'active': a client archived before they
// ever completed onboarding has no password, so restoring them to 'active'
// would leave an account that reads as live but can never be signed into.
// Those go back to 'pending-onboarding' so the admin's next step (resend the
// invite) is the obvious one.
const restoreClient = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid client id" });
        }

        const client = await Client.findById(req.params.id);
        if (!client) {
            return res.status(404).json({ message: "Client not found" });
        }

        // Only an archived client can be restored. Guarding here keeps this
        // from becoming a backdoor for flipping a 'paused' client to active
        // without going through the normal update path.
        if (client.status !== "churned") {
            return res.status(409).json({
                message: `Only an archived client can be restored (current status: '${client.status}')`,
            });
        }

        client.status = client.isOnboardingComplete
            ? "active"
            : "pending-onboarding";
        await client.save();

        const fresh = await Client.findById(client._id)
            .select("-passwordHash")
            .populate("accountManager", "name email");

        return res.json({ ok: true, client: fresh, status: fresh.status });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ==================== SET PASSWORD (internal / testing) ====================

// POST /api/admin/clients/:id/set-password  — admin-only.
//
// Internal mechanism to make a client immediately usable without the email
// magic link. Needed while client onboarding is disabled (createClient no
// longer emails an invite), and useful for operational/testing access.
//
// Sets a known password and ACTIVATES the client in one step:
//   passwordHash (pre-save hook hashes it) + isOnboardingComplete + status.
// This mirrors what completeOnboarding would have done, so the client can then
// sign in normally at /client/login. It does NOT expose or return the password.
const setClientPassword = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid client id" });
        }

        const cleaned = String(req.body && req.body.password != null ? req.body.password : "").trim();
        if (cleaned.length < 6) {
            return res.status(400).json({
                message: "Password must be at least 6 characters (non-whitespace)",
            });
        }

        const client = await Client.findById(req.params.id).select("+passwordHash");
        if (!client) {
            return res.status(404).json({ message: "Client not found" });
        }
        // Don't silently resurrect an archived client. Admin should restore first.
        if (client.status === "churned") {
            return res.status(409).json({
                message: "Restore the archived client before setting a password",
            });
        }

        // Assigning the plaintext triggers the model's pre-save bcrypt hook and
        // stamps passwordChangedAt (which invalidates older JWTs).
        client.passwordHash = cleaned;
        client.isOnboardingComplete = true;
        if (client.status === "pending-onboarding") {
            client.status = "active";
        }
        await client.save();

        return res.json({
            ok: true,
            clientId: client._id,
            email: client.contactEmail,
            status: client.status,
            isOnboardingComplete: client.isOnboardingComplete,
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    createClient,
    listClients,
    getClient,
    updateClient,
    deleteClient,
    restoreClient,
    setClientPassword,
};
