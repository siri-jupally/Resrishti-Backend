/*
  payrollReportController.js — reconciling a run, and proving what happened.

  Two jobs the spec bundles together:

    reporting  the register, summaries by department / employment type / pay
               model, month-over-month movement, and an export finance can
               open in Excel
    audit      every payroll action with its actor, across all runs

  Everything reads from PayrollLine, which snapshots its inputs — so a register
  pulled a year later shows what was paid, not what today's rates would make it.

  Mounted under /api/payroll.
*/
const PayrollRun = require("../models/PayrollRun");
const PayrollLine = require("../models/PayrollLine");
const PayrollAudit = require("../models/PayrollAudit");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const emptyTotals = () => ({
    people: 0, gross: 0, overtimePay: 0, adjustments: 0, deductions: 0, net: 0,
});

const addTo = (totals, line) => {
    totals.people += 1;
    totals.gross = round2(totals.gross + (line.gross || 0));
    totals.overtimePay = round2(totals.overtimePay + (line.overtimePay || 0));
    totals.adjustments = round2(totals.adjustments + (line.adjustments || 0));
    totals.deductions = round2(totals.deductions + (line.deductions || 0));
    totals.net = round2(totals.net + (line.net || 0));
    return totals;
};

/** Group lines by a field, with "Unassigned" for the ones that have none. */
const groupBy = (lines, key, fallback = "Unassigned") => {
    const groups = new Map();
    for (const line of lines) {
        const name = line[key] || fallback;
        groups.set(name, addTo(groups.get(name) || emptyTotals(), line));
    }
    return [...groups.entries()]
        .map(([name, totals]) => ({ name, ...totals }))
        .sort((a, b) => b.net - a.net);
};

// GET /api/payroll/runs/:month/register
//
// The full per-person breakdown plus the summaries finance reconciles against.
const getRegister = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }

        const run = await PayrollRun.findOne({ month }).lean();
        if (!run) {
            return res.status(404).json({ message: "Nothing has been calculated for this month" });
        }

        const lines = await PayrollLine.find({ run: run._id }).sort({ personName: 1 }).lean();

        return res.json({
            month,
            run: {
                status: run.status,
                calculatedAt: run.calculatedAt,
                approvedAt: run.approvedAt,
                lockedAt: run.lockedAt,
                approvedBy: run.approvedBy,
                exceptions: run.exceptions || [],
            },
            totals: lines.reduce((acc, l) => addTo(acc, l), emptyTotals()),
            byDepartment: groupBy(lines, "department", "No department"),
            byEmploymentType: groupBy(lines, "employmentType", "Not set"),
            byPayModel: groupBy(lines, "payModel"),
            lines,
        });
    } catch (err) {
        console.error("getRegister error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/payroll/runs/:month/register.csv
//
// Written by hand rather than with a library: the shape is fixed, and a CSV
// dependency is a lot of surface for six lines of string building. Fields are
// quoted and embedded quotes doubled, so a name with a comma cannot shift every
// column after it.
const escapeCsv = (value) => {
    const text = value === null || value === undefined ? "" : String(value);
    return `"${text.replace(/"/g, '""')}"`;
};

const exportRegisterCsv = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const run = await PayrollRun.findOne({ month }).lean();
        if (!run) {
            return res.status(404).json({ message: "Nothing has been calculated for this month" });
        }
        const lines = await PayrollLine.find({ run: run._id }).sort({ personName: 1 }).lean();

        const headers = [
            "Name", "Email", "Type", "Employment", "Department", "Job role",
            "Pay model", "Rate", "Per day", "Days on payroll", "Days paid",
            "Days not paid", "Worked", "Paid leave", "Unpaid leave", "Absent",
            "Overtime days", "Base pay", "Overtime pay", "Adjustments",
            "Deductions", "Net", "Payslip no.", "Flags",
        ];

        const rows = lines.map((l) => [
            l.personName, l.personEmail, l.personType, l.employmentType,
            l.department, l.jobRole, l.payModel, l.rateAmount, l.perDayRate,
            l.daysOnPayroll, l.payableDays, l.lopDays,
            l.days?.worked, l.days?.leavePaid, l.days?.leaveUnpaid, l.days?.absent,
            l.overtimeDays, l.basePay, l.overtimePay, l.adjustments,
            l.deductions, l.net, l.payslip?.number,
            (l.exceptions || []).map((e) => e.code).join(" "),
        ]);

        const totals = lines.reduce((acc, l) => addTo(acc, l), emptyTotals());
        const totalRow = new Array(headers.length).fill("");
        totalRow[0] = `TOTAL (${totals.people} people)`;
        totalRow[17] = totals.gross - totals.overtimePay;
        totalRow[18] = totals.overtimePay;
        totalRow[19] = totals.adjustments;
        totalRow[20] = totals.deductions;
        totalRow[21] = totals.net;

        const csv = [headers, ...rows, totalRow]
            .map((row) => row.map(escapeCsv).join(","))
            .join("\r\n");

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="payroll-register-${month}.csv"`
        );
        // A BOM, so Excel opens it as UTF-8 rather than mangling names.
        return res.send(`﻿${csv}`);
    } catch (err) {
        console.error("exportRegisterCsv error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/payroll/reports/trend?months=12
//
// Month by month, so a jump in the payroll is visible as a shape rather than
// found by comparing two screens.
const getTrend = async (req, res) => {
    try {
        const count = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 36);
        const runs = await PayrollRun.find({ status: { $in: ["approved", "locked"] } })
            .sort({ month: -1 })
            .limit(count)
            .lean();

        const months = runs.map((r) => r.month).sort();
        const lines = await PayrollLine.find({ month: { $in: months } })
            .select("month net gross overtimePay payModel department")
            .lean();

        const byMonth = new Map(months.map((m) => [m, { month: m, ...emptyTotals(), daily: 0, monthly: 0 }]));
        for (const line of lines) {
            const entry = byMonth.get(line.month);
            if (!entry) continue;
            addTo(entry, line);
            if (line.payModel === "daily") entry.daily = round2(entry.daily + line.net);
            else entry.monthly = round2(entry.monthly + line.net);
        }

        const series = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

        // Movement against the month before, which is the number anybody
        // actually asks about.
        const withChange = series.map((entry, i) => {
            const previous = i > 0 ? series[i - 1].net : null;
            return {
                ...entry,
                previousNet: previous,
                changePercent:
                    previous && previous > 0
                        ? round2(((entry.net - previous) / previous) * 100)
                        : null,
            };
        });

        return res.json({ months: withChange, total: withChange.length });
    } catch (err) {
        console.error("getTrend error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/payroll/audit?month=&action=&limit=
//
// The whole log, not just one run's. This is the primary control given a small
// team, so it is readable on its own rather than only in the context of a run.
const getAuditLog = async (req, res) => {
    try {
        const filter = {};
        if (req.query.month && MONTH_RE.test(req.query.month)) filter.month = req.query.month;
        if (req.query.action) filter.action = req.query.action;

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 1000);
        const entries = await PayrollAudit.find(filter)
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean();

        // The distinct actions present, so the filter offers only what exists.
        const actions = await PayrollAudit.distinct("action");

        return res.json({ items: entries, total: entries.length, actions: actions.sort() });
    } catch (err) {
        console.error("getAuditLog error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = { getRegister, exportRegisterCsv, getTrend, getAuditLog };
