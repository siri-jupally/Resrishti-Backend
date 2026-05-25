const mongoose = require("mongoose");

const notificationLogSchema = new mongoose.Schema(
    {
        type: { type: String, required: true, index: true },
        day: { type: String, required: true, index: true },
        sent: { type: Number, default: 0 },
        skipped: { type: Number, default: 0 },
        lastAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

notificationLogSchema.index({ type: 1, day: 1 }, { unique: true });
notificationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model("NotificationLog", notificationLogSchema);
