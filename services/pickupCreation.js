/*
  pickupCreation service — the ONE place a Pickup is created.

  Extracted verbatim from clientPortalPickupController.requestPickup so that
  both the client self-service flow and the staff "create pickup on behalf of a
  client" flow run through identical validation, ID generation, address
  snapshotting, initial status, and coordinator notification. There is exactly
  one creation path; callers only differ in WHO the client is and whether an
  actor is recorded.

  createPickupForClient({ client, requestedDate, requestedStreams, clientNotes,
                          siteId, createdByActor }) → Pickup

  - `client`   : a Client document (must have _id, name, billingAddress). The
                 created pickup is linked to this client and starts at
                 status "requested" with NO supervisor — so it flows through the
                 normal triage/accept/assign lifecycle and appears in that
                 client's portal exactly like a self-requested pickup.
  - `createdByActor` (optional): { userType: "Admin"|"Manager"|"Employee",
                 userId, name } — when present (staff-created), an audit entry is
                 appended to evidence[] recording who created it on the client's
                 behalf. Omitted for the client's own requests, so that path is
                 byte-for-byte equivalent to before.

  Validation failures throw PickupCreationError(status, message) so each caller
  can map them to the same HTTP responses the client endpoint used.
*/
const crypto = require("crypto");
const mongoose = require("mongoose");
const Pickup = require("../models/Pickup");
const Site = require("../models/Site");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");
const { sendPush } = require("../utils/push");
const { activeStreamKeys } = require("../utils/wasteCategories");

class PickupCreationError extends Error {
    constructor(status, message) {
        super(message);
        this.name = "PickupCreationError";
        this.status = status;
    }
}

