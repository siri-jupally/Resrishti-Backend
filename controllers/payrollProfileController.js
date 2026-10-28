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
    POST   /remind-bank      nudge everybody with no salary account on file

  Bank details are not set here. The employee owns their salary account and
  fills it in on their own profile (Employee.bank / Manager.bank, written by
  controllers/profileController.js), which is also what the bank file and the
  payment screen read. This used to let an accountant type them into
  PayrollProfile.bank, which nothing read — so the details were collected
  twice and paid from neither reliably. Payroll now reads the person's own
  account and, when it is missing, asks them for it.
*/
const mongoose = require("mongoose");

const PayrollProfile = require("../models/PayrollProfile");
const PaidDayPolicy = require("../models/PaidDayPolicy");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const JobRole = require("../models/JobRole");
const { defaultPolicyFor, seedPaidDayPolicies } = require("../utils/payrollDefaults");
const { notifyIfEnabled } = require("../utils/push");
const { sendEmail } = require("../utils/emailService");
const { writeAudit } = require("../utils/payrollAudit");

const TYPES = ["Employee", "Manager"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const actorName = (req) =>
    req.admin?.name ||
    req.admin?.email ||
    req.payrollEmployee?.name ||
    req.payrollEmployee?.email ||
    req.payrollManager?.name ||
    req.payrollManager?.email ||
    "";

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
            Employee.find({}).select("name email jobRole jobRoleId department joiningDate manager bank bankUpdatedAt").lean(),
            Manager.find({}).select("name email jobRole jobRoleId department joiningDate bank bankUpdatedAt").lean(),
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
                jobRoleId: person.jobRoleId || null,
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
                // Their own account, the one the bank file is built from.
                hasBankDetails: Boolean(person.bank?.accountNumber),
                bankUpdatedAt: person.bankUpdatedAt || null,
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
            Employee.find({}).select("bank").lean(),
            Manager.find({}).select("bank").lean(),
        ]);

        const tally = (key) =>
            profiles.reduce((acc, p) => {
                const value = p[key] || "unset";
                acc[value] = (acc[value] || 0) + 1;
                return acc;
            }, {});

        const people = employees.length + managers.length;

        /*
          Counted against the person's own record, not the payroll profile:
          the account they typed in is the one that gets paid. Reported only
          for people who are actually on payroll, because an untagged person
          with no account is not yet a problem.
        */
        const bankByPerson = new Map([
            ...employees.map((e) => [`Employee:${String(e._id)}`, e.bank]),
            ...managers.map((m) => [`Manager:${String(m._id)}`, m.bank]),
        ]);
        const onPayroll = profiles.filter((p) => p.isActive !== false);
        const withBank = onPayroll.filter(
            (p) => bankByPerson.get(`${p.personType}:${String(p.personId)}`)?.accountNumber
        ).length;

        return res.json({
            people,
            tagged: profiles.length,
            untagged: people - profiles.length,
            byEmploymentType: tally("employmentType"),
            byPayModel: tally("payModel"),
            active: onPayroll.length,
            withBankDetails: withBank,
            missingBankDetails: onPayroll.length - withBank,
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
        .select("name email jobRole department joiningDate bank bankUpdatedAt bankHistory")
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
            /*
              Their own salary account. Read-only to payroll: it is theirs to
              change, on their own profile, and every change there is emailed
              to them and kept in bankHistory. `bankUpdatedAt` is what a run
              uses to flag an account that moved after it was generated.
            */
            bank: person.bank?.accountNumber ? person.bank : null,
            bankUpdatedAt: person.bankUpdatedAt || null,
            bankChanges: person.bankHistory?.length || 0,
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
        const wasCreate = !profile;

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

            let policy;
            if (req.body.paidDayPolicy) {
                if (!mongoose.Types.ObjectId.isValid(req.body.paidDayPolicy)) {
                    return res.status(400).json({ message: "Invalid paid-day policy" });
                }
                policy = await PaidDayPolicy.findById(req.body.paidDayPolicy);
                if (!policy) return res.status(400).json({ message: "That paid-day policy does not exist" });
            } else {
                policy = await defaultPolicyFor(payModel);
            }

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
            // Changing the pay model reinterprets the entire rate history — a
            // ₹30,000 MONTHLY salary would read as a ₹30,000 DAILY rate and pay
            // roughly 30× on the next run — so it is refused once any rate
            // exists. Create a new profile with fresh rates instead.
            if (payModel !== profile.payModel && (profile.rates?.length || 0) > 0) {
                return res.status(409).json({
                    message: `This profile is on the ${profile.payModel} model with pay history, so it cannot switch to ${payModel} — every past rate would be reinterpreted. Create a new profile instead.`,
                    code: "payModelLocked",
                });
            }
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

        await writeAudit({
            action: wasCreate ? "profile.created" : "profile.updated",
            req,
            detail: {
                personType,
                personId: String(person._id),
                name: person.name || person.email,
                payModel: profile.payModel,
                employmentType: profile.employmentType,
            },
        });

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

        await writeAudit({
            action: "profile.rateAdded",
            req,
            detail: {
                personType,
                personId: String(person._id),
                name: person.name || person.email,
                amount,
                effectiveFrom,
                reason,
            },
        });

        return res.json({
            rates: [...profile.rates].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)),
        });
    } catch (err) {
        console.error("addRate error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/*
  POST /api/payroll/profiles/remind-bank

  Nobody can be paid without an account, and the first anybody usually hears
  about a missing one is on payday. The employee's own dashboard already nags
  them every day it is missing (components/profile/BankDetailsNotice.jsx), but
  that only works for somebody who opens the app, so this is the push from the
  other side: whoever is preparing payroll can ask everybody still missing an
  account, in one action, and see who was asked.

  Only people on payroll are asked - an untagged person is not being paid yet.
  Notifications are best-effort: a failed push or email must not fail the call,
  because the useful part is the list it comes back with.
*/
const remindMissingBank = async (req, res) => {
    try {
        const [profiles, employees, managers] = await Promise.all([
            PayrollProfile.find({ isActive: { $ne: false } })
                .select("personType personId")
                .lean(),
            Employee.find({}).select("name email bank pushSubscription").lean(),
            Manager.find({}).select("name email bank pushSubscription").lean(),
        ]);

        const byKey = new Map([
            ...employees.map((e) => [`Employee:${String(e._id)}`, e]),
            ...managers.map((m) => [`Manager:${String(m._id)}`, m]),
        ]);

        const missing = profiles
            .map((p) => ({
                personType: p.personType,
                person: byKey.get(`${p.personType}:${String(p.personId)}`),
            }))
            .filter((row) => row.person && !row.person.bank?.accountNumber);

        const asked = [];
        for (const { personType, person } of missing) {
            asked.push({
                personType,
                personId: String(person._id),
                name: person.name || person.email,
                email: person.email,
                notified: Boolean(person.pushSubscription),
            });

            if (person.pushSubscription) {
                try {
                    await notifyIfEnabled("attendance", person.pushSubscription, {
                        title: "Add your salary account",
                        body: "Your salary cannot be paid until your bank details are on your profile. It takes a minute.",
                        url: "/",
                    });
                } catch (err) {
                    console.error("bank reminder push failed:", err.message);
                }
            }

            try {
                await sendEmail({
                    to: person.email,
                    subject: "We need your bank details to pay your salary",
                    html: `<p>Hello ${person.name || ""},</p>
                           <p>We do not have a bank account on file for you, and your salary
                           cannot be paid without one. Please open your ReSrishti profile and
                           add your account holder name, account number, IFSC and bank.</p>
                           <p>It takes a minute, and you can change it later if you need to.</p>`,
                });
            } catch (err) {
                console.error("bank reminder email failed:", err.message);
            }
        }

        return res.json({
            asked: asked.length,
            people: asked.sort((a, b) => String(a.name).localeCompare(String(b.name))),
        });
    } catch (err) {
        console.error("remindMissingBank error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/*
  POST /api/payroll/profiles/apply-role   { jobRoleId, rate?, effectiveFrom? }

  "Add everyone in this role to payroll." Reads the role's payroll template and
  creates a profile for each person who holds the role and is not already on
  payroll, using the template + the role's default rate (or a rate passed for
  this batch). People already tagged are left untouched — this never overwrites
  an existing profile, so it is safe to run again. Approver-only, because it
  sets pay.
*/
const applyRole = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.body?.jobRoleId || "")) {
            return res.status(400).json({ message: "A job role is required" });
        }
        const role = await JobRole.findById(req.body.jobRoleId);
        if (!role) return res.status(404).json({ message: "Job role not found" });

        const t = role.payroll;
        if (!t?.employmentType || !t?.payModel) {
            return res.status(400).json({
                message: `"${role.name}" has no payroll template yet. Set it up in Payroll → Setup first.`,
                code: "roleNotConfigured",
            });
        }

        // The rate for this batch: an explicit one wins, else the role default.
        // A profile cannot exist without a rate, so one must be available.
        const explicit = req.body?.rate;
        const rate = (explicit !== undefined && explicit !== null && String(explicit).trim() !== "")
            ? Number(explicit)
            : (typeof t.defaultRate === "number" ? t.defaultRate : null);
        if (rate === null || !Number.isFinite(rate) || rate <= 0) {
            return res.status(400).json({
                message: "A pay rate is needed. Set a default rate on the role, or pass a rate for this batch.",
                code: "rateRequired",
            });
        }
        const effectiveFrom = DATE_RE.test(String(req.body?.effectiveFrom || ""))
            ? req.body.effectiveFrom
            : new Date().toISOString().slice(0, 10);

        // Everybody who holds this role, within what the role applies to.
        const [emps, mgrs] = await Promise.all([
            role.appliesTo === "manager" ? [] : Employee.find({ jobRoleId: role._id }).select("name email").lean(),
            role.appliesTo === "employee" ? [] : Manager.find({ jobRoleId: role._id }).select("name email").lean(),
        ]);
        const holders = [
            ...emps.map((e) => ({ personType: "Employee", personId: e._id, name: e.name || e.email })),
            ...mgrs.map((m) => ({ personType: "Manager", personId: m._id, name: m.name || m.email })),
        ];
        if (holders.length === 0) {
            return res.status(400).json({ message: `Nobody holds the "${role.name}" role yet.` });
        }

        const existing = new Set(
            (await PayrollProfile.find({ personId: { $in: holders.map((h) => h.personId) } })
                .select("personType personId").lean())
                .map((p) => `${p.personType}:${String(p.personId)}`)
        );
        const toCreate = holders.filter((h) => !existing.has(`${h.personType}:${String(h.personId)}`));

        const docs = toCreate.map((h) => ({
            personType: h.personType,
            personId: h.personId,
            employmentType: t.employmentType,
            payModel: t.payModel,
            paidDayPolicy: t.paidDayPolicy,
            overtimeEligible: !!t.overtimeEligible,
            rates: [{ effectiveFrom, amount: rate, reason: `Set from role: ${role.name}`, setByName: actorName(req) }],
        }));
        if (docs.length > 0) await PayrollProfile.insertMany(docs, { ordered: false });

        await writeAudit({
            action: "profile.bulkFromRole",
            req,
            detail: { role: role.name, created: docs.length, skipped: holders.length - docs.length, rate, effectiveFrom },
        });

        return res.status(201).json({
            role: role.name,
            created: docs.length,
            skipped: holders.length - docs.length,
            total: holders.length,
            createdNames: toCreate.map((h) => h.name),
        });
    } catch (err) {
        console.error("applyRole error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    listProfiles,
    summary,
    getProfile,
    upsertProfile,
    addRate,
    remindMissingBank,
    applyRole,
};
