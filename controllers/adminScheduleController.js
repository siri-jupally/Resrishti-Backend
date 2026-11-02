/*
  adminScheduleController.js — admin/coordinator review of recurring pickup
  schedules (the "Recurring" tab in admin Pickups).

  A client's recurring request is created `pending` (clientPortalScheduleController)
  and generates NO pickups until it is approved here. On approval the coordinator
  picks a DEFAULT SUPERVISOR; every occurrence the schedule later generates is
  auto-accepted and assigned to them (services/recurringPickupJob +
  services/pickupCreation.assignSupervisor), so there is no per-pickup triage.
  A specific generated pickup can still be reassigned the normal way.

  Endpoints (mounted under /api/admin/schedules behind protectTriage):
    GET   /                 listSchedules
    PATCH /:id/approve      approveSchedule   { supervisorUserType, supervisorUserId }
    PATCH /:id/reject       rejectSchedule    { reason? }
*/
const mongoose = require("mongoose");
const PickupSchedule = require("../models/PickupSchedule");
const Client = require("../models/Client");
const { describeCadence } = require("../utils/recurrence");
const {
    resolveSupervisor,
    buildSupervisorSnapshot,
    actorFromReq,
} = require("./adminPickupController");
const { generateDueForSchedule } = require("../services/recurringPickupJob");
const { sendEmail } = require("../utils/emailService");
const { sendPush } = require("../utils/push");

const canTriage = (req) => {
    if (req.admin) return true;
    if (req.manager && req.manager.canCoordinate) return true;
    return false;
};

const withSummary = (s) => ({ ...s, cadenceSummary: describeCadence(s.cadence) });

// Pending first, then the rest — so the review queue surfaces what needs a
// decision at the top regardless of the status filter.
const STATUS_ORDER = { pending: 0, active: 1, paused: 2, completed: 3, rejected: 4, cancelled: 5 };

