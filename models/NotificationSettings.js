const mongoose = require("mongoose");

const NOTIFICATION_TYPES = [
    // Task
    "task.assigned",
    "task.statusUpdated",
    "task.comment",
    "task.messageFromManager",
    "task.messageFromEmployee",
    "task.attachmentFromEmployee",

    // Attendance (Employee)
    "attendance.outOfBoundary",
    "attendance.approval",
    "attendance.correctionRequest",
    "attendance.correctionApproval",
    "attendance.workModeUpdate",

    // Leaves (Employee)
    "leave.requestToManager",
    "leave.requestToAdmin",
    "leave.approvalByManager",
    "leave.approvalNotifyAdmin",
    "leave.approvalByAdmin",

    // Manager-level
    "manager.outOfBoundary",
    "manager.correctionRequest",
    "manager.leaveRequest",
    "manager.attendanceApproval",
    "manager.correctionApproval",
    "manager.leaveApproval",
];

const buildDefaultToggles = () => {
    const obj = {};
    for (const t of NOTIFICATION_TYPES) obj[t] = true;
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

notificationSettingsSchema.statics.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
notificationSettingsSchema.statics.buildDefaultToggles = buildDefaultToggles;

module.exports = mongoose.model("NotificationSettings", notificationSettingsSchema);
module.exports.NOTIFICATION_TYPES = NOTIFICATION_TYPES;
