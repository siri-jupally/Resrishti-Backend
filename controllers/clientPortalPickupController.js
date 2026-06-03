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
const crypto = require("crypto");
const Pickup = require("../models/Pickup");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");
const { sendPush } = require("../utils/push");

// Mirrors generateTaskId in controllers/managerController.js but emits PU-... ids.
// Using crypto.randomBytes instead of Math.random gives a higher-entropy 6-char
// hex tail, which keeps collision odds vanishingly small even at high volume.
const generatePickupId = () => {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(
        2,
        "0"
    )}${String(d.getDate()).padStart(2, "0")}`;
    const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `PU-${ymd}-${rand}`;
};

// Stream enum mirrors models/Pickup.js wasteLineItemSchema. Kept in sync by
// hand — if the spec adds streams later, both lists must update together.
const ALLOWED_STREAMS = [
    "plastic",
    "paper",
    "ewaste",
    "biomedical",
    "foam-thermocol",
    "dry-waste",
    "agr",
    "battery",
    "expired-food",
    "hazardous",
    "other",
];

// Build a human-readable address string from the client's billingAddress
// object. Snapshotting it onto the pickup ensures the audit trail / cert PDF
// stays stable even if the client's address changes later.
const formatPickupAddress = (client) => {
    const a = client.billingAddress || {};
    return [a.line1, a.line2, a.city, a.state, a.postalCode, a.country]
        .filter(Boolean)
        .join(", ");
};

// POST /api/client/pickups
const requestPickup = async (req, res) => {
    try {
        const { requestedDate, requestedStreams, clientNotes } = req.body;

        // --- validation ---------------------------------------------------
        if (
            !Array.isArray(requestedStreams) ||
            requestedStreams.length === 0
        ) {
            return res
                .status(400)
                .json({ message: "requestedStreams must be a non-empty array" });
        }
        const invalidStream = requestedStreams.find(
            (s) => !ALLOWED_STREAMS.includes(s)
        );
        if (invalidStream) {
            return res
                .status(400)
                .json({ message: `Invalid stream: ${invalidStream}` });
        }

        // requestedDate must parse AND be today-or-future.
        if (!requestedDate) {
            return res.status(400).json({ message: "requestedDate is required" });
        }
        const rd = new Date(requestedDate);
        if (Number.isNaN(rd.getTime())) {
            return res
                .status(400)
                .json({ message: "requestedDate is not a valid date" });
        }
        // Compare on calendar-day boundary so a same-day request submitted in
        // the afternoon doesn't get rejected just because Date.now() > 00:00.
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const rdDay = new Date(rd);
        rdDay.setHours(0, 0, 0, 0);
        if (rdDay.getTime() < today.getTime()) {
            return res
                .status(400)
                .json({ message: "requestedDate cannot be in the past" });
        }

        // --- soft duplicate warning ---------------------------------------
        // Admin sees this in the queue; we don't block — they decide.
        try {
            const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
            const recent = await Pickup.findOne({
                client: req.client._id,
                createdAt: { $gte: tenMinAgo },
                requestedStreams: { $in: requestedStreams },
            }).select("_id pickupID");
            if (recent) {
                console.warn(
                    `[pickup] Possible duplicate request from client ${req.client._id} — recent pickup ${recent.pickupID} (${recent._id}) within last 10 min with overlapping streams.`
                );
            }
        } catch (e) {
            // Non-fatal — just log and proceed.
            console.error("Duplicate-warn lookup failed:", e.message);
        }

        // --- create with pickupID retry loop ------------------------------
        // Same 3-attempt pattern as managerController.createTask. After 3
        // unique-collisions we bail; in practice 6-hex/day collisions are
        // ~1-in-16M so a single attempt almost always succeeds.
        let pickup = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const pickupID = generatePickupId();
            try {
                // eslint-disable-next-line no-await-in-loop
                pickup = await Pickup.create({
                    pickupID,
                    client: req.client._id,
                    clientNameSnapshot: req.client.name,
                    pickupAddressSnapshot: formatPickupAddress(req.client),
                    requestedDate: rd,
                    requestedStreams,
                    clientNotes,
                    status: "requested",
                });
                break;
            } catch (err) {
                lastErr = err;
                // Mongo dup-key on pickupID → retry. Anything else → rethrow.
                if (err && err.code === 11000 && err.keyPattern?.pickupID) {
                    continue;
                }
                throw err;
            }
        }
        if (!pickup) {
            console.error("Failed to generate pickupID after 3 attempts:", lastErr);
            return res
                .status(500)
                .json({ message: "Failed to generate pickupID" });
        }

        // --- notify coordinators ------------------------------------------
        // Admins + Managers with canCoordinate=true AND a push subscription.
        // sendPush is fire-and-forget per recipient; we don't await the array
        // because a slow push provider shouldn't delay the API response.
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
                title: "New Pickup Request",
                body: `${req.client.name} requested pickup of ${requestedStreams.join(
                    ", "
                )}`,
                icon: "/android-chrome-512x512.png",
                tag: `pickup-new-${pickup._id}`,
                data: {
                    url: `/admin/dashboard?tab=pickups&id=${pickup._id}`,
                },
            };
            // Fire-and-forget — same pattern as createTask. Errors logged in sendPush.
            await Promise.all(
                recipients
                    .filter((r) => r.pushSubscription)
                    .map((r) => sendPush(r.pushSubscription, payload))
            );
        } catch (e) {
            // Push delivery failures must not break pickup creation.
            console.error("Coordinator push notify failed:", e.message);
        }

        return res.status(201).json(pickup);
    } catch (err) {
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
        if (status) query.status = status;

        const [items, total] = await Promise.all([
            Pickup.find(query)
                .sort({ createdAt: -1 })
                .skip(offset)
                .limit(limit),
            Pickup.countDocuments(query),
        ]);

        return res.json({ items, total, limit, offset });
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

        return res.json(pickup);
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
