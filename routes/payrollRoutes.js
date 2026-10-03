/*
  payrollRoutes.js — everything under /api/payroll.

  Three gates, matching the module's control model (middleware/authPayroll.js):
    protectPayroll   read access — accountant or admin
    protectPreparer  preparing and calculating — accountant, or admin when the
                     office runs single-approver
    protectApprover  admin only — approving, locking, and setting pay

  Setting what somebody is paid sits behind the approver gate deliberately: an
  accountant who could both set the rate and run the payroll would make
  maker-checker decorative.
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
const reports = require("../controllers/payrollReportController");

// ---- sign in (public) -----------------------------------------------------
router.post("/accountant/login", config.loginAccountant);

// ---- settings -------------------------------------------------------------
router.get("/settings", protectPayroll, config.readSettings);
router.put("/settings", protectApprover, config.updateSettings);

// ---- paid-day policies ----------------------------------------------------
router.get("/paid-day-policies", protectPayroll, config.listPolicies);
router.post("/paid-day-policies", protectApprover, config.createPolicy);
router.patch("/paid-day-policies/:id", protectApprover, config.updatePolicy);

// ---- accountant logins ----------------------------------------------------
router.get("/accountants", protectApprover, config.listAccountants);
router.post("/accountants", protectApprover, config.createAccountant);
router.patch("/accountants/:id", protectApprover, config.updateAccountant);

// ---- payroll profiles -----------------------------------------------------
// Literal paths before /:type/:id so they are not read as a person.
router.get("/profiles/summary", protectPayroll, profiles.summary);
router.get("/profiles", protectPayroll, profiles.listProfiles);
router.get("/profiles/:type/:id", protectPayroll, profiles.getProfile);
router.put("/profiles/:type/:id", protectApprover, profiles.upsertProfile);
router.post("/profiles/:type/:id/rates", protectApprover, profiles.addRate);
// Bank details are data entry rather than a pay decision, so the preparer may
// keep them up to date.
router.patch("/profiles/:type/:id/bank", protectPreparer, profiles.updateBank);

// ---- payroll runs ---------------------------------------------------------
// Calculating is the preparer's job; approving and locking are the approver's.
// A run only ever calculates on a closed attendance month.
router.get("/runs", protectPayroll, runs.listRuns);
router.get("/runs/:month", protectPayroll, runs.getRun);
router.get("/runs/:month/audit", protectPayroll, runs.getRunAudit);
router.post("/runs/:month/calculate", protectPreparer, runs.calculateRun);
router.post("/runs/:month/lines/:lineId/adjust", protectPreparer, runs.adjustLine);
router.post("/runs/:month/approve", protectApprover, runs.approveRun);
router.post("/runs/:month/lock", protectApprover, runs.lockRun);
router.post("/runs/:month/reopen", protectApprover, runs.reopenRun);

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
