/*
  Disbursement — getting the money out, and recording what the bank did.

  There is no payment gateway here on purpose. The bank file goes to whoever
  operates the bank account, they upload it, and the outcome comes back as a
  reference per person. This controller is the record of that: which salaries
  went out, under what reference, and which bounced.

  Why the payment state lives on the line and not on the run:
    a failed transfer is a fact about one person. If it were a run status, one
    bounced account would make the whole month "failed", and the other
    twenty-three people who were paid would have nowhere to be recorded. So the
    run stays `approved` until every line is settled, and only then moves to
    `paid`. That is what keeps the status list at five.

  Who may do what:
    · exporting the bank file and recording payments — accountant or admin
      (the accountant is the designated user in §3's terms)
    · approving the run beforehand — admin only, enforced on the route
*/
const PayrollRun = require("../models/PayrollRun");
const PayrollLine = require("../models/PayrollLine");
const PayrollAudit = require("../models/PayrollAudit");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const { actorFromReq } = require("../utils/payrollActor");

const audit = async ({ action, run, line, month, req, detail, reason }) => {
    try {
        await PayrollAudit.create({
            action,
            run: run?._id,
            line: line?._id,
            month: month || run?.month,
            actor: actorFromReq(req),
            detail,
            reason,
        });
    } catch (err) {
        // An audit write must never be the thing that fails a payment record.
        console.error("payroll audit write failed:", err.message);
    }
};

const last4 = (acc) => (acc ? String(acc).slice(-4) : undefined);

/**
 * Bank details for every person on these lines, keyed by person id.
 * Read from the Employee/Manager record — the account is theirs, not payroll's.
 */
const bankByPerson = async (lines) => {
    const byType = { Employee: [], Manager: [] };
    for (const l of lines) if (byType[l.personType]) byType[l.personType].push(l.personId);
    const [employees, managers] = await Promise.all([
        byType.Employee.length
            ? Employee.find({ _id: { $in: byType.Employee } }).select("name bank bankUpdatedAt").lean()
            : [],
        byType.Manager.length
            ? Manager.find({ _id: { $in: byType.Manager } }).select("name bank bankUpdatedAt").lean()
            : [],
    ]);
    return new Map([...employees, ...managers].map((p) => [String(p._id), p]));
};

/** Recount the run's payment rollup from its lines. */
const rollUp = async (run) => {
    const lines = await PayrollLine.find({ run: run._id }).select("net payment").lean();
    const counts = { paidCount: 0, failedCount: 0, pendingCount: 0, paidAmount: 0 };
    for (const l of lines) {
        const st = l.payment?.status || "pending";
        if (st === "paid") {
            counts.paidCount += 1;
            counts.paidAmount += Number(l.payment?.amount ?? l.net) || 0;
        } else if (st === "failed") counts.failedCount += 1;
        else counts.pendingCount += 1;
    }
    counts.paidAmount = Math.round(counts.paidAmount * 100) / 100;
    run.payment = counts;
    return { counts, total: lines.length };
};

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

// ─────────────────────────── the bank file ───────────────────────────

