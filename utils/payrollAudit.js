/*
  payrollAudit — append a row to the payroll audit trail.

  The run controller has always written PayrollAudit rows for lifecycle actions
  (calculate / submit / approve / reject / pay / close / reopen). The profile
  and settings controllers did not, which left the most sensitive writes — a
  pay-rate change, and flipping maker-checker off via settings — with no
  append-only record. This shared helper closes that gap and keeps one shape.

  A failed audit write is logged loudly but never throws: a broken trail must
  not swallow the action it was recording, yet a gap in the log is a gap in the
  control and must be visible.
*/
const PayrollAudit = require("./../models/PayrollAudit");
const { actorFromReq } = require("./payrollActor");

const writeAudit = async ({ action, req, month, detail, reason, run, line }) => {
    try {
        await PayrollAudit.create({
            action,
            run: run?._id || run,
            line: line?._id || line,
            month: month || run?.month,
            actor: actorFromReq(req),
            detail,
            reason,
        });
    } catch (err) {
        console.error("payroll audit write failed:", err.message);
    }
};

module.exports = { writeAudit };
