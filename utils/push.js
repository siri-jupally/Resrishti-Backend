const webpush = require("web-push");
const NotificationSettings = require("../models/NotificationSettings");
const NotificationLog = require("../models/NotificationLog");

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

function isEnabled(settings, type) {
    if (!settings) return true;
    const togglesMap = settings.toggles;
    if (!togglesMap) return true;
    const val =
        typeof togglesMap.get === "function"
            ? togglesMap.get(type)
            : togglesMap[type];
    return val !== false;
}

function dayKey(d = new Date()) {
    return d.toISOString().slice(0, 10);
}

async function logEvent(type, field) {
    try {
        await NotificationLog.updateOne(
            { type, day: dayKey() },
            { $inc: { [field]: 1 }, $set: { lastAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        // Counters are best-effort; never block.
        console.error("notification log error:", err);
    }
}

/**
 * Gated push: checks admin settings; if the type is disabled, the push is
 * skipped (counted as `skipped`). Otherwise sends and counts as `sent`.
 * Returns true if sent, false if skipped/no-op.
 */
async function notifyIfEnabled(type, subscription, payload) {
    const settings = await getSettings();
    if (!isEnabled(settings, type)) {
        logEvent(type, "skipped");
        return false;
    }
    if (!subscription) {
        return false;
    }
    logEvent(type, "sent");
    await sendPush(subscription, payload);
    return true;
}

module.exports = {
    sendPush,
    notifyIfEnabled,
    getSettings,
    invalidateSettingsCache,
};