// GET /api/payroll/runs/:month/bank-file.csv
//
// One row per payable person, in the shape a bank's bulk-transfer upload
// wants. Anyone without an account is left out of the file and listed in the
// response headers' count instead — a row with no account number would be
// rejected by the bank anyway, and silently dropping it would be worse.
const exportBankFile = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (!["approved", "paid", "closed"].includes(run.status)) {
            return res.status(409).json({
                message: "The bank file is available once the run is approved.",
                runStatus: run.status,
            });
        }

        const lines = await PayrollLine.find({ run: run._id }).sort({ personName: 1 }).lean();
        const banks = await bankByPerson(lines);

        const header = [
            "Employee Name", "Account Holder", "Account Number", "IFSC",
            "Bank", "Amount", "Reference", "Month",
        ];
        const rows = [header.map(csvCell).join(",")];
        let skipped = 0;

        for (const l of lines) {
            // Already settled lines stay out of a fresh file so nobody is paid
            // twice by uploading it again.
            if (l.payment?.status === "paid") continue;
            const bank = banks.get(String(l.personId))?.bank;
            if (!bank?.accountNumber) {
                skipped += 1;
                continue;
            }
            rows.push([
                l.personName,
                bank.accountHolderName || l.personName,
                bank.accountNumber,
                bank.ifsc || "",
                bank.bankName || "",
                Number(l.net || 0).toFixed(2),
                `SAL-${month}-${String(l.personName || "").split(" ")[0]}`.slice(0, 30),
                month,
            ].map(csvCell).join(","));
        }

        await audit({
            action: "payment.bankFileExported",
            run,
            month,
            req,
            detail: { rows: rows.length - 1, skippedNoBank: skipped },
        });

        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="salary-${month}.csv"`);
        res.setHeader("X-Rows", String(rows.length - 1));
        res.setHeader("X-Skipped-No-Bank", String(skipped));
        // BOM, so Excel opens it as UTF-8 rather than mangling names.
        return res.send("﻿" + rows.join("\r\n"));
    } catch (err) {
        console.error("exportBankFile error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// ───────────────────────── recording the outcome ─────────────────────────

/**
 * Apply one payment outcome to one line. Shared by the single and bulk paths
 * so they cannot drift.
 */
const applyOutcome = (line, { status, reference, failureReason, actor, bank }) => {
    line.payment = line.payment || {};
    line.payment.status = status;
    line.payment.attempts = line.payment.attempts || [];
    line.payment.attempts.push({
        status,
        reference: reference || undefined,
        failureReason: failureReason || undefined,
        at: new Date(),
        byName: actor?.name,
    });

    if (status === "paid") {
        line.payment.reference = reference || undefined;
        line.payment.amount = line.net;
        line.payment.paidAt = new Date();
        line.payment.paidBy = actor;
        line.payment.failureReason = undefined;
        if (bank) {
            line.payment.bankSnapshot = {
                accountNumberLast4: last4(bank.accountNumber),
                ifsc: bank.ifsc,
                bankName: bank.bankName,
            };
        }
    } else {
        line.payment.failureReason = failureReason || "Not stated";
        line.payment.paidAt = undefined;
        line.payment.reference = undefined;
    }
};

// POST /api/payroll/runs/:month/payments
//
// Records outcomes for one or more lines, and moves the run to `paid` once
// every line is settled.
//
// Body: { outcomes: [{ lineId, status: "paid"|"failed", reference?, failureReason? }] }
//    or { markAllPaid: true, reference? }  — the common case, where one bulk
//       transfer went through and every line shares its reference.
const recordPayments = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (!["approved", "paid"].includes(run.status)) {
            return res.status(409).json({
                message:
                    run.status === "closed"
                        ? "This month is closed. Reopen it if a payment genuinely needs correcting."
                        : "Payments can only be recorded once an admin has approved the run.",
                runStatus: run.status,
            });
        }

        const actor = actorFromReq(req);
        const lines = await PayrollLine.find({ run: run._id });
        const byId = new Map(lines.map((l) => [String(l._id), l]));
        const banks = await bankByPerson(lines.map((l) => ({ personType: l.personType, personId: l.personId })));

        let outcomes = Array.isArray(req.body?.outcomes) ? req.body.outcomes : null;

        if (!outcomes && (req.body?.markAllPaid === true || String(req.body?.markAllPaid) === "true")) {
            // Everyone not already paid, with the one shared reference. People
            // with no bank account are refused rather than marked paid — the
            // money cannot have reached an account that does not exist.
            const reference = String(req.body.reference || "").trim();
            const missing = lines.filter(
                (l) => l.payment?.status !== "paid" && !banks.get(String(l.personId))?.bank?.accountNumber
            );
            if (missing.length > 0) {
                return res.status(409).json({
                    message: `${missing.length} ${missing.length === 1 ? "person has" : "people have"} no bank account on file, so they cannot be marked paid.`,
                    people: missing.map((l) => ({ lineId: l._id, name: l.personName })),
                    code: "noBankDetails",
                });
            }
            outcomes = lines
                .filter((l) => l.payment?.status !== "paid")
                .map((l) => ({ lineId: String(l._id), status: "paid", reference }));
        }

        if (!outcomes || outcomes.length === 0) {
            return res.status(400).json({
                message: "Send outcomes: [{ lineId, status }] or markAllPaid: true",
            });
        }

        const applied = [];
        const problems = [];
        for (const o of outcomes) {
            const line = byId.get(String(o.lineId));
            if (!line) {
                problems.push({ lineId: o.lineId, message: "Not a line on this run" });
                continue;
            }
            if (!["paid", "failed"].includes(o.status)) {
                problems.push({ lineId: o.lineId, message: "status must be paid or failed" });
                continue;
            }
            const bank = banks.get(String(line.personId))?.bank;
            if (o.status === "paid" && !bank?.accountNumber) {
                problems.push({
                    lineId: o.lineId,
                    name: line.personName,
                    message: "No bank account on file",
                });
                continue;
            }
            applyOutcome(line, {
                status: o.status,
                reference: o.reference,
                failureReason: o.failureReason,
                actor,
                bank,
            });
            // eslint-disable-next-line no-await-in-loop
            await line.save();
            applied.push({ lineId: String(line._id), name: line.personName, status: o.status });
        }

        if (applied.length === 0) {
            return res.status(400).json({ message: "Nothing was recorded.", problems });
        }

        const { counts, total } = await rollUp(run);
        // The run becomes `paid` only when every line is settled — not when
        // most of them are. A part-paid month stays approved and visibly
        // unfinished.
        const settled = counts.paidCount === total && total > 0;
        if (settled && run.status !== "paid") {
            run.status = "paid";
            run.paidAt = new Date();
            run.paidBy = actor;
        }
        await run.save();

        await audit({
            action: "payment.recorded",
            run,
            month,
            req,
            detail: { applied: applied.length, paid: counts.paidCount, failed: counts.failedCount },
        });
        if (settled) {
            await audit({ action: "run.paid", run, month, req, detail: { paidAmount: counts.paidAmount } });
        }

        return res.json({
            ok: true,
            run,
            applied,
            problems,
            payment: counts,
            allSettled: settled,
        });
    } catch (err) {
        console.error("recordPayments error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/payroll/runs/:month/payments
//
// Payment state per person, for the disbursement screen. Carries the bank
// account masked to the last four digits — enough to recognise, not enough to
// leak if the screen is over somebody's shoulder.
const listPayments = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }
        const run = await PayrollRun.findOne({ month }).lean();
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });

        const lines = await PayrollLine.find({ run: run._id })
            .select("personName personType personId net payment")
            .sort({ personName: 1 })
            .lean();
        const banks = await bankByPerson(lines);

        const items = lines.map((l) => {
            const bank = banks.get(String(l.personId))?.bank;
            const bankChangedAt = banks.get(String(l.personId))?.bankUpdatedAt;
            return {
                lineId: l._id,
                name: l.personName,
                personType: l.personType,
                net: l.net,
                status: l.payment?.status || "pending",
                reference: l.payment?.reference,
                paidAt: l.payment?.paidAt,
                failureReason: l.payment?.failureReason,
                attempts: (l.payment?.attempts || []).length,
                hasBank: Boolean(bank?.accountNumber),
                accountMasked: bank?.accountNumber
                    ? `•••• ${last4(bank.accountNumber)}`
                    : null,
                bankName: bank?.bankName || null,
                // A run generated before the account changed may have been
                // checked against the old one.
                bankChangedAfterRun: Boolean(
                    bankChangedAt && run.calculatedAt && bankChangedAt > run.calculatedAt
                ),
            };
        });

        return res.json({
            month,
            runStatus: run.status,
            payment: run.payment || { paidCount: 0, failedCount: 0, pendingCount: items.length, paidAmount: 0 },
            items,
        });
    } catch (err) {
        console.error("listPayments error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    exportBankFile,
    recordPayments,
    listPayments,
    // Exported for tests.
    bankByPerson,
    rollUp,
    applyOutcome,
};
