const mongoose = require("mongoose");

const locationPointSchema = new mongoose.Schema({
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: Number,
    timestamp: { type: Date, required: true },
}, { _id: false });

const locationTrailSchema = new mongoose.Schema({
    // One of these will be set depending on who is being tracked
    employee: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Employee",
    },
    manager: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Manager",
    },
    date: { type: String, required: true }, // YYYY-MM-DD
    locations: [locationPointSchema],
    checkInTime: Date,
    checkOutTime: Date,
}, { timestamps: true });

locationTrailSchema.index({ employee: 1, date: 1 }, { unique: true, sparse: true });
locationTrailSchema.index({ manager: 1, date: 1 }, { unique: true, sparse: true });
locationTrailSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 }); // 90-day TTL

module.exports = mongoose.model("LocationTrail", locationTrailSchema);
