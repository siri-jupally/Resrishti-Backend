/*
  payrollConfigController.js — payroll settings, paid-day policies, and who is
  assigned as an accountant.

  Only the settings the shipped features need are exposed; the rest of the
  configuration hub arrives with the features that want it.

  There is no accountant login to create any more. An accountant is an employee
  an admin has assigned, and they prepare payroll with their ordinary employee
  credentials — so this file hands out a job tag rather than a password.

  Mounted at /api/payroll.
    GET    /settings              read (accountant or admin)
    PUT    /settings              change (admin)
    GET    /paid-day-policies     list
    POST   /paid-day-policies     create (admin)
    PATCH  /paid-day-policies/:id edit (admin)
    GET    /accountants            who is assigned (admin)
    GET    /accountants/candidates  who could be (admin)
    POST   /accountants             assign somebody (admin)
    DELETE /accountants/:type/:id   un-assign them (admin)
*/
const mongoose = require("mongoose");

const PaidDayPolicy = require("../models/PaidDayPolicy");
const PayrollProfile = require("../models/PayrollProfile");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const JobRole = require("../models/JobRole");
const { getSettings, seedPaidDayPolicies } = require("../utils/payrollDefaults");
const { writeAudit } = require("../utils/payrollAudit");

/*
  Staff come in two collections, and the payroll module already names that
  distinction `personType` everywhere else (PayrollProfile, PayrollLine), so
  these mirror payrollProfileController rather than inventing a third spelling.

  A manager is an employee who manages people; the two collections are an
  accident of how the system grew, not a statement about payroll. When they are
  merged, `normaliseType` and `modelFor` here go away.
*/
const normaliseType = (raw) => {
    const value = String(raw || "").toLowerCase();
    if (value === "employee") return "Employee";
    if (value === "manager") return "Manager";
    return null;
};

const modelFor = (personType) => (personType === "Employee" ? Employee : Manager);

