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
const { issueOnboardingToken } = require("./onboardingController");

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
        let onboarding = { emailSent: false, expiresAt: null };
        try {
            onboarding = await issueOnboardingToken(
                client,
                req.admin && req.admin._id
            );
        } catch (onboardErr) {
            console.error("Onboarding email error (non-fatal):", onboardErr.message);
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
        if (status) filter.status = status;

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

// ==================== DELETE (soft) ====================

// DELETE /api/admin/clients/:id  — soft-delete only (sets status='churned')
const deleteClient = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid client id" });
        }

        const client = await Client.findById(req.params.id);
        if (!client) {
            return res.status(404).json({ message: "Client not found" });
        }

        // Hard delete is intentionally out of scope (clients have historical
        // pickups + certificates referencing them; orphaning those is unsafe).
        client.status = "churned";
        await client.save();

        return res.json({ ok: true });
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
};