// GET /api/admin/schedules?status=pending,active
const listSchedules = async (req, res) => {
    if (!canTriage(req)) return res.status(403).json({ message: "Not authorized" });
    try {
        const ALLOWED = ["pending", "active", "paused", "cancelled", "completed", "rejected"];
        const filter = {};
        const status = (req.query.status || "").toString().trim();
        if (status) {
            const parts = status.split(",").map((s) => s.trim()).filter((s) => ALLOWED.includes(s));
            if (parts.length) filter.status = { $in: parts };
        }
        const items = await PickupSchedule.find(filter)
            .populate("client", "name contactName contactEmail")
            .populate("site", "name")
            .lean();
        items.sort((a, b) => {
            const d = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
            if (d !== 0) return d;
            return new Date(b.createdAt) - new Date(a.createdAt);
        });
        return res.json({ items: items.map(withSummary), total: items.length });
    } catch (err) {
        console.error("listSchedules error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/schedules/:id/approve  { supervisorUserType, supervisorUserId }
const approveSchedule = async (req, res) => {
    if (!canTriage(req)) return res.status(403).json({ message: "Not authorized" });
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid schedule id" });
        }
        const { supervisorUserType, supervisorUserId } = req.body || {};
        if (!supervisorUserType || !supervisorUserId) {
            return res.status(400).json({ message: "A default supervisor is required to approve" });
        }
        const { user, error } = await resolveSupervisor(supervisorUserType, supervisorUserId);
        if (error) return res.status(error.status).json({ message: error.message });

        const schedule = await PickupSchedule.findById(id);
        if (!schedule) return res.status(404).json({ message: "Schedule not found" });
        if (schedule.status !== "pending") {
            return res.status(409).json({
                message: `Only a pending schedule can be approved (current: '${schedule.status}')`,
            });
        }

        const actor = actorFromReq(req);
        const snap = buildSupervisorSnapshot({ user, userType: supervisorUserType, assignedBy: actor.userId });
        schedule.defaultSupervisor = {
            userType: supervisorUserType,
            userId: user._id,
            name: snap.name,
            phone: snap.phone,
        };
        schedule.reviewedBy = { userType: actor.userType, userId: actor.userId, name: actor.name };
        schedule.reviewedAt = new Date();
        schedule.status = "active";
        await schedule.save();

        // Materialise any occurrence already within the generation lead window,
        // so an approved schedule doesn't look empty until the next daily run.
        try { await generateDueForSchedule(schedule); } catch (e) { console.error("generateDueForSchedule (approve):", e.message); }

        // Tell the client their recurring pickup is live.
        try {
            const client = await Client.findById(schedule.client).select("name contactName contactEmail pushSubscription").lean();
            const cad = describeCadence(schedule.cadence);
            if (client?.contactEmail) {
                await sendEmail(
                    client.contactEmail,
                    "Your recurring pickup is approved",
                    `Dear ${client.contactName || client.name},\n\nYour recurring pickup request (${cad}) has been approved. We'll schedule each collection automatically — you'll see them under Pickups.\n\n— GreenEarth Integrated Facility Pvt Ltd`,
                    `<p>Dear ${client.contactName || client.name},</p><p>Your recurring pickup request (<strong>${cad}</strong>) has been <strong>approved</strong>. We'll schedule each collection automatically — you'll see them under Pickups.</p><p>— GreenEarth Integrated Facility Pvt Ltd</p>`
                );
            }
            if (client?.pushSubscription) {
                await sendPush(client.pushSubscription, {
                    title: "Recurring pickup approved",
                    body: "Your recurring schedule is now active.",
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/client/dashboard?tab=recurring" },
                });
            }
        } catch (e) { console.error("approve notify failed:", e.message); }

        const fresh = await PickupSchedule.findById(id).populate("client", "name contactEmail").populate("site", "name").lean();
        return res.json(withSummary(fresh));
    } catch (err) {
        console.error("approveSchedule error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/schedules/:id/reject  { reason? }
const rejectSchedule = async (req, res) => {
    if (!canTriage(req)) return res.status(403).json({ message: "Not authorized" });
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid schedule id" });
        }
        const reason = String(req.body?.reason || "").trim();

        const schedule = await PickupSchedule.findById(id);
        if (!schedule) return res.status(404).json({ message: "Schedule not found" });
        if (schedule.status !== "pending") {
            return res.status(409).json({
                message: `Only a pending schedule can be rejected (current: '${schedule.status}')`,
            });
        }

        const actor = actorFromReq(req);
        schedule.status = "rejected";
        schedule.rejectionReason = reason || undefined;
        schedule.reviewedBy = { userType: actor.userType, userId: actor.userId, name: actor.name };
        schedule.reviewedAt = new Date();
        schedule.nextOccurrence = null;
        await schedule.save();

        try {
            const client = await Client.findById(schedule.client).select("name contactName contactEmail pushSubscription").lean();
            const cad = describeCadence(schedule.cadence);
            if (client?.contactEmail) {
                const reasonLine = reason ? `\n\nReason: ${reason}` : "";
                await sendEmail(
                    client.contactEmail,
                    "About your recurring pickup request",
                    `Dear ${client.contactName || client.name},\n\nWe're unable to set up your recurring pickup request (${cad}) at this time.${reasonLine}\n\nPlease contact your account manager to discuss alternatives.\n\n— GreenEarth Integrated Facility Pvt Ltd`,
                    `<p>Dear ${client.contactName || client.name},</p><p>We're unable to set up your recurring pickup request (<strong>${cad}</strong>) at this time.</p>${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ""}<p>Please contact your account manager to discuss alternatives.</p><p>— GreenEarth Integrated Facility Pvt Ltd</p>`
                );
            }
            if (client?.pushSubscription) {
                await sendPush(client.pushSubscription, {
                    title: "Recurring request update",
                    body: "Your recurring pickup request wasn't approved. Tap for details.",
                    icon: "/android-chrome-512x512.png",
                    data: { url: "/client/dashboard?tab=recurring" },
                });
            }
        } catch (e) { console.error("reject notify failed:", e.message); }

        const fresh = await PickupSchedule.findById(id).populate("client", "name contactEmail").populate("site", "name").lean();
        return res.json(withSummary(fresh));
    } catch (err) {
        console.error("rejectSchedule error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = { listSchedules, approveSchedule, rejectSchedule };
