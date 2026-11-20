/*
  payrollRoutes.js — everything under /api/payroll.

  Four gates, matching the module's control model (middleware/authPayroll.js):
    protectPayroll     read access — an assigned accountant or an admin
    protectAccountant  GENERATING a run (calculate/adjust/submit) — the
                       accountant; an admin only to bootstrap when none assigned
    protectPreparer    disbursement (record payments / bank file) — either of them
    protectApprover    admin only — approving, closing, and setting pay

  Setting what somebody is paid sits behind the approver gate deliberately: an
  accountant who could both set the rate and run the payroll would make
  maker-checker decorative. Generating sits behind protectAccountant so an admin
  does not prepare a run and then approve their own work (#12).

  Nothing here is public. The accountant login is gone — an accountant is an
  employee an admin has assigned, and arrives with an employee token.
*/
const express = require("express");
const router = express.Router();

const {
    protectPayroll,
    protectAccountant,
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

// ---- role-based payroll defaults ------------------------------------------
// Reads feed the Setup screen and the tagging pre-fill; setting a role's
// template decides pay, so it sits behind the approver gate.
router.get("/roles", protectPayroll, config.listRoles);
router.put("/roles/:id/defaults", protectApprover, config.setRoleDefaults);

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
// Literal path, before the /:type/:id routes. Bulk-create profiles for everyone
// in a role from that role's payroll template. The accountant sets people up on
// payroll (protectPreparer); the admin still approves every run before anyone
// is paid, which is where the maker-checker control actually sits.
router.post("/profiles/apply-role", protectPreparer, profiles.applyRole);
router.get("/profiles/:type/:id", protectPayroll, profiles.getProfile);
// Adding someone to payroll and setting/updating their rate — the accountant's
// job. (approveRun is still admin-only, and refuses a preparer approving their
// own run, so opening this does not collapse separation of duties.)
router.put("/profiles/:type/:id", protectPreparer, profiles.upsertProfile);
router.post("/profiles/:type/:id/rates", protectPreparer, profiles.addRate);

// The accountant maintains a person's salary account and their KYC documents.
// Bank changes go through the same fraud-safe path as the person's own editor
// (history + email); KYC is a growing list of labelled docs (Aadhaar, PAN, …).
router.put("/profiles/:type/:id/bank", protectPreparer, profiles.updateBank);
router.post("/profiles/:type/:id/kyc", protectPreparer, profiles.kycUpload.single("file"), profiles.addKyc);
router.delete("/profiles/:type/:id/kyc/:docId", protectPreparer, profiles.removeKyc);

/*
  Nudge everyone who still has no salary account on file: one call, push + email
  to each. (The accountant can now also enter an account for someone directly,
  above, for a person who cannot do it themselves.)
*/
router.post("/profiles/remind-bank", protectPreparer, profiles.remindMissingBank);

// ---- payroll runs ---------------------------------------------------------
// Calculating is the preparer's job; approving and locking are the approver's.
// A run only ever calculates on a closed attendance month.
router.get("/runs", protectPayroll, runs.listRuns);
router.get("/runs/:month", protectPayroll, runs.getRun);
router.get("/runs/:month/audit", protectPayroll, runs.getRunAudit);
// Generating a run is the accountant's job — an admin only when none is assigned
// (protectAccountant), so an admin never prepares a run and then approves it (#12).
router.post("/runs/:month/calculate", protectAccountant, runs.calculateRun);
router.post("/runs/:month/lines/:lineId/adjust", protectAccountant, runs.adjustLine);
// Draft -> pending-approval. The preparer submits their own work.
router.post("/runs/:month/submit", protectAccountant, runs.submitRun);
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
