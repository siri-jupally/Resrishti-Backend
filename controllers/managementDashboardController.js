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

        // Which categories, if any, the reader has narrowed to. Every weight on
        // the page is then that category's weight — not the weight of pickups
        // that happened to include it.
        const streamFilter = req.query.stream
            ? (Array.isArray(req.query.stream) ? req.query.stream : [req.query.stream])
            : null;

        const [
            statusCounts,
            pickupTotals,
            wasteFacet,
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

            // Pickup-level weight: what the crews recorded, whole pickups.
            // Used as the headline when no category filter is on, and as the
            // check that every kilo has a category.
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

            // Everything else about weight comes from one pass over the line
            // items, so the total, the category split and the monthly trend can
            // never disagree with each other. Before this, the total summed
            // whole pickups while the split summed line items: filtering by
            // Plastic gave a pickup's full 150 kg against a 100 kg plastic bar.
            Pickup.aggregate([
                { $match: byWeighed },
                { $unwind: "$lineItems" },
                ...(streamFilter
                    ? [{ $match: { "lineItems.stream": { $in: streamFilter } } }]
                    : []),
                {
                    $facet: {
                        byMonth: [
                            {
                                $group: {
                                    _id: {
                                        y: { $year: "$wasteDataEnteredAt" },
                                        m: { $month: "$wasteDataEnteredAt" },
                                    },
                                    kg: { $sum: "$lineItems.qtyKg" },
                                    pickups: { $addToSet: "$_id" },
                                },
                            },
                            {
                                $project: {
                                    kg: 1,
                                    pickups: { $size: "$pickups" },
                                },
                            },
                            { $sort: { "_id.y": 1, "_id.m": 1 } },
                        ],
                        // Two groups: the first folds a pickup's repeated lines
                        // for one stream together, so the second can count
                        // pickups rather than lines.
                        byStream: [
                            {
                                $group: {
                                    _id: { stream: "$lineItems.stream", pickup: "$_id" },
                                    kg: { $sum: "$lineItems.qtyKg" },
                                },
                            },
                            {
                                $group: {
                                    _id: "$_id.stream",
                                    kg: { $sum: "$kg" },
                                    pickups: { $sum: 1 },
                                },
                            },
                            { $sort: { kg: -1 } },
                        ],
                        overall: [
                            {
                                $group: {
                                    _id: null,
                                    kg: { $sum: "$lineItems.qtyKg" },
                                    pickups: { $addToSet: "$_id" },
                                },
                            },
                            { $project: { kg: 1, pickups: { $size: "$pickups" } } },
                        ],
                    },
                },
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

        const pickupLevel = pickupTotals[0] || { totalKg: 0, pickups: 0, partial: 0 };
        const facet = wasteFacet[0] || { byMonth: [], byStream: [], overall: [] };
        const lineLevel = facet.overall[0] || { kg: 0, pickups: 0 };

        // The headline weight answers the question the filters ask. Narrowed to
        // a category, that is the weight of THAT category; otherwise it is the
        // whole weight the crews recorded, which also covers any old pickup
        // that carries a total without a category breakdown.
        const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
        const totalWasteKg = streamFilter ? lineLevel.kg : pickupLevel.totalKg;
        const weighedPickups = streamFilter ? lineLevel.pickups : pickupLevel.pickups;

        // Weight recorded without any category against it. Normally zero; if it
        // is not, the category chart cannot add up to the headline and the page
        // says so rather than letting the reader find the gap themselves.
        const uncategorisedKg = streamFilter
            ? 0
            : Math.max(0, pickupLevel.totalKg - lineLevel.kg);

        // ---- categories, with the configured label and CO2e --------------
        const labels = new Map(activeCategories().map((c) => [c.key, c.label]));
        const categories = facet.byStream.map((row) => {
            const factor = factorForStream(row._id);
            return {
                stream: row._id,
                label: labels.get(row._id) || row._id,
                kg: round1(row.kg),
                pickups: row.pickups,
                // kg CO2e avoided per kg, so the arithmetic on screen can be
                // checked against the factor in Settings.
                factor,
                co2eKg: round1(row.kg * factor),
                // Share of the headline weight, so the percentages on screen
                // add up to what the total tile shows.
                share: totalWasteKg > 0 ? Math.round((row.kg / totalWasteKg) * 1000) / 10 : 0,
                averageKgPerPickup: row.pickups > 0 ? round1(row.kg / row.pickups) : 0,
            };
        });

        // Summed before rounding — adding rounded rows drifts by a few hundred
        // grams per category, which looks like an error on a total.
        const co2eAvoidedKg = facet.byStream.reduce(
            (sum, row) => sum + row.kg * factorForStream(row._id),
            0
        );

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
        for (const row of facet.byMonth) {
            const key = `${row._id.y}-${String(row._id.m).padStart(2, "0")}`;
            const m = touch(key);
            m.kg = round1(row.kg);
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
                // Names for the categories filtered to, so the page can say
                // "Plastic only" instead of leaving the reader to assume the
                // weight covers everything.
                streamLabels: streamFilter
                    ? streamFilter.map((s) => labels.get(s) || s)
                    : null,
            },
            kpis: {
                activeClients: filteredClients === null ? activeClients : filteredClients,
                pendingPickups: byStage.pending,
                scheduledPickups: byStage.scheduled,
                inProgressPickups: byStage.inProgress,
                completedPickups: byStage.completed,
                failedOrCancelledPickups: byStage.failedOrCancelled,
                totalPickups,
                partialPickups: pickupLevel.partial,
                // Drafted or issued but not yet in the client's hands.
                pendingCertificates: (certByStatus.draft || 0) + (certByStatus.issued || 0),
                certificatesIssued: certByStatus.issued || 0,
                certificatesSent: certByStatus.sent || 0,
                certificatesCancelled: certByStatus.cancelled || 0,
                // With a category filter on, this is that category's weight.
                totalWasteKg: round1(totalWasteKg),
                weighedPickups,
                // Always the whole weight of the matching pickups, so the page
                // can show what a category is a share OF.
                allCategoriesKg: round1(pickupLevel.totalKg),
                categorisedKg: round1(lineLevel.kg),
                uncategorisedKg: round1(uncategorisedKg),
                co2eAvoidedKg: round1(co2eAvoidedKg),
                averageKgPerPickup: weighedPickups > 0 ? round1(totalWasteKg / weighedPickups) : 0,
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
