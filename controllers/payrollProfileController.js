/*
  payrollProfileController.js — tagging people for payroll.

  Nothing in the module computes until the workforce is tagged, and the act of
  tagging is what finally answers "how many of our people are daily-wage?" —
  employment type was never recorded before. So the list below deliberately
  returns everybody, tagged or not, with the untagged ones visible rather than
  filtered away.

  Mounted at /api/payroll/profiles.
    GET    /                 everyone, with their payroll profile if they have one
    GET    /summary          the workforce split, once tagging is underway
    GET    /:type/:id        one person's profile and rate history
    PUT    /:type/:id        create or update a profile (admin only)
    POST   /:type/:id/rates  add a rate effective from a date (admin only)
    PATCH  /:type/:id/bank   bank details, which the office fills in later
*/
const mongoose = require("mongoose");

const PayrollProfile = require("../models/PayrollProfile");
const PaidDayPolicy = require("../models/PaidDayPolicy");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const { defaultPolicyFor, seedPaidDayPolicies } = require("../utils/payrollDefaults");

const TYPES = ["Employee", "Manager"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const actorName = (req) =>
    req.admin?.name || req.admin?.email || req.accountant?.name || req.accountant?.email || "";

const normaliseType = (raw) => {
    const value = String(raw || "").toLowerCase();
    if (value === "employee") return "Employee";
    if (value === "manager") return "Manager";
    return null;
};

const modelFor = (personType) => (personType === "Employee" ? Employee : Manager);

// GET /api/payroll/profiles?status=untagged&search=&payModel=
//
// Everybody on the payroll's radar, tagged or not. The untagged are the work
// list: until they have a profile they cannot be paid, and the engine will
// pull them out of a run rather than guess.
const listProfiles = async (req, res) => {
    try {
        await seedPaidDayPolicies();

        const [employees, managers, profiles] = await Promise.all([
            Employee.find({}).select("name email jobRole department joiningDate manager").lean(),
            Manager.find({}).select("name email jobRole department joiningDate").lean(),
            PayrollProfile.find({}).populate("paidDayPolicy", "name payWeeklyOff payHoliday").lean(),
        ]);

        const byPerson = new Map(
            profiles.map((p) => [`${p.personType}:${String(p.personId)}`, p])
        );

        const rows = [
            ...employees.map((e) => ({ person: e, personType: "Employee" })),
            ...managers.map((m) => ({ person: m, personType: "Manager" })),
        ].map(({ person, personType }) => {
            const profile = byPerson.get(`${personType}:${String(person._id)}`) || null;
            const latestRate = profile?.rates?.length
                ? [...profile.rates].sort((a, b) =>
                      a.effectiveFrom.localeCompare(b.effectiveFrom)
                  )[profile.rates.length - 1]
                : null;
            return {
                personType,
                personId: person._id,
                name: person.name || person.email,
                email: person.email,
                jobRole: person.jobRole || null,
                department: person.department || null,
                joiningDate: person.joiningDate || null,
                tagged: Boolean(profile),
                profileId: profile?._id || null,
                employmentType: profile?.employmentType || null,
                payModel: profile?.payModel || null,
                currentRate: latestRate?.amount ?? null,
                rateEffectiveFrom: latestRate?.effectiveFrom ?? null,
                paidDayPolicy: profile?.paidDayPolicy || null,
                overtimeEligible: profile?.overtimeEligible === true,
                hasBankDetails: Boolean(profile?.bank?.accountNumber),
                isActive: profile ? profile.isActive !== false : null,
            };
        });

        const search = String(req.query.search || "").trim().toLowerCase();
        const filtered = rows.filter((r) => {
            if (req.query.status === "untagged" && r.tagged) return false;
            if (req.query.status === "tagged" && !r.tagged) return false;
            if (req.query.payModel && r.payModel !== req.query.payModel) return false;
            if (req.query.personType && r.personType !== normaliseType(req.query.personType)) return false;
            if (search) {
                const hay = `${r.name} ${r.email} ${r.jobRole || ""} ${r.department || ""}`.toLowerCase();
                if (!hay.includes(search)) return false;
            }
            return true;
        });

        filtered.sort((a, b) => {
            // Untagged first: they are the ones needing attention.
            if (a.tagged !== b.tagged) return a.tagged ? 1 : -1;
            return String(a.name).localeCompare(String(b.name));
        });

        return res.json({
            items: filtered,
            total: filtered.length,
            counts: {
                people: rows.length,
                tagged: rows.filter((r) => r.tagged).length,
                untagged: rows.filter((r) => !r.tagged).length,
            },
        });
    } catch (err) {
        console.error("listProfiles error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/payroll/profiles/summary
//
// The workforce composition, which nothing recorded before payroll existed.
const summary = async (req, res) => {
    try {
        const [profiles, employees, managers] = await Promise.all([
            PayrollProfile.find({}).lean(),
            Employee.countDocuments({}),
            Manager.countDocuments({}),
        ]);

        const tally = (key) =>
            profiles.reduce((acc, p) => {
                const value = p[key] || "unset";
                acc[value] = (acc[value] || 0) + 1;
                return acc;
            }, {});

        const people = employees + managers;
        return res.json({
            people,
            tagged: profiles.length,
            untagged: people - profiles.length,
            byEmploymentType: tally("employmentType"),
            byPayModel: tally("payModel"),
            active: profiles.filter((p) => p.isActive !== false).length,
            withBankDetails: profiles.filter((p) => p.bank?.accountNumber).length,
            overtimeEligible: profiles.filter((p) => p.overtimeEligible === true).length,
        });
    } catch (err) {
        console.error("payroll summary error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

const loadPerson = async (req, res) => {
    const personType = normaliseType(req.params.type);
    if (!personType) {
        res.status(400).json({ message: "type must be employee or manager" });
        return null;
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
        res.status(400).json({ message: "Invalid id" });
        return null;
    }
    const person = await modelFor(personType)
        .findById(req.params.id)
        .select("name email jobRole department joiningDate")
        .lean();
    if (!person) {
        res.status(404).json({ message: `${personType} not found` });
        return null;
    }
    return { personType, person };
};

// GET /api/payroll/profiles/:type/:id
const getProfile = async (req, res) => {
    try {
        const found = await loadPerson(req, res);
        if (!found) return undefined;
        const { personType, person } = found;

        const profile = await PayrollProfile.findOne({ personType, personId: person._id })
            .populate("paidDayPolicy")
            .lean();

        return res.json({
            personType,
            person,
            profile: profile || null,
            // Newest first — the rate in force is what a reader looks for.
            rates: profile
                ? [...profile.rates].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))
                : [],
        });
    } catch (err) {
        console.error("getProfile error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// PUT /api/payroll/profiles/:type/:id
//
// Creating a profile needs a first rate; updating one leaves the rate history
// alone, because changing pay is its own action with its own effective date.
const upsertProfile = async (req, res) => {
    try {
        const found = await loadPerson(req, res);
        if (!found) return undefined;
        const { personType, person } = found;

        const { employmentType, payModel } = req.body || {};
        if (!["permanent", "contract", "daily-wage"].includes(employmentType)) {
            return res.status(400).json({
                message: "employmentType must be permanent, contract or daily-wage",
            });
        }
        if (!["monthly", "daily"].includes(payModel)) {
            return res.status(400).json({ message: "payModel must be monthly or daily" });
        }

        let profile = await PayrollProfile.findOne({ personType, personId: person._id });

        if (!profile) {
            const amount = Number(req.body.amount);
            const effectiveFrom = String(req.body.effectiveFrom || "").trim();
            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({
                    message:
                        payModel === "monthly"
                            ? "A monthly salary is required to tag somebody for payroll"
                            : "A daily rate is required to tag somebody for payroll",
                });
            }
            if (!DATE_RE.test(effectiveFrom)) {
                return res.status(400).json({
                    message: "effectiveFrom must be YYYY-MM-DD — the date this rate starts applying",
                });
            }

            const policy = req.body.paidDayPolicy
                ? await PaidDayPolicy.findById(req.body.paidDayPolicy)
                : await defaultPolicyFor(payModel);

            profile = new PayrollProfile({
                personType,
                personId: person._id,
                employmentType,
                payModel,
                paidDayPolicy: policy?._id,
                rates: [
                    {
                        effectiveFrom,
                        amount,
                        reason: String(req.body.reason || "Initial rate").trim(),
                        setByName: actorName(req),
                    },
                ],
            });
        } else {
            profile.employmentType = employmentType;
            profile.payModel = payModel;
            if (req.body.paidDayPolicy !== undefined) {
                profile.paidDayPolicy = req.body.paidDayPolicy || undefined;
            }
        }

        if (req.body.payrollStartDate !== undefined) {
            profile.payrollStartDate = req.body.payrollStartDate || undefined;
        }
        if (req.body.payrollEndDate !== undefined) {
            profile.payrollEndDate = req.body.payrollEndDate || undefined;
        }
        if (req.body.isActive !== undefined) {
            profile.isActive = req.body.isActive === true || req.body.isActive === "true";
        }
        if (req.body.grade !== undefined) profile.grade = String(req.body.grade).trim();
        if (req.body.notes !== undefined) profile.notes = String(req.body.notes).trim();

        // Whether this person earns overtime at all — decided for them, not for
        // their pay model.
        if (req.body.overtimeEligible !== undefined) {
            profile.overtimeEligible =
                req.body.overtimeEligible === true || req.body.overtimeEligible === "true";
        }

        // An overtime rate just for this person; cleared by sending null.
        if (req.body.overtimeOverride !== undefined) {
            const override = req.body.overtimeOverride;
            if (!override) {
                profile.overtimeOverride = undefined;
            } else {
                const value = Number(override.value);
                if (!["multiplier", "flat"].includes(override.mode) || !Number.isFinite(value) || value < 0) {
                    return res.status(400).json({
                        message: "overtimeOverride needs mode 'multiplier' or 'flat' and a value of zero or more",
                    });
                }
                profile.overtimeOverride = { mode: override.mode, value };
            }
        }

        profile.updatedByName = actorName(req);
        await profile.save();

        const saved = await PayrollProfile.findById(profile._id).populate("paidDayPolicy").lean();
        return res.json(saved);
    } catch (err) {
        if (err?.code === 11000) {
            return res.status(409).json({ message: "This person already has a payroll profile" });
        }
        console.error("upsertProfile error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/payroll/profiles/:type/:id/rates   { amount, effectiveFrom, reason }
//
// A raise, or a correction. Never an edit: the old rate stays, because what
// March paid must keep computing to what March paid.
const addRate = async (req, res) => {
    try {
        const found = await loadPerson(req, res);
        if (!found) return undefined;
        const { personType, person } = found;

        const profile = await PayrollProfile.findOne({ personType, personId: person._id });
        if (!profile) {
            return res.status(404).json({
                message: "Tag this person for payroll before setting a rate",
            });
        }

        const amount = Number(req.body?.amount);
        const effectiveFrom = String(req.body?.effectiveFrom || "").trim();
        const reason = String(req.body?.reason || "").trim();

        if (!Number.isFinite(amount) || amount <= 0) {
            return res.status(400).json({ message: "amount must be more than zero" });
        }
        if (!DATE_RE.test(effectiveFrom)) {
            return res.status(400).json({ message: "effectiveFrom must be YYYY-MM-DD" });
        }
        if (reason.length < 3) {
            return res.status(400).json({
                message: "Say why the rate is changing — it stays on the record",
            });
        }
        if (profile.rates.some((r) => r.effectiveFrom === effectiveFrom)) {
            return res.status(409).json({
                message: `There is already a rate effective from ${effectiveFrom}. Use a different date, or remove that one first.`,
            });
        }

        profile.rates.push({ effectiveFrom, amount, reason, setByName: actorName(req) });
        profile.updatedByName = actorName(req);
        await profile.save();

        return res.json({
            rates: [...profile.rates].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)),
        });
    } catch (err) {
        console.error("addRate error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/payroll/profiles/:type/:id/bank
//
// Kept apart from the rest of the profile: bank details are filled in later,
// by whoever collects them, and changing them should not require touching
// somebody's pay.
const updateBank = async (req, res) => {
    try {
        const found = await loadPerson(req, res);
        if (!found) return undefined;
        const { personType, person } = found;

        const profile = await PayrollProfile.findOne({ personType, personId: person._id });
        if (!profile) {
            return res.status(404).json({ message: "This person has no payroll profile yet" });
        }

        const bank = req.body?.bank || req.body || {};
        const ifsc = String(bank.ifsc || "").trim().toUpperCase();
        if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
            return res.status(400).json({
                message: "That IFSC does not look right — it is 4 letters, a zero, then 6 characters.",
            });
        }

        profile.bank = {
            accountHolderName: String(bank.accountHolderName || "").trim(),
            accountNumber: String(bank.accountNumber || "").trim(),
            ifsc,
            bankName: String(bank.bankName || "").trim(),
            branch: String(bank.branch || "").trim(),
        };
        profile.updatedByName = actorName(req);
        await profile.save();

        return res.json({ bank: profile.bank });
    } catch (err) {
        console.error("updateBank error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    listProfiles,
    summary,
    getProfile,
    upsertProfile,
    addRate,
    updateBank,
};
