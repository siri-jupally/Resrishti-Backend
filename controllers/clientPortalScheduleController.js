/*
  clientPortalScheduleController.js — a client's recurring pickup schedules.

  Mounted at /api/client/schedules behind protectClient. A schedule is a
  recurring "contract" the daily recurringPickupJob turns into normal requested
  pickups. The client can create, list, pause, resume and cancel.
*/
const PickupSchedule = require("../models/PickupSchedule");
const Site = require("../models/Site");
const { activeStreamKeys } = require("../utils/wasteCategories");
const { validateCadence, describeCadence, atMidnight } = require("../utils/recurrence");
const { generateDueForSchedule } = require("../services/recurringPickupJob");

// Keep only the cadence fields that belong to the chosen type.
const normalizeCadence = (c) => {
    const out = { type: c.type };
    if (c.type === "weekly" || c.type === "biweekly") out.weekday = Number(c.weekday);
    if (c.type === "monthly") out.dayOfMonth = Number(c.dayOfMonth);
    if (c.type === "everyNDays") out.intervalDays = Number(c.intervalDays);
    return out;
};

const withSummary = (s) => ({ ...s, cadenceSummary: describeCadence(s.cadence) });

// POST /api/client/schedules
const createSchedule = async (req, res) => {
    try {
        const client = req.client;
        const { cadence, requestedStreams, clientNotes, siteId, startDate, endDate } = req.body;

        const cadErr = validateCadence(cadence);
        if (cadErr) return res.status(400).json({ message: cadErr });

        if (!Array.isArray(requestedStreams) || requestedStreams.length === 0) {
            return res.status(400).json({ message: "Pick at least one waste stream" });
        }
        const allowed = await activeStreamKeys();
        const bad = requestedStreams.find((s) => !allowed.includes(s));
        if (bad) return res.status(400).json({ message: `Invalid stream: ${bad}` });

        const start = startDate ? new Date(startDate) : new Date();
        if (Number.isNaN(start.getTime())) return res.status(400).json({ message: "Invalid start date" });
        if (atMidnight(start) < atMidnight(new Date())) {
            return res.status(400).json({ message: "Start date cannot be in the past" });
        }
        let end = null;
        if (endDate) {
            end = new Date(endDate);
            if (Number.isNaN(end.getTime())) return res.status(400).json({ message: "Invalid end date" });
            if (atMidnight(end) < atMidnight(start)) {
                return res.status(400).json({ message: "End date must be on or after the start date" });
            }
        }

        let site = null;
        if (siteId) {
            site = await Site.findOne({ _id: siteId, client: client._id, isActive: true });
            if (!site) return res.status(404).json({ message: "Location not found" });
        }

        const schedule = await PickupSchedule.create({
            client: client._id,
            site: site ? site._id : null,
            requestedStreams,
            clientNotes: clientNotes ? String(clientNotes).trim() || undefined : undefined,
            cadence: normalizeCadence(cadence),
            startDate: start,
            endDate: end,
            status: "active",
            createdByType: "Client",
            createdById: client._id,
            createdByName: client.name,
        });

        // Produce the first pickup(s) immediately if any occurrence is already
        // within the lead window, so the client sees it without waiting a day.
        try { await generateDueForSchedule(schedule); } catch (e) { console.error("generateDueForSchedule (create):", e.message); }

        const fresh = await PickupSchedule.findById(schedule._id).lean();
        return res.status(201).json(withSummary(fresh));
    } catch (err) {
        console.error("createSchedule error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/client/schedules
const listMySchedules = async (req, res) => {
    try {
        const items = await PickupSchedule.find({ client: req.client._id })
            .populate("site", "name")
            .sort({ status: 1, createdAt: -1 })
            .lean();
        return res.json({ items: items.map(withSummary), total: items.length });
    } catch (err) {
        console.error("listMySchedules error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// Shared loader scoped to the authenticated client.
const loadOwn = async (req, res) => {
    const s = await PickupSchedule.findOne({ _id: req.params.id, client: req.client._id });
    if (!s) { res.status(404).json({ message: "Schedule not found" }); return null; }
    return s;
};

// PATCH /api/client/schedules/:id/pause
const pauseSchedule = async (req, res) => {
    try {
        const s = await loadOwn(req, res); if (!s) return;
        if (s.status !== "active") return res.status(409).json({ message: `Can't pause a ${s.status} schedule.` });
        s.status = "paused";
        await s.save();
        return res.json(withSummary(s.toObject()));
    } catch (err) { console.error("pauseSchedule:", err.message); return res.status(500).json({ message: err.message }); }
};

// PATCH /api/client/schedules/:id/resume
const resumeSchedule = async (req, res) => {
    try {
        const s = await loadOwn(req, res); if (!s) return;
        if (s.status !== "paused") return res.status(409).json({ message: `Can't resume a ${s.status} schedule.` });
        s.status = "active";
        await s.save();
        // Catch up any occurrence now within the lead window.
        try { await generateDueForSchedule(s); } catch (e) { console.error("generateDueForSchedule (resume):", e.message); }
        const fresh = await PickupSchedule.findById(s._id).lean();
        return res.json(withSummary(fresh));
    } catch (err) { console.error("resumeSchedule:", err.message); return res.status(500).json({ message: err.message }); }
};

// PATCH /api/client/schedules/:id/cancel
const cancelSchedule = async (req, res) => {
    try {
        const s = await loadOwn(req, res); if (!s) return;
        if (s.status === "cancelled") return res.status(409).json({ message: "Already cancelled." });
        if (s.status === "completed") return res.status(409).json({ message: "This schedule has already finished." });
        s.status = "cancelled";
        s.nextOccurrence = null;
        await s.save();
        return res.json(withSummary(s.toObject()));
    } catch (err) { console.error("cancelSchedule:", err.message); return res.status(500).json({ message: err.message }); }
};

module.exports = {
    createSchedule,
    listMySchedules,
    pauseSchedule,
    resumeSchedule,
    cancelSchedule,
};
