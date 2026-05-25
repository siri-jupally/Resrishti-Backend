const NotificationSettings = require("../models/NotificationSettings");
const NotificationLog = require("../models/NotificationLog");
const { invalidateSettingsCache } = require("../utils/push");

const { NOTIFICATION_TYPES } = NotificationSettings;

function togglesToObject(togglesMap) {
    const out = {};
    for (const t of NOTIFICATION_TYPES) out[t] = true;
    if (!togglesMap) return out;
    if (typeof togglesMap.get === "function") {
        for (const [k, v] of togglesMap.entries()) out[k] = v;
    } else {
        for (const k of Object.keys(togglesMap)) out[k] = togglesMap[k];
    }
    for (const t of NOTIFICATION_TYPES) {
        if (typeof out[t] !== "boolean") out[t] = true;
    }
    return out;
}

const getSettings = async (req, res) => {
    try {
        let doc = await NotificationSettings.findOne({ key: "global" });
        if (!doc) doc = await NotificationSettings.create({ key: "global" });
        res.json({
            types: NOTIFICATION_TYPES,
            toggles: togglesToObject(doc.toggles),
            updatedAt: doc.updatedAt,
        });
    } catch (err) {
        console.error("getSettings error:", err);
        res.status(500).json({ message: "Failed to load settings" });
    }
};

const updateSettings = async (req, res) => {
    try {
        const { toggles } = req.body || {};
        if (!toggles || typeof toggles !== "object") {
            return res.status(400).json({ message: "toggles object is required" });
        }
        let doc = await NotificationSettings.findOne({ key: "global" });
        if (!doc) doc = await NotificationSettings.create({ key: "global" });

        const next = { ...(doc.toggles || {}) };
        for (const t of NOTIFICATION_TYPES) {
            if (Object.prototype.hasOwnProperty.call(toggles, t)) {
                next[t] = !!toggles[t];
            } else if (typeof next[t] !== "boolean") {
                next[t] = true;
            }
        }
        doc.toggles = next;
        doc.markModified("toggles");
        if (req.admin?._id) doc.updatedBy = req.admin._id;
        await doc.save();
        invalidateSettingsCache();

        res.json({
            types: NOTIFICATION_TYPES,
            toggles: togglesToObject(doc.toggles),
            updatedAt: doc.updatedAt,
        });
    } catch (err) {
        console.error("updateSettings error:", err);
        res.status(500).json({ message: "Failed to update settings" });
    }
};

const getStats = async (req, res) => {
    try {
        const days = Math.max(1, Math.min(parseInt(req.query.days, 10) || 7, 30));
        const since = new Date();
        since.setUTCHours(0, 0, 0, 0);
        since.setUTCDate(since.getUTCDate() - (days - 1));
        const sinceKey = since.toISOString().slice(0, 10);

        const rows = await NotificationLog.aggregate([
            { $match: { day: { $gte: sinceKey } } },
            {
                $group: {
                    _id: "$type",
                    sent: { $sum: "$sent" },
                    skipped: { $sum: "$skipped" },
                    lastAt: { $max: "$lastAt" },
                },
            },
        ]);

        const byType = {};
        for (const t of NOTIFICATION_TYPES) {
            byType[t] = { sent: 0, skipped: 0, lastAt: null };
        }
        for (const r of rows) {
            byType[r._id] = {
                sent: r.sent || 0,
                skipped: r.skipped || 0,
                lastAt: r.lastAt,
            };
        }

        const totals = Object.values(byType).reduce(
            (acc, v) => {
                acc.sent += v.sent;
                acc.skipped += v.skipped;
                return acc;
            },
            { sent: 0, skipped: 0 }
        );

        res.json({ days, byType, totals });
    } catch (err) {
        console.error("getStats error:", err);
        res.status(500).json({ message: "Failed to load stats" });
    }
};

module.exports = { getSettings, updateSettings, getStats };
