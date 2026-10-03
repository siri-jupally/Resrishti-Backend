/*
  PayrollSettings — the organisation-wide payroll rules, as settings rather
  than as constants in the engine.

  A singleton, like AttendancePolicy. Only what the shipped features actually
  need lives here; the rest of the configuration hub arrives with the features
  that require it.

  Defaults are the answers given when the module was scoped:
    · pay period is the calendar month, so it lines up exactly with the
      attendance month lock
    · an unpaid day costs monthly salary ÷ 30, whatever the month's length
    · overtime means a day worked on a weekly-off, paid at a multiple of the
      day's rate, for daily-wage staff
*/
const mongoose = require("mongoose");

const payrollSettingsSchema = new mongoose.Schema(
    {
        key: { type: String, default: "global", unique: true, index: true },

        // ---- pay period ---------------------------------------------------
        // "calendar" is the 1st to the last day of the month. A cut-off cycle
        // would make a pay period straddle two locked months, so it is a
        // setting rather than an assumption, but it is not offered yet.
        payPeriod: {
            type: String,
            enum: ["calendar"],
            default: "calendar",
        },

        // ---- monthly path -------------------------------------------------
        // An unpaid day deducts monthlySalary / N.
        //   fixed30       — always 30. The same deduction every month.
        //   calendarDays  — 28, 30 or 31, so February costs more per day.
        //   workingDays   — excludes weekly-offs and holidays; costs the most.
        perDayRateBasis: {
            type: String,
            enum: ["fixed30", "calendarDays", "workingDays"],
            default: "fixed30",
        },

        // What a half-day is worth, as a fraction of a day. 0.5 pays half.
        halfDayWeight: { type: Number, default: 0.5, min: 0, max: 1 },

        // Whether arriving late costs anything. Off by default: docking pay for
        // lateness is a policy decision, and the attendance module already
        // flags late arrivals for a manager to deal with.
        lateMarkCostsPay: { type: Boolean, default: false },
        lateMarksPerLopDay: { type: Number, default: 3, min: 1 },

        // ---- overtime -----------------------------------------------------
        // Overtime here is a whole day worked on a weekly-off, which the
        // attendance record already flags. Hours beyond a normal day are not
        // overtime under this arrangement.
        //
        // These are the default terms. WHO earns overtime is not decided here:
        // it is a per-person flag on the payroll profile, because two people on
        // the same pay model may have been given different arrangements and a
        // rule about the kind of work would hide that.
        overtime: {
            enabled: { type: Boolean, default: true },
            // Which non-working days earn it.
            countWeeklyOff: { type: Boolean, default: true },
            countHoliday: { type: Boolean, default: false },
            // "multiplier" pays the day's rate × value; "flat" pays value.
            mode: { type: String, enum: ["multiplier", "flat"], default: "multiplier" },
            value: { type: Number, default: 2, min: 0 },
            _id: false,
        },

        // ---- run lifecycle (used from Phase 2) ----------------------------
        // Single approver, or the preparer and the approver must differ.
        approvalDepth: {
            type: String,
            enum: ["single", "makerChecker"],
            default: "makerChecker",
        },
        // Net moving more than this much against last month is flagged before
        // approval. It does not block anything; it asks for a second look.
        variancePercentThreshold: { type: Number, default: 20, min: 0 },
        // The most a single manual adjustment may be, and what it may be for.
        maxAdjustmentAmount: { type: Number, default: 10000, min: 0 },
        adjustmentCategories: {
            type: [String],
            default: ["bonus", "incentive", "advance-recovery", "fine", "correction", "other"],
        },

        // ---- payslip ------------------------------------------------------
        payslipNote: { type: String, trim: true, maxlength: 500 },
        showBankOnPayslip: { type: Boolean, default: false },

        updatedByName: String,
    },
    { timestamps: true }
);

module.exports = mongoose.model("PayrollSettings", payrollSettingsSchema);
