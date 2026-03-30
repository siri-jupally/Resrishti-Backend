const mongoose = require("mongoose");

const managerLeaveSchema = new mongoose.Schema(
    {
        manager: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Manager",
            required: true,
        },
        type: {
            type: String,
            enum: ["casual", "sick", "earned", "unpaid"],
            required: true,
        },
        startDate: { type: String, required: true }, // YYYY-MM-DD
        endDate: { type: String, required: true },   // YYYY-MM-DD
        reason: { type: String, required: true },
        status: {
            type: String,
            enum: ["pending", "approved", "rejected"],
            default: "pending",
        },
        reviewedBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
        },
        reviewRemarks: { type: String },
    },
    { timestamps: true }
);

managerLeaveSchema.index({ manager: 1, status: 1 });
managerLeaveSchema.index({ manager: 1, startDate: 1 });
managerLeaveSchema.index({ status: 1 });

module.exports = mongoose.model("ManagerLeave", managerLeaveSchema);
