/*
  payrollRoutes.js — everything under /api/payroll.

  Three gates, matching the module's control model (middleware/authPayroll.js):
    protectPayroll   read access — an assigned accountant or an admin
    protectPreparer  preparing and calculating — either of them
    protectApprover  admin only — approving, closing, and setting pay

  Setting what somebody is paid sits behind the approver gate deliberately: an
  accountant who could both set the rate and run the payroll would make
  maker-checker decorative.

  Nothing here is public. The accountant login is gone — an accountant is an
  employee an admin has assigned, and arrives with an employee token.
*/
const express = require("express");
const router = express.Router();

const {
    protectPayroll,
    protectPreparer,
    protectApprover,
} = require("../middleware/authPayroll");

const profiles = require("../controllers/payrollProfileController");
const config = require("../controllers/payrollConfigController");
const runs = require("../controllers/payrollRunController");
const payslips = require("../controllers/payslipController");
const payments = require("../controllers/payrollPaymentController");
const reports = require("../controllers/payrollReportController");

// ---- settings -------------------------------------------------------------
router.get("/settings", protectPayroll, config.readSettings);
router.put("/settings", protectApprover, config.updateSettings);

// ---- paid-day policies ----------------------------------------------------
router.get("/paid-day-policies", protectPayroll, config.listPolicies);
router.post("/paid-day-policies", protectApprover, config.createPolicy);
router.patch("/paid-day-policies/:id", protectApprover, config.updatePolicy);

// ---- who is an accountant -------------------------------------------------
// A job tag on a member of staff, not a login. "candidates" first so it is not
// read as a person type. The :type/:id pair matches the profiles routes above.
router.get("/accountants/candidates", protectApprover, config.listAccountantCandidates);
router.get("/accountants", protectApprover, config.listAccountants);
router.post("/accountants", protectApprover, config.assignAccountant);
router.delete("/accountants/:type/:id", protectApprover, config.unassignAccountant);

// ---- payroll profiles -----------------------------------------------------
// Literal paths before /:type/:id so they are not read as a person.
router.get("/profiles/summary", protectPayroll, profiles.summary);
router.get("/profiles", protectPayroll, profiles.listProfiles);
router.get("/profiles/:type/:id", protectPayroll, profiles.getProfile);
router.put("/profiles/:type/:id", protectApprover, profiles.upsertProfile);
router.post("/profiles/:type/:id/rates", protectApprover, profiles.addRate);
// Bank details are data entry rather than a pay decision, so the preparer may
// keep them up to date.
/*
  Bank details are no longer set here. The employee owns their salary account
  and fills it in on their own profile; payroll reads it. What payroll can do
  is ask the people who have not: one call, everybody still missing an
  account, push and email.
*/
router.post("/profiles/remind-bank", protectPreparer, profiles.remindMissingBank);

// ---- payroll runs ---------------------------------------------------------
// Calculating is the preparer's job; approving and locking are the approver's.
// A run only ever calculates on a closed attendance month.
router.get("/runs", protectPayroll, runs.listRuns);
router.get("/runs/:month", protectPayroll, runs.getRun);
router.get("/runs/:month/audit", protectPayroll, runs.getRunAudit);
router.post("/runs/:month/calculate", protectPreparer, runs.calculateRun);
router.post("/runs/:month/lines/:lineId/adjust", protectPreparer, runs.adjustLine);
// Draft -> pending-approval. The preparer submits their own work.
router.post("/runs/:month/submit", protectPreparer, runs.submitRun);
// Admin only, both ways. Approval is the control the whole lifecycle exists for.
router.post("/runs/:month/approve", protectApprover, runs.approveRun);
router.post("/runs/:month/reject", protectApprover, runs.rejectRun);
// Paid -> closed, and the authorised way back into a settled month.
router.post("/runs/:month/close", protectApprover, runs.closeRun);
router.post("/runs/:month/reopen", protectApprover, runs.reopenRun);

// ---- disbursement ----------------------------------------------------
// Admin approves; the accountant may then get the money out and record what
// the bank did. Both roles pass protectPreparer, which is what §3 means by
// "initiate disbursement or authorize the designated user to do so".
router.get("/runs/:month/bank-file.csv", protectPreparer, payments.exportBankFile);
router.get("/runs/:month/payments", protectPayroll, payments.listPayments);
router.post("/runs/:month/payments", protectPreparer, payments.recordPayments);

// ---- payslips -------------------------------------------------------------
// Released from a locked run only, by an admin. Re-running is safe: anybody
// who already has one is skipped.
router.get("/runs/:month/payslips", protectPayroll, payslips.listRunPayslips);
router.post("/runs/:month/payslips/release", protectApprover, payslips.releasePayslips);

// ---- register, reporting and audit ----------------------------------------
// Read-only, so the accountant and an admin both see them.
router.get("/runs/:month/register", protectPayroll, reports.getRegister);
router.get("/runs/:month/register.csv", protectPayroll, reports.exportRegisterCsv);
router.get("/reports/trend", protectPayroll, reports.getTrend);
router.get("/audit", protectPayroll, reports.getAuditLog);

module.exports = router;
