/*
  payrollActor — who is taking a payroll action, in one place.

  There were four copies of this function across the payroll controllers, each
  reading `req.admin` and `req.accountant` slightly differently. When the
  accountant stopped being a login of its own and became an employee an admin
  assigns, every one of those copies had to learn about the new shape — which
  is the argument for there being one.

  `userType` is what goes in the audit trail, so it names the collection the
  id belongs to: an action by an assigned accountant is recorded as "Employee"
  or "Manager", because that is the record that still exists if the assignment
  is later revoked. Historical rows that say "Accountant" stay as they are;
  they were true when they were written.

  The two staff branches differ only by collection. When Employee and Manager
  become one model with a role, they become one branch.

  See middleware/authPayroll.js, which is what sets these on the request.
*/

/** The audit actor for whoever is calling. */
const actorFromReq = (req) => {
    if (req.admin) {
        return {
            userType: "Admin",
            userId: req.admin._id,
            name: req.admin.name || req.admin.email,
        };
    }
    if (req.payrollEmployee) {
        return {
            userType: "Employee",
            userId: req.payrollEmployee._id,
            name: req.payrollEmployee.name || req.payrollEmployee.email,
        };
    }
    if (req.payrollManager) {
        return {
            userType: "Manager",
            userId: req.payrollManager._id,
            name: req.payrollManager.name || req.payrollManager.email,
        };
    }
    return { userType: "System", name: "system" };
};

/** Just the name — for a `updatedByName` or a `createdByName` field. */
const actorName = (req) =>
    req.admin?.name ||
    req.admin?.email ||
    req.payrollEmployee?.name ||
    req.payrollEmployee?.email ||
    req.payrollManager?.name ||
    req.payrollManager?.email ||
    "";

module.exports = { actorFromReq, actorName };
