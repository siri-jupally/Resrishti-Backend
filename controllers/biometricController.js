/*
  Biometric (ZKTeco ADMS/push) controller.

  Two surfaces:
  1. Device-facing /iclock/* endpoints the terminal talks to (no JWT — the
     device can't send one). Trust comes from the serial-number allowlist in
     BiometricDevice, plus an optional per-device IP allowlist.
  2. Admin endpoints to register and monitor devices.

  Flow a ZKTeco push device uses:
     GET  /iclock/cdata?SN=...&options=all   → registry handshake
     GET  /iclock/getrequest?SN=...          → poll for server commands (none)
     POST /iclock/cdata?SN=...&table=ATTLOG  → push punch logs (tab-delimited)

  A punch carries only the User ID (= empNo) and a timestamp — never a
  fingerprint. We store the raw punch (idempotent) and turn it into an
  Attendance / ManagerAttendance record. Because a punch at the office door is
  itself the on-site proof, biometric check-ins are auto-approved.
*/
const Attendance = require("../models/Attendance");
const ManagerAttendance = require("../models/ManagerAttendance");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const AttendancePolicy = require("../models/AttendancePolicy");
const BiometricDevice = require("../models/BiometricDevice");
const BiometricPunch = require("../models/BiometricPunch");
const { parseDeviceTime } = require("../utils/biometricTime");

const round2 = (n) => Math.round(n * 100) / 100;

function clientIp(req) {
    const xff = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    return (xff || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

function minutesFromHHMM(str) {
    const [h, m] = String(str).split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}

// Only an active, registered device whose SN matches (and IP, if an allowlist
// is set) is trusted. Returns the device or null.
async function authDevice(sn, ip) {
    if (!sn) return null;
    const device = await BiometricDevice.findOne({ serialNo: String(sn).trim(), active: true });
    if (!device) return null;
    if (device.allowedIps && device.allowedIps.length) {
        if (!ip || !device.allowedIps.includes(ip)) return null;
    }
    return device;
}

// empNo -> the active, non-test person who owns it (Employee first, then Manager).
async function resolvePerson(empNo) {
    const active = { empNo, isTestAccount: { $ne: true }, archived: { $ne: true } };
    const emp = await Employee.findOne(active).select("_id name").lean();
    if (emp) return { personType: "Employee", person: emp };
    const mgr = await Manager.findOne(active).select("_id name").lean();
    if (mgr) return { personType: "Manager", person: mgr };
    return null;
}

// Apply one punch to a person's day: first punch = check-in, a later punch =
// check-out (updated to the latest). Mirrors the app's status/late rules.
async function applyPunch({ device, personType, person, instant, date, minutes, policy }) {
    const isEmp = personType === "Employee";
    const Model = isEmp ? Attendance : ManagerAttendance;
    const refField = isEmp ? "employee" : "manager";

    let rec = await Model.findOne({ [refField]: person._id, date });
    if (!rec) rec = new Model({ [refField]: person._id, date });

    const loc = device.location ? { address: device.location } : undefined;

    if (!rec.checkIn || !rec.checkIn.time) {
        let isLate = false;
        if (policy?.checkInStartTime) {
            const threshold = minutesFromHHMM(policy.checkInStartTime) + (policy.lateThresholdMinutes || 15);
            isLate = minutes > threshold;
        }
        rec.checkIn = { time: instant, location: loc };
        rec.workMode = "WFO";
        rec.status = "present";
        rec.approvalStatus = "auto-approved"; // on-site proof
        rec.source = "biometric";
        rec.biometricDeviceSn = device.serialNo;
        rec.isLateCheckIn = isLate;
        rec.locationWithinBoundary = true;
        await rec.save();
        return { action: "check-in" };
    }

    if (instant <= new Date(rec.checkIn.time)) {
        return { action: "ignored-earlier" }; // duplicate or before check-in
    }

    rec.checkOut = { time: instant, location: loc };
    const ms = new Date(rec.checkOut.time) - new Date(rec.checkIn.time);
    rec.workingHours = round2(ms / (1000 * 60 * 60));
    const halfThreshold = policy?.halfDayThresholdHours || 4;
    rec.status = rec.workingHours < halfThreshold ? "half-day" : "present";
    if (!rec.biometricDeviceSn) rec.biometricDeviceSn = device.serialNo;
    await rec.save();
    return { action: "check-out", workingHours: rec.workingHours };
}

// ATTLOG body: one punch per line, tab-delimited:
//   PIN \t YYYY-MM-DD HH:MM:SS \t status \t verify \t workcode
function parseAttlog(body) {
    const lines = String(body || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (const line of lines) {
        const f = line.split(/\t/);
        if (f.length < 2) continue;
        out.push({
            pin: (f[0] || "").trim(),
            timeStr: (f[1] || "").trim(),
            statusCode: f[2],
            verifyMode: f[3],
            rawLine: line,
        });
    }
    return out;
}

// Ingest one device's ATTLOG payload: idempotent raw store + attendance mapping.
async function ingestAttlog(device, body) {
    const rows = parseAttlog(body);
    const policy = await AttendancePolicy.findOne().lean();
    let stored = 0, mapped = 0, dup = 0, unmatched = 0;

    for (const row of rows) {
        const t = parseDeviceTime(row.timeStr);
        if (!t) continue;
        const empNo = parseInt(String(row.pin).replace(/\D/g, ""), 10);

        let punchDoc;
        try {
            punchDoc = await BiometricPunch.create({
                deviceSn: device.serialNo,
                pin: row.pin,
                empNo: Number.isNaN(empNo) ? undefined : empNo,
                time: t.instant,
                statusCode: row.statusCode,
                verifyMode: row.verifyMode,
                rawLine: row.rawLine,
            });
        } catch (e) {
            if (e.code === 11000) { dup += 1; continue; } // already ingested
            throw e;
        }
        stored += 1;

        const resolved = Number.isNaN(empNo) ? null : await resolvePerson(empNo);
        if (!resolved) {
            punchDoc.mapError = `No active staff with empNo ${empNo}`;
            await punchDoc.save();
            unmatched += 1;
            continue;
        }
        try {
            await applyPunch({ device, ...resolved, instant: t.instant, date: t.date, minutes: t.minutes, policy });
            punchDoc.mapped = true;
            punchDoc.personType = resolved.personType;
            punchDoc.person = resolved.person._id;
            punchDoc.attendanceDate = t.date;
            await punchDoc.save();
            mapped += 1;
        } catch (e) {
            punchDoc.mapError = e.message;
            await punchDoc.save();
        }
    }

    const now = new Date();
    await BiometricDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: now, lastPunchAt: now } });
    return { received: rows.length, stored, mapped, dup, unmatched };
}