const actorName = (req) =>
    req.admin?.name ||
    req.admin?.email ||
    req.payrollEmployee?.name ||
    req.payrollEmployee?.email ||
    req.payrollManager?.name ||
    req.payrollManager?.email ||
    "";

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
        const approvalDepthBefore = settings.approvalDepth;

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

        // ---- statutory deductions (PF / ESI / PT / TDS) -------------------
        // Each component is toggled and tuned independently. Merge onto the
        // current values (filling defaults for a settings doc that predates the
        // field), validate, and set the whole subtree back.
        if (body.statutory && typeof body.statutory === "object") {
            const cur = settings.statutory?.toObject ? settings.statutory.toObject() : (settings.statutory || {});
            const next = {
                pf: { enabled: false, employeeRate: 12, wageBasis: "basic", basicPercent: 50, wageCeiling: 15000, capToCeiling: true, ...(cur.pf || {}) },
                esi: { enabled: false, employeeRate: 0.75, grossCeiling: 21000, ...(cur.esi || {}) },
                pt: { enabled: false, amount: 200, minGross: 15000, ...(cur.pt || {}) },
                tds: { enabled: false, flatPercent: 0, ...(cur.tds || {}) },
            };
            const st = body.statutory;
            const bool = (v) => v === true || v === "true";
            const pct = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 100 ? n : NaN; };
            const nonneg = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : NaN; };

            if (st.pf) {
                if (st.pf.enabled !== undefined) next.pf.enabled = bool(st.pf.enabled);
                if (st.pf.wageBasis !== undefined) {
                    if (!["basic", "gross"].includes(st.pf.wageBasis)) return res.status(400).json({ message: "PF wage basis must be basic or gross" });
                    next.pf.wageBasis = st.pf.wageBasis;
                }
                if (st.pf.capToCeiling !== undefined) next.pf.capToCeiling = bool(st.pf.capToCeiling);
                for (const [k, f, label] of [["employeeRate", pct, "PF rate must be 0–100%"], ["basicPercent", pct, "PF basic percent must be 0–100"], ["wageCeiling", nonneg, "PF wage ceiling must be zero or more"]]) {
                    if (st.pf[k] !== undefined) { const n = f(st.pf[k]); if (Number.isNaN(n)) return res.status(400).json({ message: label }); next.pf[k] = n; }
                }
            }
            if (st.esi) {
                if (st.esi.enabled !== undefined) next.esi.enabled = bool(st.esi.enabled);
                if (st.esi.employeeRate !== undefined) { const n = pct(st.esi.employeeRate); if (Number.isNaN(n)) return res.status(400).json({ message: "ESI rate must be 0–100%" }); next.esi.employeeRate = n; }
                if (st.esi.grossCeiling !== undefined) { const n = nonneg(st.esi.grossCeiling); if (Number.isNaN(n)) return res.status(400).json({ message: "ESI gross ceiling must be zero or more" }); next.esi.grossCeiling = n; }
            }
            if (st.pt) {
                if (st.pt.enabled !== undefined) next.pt.enabled = bool(st.pt.enabled);
                if (st.pt.amount !== undefined) { const n = nonneg(st.pt.amount); if (Number.isNaN(n)) return res.status(400).json({ message: "PT amount must be zero or more" }); next.pt.amount = n; }
                if (st.pt.minGross !== undefined) { const n = nonneg(st.pt.minGross); if (Number.isNaN(n)) return res.status(400).json({ message: "PT threshold must be zero or more" }); next.pt.minGross = n; }
            }
            if (st.tds) {
                if (st.tds.enabled !== undefined) next.tds.enabled = bool(st.tds.enabled);
                if (st.tds.flatPercent !== undefined) { const n = pct(st.tds.flatPercent); if (Number.isNaN(n)) return res.status(400).json({ message: "TDS percent must be 0–100" }); next.tds.flatPercent = n; }
            }
            settings.set("statutory", next);
        }

        settings.updatedByName = actorName(req);
        await settings.save();

        // The most sensitive setting is approvalDepth — flipping it off
        // makerChecker lets one person prepare and approve. Record every
        // settings change, and the before/after of that flag in particular.
        await writeAudit({
            action: "settings.updated",
            req,
            detail: {
                changed: Object.keys(body),
                ...(approvalDepthBefore !== settings.approvalDepth
                    ? { approvalDepth: { from: approvalDepthBefore, to: settings.approvalDepth } }
                    : {}),
            },
        });
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
/*
  "Accountant" is a job tag on a member of staff, not an account.

  The previous design gave each accountant a login of its own, which meant a
  second set of credentials for somebody who already had one, and a second
  account to remember to revoke when they changed jobs. Assigning the tag to
  the record they already have removes both problems, and nothing is lost:
  approving stays admin-only, and approveRun still refuses an approver who
  prepared the run.

  Employees and managers are both assignable. A manager who prepares payroll
  also approves their own team's attendance, which is an input to the pay they
  are preparing — worth knowing, but it is not unchecked: an admin still
  approves the run, and nobody may adjust their own line (see adjustLine).
*/

/** The fields the panel needs. Never the password. */
const ACCOUNTANT_FIELDS = "name email phone jobRole department payrollAssignedAt payrollAssignedByName";

