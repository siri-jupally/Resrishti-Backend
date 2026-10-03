/*
  payrollConfigController.js — payroll settings, paid-day policies, and the
  accountant logins.

  Only the settings the shipped features need are exposed; the rest of the
  configuration hub arrives with the features that want it.

  Mounted at /api/payroll.
    GET   /settings              read (accountant or admin)
    PUT   /settings              change (admin)
    GET   /paid-day-policies     list
    POST  /paid-day-policies     create (admin)
    PATCH /paid-day-policies/:id edit (admin)
    POST  /accountants           create an accountant login (admin)
    GET   /accountants           list them (admin)
    PATCH /accountants/:id       rename, deactivate, reset password (admin)
    POST  /accountant/login      sign in
*/
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const PaidDayPolicy = require("../models/PaidDayPolicy");
const PayrollProfile = require("../models/PayrollProfile");
const Accountant = require("../models/Accountant");
const { getSettings, seedPaidDayPolicies } = require("../utils/payrollDefaults");

const actorName = (req) =>
    req.admin?.name || req.admin?.email || req.accountant?.name || req.accountant?.email || "";

// ---------------------------------------------------------------- settings

const readSettings = async (req, res) => {
    try {
        const settings = await getSettings();
        return res.json(settings);
    } catch (err) {
        console.error("readSettings error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

const updateSettings = async (req, res) => {
    try {
        const settings = await getSettings();
        const body = req.body || {};

        if (body.perDayRateBasis !== undefined) {
            if (!["fixed30", "calendarDays", "workingDays"].includes(body.perDayRateBasis)) {
                return res.status(400).json({
                    message: "perDayRateBasis must be fixed30, calendarDays or workingDays",
                });
            }
            settings.perDayRateBasis = body.perDayRateBasis;
        }
        if (body.halfDayWeight !== undefined) {
            const weight = Number(body.halfDayWeight);
            if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
                return res.status(400).json({ message: "halfDayWeight must be between 0 and 1" });
            }
            settings.halfDayWeight = weight;
        }
        if (body.lateMarkCostsPay !== undefined) {
            settings.lateMarkCostsPay = body.lateMarkCostsPay === true || body.lateMarkCostsPay === "true";
        }
        if (body.lateMarksPerLopDay !== undefined) {
            const n = Number(body.lateMarksPerLopDay);
            if (!Number.isInteger(n) || n < 1) {
                return res.status(400).json({ message: "lateMarksPerLopDay must be a whole number of 1 or more" });
            }
            settings.lateMarksPerLopDay = n;
        }

        if (body.overtime) {
            const ot = body.overtime;
            if (ot.mode !== undefined && !["multiplier", "flat"].includes(ot.mode)) {
                return res.status(400).json({ message: "overtime.mode must be multiplier or flat" });
            }
            if (ot.value !== undefined) {
                const value = Number(ot.value);
                if (!Number.isFinite(value) || value < 0) {
                    return res.status(400).json({ message: "overtime.value must be zero or more" });
                }
                settings.overtime.value = value;
            }
            // Who earns overtime lives on each person, not here.
            const flags = ["enabled", "countWeeklyOff", "countHoliday"];
            for (const flag of flags) {
                if (ot[flag] !== undefined) settings.overtime[flag] = ot[flag] === true || ot[flag] === "true";
            }
            if (ot.mode !== undefined) settings.overtime.mode = ot.mode;
        }

        if (body.approvalDepth !== undefined) {
            if (!["single", "makerChecker"].includes(body.approvalDepth)) {
                return res.status(400).json({ message: "approvalDepth must be single or makerChecker" });
            }
            settings.approvalDepth = body.approvalDepth;
        }
        if (body.variancePercentThreshold !== undefined) {
            const n = Number(body.variancePercentThreshold);
            if (!Number.isFinite(n) || n < 0) {
                return res.status(400).json({ message: "variancePercentThreshold must be zero or more" });
            }
            settings.variancePercentThreshold = n;
        }
        if (body.maxAdjustmentAmount !== undefined) {
            const n = Number(body.maxAdjustmentAmount);
            if (!Number.isFinite(n) || n < 0) {
                return res.status(400).json({ message: "maxAdjustmentAmount must be zero or more" });
            }
            settings.maxAdjustmentAmount = n;
        }
        if (body.payslipNote !== undefined) {
            settings.payslipNote = String(body.payslipNote).trim();
        }
        if (body.showBankOnPayslip !== undefined) {
            settings.showBankOnPayslip = body.showBankOnPayslip === true || body.showBankOnPayslip === "true";
        }

        settings.updatedByName = actorName(req);
        await settings.save();
        return res.json(settings);
    } catch (err) {
        console.error("updateSettings error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// ------------------------------------------------------- paid-day policies

const listPolicies = async (req, res) => {
    try {
        await seedPaidDayPolicies();
        const includeInactive = String(req.query.includeInactive) === "true";
        const items = await PaidDayPolicy.find(includeInactive ? {} : { isActive: true })
            .sort({ sortOrder: 1, name: 1 })
            .lean();

        // How many people each one covers, so switching one off is an informed act.
        const profiles = await PayrollProfile.find({}, "paidDayPolicy").lean();
        const counts = profiles.reduce((acc, p) => {
            const key = String(p.paidDayPolicy || "");
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

        return res.json({
            items: items.map((p) => ({ ...p, peopleCount: counts[String(p._id)] || 0 })),
            total: items.length,
        });
    } catch (err) {
        console.error("listPolicies error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

const createPolicy = async (req, res) => {
    try {
        const name = String(req.body?.name || "").trim();
        if (!name) return res.status(400).json({ message: "Give the policy a name" });
        if (await PaidDayPolicy.findOne({ name })) {
            return res.status(409).json({ message: `A policy called "${name}" already exists` });
        }
        const created = await PaidDayPolicy.create({
            name,
            description: String(req.body.description || "").trim() || undefined,
            payWeeklyOff: req.body.payWeeklyOff === true,
            payHoliday: req.body.payHoliday === true,
            payApprovedLeave: req.body.payApprovedLeave !== false,
            appliesTo: Array.isArray(req.body.appliesTo) && req.body.appliesTo.length
                ? req.body.appliesTo
                : ["daily"],
            sortOrder: Number.isFinite(Number(req.body.sortOrder)) ? Number(req.body.sortOrder) : 200,
            updatedByName: actorName(req),
        });
        return res.status(201).json(created);
    } catch (err) {
        console.error("createPolicy error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

const updatePolicy = async (req, res) => {
    try {
        const policy = await PaidDayPolicy.findById(req.params.id);
        if (!policy) return res.status(404).json({ message: "Policy not found" });

        if (req.body.name !== undefined) {
            const name = String(req.body.name).trim();
            if (!name) return res.status(400).json({ message: "name cannot be empty" });
            policy.name = name;
        }
        if (req.body.description !== undefined) policy.description = String(req.body.description).trim();
        for (const flag of ["payWeeklyOff", "payHoliday", "payApprovedLeave"]) {
            if (req.body[flag] !== undefined) policy[flag] = req.body[flag] === true || req.body[flag] === "true";
        }
        if (Array.isArray(req.body.appliesTo) && req.body.appliesTo.length) {
            policy.appliesTo = req.body.appliesTo;
        }
        if (req.body.isActive !== undefined) {
            const next = req.body.isActive === true || req.body.isActive === "true";
            if (!next) {
                const inUse = await PayrollProfile.countDocuments({ paidDayPolicy: policy._id });
                if (inUse > 0) {
                    return res.status(409).json({
                        message: `${inUse} ${inUse === 1 ? "person is" : "people are"} on this policy. Move them to another one first.`,
                    });
                }
            }
            policy.isActive = next;
        }

        policy.updatedByName = actorName(req);
        await policy.save();
        return res.json(policy);
    } catch (err) {
        console.error("updatePolicy error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// ------------------------------------------------------------- accountants

const generatePassword = () =>
    crypto.randomBytes(12).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 14);

const createAccountant = async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const name = String(req.body?.name || "").trim();
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            return res.status(400).json({ message: "A valid email is required" });
        }
        if (await Accountant.findOne({ email })) {
            return res.status(409).json({ message: "An accountant with that email already exists" });
        }

        // A generated password, shown once. Nobody types a password for
        // somebody else and remembers to make it a good one.
        const password = String(req.body?.password || "").trim() || generatePassword();
        const accountant = await Accountant.create({
            name: name || undefined,
            email,
            password,
            phone: String(req.body?.phone || "").trim() || undefined,
            createdByName: actorName(req),
        });

        return res.status(201).json({
            _id: accountant._id,
            name: accountant.name,
            email: accountant.email,
            isActive: accountant.isActive,
            // Returned once, never stored in the clear and never shown again.
            temporaryPassword: password,
        });
    } catch (err) {
        console.error("createAccountant error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

const listAccountants = async (req, res) => {
    try {
        const items = await Accountant.find({}).select("-password").sort({ createdAt: -1 }).lean();
        return res.json({ items, total: items.length });
    } catch (err) {
        console.error("listAccountants error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

const updateAccountant = async (req, res) => {
    try {
        const accountant = await Accountant.findById(req.params.id);
        if (!accountant) return res.status(404).json({ message: "Accountant not found" });

        if (req.body.name !== undefined) accountant.name = String(req.body.name).trim();
        if (req.body.phone !== undefined) accountant.phone = String(req.body.phone).trim();
        if (req.body.isActive !== undefined) {
            accountant.isActive = req.body.isActive === true || req.body.isActive === "true";
        }

        let temporaryPassword;
        if (req.body.resetPassword === true || req.body.resetPassword === "true") {
            temporaryPassword = generatePassword();
            accountant.password = temporaryPassword;
        }

        await accountant.save();
        const saved = accountant.toObject();
        delete saved.password;
        return res.json({ ...saved, temporaryPassword });
    } catch (err) {
        console.error("updateAccountant error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/accountant/login
const loginAccountant = async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const password = String(req.body?.password || "");
        // One message for both wrong-email and wrong-password, so the form
        // cannot be used to find out who has an account.
        const invalid = () => res.status(400).json({ message: "Invalid credentials" });

        if (!email || !password) return invalid();
        const accountant = await Accountant.findOne({ email });
        if (!accountant || !accountant.isActive) return invalid();
        if (!(await accountant.comparePassword(password))) return invalid();

        const token = jwt.sign(
            { id: accountant._id, kind: "accountant" },
            process.env.JWT_SECRET,
            { expiresIn: "12h" }
        );

        return res.json({
            token,
            name: accountant.name || accountant.email,
            email: accountant.email,
        });
    } catch (err) {
        console.error("loginAccountant error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    readSettings,
    updateSettings,
    listPolicies,
    createPolicy,
    updatePolicy,
    createAccountant,
    listAccountants,
    updateAccountant,
    loginAccountant,
};
