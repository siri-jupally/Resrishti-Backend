/*
  BiometricPunch model

  The raw, append-only log of every punch a device pushes, kept separately from
  the Attendance records it produces. Two reasons:

  - Idempotency. A device re-sends its buffer after any hiccup, so the same
    punch arrives more than once. The unique index on {deviceSn, pin, time}
    makes re-ingestion a no-op instead of a double check-in.
  - Audit. Attendance feeds pay, so there must be a traceable record of exactly
    what the device reported and whether/how it was applied.

  pin is the device User ID, which equals the person's empNo. If no active
  staff member has that empNo (e.g. a test or de-enrolled card), the punch is
  still stored but left unmapped, with mapError saying why.
*/
const mongoose = require("mongoose");

const biometricPunchSchema = new mongoose.Schema(
    {
        deviceSn: { type: String, required: true, index: true },
        pin: { type: String, required: true }, // device User ID, as sent
        empNo: { type: Number },               // parsed numeric form
        time: { type: Date, required: true },  // punch instant (IST wall-clock → UTC)
        // Raw device fields, kept for audit.
        statusCode: { type: String },  // in/out state the device reported (unreliable)
        verifyMode: { type: String },  // 1=fingerprint, 15=face, 0=password, ...
        rawLine: { type: String },

        // Mapping outcome.
        personType: { type: String, enum: ["Employee", "Manager"] },
        person: { type: mongoose.Schema.Types.ObjectId },
        attendanceDate: { type: String }, // YYYY-MM-DD it was applied to
        mapped: { type: Boolean, default: false },
        mapError: { type: String },
    },
    { timestamps: true }
);

// One physical punch = one row. Re-sent buffers collapse onto the same doc.
biometricPunchSchema.index({ deviceSn: 1, pin: 1, time: 1 }, { unique: true });

module.exports = mongoose.model("BiometricPunch", biometricPunchSchema);
