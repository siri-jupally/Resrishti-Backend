const LocationTrail = require("../models/LocationTrail");

// POST /api/employee/location/batch — employee sends batched locations
const employeeBatchLocations = async (req, res) => {
    try {
        const { locations } = req.body;
        if (!locations || !locations.length) {
            return res.status(400).json({ message: "No locations provided" });
        }
        const today = new Date().toISOString().split("T")[0];

        await LocationTrail.findOneAndUpdate(
            { employee: req.employee._id, date: today },
            {
                $push: { locations: { $each: locations } },
                $setOnInsert: { checkInTime: new Date() },
            },
            { upsert: true, new: true }
        );

        res.json({ status: "ok", received: locations.length });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/manager/location/batch — manager sends batched locations
const managerBatchLocations = async (req, res) => {
    try {
        const { locations } = req.body;
        if (!locations || !locations.length) {
            return res.status(400).json({ message: "No locations provided" });
        }
        const today = new Date().toISOString().split("T")[0];

        await LocationTrail.findOneAndUpdate(
            { manager: req.manager._id, date: today },
            {
                $push: { locations: { $each: locations } },
                $setOnInsert: { checkInTime: new Date() },
            },
            { upsert: true, new: true }
        );

        res.json({ status: "ok", received: locations.length });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// GET /api/manager/location/trail/:employeeId/:date — manager views employee trail
const getEmployeeTrail = async (req, res) => {
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
