/*
  adminStaffController.js — every member of staff, in one list.

  Until now an admin could see managers (adminOrgController.listManagers) and
  employees (adminOrgController.listAllEmployees) only as two separate lists,
  on two screens, with no single answer to "who works here". That is awkward
  for an obvious reason: a manager is not a different kind of person. They are
  a member of staff whose role happens to be manager.

  So this returns everybody, with `role` as a field rather than as the choice
  of endpoint. The two collections are still separate — Employee and Manager
  are distinct models, which is the change that was deliberately deferred as
  too risky to make while payroll was being built — but nothing above this
  line has to care: each row carries `personType` for the calls that still
  need it, and `role` for reading. When the models merge, `personType` goes
  and the rest of this file stays as it is.

  Everything here is read-only. The actions an admin takes on a person already
  exist and are untouched: reassigning an employee to another manager, the
  pickup-agent flag, payroll access, the profile editors.

    GET /api/admin/staff?search=&role=&department=&missing=
*/
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const PayrollProfile = require("../models/PayrollProfile");

const STAFF_FIELDS =
    "name email phone jobRole department joiningDate profilePhoto " +
    "isFirstLogin isProfileComplete bank bankUpdatedAt " +
    "canSupervise canCoordinate canPreparePayroll createdAt";

/* The job tags somebody carries, as words rather than booleans. */
const tagsOf = (person, role) => {
    const tags = [];
    if (role === "Manager") tags.push("Manager");
    if (person.canPreparePayroll) tags.push("Accountant");
    if (person.canSupervise) tags.push("Pickup agent");
    if (person.canCoordinate) tags.push("Request coordinator");
    return tags;
};

// GET /api/admin/staff
const listStaff = async (req, res) => {
    try {
        const [employees, managers, profiles] = await Promise.all([
            Employee.find()
                .select(STAFF_FIELDS)
                .populate("manager", "name email")
                .lean(),
            Manager.find().select(STAFF_FIELDS).lean(),
            PayrollProfile.find({})
                .select("personType personId employmentType payModel isActive rates")
                .lean(),
        ]);

        const profileByPerson = new Map(
            profiles.map((p) => [`${p.personType}:${String(p.personId)}`, p])
        );

        // How many people report to each manager, so the list says what being
        // a manager actually means for that person.
        const teamSize = new Map();
        for (const e of employees) {
            const id = e.manager?._id ? String(e.manager._id) : null;
            if (id) teamSize.set(id, (teamSize.get(id) || 0) + 1);
        }

        const rowFor = (person, personType) => {
            const role = personType === "Manager" ? "Manager" : "Employee";
            const profile = profileByPerson.get(`${personType}:${String(person._id)}`) || null;
            const latestRate = profile?.rates?.length
                ? [...profile.rates].sort((a, b) =>
                      a.effectiveFrom.localeCompare(b.effectiveFrom)
                  )[profile.rates.length - 1]
                : null;

            return {
                // Still needed by every call that reaches into one collection
                // or the other. It disappears when the models merge.
                personType,
                _id: person._id,
                name: person.name || person.email,
                email: person.email,
                phone: person.phone || null,
                role,
                jobRole: person.jobRole || null,
                department: person.department || null,
                joiningDate: person.joiningDate || null,
                profilePhoto: person.profilePhoto || null,
                // A manager answers to the admin; an employee to their manager.
                reportsTo: role === "Manager"
                    ? null
                    : person.manager
                        ? { _id: person.manager._id, name: person.manager.name || person.manager.email }
                        : null,
                teamSize: role === "Manager" ? teamSize.get(String(person._id)) || 0 : null,
                tags: tagsOf(person, role),
                canSupervise: Boolean(person.canSupervise),
                canCoordinate: Boolean(person.canCoordinate),
                canPreparePayroll: Boolean(person.canPreparePayroll),
                // Their own salary account, which they enter themselves.
                hasBankDetails: Boolean(person.bank?.accountNumber),
                bankUpdatedAt: person.bankUpdatedAt || null,
                isProfileComplete: Boolean(person.isProfileComplete),
                hasLoggedIn: person.isFirstLogin === false,
                onPayroll: Boolean(profile) && profile.isActive !== false,
                employmentType: profile?.employmentType || null,
                payModel: profile?.payModel || null,
                currentRate: latestRate?.amount ?? null,
                createdAt: person.createdAt || null,
            };
        };

        const all = [
            ...managers.map((m) => rowFor(m, "Manager")),
            ...employees.map((e) => rowFor(e, "Employee")),
        ];

        const search = String(req.query.search || "").trim().toLowerCase();
        const role = String(req.query.role || "");
        const department = String(req.query.department || "");
        const missing = String(req.query.missing || "");

        const items = all.filter((r) => {
            if (role && r.role !== role) return false;
            if (department && r.department !== department) return false;
            // The three gaps an admin actually chases.
            if (missing === "bank" && r.hasBankDetails) return false;
            if (missing === "profile" && r.isProfileComplete) return false;
            if (missing === "payroll" && r.onPayroll) return false;
            if (search) {
                const hay = [r.name, r.email, r.jobRole, r.department, r.phone]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();
                if (!hay.includes(search)) return false;
            }
            return true;
        });

        // Managers first, then alphabetical: a list of staff reads best as the
        // shape of the organisation rather than as the order people joined.
        items.sort((a, b) => {
            if (a.role !== b.role) return a.role === "Manager" ? -1 : 1;
            return String(a.name).localeCompare(String(b.name));
        });

        return res.json({
            items,
            total: items.length,
            // Counted over everybody, not over the filtered view: these are the
            // headline figures, and they should not move when you search.
            counts: {
                people: all.length,
                managers: all.filter((r) => r.role === "Manager").length,
                employees: all.filter((r) => r.role === "Employee").length,
                accountants: all.filter((r) => r.canPreparePayroll).length,
                onPayroll: all.filter((r) => r.onPayroll).length,
                offPayroll: all.filter((r) => !r.onPayroll).length,
                missingBank: all.filter((r) => !r.hasBankDetails).length,
                incompleteProfile: all.filter((r) => !r.isProfileComplete).length,
                neverLoggedIn: all.filter((r) => !r.hasLoggedIn).length,
                unassigned: all.filter((r) => r.role === "Employee" && !r.reportsTo).length,
            },
            departments: [...new Set(all.map((r) => r.department).filter(Boolean))].sort(),
        });
    } catch (err) {
        console.error("listStaff error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = { listStaff };
