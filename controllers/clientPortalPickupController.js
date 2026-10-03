/*
  Client portal — Pickup controller (Phase 1, §7.5)

  Surface (all mounted under /api/client/pickups, all behind protectClient):
  - POST   /                  requestPickup
  - GET    /                  listMyPickups
  - GET    /:id               getMyPickup
  - PATCH  /:id/cancel        cancelMyPickup

  Why a separate controller from clientPortalController:
  - Pickup is a fat domain. Keeping login/me thin (client portal shell) and the
    pickup endpoints in their own file makes the Backend E (admin triage) and
    Backend F (supervisor flow) controllers easier to write without import
    collisions on /pickups handlers.

  Authorization:
  - `protectClient` (middleware/authClient.js) loads `req.client` and rejects
    inactive/wrong-kind tokens. EVERY handler that resolves a pickup by id MUST
    also check `pickup.client.toString() === req.client._id.toString()`. A
    findById-only check would let one client view/cancel another's pickups —
    do not omit this guard.

  Pickup ID format: PU-YYYYMMDD-XXXXXX (6 hex chars). Generated locally with a
  3-attempt retry loop to absorb the rare collision (same pattern as
  managerController.createTask). See `generatePickupId` below.
*/
const mongoose = require("mongoose");
const Pickup = require("../models/Pickup");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");
const { sendPush } = require("../utils/push");
// Single shared pickup-creation path (also used by the staff "create on behalf"
// flow). requestPickup delegates to it so both paths stay identical.
const { createPickupForClient, PickupCreationError } = require("../services/pickupCreation");

// Certificate-workflow stages that are internal to Resrishti. A certificate
// sitting in draft or awaiting manager review is not something the client
// should know about — from their side the waste is simply processed, and the
// certificate appears when it is actually sent.
const INTERNAL_CERT_STAGES = new Set(["cert-draft", "cert-issued"]);

/**
 * Strip internal workflow state out of a pickup before it leaves for the client.
 *
 * Two things are hidden:
 *  - `cert-draft` / `cert-issued` are reported as `processed`. These are review
 *    stages; surfacing them told the client a certificate existed while it was
 *    still being checked.
 *  - The certificate link is withheld until the pickup reaches `cert-sent`.
 *    Previously the portal offered a download at `cert-issued` that the
 *    certificate endpoint then refused (only 'sent' certs are downloadable),
 *    so the client got a button that always errored.
 *
 * Masking here rather than only in the UI means the raw API response can't be
 * read to learn the same thing.
 */
const maskPickupForClient = (doc) => {
    const p = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
    if (p.status !== "cert-sent") delete p.certificate;
    if (INTERNAL_CERT_STAGES.has(p.status)) p.status = "processed";
    return p;
};

