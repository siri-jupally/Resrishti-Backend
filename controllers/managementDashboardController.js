/*
  managementDashboardController.js — one call that answers "how is the
  operation doing?" for the admin dashboard.

  GET /api/admin/dashboard/overview
    ?from=YYYY-MM-DD & to=YYYY-MM-DD
    &clientId= &siteId= &stream= &status=a&status=b

  Which date a figure is counted against matters, and the two answers differ:
    - pickup counts are keyed on `requestedAt` — when the work was asked for
    - waste figures are keyed on `wasteDataEnteredAt` — when it was weighed
  A pickup requested in March and weighed in April belongs to March's pickup
  count and April's tonnage. Reporting both off one date would make one of the
  two wrong, so the UI states which is which.

  Everything is computed in Mongo rather than in Node: these collections grow
  without bound and pulling every pickup back to count them would not survive
  a year of operation.
*/
const mongoose = require("mongoose");
const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const Certificate = require("../models/Certificate");
const { factorForStream, refreshCache, activeCategories } =
    require("../utils/wasteCategories");

// Pickup statuses grouped into the stages management actually asks about.
// Mirrors STATUSES_BY_STAGE in the frontend's pickupStatus.js.
const STAGES = {
    pending: ["requested"],
    scheduled: ["accepted", "scheduled", "postponed"],
    inProgress: ["en-route", "at-client", "picked-up", "at-facility", "weighed"],
    completed: ["processed", "cert-draft", "cert-issued", "cert-sent"],
    failedOrCancelled: ["failed", "no-show", "cancelled", "rejected"],
};

const stageOf = (status) => {
    for (const [stage, statuses] of Object.entries(STAGES)) {
        if (statuses.includes(status)) return stage;
    }
    return "inProgress";
};

const parseDate = (value, endOfDay = false) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    if (endOfDay) d.setHours(23, 59, 59, 999);
    else d.setHours(0, 0, 0, 0);
    return d;
};

const monthKey = (date) => {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

/**
 * Filters every figure on this dashboard shares: who, where, what and which
 * stage. The date range is applied separately per figure, because pickup
 * counts and tonnage are keyed on different dates.
 */
const buildBaseMatch = (query) => {
    const match = {};
    if (query.clientId && mongoose.Types.ObjectId.isValid(query.clientId)) {
        match.client = new mongoose.Types.ObjectId(query.clientId);
    }
    if (query.siteId && mongoose.Types.ObjectId.isValid(query.siteId)) {
        match.site = new mongoose.Types.ObjectId(query.siteId);
    }
    if (query.stream) {
        const streams = Array.isArray(query.stream) ? query.stream : [query.stream];
        // A pickup counts for a stream if it was asked for OR actually
        // collected — filtering on only one of the two hides the pickups where
        // the crew found something different from what was booked.
        match.$or = [
            { "lineItems.stream": { $in: streams } },
            { requestedStreams: { $in: streams } },
        ];
    }
    if (query.status) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status];
        if (statuses.length > 0) match.status = { $in: statuses };
    }
    return match;
};

const withDateRange = (match, field, from, to) => {
    if (!from && !to) return match;
    const range = {};
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    return { ...match, [field]: range };
};