// ============ device-facing /iclock endpoints ============

// GET /iclock/cdata — registry handshake.
const cdataHandshake = async (req, res) => {
    const sn = req.query.SN || req.query.sn;
    const device = await authDevice(sn, clientIp(req));
    if (!device) return res.status(200).type("text/plain").send("OK"); // don't engage an unknown device
    await BiometricDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date() } });
    res.status(200).type("text/plain").send(
        `GET OPTION FROM: ${sn}\r\n` +
        `Stamp=0\r\nOpStamp=0\r\nErrorDelay=30\r\nDelay=30\r\n` +
        `TransTimes=00:00;14:05\r\nTransInterval=1\r\nTransFlag=1111000000\r\n` +
        `TimeZone=5.5\r\nRealtime=1\r\nEncrypt=0\r\n`
    );
};

// GET /iclock/getrequest — device polls for commands; we issue none.
const getrequest = async (req, res) => {
    const sn = req.query.SN || req.query.sn;
    const device = await authDevice(sn, clientIp(req));
    if (device) await BiometricDevice.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date() } });
    res.status(200).type("text/plain").send("OK");
};

// POST /iclock/cdata — punch logs (and other tables we just acknowledge).
const cdataPost = async (req, res) => {
    const sn = req.query.SN || req.query.sn;
    const table = String(req.query.table || req.query.Table || "").toUpperCase();
    const device = await authDevice(sn, clientIp(req));
    if (!device) return res.status(200).type("text/plain").send("OK");

    if (table && table !== "ATTLOG") {
        // OPERLOG (enrol/admin ops), etc. — acknowledge; not processed yet.
        return res.status(200).type("text/plain").send("OK");
    }
    try {
        const result = await ingestAttlog(device, req.body);
        // ZKTeco clears its buffer on "OK: <count>".
        return res.status(200).type("text/plain").send(`OK: ${result.stored + result.dup}`);
    } catch (e) {
        console.error("[biometric] ingest failed:", e.message);
        return res.status(500).type("text/plain").send("ERROR");
    }
};

// ============ admin endpoints (JWT-protected via routes) ============

const registerDevice = async (req, res) => {
    try {
        const { serialNo, name, location, allowedIps } = req.body;
        if (!serialNo) return res.status(400).json({ message: "serialNo is required" });
        const exists = await BiometricDevice.findOne({ serialNo: String(serialNo).trim() });
        if (exists) return res.status(400).json({ message: "A device with this serial is already registered" });
        const device = await BiometricDevice.create({
            serialNo: String(serialNo).trim(),
            name,
            location,
            allowedIps: Array.isArray(allowedIps) && allowedIps.length ? allowedIps : undefined,
        });
        res.status(201).json(device);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const listDevices = async (_req, res) => {
    try {
        const devices = await BiometricDevice.find().sort({ createdAt: -1 }).lean();
        res.json(devices);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const updateDevice = async (req, res) => {
    try {
        const allowed = ["name", "location", "active", "allowedIps"];
        const update = {};
        for (const k of allowed) if (k in req.body) update[k] = req.body[k];
        const device = await BiometricDevice.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
        if (!device) return res.status(404).json({ message: "Device not found" });
        res.json(device);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

const deleteDevice = async (req, res) => {
    try {
        const device = await BiometricDevice.findByIdAndDelete(req.params.id);
        if (!device) return res.status(404).json({ message: "Device not found" });
        res.json({ message: "Device removed" });
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

// Recent punches, for monitoring / debugging an enrolment.
const listPunches = async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 100, 500);
        const filter = {};
        if (req.query.deviceSn) filter.deviceSn = req.query.deviceSn;
        if (req.query.unmatched === "true") filter.mapped = false;
        const punches = await BiometricPunch.find(filter).sort({ time: -1 }).limit(limit).lean();
        res.json(punches);
    } catch (e) {
        res.status(500).json({ message: e.message });
    }
};

module.exports = {
    // device-facing
    cdataHandshake,
    getrequest,
    cdataPost,
    // admin
    registerDevice,
    listDevices,
    updateDevice,
    deleteDevice,
    listPunches,
    // exported for tests / manual ingestion
    ingestAttlog,
    parseAttlog,
    resolvePerson,
};
