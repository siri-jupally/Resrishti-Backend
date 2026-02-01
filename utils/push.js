const webpush = require("web-push");

// Configure VAPID keys
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

module.exports = { sendPush };