/** Both collections, newest assignment first, as one list. */
const listAccountants = async (req, res) => {
    try {
        const [employees, managers] = await Promise.all([
            Employee.find({ canPreparePayroll: true }).select(ACCOUNTANT_FIELDS).lean(),
            Manager.find({ canPreparePayroll: true }).select(ACCOUNTANT_FIELDS).lean(),
        ]);
        const items = [
            ...employees.map((e) => ({ ...e, personType: "Employee" })),
            ...managers.map((m) => ({ ...m, personType: "Manager" })),
        ].sort((a, b) => {
            const at = a.payrollAssignedAt ? new Date(a.payrollAssignedAt).getTime() : 0;
            const bt = b.payrollAssignedAt ? new Date(b.payrollAssignedAt).getTime() : 0;
            if (at !== bt) return bt - at;
            return String(a.name || a.email).localeCompare(String(b.name || b.email));
        });
        return res.json({ items, total: items.length });
    } catch (err) {
        console.error("listAccountants error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/*
  Who could be assigned. Searchable, because an office with a few hundred
  staff should not be scrolled through, and capped so a blank query cannot
  pull the whole directory down the wire.
*/
const CANDIDATE_LIMIT = 25;

const listAccountantCandidates = async (req, res) => {
    try {
        const q = String(req.query?.q || "").trim();
        const filter = { canPreparePayroll: { $ne: true } };
        if (q) {
            // Escaped: a search box is not a place to accept a regex.
            const safe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const rx = new RegExp(safe, "i");
            filter.$or = [{ name: rx }, { email: rx }];
        }
        // The limit is applied per collection and then to the merged list, so
        // a long employee list cannot crowd the managers out of the results.
        const [employees, managers] = await Promise.all([
            Employee.find(filter).select("name email jobRole department")
                .sort({ name: 1 }).limit(CANDIDATE_LIMIT).lean(),
            Manager.find(filter).select("name email jobRole department")
                .sort({ name: 1 }).limit(CANDIDATE_LIMIT).lean(),
        ]);
        const items = [
            ...employees.map((e) => ({ ...e, personType: "Employee" })),
            ...managers.map((m) => ({ ...m, personType: "Manager" })),
        ]
            .sort((a, b) =>
                String(a.name || a.email).localeCompare(String(b.name || b.email)))
            .slice(0, CANDIDATE_LIMIT);
        return res.json({ items, total: items.length, limit: CANDIDATE_LIMIT });
    } catch (err) {
        console.error("listAccountantCandidates error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

const assignAccountant = async (req, res) => {
    try {
        // `personType` defaults to Employee, which is both the common case and
        // what the field meant before managers could be assigned.
        const personType = normaliseType(req.body?.personType || "employee");
        if (!personType) {
            return res.status(400).json({ message: "personType must be employee or manager" });
        }
        const personId = String(req.body?.personId || req.body?.employeeId || "");
        if (!mongoose.Types.ObjectId.isValid(personId)) {
            return res.status(400).json({ message: "A valid person is required" });
        }

        const person = await modelFor(personType).findById(personId);
        if (!person) return res.status(404).json({ message: `${personType} not found` });
        if (person.canPreparePayroll) {
            return res.status(409).json({
                message: `${person.name || person.email} is already an accountant`,
            });
        }

        person.canPreparePayroll = true;
        person.payrollAssignedAt = new Date();
        person.payrollAssignedByName = actorName(req);
        await person.save();

        await writeAudit({
            action: "accountant.assigned",
            req,
            detail: { personType, personId: String(person._id), name: person.name || person.email },
        });

        return res.status(201).json({
            _id: person._id,
            personType,
            name: person.name,
            email: person.email,
            phone: person.phone,
            jobRole: person.jobRole,
            department: person.department,
            payrollAssignedAt: person.payrollAssignedAt,
            payrollAssignedByName: person.payrollAssignedByName,
        });
    } catch (err) {
        console.error("assignAccountant error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/*
  Un-assigning takes payroll away and nothing else: they keep their login,
  their tasks and their own payslips, because they are still a member of
  staff. Any run they prepared keeps their name on it — the audit trail stores
  the name alongside the id for exactly this reason.
*/
const unassignAccountant = async (req, res) => {
    try {
        const personType = normaliseType(req.params.type);
        if (!personType) {
            return res.status(400).json({ message: "type must be employee or manager" });
        }
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid id" });
        }
        const person = await modelFor(personType).findById(id);
        if (!person) return res.status(404).json({ message: `${personType} not found` });
        if (!person.canPreparePayroll) {
            return res.status(409).json({ message: "They are not an accountant" });
        }

        person.canPreparePayroll = false;
        person.payrollAssignedAt = undefined;
        person.payrollAssignedByName = undefined;
        await person.save();

        await writeAudit({
            action: "accountant.unassigned",
            req,
            detail: { personType, personId: String(person._id), name: person.name || person.email },
        });

        return res.json({
            _id: person._id,
            personType,
            name: person.name,
            email: person.email,
            canPreparePayroll: false,
        });
    } catch (err) {
        console.error("unassignAccountant error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// ── role-based payroll defaults ─────────────────────────────────────────────

/*
  Every active role, with its payroll template and how many of its holders are
  already on payroll — the data the Setup "role defaults" screen and the
  profile-tagging pre-fill both read.
*/
const listRoles = async (req, res) => {
    try {
        const roles = await JobRole.find({ isActive: true })
            .sort({ name: 1 })
            .populate("payroll.paidDayPolicy", "name")
            .lean();

        const [emps, mgrs, profiles] = await Promise.all([
            Employee.find({ jobRoleId: { $ne: null } }).select("jobRoleId").lean(),
            Manager.find({ jobRoleId: { $ne: null } }).select("jobRoleId").lean(),
            PayrollProfile.find({}).select("personType personId").lean(),
        ]);
        const onPayroll = new Set(profiles.map((p) => `${p.personType}:${String(p.personId)}`));

        const tally = {};
        const add = (roleId, type, id) => {
            const k = String(roleId);
            (tally[k] = tally[k] || { people: 0, onPayroll: 0 }).people += 1;
            if (onPayroll.has(`${type}:${String(id)}`)) tally[k].onPayroll += 1;
        };
        emps.forEach((e) => add(e.jobRoleId, "Employee", e._id));
        mgrs.forEach((m) => add(m.jobRoleId, "Manager", m._id));

        return res.json({
            items: roles.map((r) => ({
                _id: r._id,
                name: r.name,
                appliesTo: r.appliesTo,
                payroll: r.payroll || null,
                configured: Boolean(r.payroll?.employmentType && r.payroll?.payModel),
                people: tally[String(r._id)]?.people || 0,
                onPayroll: tally[String(r._id)]?.onPayroll || 0,
            })),
        });
    } catch (err) {
        console.error("listRoles error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/*
  PUT /api/payroll/roles/:id/defaults
  Set (or clear, with { clear: true }) a role's payroll template. Approver-only
  — it decides pay. Only affects profiles created afterwards.
*/
const setRoleDefaults = async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid job role" });
        }
        const role = await JobRole.findById(req.params.id);
        if (!role) return res.status(404).json({ message: "Job role not found" });

        const b = req.body || {};

        if (b.clear === true) {
            role.payroll = undefined;
            await role.save();
            await writeAudit({ action: "role.payrollCleared", req, detail: { role: role.name } });
            return res.json({ _id: role._id, name: role.name, payroll: null, configured: false });
        }

        if (!["permanent", "contract", "daily-wage"].includes(b.employmentType)) {
            return res.status(400).json({ message: "employmentType must be permanent, contract or daily-wage" });
        }
        if (!["monthly", "daily"].includes(b.payModel)) {
            return res.status(400).json({ message: "payModel must be monthly or daily" });
        }
        let policyId;
        if (b.paidDayPolicy) {
            if (!mongoose.Types.ObjectId.isValid(b.paidDayPolicy)) {
                return res.status(400).json({ message: "Invalid paid-day policy" });
            }
            const policy = await PaidDayPolicy.findById(b.paidDayPolicy);
            if (!policy) return res.status(400).json({ message: "That paid-day policy does not exist" });
            policyId = policy._id;
        }
        let defaultRate;
        if (b.defaultRate !== undefined && b.defaultRate !== null && String(b.defaultRate).trim() !== "") {
            const n = Number(b.defaultRate);
            if (!Number.isFinite(n) || n < 0) {
                return res.status(400).json({ message: "defaultRate must be zero or more, or left blank" });
            }
            defaultRate = n;
        }

        role.payroll = {
            employmentType: b.employmentType,
            payModel: b.payModel,
            paidDayPolicy: policyId,
            overtimeEligible: b.overtimeEligible === true || b.overtimeEligible === "true",
            defaultRate,
            setByName: actorName(req),
            updatedAt: new Date(),
        };
        await role.save();

        await writeAudit({
            action: "role.payrollSet",
            req,
            detail: { role: role.name, employmentType: b.employmentType, payModel: b.payModel, defaultRate: defaultRate ?? null },
        });

        const saved = await JobRole.findById(role._id).populate("payroll.paidDayPolicy", "name").lean();
        return res.json({ _id: role._id, name: role.name, payroll: saved.payroll, configured: true });
    } catch (err) {
        console.error("setRoleDefaults error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    readSettings,
    updateSettings,
    listPolicies,
    createPolicy,
    updatePolicy,
    listAccountants,
    listAccountantCandidates,
    assignAccountant,
    unassignAccountant,
    listRoles,
    setRoleDefaults,
};
