const mongoose = require("mongoose");

// Only two notification groups. Each gates the entire push pipeline for
// its category (push HTTPS call + any related fan-out work).
const NOTIFICATION_GROUPS = ["task", "attendance"];

const buildDefaultToggles = () => {
    const obj = {};
    for (const g of NOTIFICATION_GROUPS) obj[g] = true;
    return obj;
};

const notificationSettingsSchema = new mongoose.Schema(
    {
        key: { type: String, default: "global", unique: true, index: true },
        toggles: {
            type: mongoose.Schema.Types.Mixed,
            default: buildDefaultToggles,
        },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin" },
    },
    { timestamps: true, minimize: false }
);

notificationSettingsSchema.statics.NOTIFICATION_GROUPS = NOTIFICATION_GROUPS;
notificationSettingsSchema.statics.buildDefaultToggles = buildDefaultToggles;

module.exports = mongoose.model("NotificationSettings", notificationSettingsSchema);
module.exports.NOTIFICATION_GROUPS = NOTIFICATION_GROUPS;
