/*
  authPayroll.js — who may touch payroll.

  Three middlewares, because the module's whole control model is that
  preparing and approving are different jobs:

    protectPayroll   — an assigned accountant or an admin. Reading a register,
                       listing profiles, seeing a draft run.
    protectPreparer  — whoever may prepare and calculate: the accountant, and
                       an admin too (see the note on that middleware).
    protectApprover  — admin only. Approving, closing and reopening a run, and
                       setting people's pay.

  There is no accountant login. An accountant is a member of staff an admin
  has assigned (`canPreparePayroll` on Employee or Manager), and they reach
  payroll with their ordinary token — one set of credentials per person, and
  no account to forget to revoke when they move on.

  Employee and Manager are checked separately only because they are separate
  collections. A manager here is an employee who manages people; when the two
  models are merged this becomes one lookup.

  That merge does not weaken maker–checker, because the control was never in
  the separate login: approving is still admin-only, and approveRun still
  refuses an approver who prepared the run.

  A client-portal token, and the old `kind: "accountant"` token from the
  separate login, are both refused outright.
*/
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");

const bearer = (req) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) return null;
    return header.split(" ")[1];
};

const stale = (user, decoded) =>
    user.passwordChangedAt &&
    decoded.iat &&
    decoded.iat * 1000 < user.passwordChangedAt.getTime();

/**
 * Resolve whoever is calling into req.admin or req.payrollEmployee.
 * Returns null when the token is no good.
 */
const resolveActor = async (req) => {
    const token = bearer(req);
    if (!token) return null;

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        return null;
    }
    if (!decoded?.id) return null;

    // A client-portal token must never reach payroll.
    if (decoded.kind === "client") return null;

    // The separate accountant login is gone. Any token still carrying its kind
    // was minted before the change and is not honoured — the point of the
    // change is that those credentials no longer exist.
    if (decoded.kind === "accountant") return null;

    const admin = await Admin.findById(decoded.id).select("-password");
    if (admin) {
        if (stale(admin, decoded)) return { expired: true };
        req.admin = admin;
        return { role: "admin" };
    }

    /*
      A staff token. Payroll is open only to somebody an admin has assigned as
      an accountant; for everybody else this is indistinguishable from a token
      with no payroll rights at all, which is what we want it to look like —
      the endpoint should not confirm that the caller is a real user.

      Employee first because that is the common case, and the tokens are
      identical in shape (a bare `{ id }`), so there is nothing to tell them
      apart but the collection the id is in.
    */
    const employee = await Employee.findById(decoded.id).select("-password");
    if (employee) {
        if (!employee.canPreparePayroll) return null;
        if (stale(employee, decoded)) return { expired: true };
        req.payrollEmployee = employee;
        return { role: "accountant" };
    }

    const manager = await Manager.findById(decoded.id).select("-password");
    if (!manager || !manager.canPreparePayroll) return null;
    if (stale(manager, decoded)) return { expired: true };
    req.payrollManager = manager;
    return { role: "accountant" };
};

const deny = (res, actor) =>
    actor?.expired
        ? res.status(401).json({
              message:
                  "Session expired because the password was changed. Please sign in again.",
          })
        : res.status(401).json({ message: "Not authorized" });

/** Anyone with payroll access: accountant or admin. */
const protectPayroll = async (req, res, next) => {
    const actor = await resolveActor(req);
    if (!actor?.role) return deny(res, actor);
    return next();
};

/**
 * Whoever may prepare a run. Always the accountant. The admin too, but only
 * when the office has chosen single-approver — under maker–checker the admin
 * approves, and letting them also prepare would collapse the control.
 */
/*
  Who may prepare: both the accountant and an admin.

  This used to refuse admins under maker–checker, on the reasoning that an
  admin's job is to approve. In practice that left a month unrunnable whenever
  the accountant was away, and it is not what separation of duties requires —
  the rule is that one person must not approve their own work, not that a role
  is barred from the work.

  So preparing is open to both, and the separation is enforced where it
  actually matters: approveRun compares the approver against whoever prepared
  the run and refuses if they are the same person (under makerChecker). An
  admin who prepares a run therefore needs a second admin to approve it, and
  the dashboard warns them of that at generate time rather than at the end.
*/
const protectPreparer = async (req, res, next) => {
    const actor = await resolveActor(req);
    if (!actor?.role) return deny(res, actor);
    if (actor.role === "accountant" || actor.role === "admin") return next();
    return deny(res, actor);
};

/** Approving, locking, reopening, and setting what people are paid. */
const protectApprover = async (req, res, next) => {
    const actor = await resolveActor(req);
    if (!actor?.role) return deny(res, actor);
    if (actor.role === "admin") return next();
    return res.status(403).json({
        message: "Only an admin can approve or lock payroll.",
    });
};

module.exports = { protectPayroll, protectPreparer, protectApprover, resolveActor };