const generatePickupId = () => {
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(
        2,
        "0"
    )}${String(d.getDate()).padStart(2, "0")}`;
    const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
    return `PU-${ymd}-${rand}`;
};

const formatSiteAddress = (site) => {
    const a = (site && site.address) || {};
    return [a.line1, a.line2, a.city, a.state, a.postalCode, a.country]
        .filter(Boolean)
        .join(", ");
};

const formatPickupAddress = (client) => {
    const a = client.billingAddress || {};
    return [a.line1, a.line2, a.city, a.state, a.postalCode, a.country]
        .filter(Boolean)
        .join(", ");
};

async function createPickupForClient({
    client,
    requestedDate,
    requestedStreams,
    clientNotes,
    siteId,
    createdByActor = null,
    // When true (and createdByActor is set), the pickup is created already
    // "accepted" and self-assigned to the creating Pickup Agent, so it lands
    // directly in their My Pickups ready to execute — skipping admin triage.
    // Left false for the client self-service path (starts at "requested").
    assignToActor = false,
}) {
    if (!client || !client._id) {
        throw new PickupCreationError(400, "A valid client is required");
    }

    // --- validation -------------------------------------------------------
    if (!Array.isArray(requestedStreams) || requestedStreams.length === 0) {
        throw new PickupCreationError(400, "requestedStreams must be a non-empty array");
    }
    const allowedStreams = await activeStreamKeys();
    const invalidStream = requestedStreams.find((s) => !allowedStreams.includes(s));
    if (invalidStream) {
        throw new PickupCreationError(400, `Invalid stream: ${invalidStream}`);
    }

    if (!requestedDate) {
        throw new PickupCreationError(400, "requestedDate is required");
    }
    const rd = new Date(requestedDate);
    if (Number.isNaN(rd.getTime())) {
        throw new PickupCreationError(400, "requestedDate is not a valid date");
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rdDay = new Date(rd);
    rdDay.setHours(0, 0, 0, 0);
    if (rdDay.getTime() < today.getTime()) {
        throw new PickupCreationError(400, "requestedDate cannot be in the past");
    }

    // --- location (scoped to THIS client) ---------------------------------
    let site = null;
    if (siteId) {
        if (!mongoose.Types.ObjectId.isValid(siteId)) {
            throw new PickupCreationError(400, "Invalid location");
        }
        site = await Site.findOne({
            _id: siteId,
            client: client._id,
            isActive: true,
        });
        if (!site) {
            throw new PickupCreationError(404, "Location not found");
        }
    }

    // --- soft duplicate warning (log only, non-blocking) ------------------
    try {
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
        const recent = await Pickup.findOne({
            client: client._id,
            createdAt: { $gte: tenMinAgo },
            requestedStreams: { $in: requestedStreams },
        }).select("_id pickupID");
        if (recent) {
            console.warn(
                `[pickup] Possible duplicate request for client ${client._id} — recent pickup ${recent.pickupID} (${recent._id}) within last 10 min with overlapping streams.`
            );
        }
    } catch (e) {
        console.error("Duplicate-warn lookup failed:", e.message);
    }

    // --- create with pickupID retry loop ----------------------------------
    const now = new Date();
    // Self-assign only makes sense for a staff-created pickup (actor present).
    const selfAssign = Boolean(assignToActor && createdByActor);
    const actorRef = createdByActor
        ? { userType: createdByActor.userType, userId: createdByActor.userId, name: createdByActor.name }
        : null;

    // Audit entry recording the staff member who created it (and self-assignment
    // when applicable). Only added for the staff flow, so the client
    // self-service path is unchanged.
    const evidence = createdByActor
        ? [
              {
                  status: selfAssign ? "accepted" : "requested",
                  notes: selfAssign
                      ? `Created & self-assigned by ${createdByActor.userType} ${createdByActor.name || ""}`.trim()
                      : `Created on behalf of client by ${createdByActor.userType} ${createdByActor.name || ""}`.trim(),
                  by: actorRef,
                  at: now,
              },
          ]
        : undefined;

    let pickup = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const pickupID = generatePickupId();
        try {
            const doc = {
                pickupID,
                client: client._id,
                clientNameSnapshot: client.name,
                site: site ? site._id : null,
                siteNameSnapshot: site ? site.name : undefined,
                pickupAddressSnapshot: site
                    ? formatSiteAddress(site)
                    : formatPickupAddress(client),
                requestedDate: rd,
                requestedStreams,
                clientNotes,
                status: selfAssign ? "accepted" : "requested",
                ...(evidence ? { evidence } : {}),
            };
            if (selfAssign) {
                // Mirror what admin acceptPickup sets: accepted + scheduled +
                // supervisor, so the pickup follows the normal field lifecycle
                // from "accepted" onward — just without a triage round-trip.
                doc.scheduledDate = rd;
                doc.acceptedAt = now;
                doc.acceptedBy = actorRef;
                doc.supervisor = {
                    userType: createdByActor.userType, // Admin | Manager | Employee
                    userId: createdByActor.userId,
                    name: createdByActor.name,
                    phone: createdByActor.phone,
                    assignedAt: now,
                    assignedBy: createdByActor.userId, // schema: ObjectId
                };
            }
            // eslint-disable-next-line no-await-in-loop
            pickup = await Pickup.create(doc);
            break;
        } catch (err) {
            lastErr = err;
            if (err && err.code === 11000 && err.keyPattern?.pickupID) {
                continue;
            }
            throw err;
        }
    }
    if (!pickup) {
        console.error("Failed to generate pickupID after 3 attempts:", lastErr);
        throw new PickupCreationError(500, "Failed to generate pickupID");
    }

    // --- notify coordinators (fire-and-forget) ----------------------------
    // Skipped when self-assigned — there is no triage step for a coordinator
    // to action, so the "New Pickup Request" push would be misleading noise.
    if (!selfAssign) try {
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
            body: `${client.name} requested pickup of ${requestedStreams.join(", ")}`,
            icon: "/android-chrome-512x512.png",
            tag: `pickup-new-${pickup._id}`,
            data: { url: `/admin/dashboard?tab=pickups&id=${pickup._id}` },
        };
        await Promise.all(
            recipients
                .filter((r) => r.pushSubscription)
                .map((r) => sendPush(r.pushSubscription, payload))
        );
    } catch (e) {
        console.error("Coordinator push notify failed:", e.message);
    }

    return pickup;
}

module.exports = {
    createPickupForClient,
    PickupCreationError,
    generatePickupId,
    formatSiteAddress,
    formatPickupAddress,
};
