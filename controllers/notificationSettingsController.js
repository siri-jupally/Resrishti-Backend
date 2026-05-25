const NotificationSettings = require("../models/NotificationSettings");
const { invalidateSettingsCache } = require("../utils/push");

const { NOTIFICATION_GROUPS } = NotificationSettings;

function togglesToObject(toggles) {
    const out = {};
    for (const g of NOTIFICATION_GROUPS) out[g] = true;
    if (!toggles) return out;
    if (typeof toggles.get === "function") {
        for (const [k, v] of toggles.entries()) out[k] = v;
    } else {
        for (const k of Object.keys(toggles)) out[k] = toggles[k];
    }
    for (const g of NOTIFICATION_GROUPS) {
        if (typeof out[g] !== "boolean") out[g] = true;
    }
    return out;
}

const getSettings = async (req, res) => {
    try {
        let doc = await NotificationSettings.findOne({ key: "global" });
        if (!doc) doc = await NotificationSettings.create({ key: "global" });
        res.json({
            groups: NOTIFICATION_GROUPS,
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
        for (const g of NOTIFICATION_GROUPS) {
            if (Object.prototype.hasOwnProperty.call(toggles, g)) {
                next[g] = !!toggles[g];
            } else if (typeof next[g] !== "boolean") {
                next[g] = true;
            }
        }
        doc.toggles = next;
        doc.markModified("toggles");
        if (req.admin?._id) doc.updatedBy = req.admin._id;
        await doc.save();
        invalidateSettingsCache();

        res.json({
            groups: NOTIFICATION_GROUPS,
            toggles: togglesToObject(doc.toggles),
            updatedAt: doc.updatedAt,
        });
    } catch (err) {
        console.error("updateSettings error:", err);
        res.status(500).json({ message: "Failed to update settings" });
    }
};

module.exports = { getSettings, updateSettings };
