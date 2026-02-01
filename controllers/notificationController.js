const Employee = require("../models/Employee");
const Manager = require("../models/Manager");

// @desc    Subscribe to Push Notifications
// @route   POST /api/employee/subscribe OR /api/manager/subscribe
// @access  Private
const subscribe = async (req, res) => {
    try {
        const subscription = req.body;

        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ message: "Invalid subscription object" });
        }

        if (req.employee) {
            req.employee.pushSubscription = subscription;
            await req.employee.save();
            return res.status(200).json({ message: "Employee subscribed successfully" });
        }

        if (req.manager) {
            req.manager.pushSubscription = subscription;
            await req.manager.save();
            return res.status(200).json({ message: "Manager subscribed successfully" });
        }

        return res.status(401).json({ message: "Not authorized to subscribe" });
    } catch (err) {
        console.error("Subscription Error:", err);
        res.status(500).json({ message: "Server Error" });
    }
};

module.exports = { subscribe };