const getOverview = async (req, res) => {
    try {
        const from = parseDate(req.query.from);
        const to = parseDate(req.query.to, true);
        const base = buildBaseMatch(req.query);

        // `requestedAt` is set on every pickup by default, but very old
        // records may predate it — fall back to createdAt so nothing silently
        // drops out of the counts.
        const byRequested = withDateRange(base, "requestedAt", from, to);
        const byWeighed = withDateRange(
            { ...base, wasteDataEnteredAt: { $ne: null } },
            "wasteDataEnteredAt",
            from,
            to
        );

        await refreshCache();

        const [
            statusCounts,
            wasteTotals,
            categoryRows,
            monthlyWasteRows,
            monthlyPickupRows,
            certCounts,
            activeClients,
            filteredClients,
        ] = await Promise.all([
            // Pickup counts per status, folded into stages below.
            Pickup.aggregate([
                { $match: byRequested },
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),

            // Weight actually collected, and how many pickups it came from.
            Pickup.aggregate([
                { $match: byWeighed },
                {
                    $group: {
                        _id: null,
                        totalKg: { $sum: "$totalKg" },
                        pickups: { $sum: 1 },
                        partial: { $sum: { $cond: ["$isPartial", 1, 0] } },
                    },
                },
            ]),

            // Category-wise summary, from the line items actually recorded.
            Pickup.aggregate([
                { $match: byWeighed },
                { $unwind: "$lineItems" },
                ...(req.query.stream
                    ? [{
                        $match: {
                            "lineItems.stream": {
                                $in: Array.isArray(req.query.stream)
                                    ? req.query.stream
                                    : [req.query.stream],
                            },
                        },
                    }]
                    : []),
                {
                    $group: {
                        _id: "$lineItems.stream",
                        kg: { $sum: "$lineItems.qtyKg" },
                        lines: { $sum: 1 },
                    },
                },
                { $sort: { kg: -1 } },
            ]),

            // Month-wise collection trend.
            Pickup.aggregate([
                { $match: byWeighed },
                {
                    $group: {
                        _id: {
                            y: { $year: "$wasteDataEnteredAt" },
                            m: { $month: "$wasteDataEnteredAt" },
                        },
                        kg: { $sum: "$totalKg" },
                        pickups: { $sum: 1 },
                    },
                },
                { $sort: { "_id.y": 1, "_id.m": 1 } },
            ]),

            // Month-wise pickup summary, split into completed vs lost so the
            // trend shows quality, not just volume.
            Pickup.aggregate([
                { $match: byRequested },
                {
                    $group: {
                        _id: {
                            y: { $year: "$requestedAt" },
                            m: { $month: "$requestedAt" },
                        },
                        total: { $sum: 1 },
                        completed: {
                            $sum: {
                                $cond: [{ $in: ["$status", STAGES.completed] }, 1, 0],
                            },
                        },
                        lost: {
                            $sum: {
                                $cond: [
                                    { $in: ["$status", STAGES.failedOrCancelled] },
                                    1,
                                    0,
                                ],
                            },
                        },
                    },
                },
                { $sort: { "_id.y": 1, "_id.m": 1 } },
            ]),

            // Certificates, on their own dates: drafted/issued are outstanding
            // work, sent is delivered.
            Certificate.aggregate([
                {
                    $match: {
                        ...(base.client ? { client: base.client } : {}),
                        ...(from || to
                            ? { createdAt: { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) } }
                            : {}),
                    },
                },
                { $group: { _id: "$status", count: { $sum: 1 } } },
            ]),

            Client.countDocuments({ status: "active" }),

            // With a client filter on, "active clients" means that one client.
            base.client
                ? Client.countDocuments({ _id: base.client, status: "active" })
                : Promise.resolve(null),
        ]);

        // ---- fold status counts into stages -----------------------------
        const byStatus = {};
        const byStage = {
            pending: 0, scheduled: 0, inProgress: 0, completed: 0, failedOrCancelled: 0,
        };
        let totalPickups = 0;
        for (const row of statusCounts) {
            byStatus[row._id] = row.count;
            byStage[stageOf(row._id)] += row.count;
            totalPickups += row.count;
        }

        const certByStatus = {};
        for (const row of certCounts) certByStatus[row._id] = row.count;

        const waste = wasteTotals[0] || { totalKg: 0, pickups: 0, partial: 0 };

        // ---- categories, with the configured label and CO2e --------------
        const labels = new Map(activeCategories().map((c) => [c.key, c.label]));
        const categories = categoryRows.map((row) => ({
            stream: row._id,
            label: labels.get(row._id) || row._id,
            kg: Math.round(row.kg * 10) / 10,
            lines: row.lines,
            co2eKg: Math.round(row.kg * factorForStream(row._id) * 10) / 10,
            share: waste.totalKg > 0 ? Math.round((row.kg / waste.totalKg) * 1000) / 10 : 0,
        }));

        const co2eAvoidedKg = categories.reduce((sum, c) => sum + c.co2eKg, 0);

        // ---- month series, merged so a month with pickups but no tonnage
        //      (or the reverse) still appears ------------------------------
        const months = new Map();
        const touch = (key) => {
            if (!months.has(key)) {
                months.set(key, {
                    month: key, kg: 0, weighedPickups: 0,
                    pickups: 0, completed: 0, lost: 0,
                });
            }
            return months.get(key);
        };
        for (const row of monthlyWasteRows) {
            const key = `${row._id.y}-${String(row._id.m).padStart(2, "0")}`;
            const m = touch(key);
            m.kg = Math.round(row.kg * 10) / 10;
            m.weighedPickups = row.pickups;
        }
        for (const row of monthlyPickupRows) {
            const key = `${row._id.y}-${String(row._id.m).padStart(2, "0")}`;
            const m = touch(key);
            m.pickups = row.total;
            m.completed = row.completed;
            m.lost = row.lost;
        }
        const monthly = [...months.values()].sort((a, b) => a.month.localeCompare(b.month));

        return res.json({
            filters: {
                from: from ? from.toISOString() : null,
                to: to ? to.toISOString() : null,
                clientId: req.query.clientId || null,
                siteId: req.query.siteId || null,
                stream: req.query.stream || null,
                status: req.query.status || null,
            },
            kpis: {
                activeClients: filteredClients === null ? activeClients : filteredClients,
                pendingPickups: byStage.pending,
                scheduledPickups: byStage.scheduled,
                inProgressPickups: byStage.inProgress,
                completedPickups: byStage.completed,
                failedOrCancelledPickups: byStage.failedOrCancelled,
                totalPickups,
                partialPickups: waste.partial,
                // Drafted or issued but not yet in the client's hands.
                pendingCertificates: (certByStatus.draft || 0) + (certByStatus.issued || 0),
                certificatesIssued: certByStatus.issued || 0,
                certificatesSent: certByStatus.sent || 0,
                certificatesCancelled: certByStatus.cancelled || 0,
                totalWasteKg: Math.round(waste.totalKg * 10) / 10,
                weighedPickups: waste.pickups,
                co2eAvoidedKg: Math.round(co2eAvoidedKg * 10) / 10,
            },
            byStatus,
            categories,
            monthly,
            // So the UI can label which date each half is counted on.
            countedOn: { pickups: "requestedAt", waste: "wasteDataEnteredAt" },
        });
    } catch (err) {
        console.error("getOverview error:", err);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = { getOverview, STAGES, monthKey };
