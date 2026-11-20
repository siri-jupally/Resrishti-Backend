/*
  BiometricDevice model

  A fingerprint attendance terminal (e.g. a ZKTeco K40) that pushes punches to
  us over the ADMS/push protocol. The device's SERIAL NUMBER is the trust
  anchor: the ingest endpoint only accepts punches whose SN matches a registered,
  active device here. The raw protocol has no auth of its own, so this allowlist
  (plus optional IP allowlist and HTTPS) is what keeps forged punches — which
  would become pay — out.

  Enrolment: fingerprints live ON the device, matched locally. We never receive
  or store a fingerprint; a punch carries only the User ID (= the person's
  empNo) and a timestamp.
*/
const mongoose = require("mongoose");

const biometricDeviceSchema = new mongoose.Schema(
    {
        // Device serial number, printed on the unit and sent as `SN` on every
        // ADMS request. The identity we trust.
        serialNo: { type: String, required: true, unique: true, trim: true },
        // Human label, e.g. "HQ entrance".
        name: { type: String, trim: true },
        // Office/site label written onto the attendance record as the check-in
        // location (a punch at the door IS the premises proof).
        location: { type: String, trim: true },
        // Only active devices are accepted. Deactivate to cut a device off
        // without deleting its history.
        active: { type: Boolean, default: true },
        // Optional extra guard: if set, punches are accepted only from these
        // source IPs (the office's egress IP).
        allowedIps: { type: [String], default: undefined },
        lastSeenAt: { type: Date },   // last handshake/poll
        lastPunchAt: { type: Date },  // last attendance log received
    },
    { timestamps: true }
);

module.exports = mongoose.model("BiometricDevice", biometricDeviceSchema);
