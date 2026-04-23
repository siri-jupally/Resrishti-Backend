const LocationTrail = require("../models/LocationTrail");

// Minimum seconds between stored points — rejects any incoming point closer than this to the last stored one
const MIN_POINT_GAP_SECONDS = 60;

// Dedupe incoming points against the existing trail: drops any point whose timestamp is
// within MIN_POINT_GAP_SECONDS of the last stored point.
function dedupePoints(existingLocations, incoming) {
    if (!existingLocations || existingLocations.length === 0) return incoming;
    const lastTs = new Date(existingLocations[existingLocations.length - 1].timestamp).getTime();
    return incoming.filter((p) => {
        const ts = new Date(p.timestamp).getTime();
        return ts - lastTs >= MIN_POINT_GAP_SECONDS * 1000;
    });
}

// POST /api/employee/location/batch — employee sends batched locations
const employeeBatchLocations = async (req, res) => {
    try {
        const { locations } = req.body;
        console.log("[LocationBatch] Employee:", req.employee?._id, "Points:", locations?.length);

        if (!locations || !locations.length) {
            return res.status(400).json({ message: "No locations provided" });
        }
        const today = new Date().toISOString().split("T")[0];

        const existing = await LocationTrail.findOne({ employee: req.employee._id, date: today });
        const fresh = dedupePoints(existing?.locations, locations);
        console.log("[LocationBatch] Incoming:", locations.length, "After dedupe:", fresh.length);

        if (fresh.length === 0) {
            return res.json({ status: "ok", received: 0, skipped: locations.length });
        }

        const result = await LocationTrail.findOneAndUpdate(
            { employee: req.employee._id, date: today },
            {
                $push: { locations: { $each: fresh } },
                $setOnInsert: { checkInTime: new Date() },
            },
            { upsert: true, new: true }
        );

        console.log("[LocationBatch] Success. Total points in trail:", result.locations.length);
        res.json({ status: "ok", received: fresh.length, skipped: locations.length - fresh.length });
    } catch (err) {
        console.error("[LocationBatch] ERROR for employee:", req.employee?._id, err.message);
        res.status(500).json({ message: err.message });
    }
};

// POST /api/manager/location/batch — manager sends batched locations
const managerBatchLocations = async (req, res) => {
    try {
        const { locations } = req.body;
        console.log("[LocationBatch] Manager:", req.manager?._id, "Points:", locations?.length);

        if (!locations || !locations.length) {
            return res.status(400).json({ message: "No locations provided" });
        }
        const today = new Date().toISOString().split("T")[0];

        const existing = await LocationTrail.findOne({ manager: req.manager._id, date: today });
        const fresh = dedupePoints(existing?.locations, locations);
        console.log("[LocationBatch] Incoming:", locations.length, "After dedupe:", fresh.length);

        if (fresh.length === 0) {
            return res.json({ status: "ok", received: 0, skipped: locations.length });
        }

        const result = await LocationTrail.findOneAndUpdate(
            { manager: req.manager._id, date: today },
            {
                $push: { locations: { $each: fresh } },
                $setOnInsert: { checkInTime: new Date() },
            },
            { upsert: true, new: true }
        );

        console.log("[LocationBatch] Success. Total points in trail:", result.locations.length);
        res.json({ status: "ok", received: fresh.length, skipped: locations.length - fresh.length });
    } catch (err) {
        console.error("[LocationBatch] ERROR for manager:", req.manager?._id, err.message);
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/location/trail/:employeeId/:date — manager views employee trail
const getEmployeeTrail = async (req, res) => {
    try {
        console.log("[TrailFetch] Manager", req.manager?._id, "requesting trail for employee:", req.params.employeeId, "date:", req.params.date);

        const trail = await LocationTrail.findOne({
            employee: req.params.employeeId,
            date: req.params.date,
        }).populate("employee", "name email");

        console.log("[TrailFetch] Found trail?", !!trail, "Points:", trail?.locations?.length || 0);
        res.json(trail || { locations: [] });
    } catch (err) {
        console.error("[TrailFetch] ERROR:", err.message);
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/location/trail/employee/:employeeId/:date
const getEmployeeTrailByAdmin = async (req, res) => {
    try {
        const trail = await LocationTrail.findOne({
            employee: req.params.employeeId,
            date: req.params.date,
        }).populate("employee", "name email");
        res.json(trail || { locations: [] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/admin/location/trail/manager/:managerId/:date
const getManagerTrailByAdmin = async (req, res) => {
    try {
        const trail = await LocationTrail.findOne({
            manager: req.params.managerId,
            date: req.params.date,
        }).populate("manager", "name email");
        res.json(trail || { locations: [] });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

module.exports = {
    employeeBatchLocations,
    managerBatchLocations,
    getEmployeeTrail,
    getEmployeeTrailByAdmin,
    getManagerTrailByAdmin,
};
