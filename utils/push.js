const webpush = require("web-push");
const NotificationSettings = require("../models/NotificationSettings");

if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        process.env.VAPID_MAILTO || "mailto:admin@example.com",
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
} else {
    console.warn("VAPID keys not set. Web Push will not work.");
}

const sendPush = async (subscription, payload) => {
    try {
        if (!subscription) return;
        await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (err) {
        console.error("Error sending push notification:", err);
    }
};

const SETTINGS_TTL_MS = 60 * 1000;
let cachedSettings = null;
let cachedAt = 0;
let loadingPromise = null;

async function loadSettings() {
    let doc = await NotificationSettings.findOne({ key: "global" });
    if (!doc) {
        doc = await NotificationSettings.create({ key: "global" });
    }
    return doc;
}

async function getSettings() {
    const now = Date.now();
    if (cachedSettings && now - cachedAt < SETTINGS_TTL_MS) return cachedSettings;
    if (loadingPromise) return loadingPromise;
    loadingPromise = loadSettings()
        .then((doc) => {
            cachedSettings = doc;
            cachedAt = Date.now();
            loadingPromise = null;
            return doc;
        })
        .catch((err) => {
            loadingPromise = null;
            console.error("notification settings load error:", err);
            return null;
        });
    return loadingPromise;
}

function invalidateSettingsCache() {
    cachedSettings = null;
    cachedAt = 0;
}

function isEnabled(settings, group) {
    if (!settings) return true;
    const togglesMap = settings.toggles;
    if (!togglesMap) return true;
    const val =
        typeof togglesMap.get === "function"
            ? togglesMap.get(group)
            : togglesMap[group];
    return val !== false;
}

/**
 * Lightweight check exposed for callers that want to early-exit
 * BEFORE doing expensive recipient lookups. Returns true if the group
 * is enabled (or unknown - we default to enabled).
 */
async function isGroupEnabled(group) {
    const settings = await getSettings();
    return isEnabled(settings, group);
}

/**
 * Gated push: checks admin settings; if the group is disabled, the push
 * is skipped silently. Returns true if sent, false if skipped/no-op.
 * `group` must be one of: "task", "attendance".
 */
async function notifyIfEnabled(group, subscription, payload) {
    if (!subscription) return false;
    const settings = await getSettings();
    if (!isEnabled(settings, group)) return false;
    await sendPush(subscription, payload);
    return true;
}

module.exports = {
    sendPush,
    notifyIfEnabled,
    isGroupEnabled,
    getSettings,
    invalidateSettingsCache,
};