// POST /api/client/pickups
// Thin wrapper over the shared createPickupForClient service (see
// services/pickupCreation.js). Behaviour is unchanged: validates, creates the
// pickup linked to req.client at status "requested", and notifies coordinators.
const requestPickup = async (req, res) => {
    try {
        const { requestedDate, requestedStreams, clientNotes, siteId } = req.body;
        const pickup = await createPickupForClient({
            client: req.client,
            requestedDate,
            requestedStreams,
            clientNotes,
            siteId,
        });
        return res.status(201).json(pickup);
    } catch (err) {
        if (err instanceof PickupCreationError) {
            return res.status(err.status).json({ message: err.message });
        }
        console.error("requestPickup error:", err);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/client/pickups?status=&limit=&offset=
const listMyPickups = async (req, res) => {
    try {
        const { status } = req.query;
        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

        const query = { client: req.client._id };
        // 'processed' is what the client sees for the two internal cert stages
        // (see maskPickupForClient), so filtering by it must match them too —
        // otherwise a pickup visibly marked "Processed" vanishes from its own filter.
        if (status) {
            query.status = status === "processed"
                ? { $in: ["processed", ...INTERNAL_CERT_STAGES] }
                : status;
        }

        const [items, total] = await Promise.all([
            Pickup.find(query)
                .sort({ createdAt: -1 })
                .skip(offset)
                .limit(limit),
            Pickup.countDocuments(query),
        ]);

        return res.json({
            items: items.map(maskPickupForClient),
            total,
            limit,
            offset,
        });
    } catch (err) {
        console.error("listMyPickups error:", err);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/client/pickups/:id
const getMyPickup = async (req, res) => {
    try {
        const pickup = await Pickup.findById(req.params.id);
        if (!pickup) {
            return res.status(404).json({ message: "Pickup not found" });
        }
        // Ownership guard — never let one client see another's data.
        if (pickup.client.toString() !== req.client._id.toString()) {
            return res.status(403).json({ message: "Forbidden" });
        }

        // Best-effort populate of certificate. The Certificate model doesn't
        // exist yet (Phase 1 step 8); wrap in try so a MissingSchemaError on
        // populate never breaks the detail page.
        if (pickup.certificate) {
            try {
                await pickup.populate({
                    path: "certificate",
                    select: "certNumber status",
                });
            } catch (e) {
                // Certificate model not registered yet — leave the raw ObjectId.
                console.warn(
                    "Certificate populate skipped (model not registered yet):",
                    e.message
                );
            }
        }

        return res.json(maskPickupForClient(pickup));
    } catch (err) {
        console.error("getMyPickup error:", err);
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/client/pickups/:id/cancel
const cancelMyPickup = async (req, res) => {
    try {
        const { cancelledReason } = req.body || {};

        const pickup = await Pickup.findById(req.params.id);
        if (!pickup) {
            return res.status(404).json({ message: "Pickup not found" });
        }
        // Ownership guard — same reason as getMyPickup.
        if (pickup.client.toString() !== req.client._id.toString()) {
            return res.status(403).json({ message: "Forbidden" });
        }

        // Cancellation rules (clientmngmt.md §7.5, §8.1):
        // Clients can cancel only BEFORE the supervisor has departed. Anything
        // from en-route onward is a 409 — admin/manager has to handle it as a
        // failed pickup, not a customer cancellation.
        const cancellable = new Set(["requested", "accepted", "scheduled"]);
        const blockedOnceEnRoute = new Set([
            "en-route",
            "at-client",
            "picked-up",
            "at-facility",
            "weighed",
            "processed",
            "cert-draft",
            "cert-issued",
            "cert-sent",
        ]);
        if (blockedOnceEnRoute.has(pickup.status)) {
            return res
                .status(409)
                .json({ message: "Cannot cancel once pickup is en-route" });
        }
        if (!cancellable.has(pickup.status)) {
            // Already cancelled / rejected / postponed — treat as a 409 too.
            return res.status(409).json({
                message: `Cannot cancel a pickup in '${pickup.status}' status`,
            });
        }

        pickup.status = "cancelled";
        if (cancelledReason) pickup.cancelledReason = cancelledReason;
        pickup.evidence.push({
            status: "cancelled",
            at: new Date(),
            by: {
                userType: "Client",
                userId: req.client._id,
                name: req.client.name,
            },
        });
        await pickup.save();

        // Notify admins + coordinators that this pickup was cancelled. Same
        // recipient set as the new-request notification.
        try {
            const [admins, managers] = await Promise.all([
                Admin.find({
                    canCoordinate: true,
                    pushSubscription: { $exists: true, $ne: null },
                })
                    .select("pushSubscription")
                    .lean(),
                Manager.find({
                    canCoordinate: true,
                    pushSubscription: { $exists: true, $ne: null },
                })
                    .select("pushSubscription")
                    .lean(),
            ]);
            const recipients = [...admins, ...managers];
            const payload = {
                title: "Pickup Cancelled",
                body: `${req.client.name} cancelled pickup ${pickup.pickupID}`,
                icon: "/android-chrome-512x512.png",
                tag: `pickup-cancel-${pickup._id}`,
                data: {
                    url: `/admin/dashboard?tab=pickups&id=${pickup._id}`,
                },
            };
            await Promise.all(
                recipients
                    .filter((r) => r.pushSubscription)
                    .map((r) => sendPush(r.pushSubscription, payload))
            );
        } catch (e) {
            console.error("Cancellation push notify failed:", e.message);
        }

        return res.json(pickup);
    } catch (err) {
        console.error("cancelMyPickup error:", err);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    requestPickup,
    listMyPickups,
    getMyPickup,
    cancelMyPickup,
};
