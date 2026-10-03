/*
  payslipController.js — producing payslips and getting them to people.

  A payslip is a rendered PDF of one payroll line, so there is no separate
  payslip collection: the line already holds every snapshotted figure, and
  adding a parallel record would create two places for the same truth to live.
  The PDF's location and release state sit on the line itself.

  Two rules:

  1. Payslips are only produced from a LOCKED run. Releasing a payslip for a
     run still under review would put a figure in somebody's hands that may
     still change, and a payslip is the one thing people keep.

  2. Downloads stream through this server rather than handing out a presigned
     S3 link. A payslip is the most personal document the platform produces;
     a URL that works for anybody holding it, and that exposes the bucket, is
     the wrong shape for it.

  Admin/accountant:  POST /api/payroll/runs/:month/payslips/release
  Employee/manager:  GET  /api/{employee|manager}/payslips
                     GET  /api/{employee|manager}/payslips/:lineId/download
*/
const mongoose = require("mongoose");
const { GetObjectCommand } = require("@aws-sdk/client-s3");

const PayrollRun = require("../models/PayrollRun");
const PayrollLine = require("../models/PayrollLine");
const PayrollAudit = require("../models/PayrollAudit");
const Counter = require("../models/Counter");

const { uploadFile, getS3Client } = require("../utils/s3");
const { renderPayslipPdf } = require("../utils/payslipPdf");
const { getSettings } = require("../utils/payrollDefaults");
const { notifyIfEnabled } = require("../utils/push");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const actorFromReq = (req) => {
    if (req.admin) return { userType: "Admin", userId: req.admin._id, name: req.admin.name || req.admin.email };
    if (req.accountant) {
        return { userType: "Accountant", userId: req.accountant._id, name: req.accountant.name || req.accountant.email };
    }
    return { userType: "System", name: "system" };
};

/** PS-YYYY-MM-#### — sequential within the month, so a run reads in order. */
const nextPayslipNumber = async (month) => {
    const seq = await Counter.nextValue(`payslip-${month}`);
    return `PS-${month}-${String(seq).padStart(4, "0")}`;
};

// POST /api/payroll/runs/:month/payslips/release
//
// Renders a payslip for every line that does not have one, stores it, and tells
// each person it is there. Re-running is safe: a line that already has a
// payslip is left alone, so a failure part-way through is fixed by pressing it
// again rather than by producing everybody's twice.
const releasePayslips = async (req, res) => {
    try {
        const { month } = req.params;
        if (!MONTH_RE.test(month)) {
            return res.status(400).json({ message: "month must be YYYY-MM" });
        }

        const run = await PayrollRun.findOne({ month });
        if (!run) return res.status(404).json({ message: "Nothing has been calculated for this month" });
        if (run.status !== "locked") {
            return res.status(409).json({
                message:
                    "Payslips are only released from a locked run. A figure somebody can still change is not something to put in people's hands.",
            });
        }

        const settings = await getSettings();
        const lines = await PayrollLine.find({ run: run._id });

        const produced = [];
        const failed = [];

        for (const line of lines) {
            if (line.payslip?.key) continue;   // already has one

            try {
                const payslipNumber = line.payslip?.number || (await nextPayslipNumber(month));
                const buffer = await renderPayslipPdf(line.toObject(), {
                    payslipNumber,
                    note: settings.payslipNote,
                });

                const stored = await uploadFile({
                    folder: `payslips/${month}`,
                    originalName: `${payslipNumber}.pdf`,
                    buffer,
                    contentType: "application/pdf",
                });

                line.payslip = {
                    number: payslipNumber,
                    key: stored.key,
                    bucket: stored.bucket,
                    generatedAt: new Date(),
                    releasedAt: new Date(),
                };
                await line.save();
                produced.push({ person: line.personName, number: payslipNumber });

                // Tell them it is there. A push failure must not stop the rest
                // of the run being released.
                try {
                    const model = line.personType === "Manager" ? Manager : Employee;
                    const person = await model.findById(line.personId).select("pushSubscription").lean();
                    if (person?.pushSubscription) {
                        await notifyIfEnabled("attendance", person.pushSubscription, {
                            title: "Your payslip is ready",
                            body: `Your payslip for ${month} is available to download.`,
                            icon: "/android-chrome-512x512.png",
                            data: { url: `/${line.personType.toLowerCase()}/dashboard?tab=payslips` },
                        });
                    }
                } catch (pushErr) {
                    console.error("payslip push failed:", pushErr.message);
                }
            } catch (err) {
                console.error(`payslip render failed for ${line.personName}:`, err.message);
                failed.push({ person: line.personName, reason: err.message });
            }
        }

        await PayrollAudit.create({
            action: "payslips.released",
            run: run._id,
            month,
            actor: actorFromReq(req),
            detail: { produced: produced.length, failed: failed.length },
        });

        return res.json({
            month,
            produced: produced.length,
            alreadyHad: lines.length - produced.length - failed.length,
            failed,
        });
    } catch (err) {
        console.error("releasePayslips error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/payroll/runs/:month/payslips — who has one, for the run screen.
const listRunPayslips = async (req, res) => {
    try {
        const { month } = req.params;
        const lines = await PayrollLine.find({ month })
            .select("personName personType net payslip")
            .sort({ personName: 1 })
            .lean();
        return res.json({
            month,
            items: lines.map((l) => ({
                lineId: l._id,
                personName: l.personName,
                personType: l.personType,
                net: l.net,
                payslipNumber: l.payslip?.number || null,
                releasedAt: l.payslip?.releasedAt || null,
            })),
            released: lines.filter((l) => l.payslip?.key).length,
            total: lines.length,
        });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
};

// ---------------------------------------------------------------- self-serve

/** Whoever is asking, and which kind of person they are. */
const selfFromReq = (req) => {
    if (req.employee) return { personType: "Employee", personId: req.employee._id };
    if (req.manager) return { personType: "Manager", personId: req.manager._id };
    return null;
};

// GET /api/{employee|manager}/payslips
//
// Only released payslips, and only their own. A line that exists but has not
// been released is not theirs to see yet.
const listMyPayslips = async (req, res) => {
    try {
        const self = selfFromReq(req);
        if (!self) return res.status(401).json({ message: "Not authorized" });

        const lines = await PayrollLine.find({
            personType: self.personType,
            personId: self.personId,
            "payslip.releasedAt": { $ne: null },
        })
            .sort({ month: -1 })
            .lean();

        return res.json({
            items: lines.map((line) => ({
                lineId: line._id,
                month: line.month,
                payslipNumber: line.payslip.number,
                releasedAt: line.payslip.releasedAt,
                payModel: line.payModel,
                payableDays: line.payableDays,
                lopDays: line.lopDays,
                overtimeDays: line.overtimeDays,
                gross: line.gross,
                deductions: line.deductions,
                adjustments: line.adjustments,
                net: line.net,
            })),
            total: lines.length,
        });
    } catch (err) {
        console.error("listMyPayslips error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// GET /api/{employee|manager}/payslips/:lineId/download
//
// Streamed through this server on purpose — see the header. The response is the
// PDF itself, so the browser downloads it without a bucket ever being named.
const downloadMyPayslip = async (req, res) => {
    try {
        const self = selfFromReq(req);
        if (!self) return res.status(401).json({ message: "Not authorized" });
        if (!mongoose.Types.ObjectId.isValid(req.params.lineId)) {
            return res.status(400).json({ message: "Invalid payslip id" });
        }

        // Ownership is part of the query, so somebody else's id simply is not
        // found rather than being refused — which would confirm it exists.
        const line = await PayrollLine.findOne({
            _id: req.params.lineId,
            personType: self.personType,
            personId: self.personId,
        }).lean();

        if (!line || !line.payslip?.key || !line.payslip?.releasedAt) {
            return res.status(404).json({ message: "Payslip not found" });
        }

        const s3 = getS3Client();
        const object = await s3.send(
            new GetObjectCommand({ Bucket: line.payslip.bucket, Key: line.payslip.key })
        );

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="${line.payslip.number}.pdf"`
        );
        // Node streams the body straight through; nothing is buffered here.
        object.Body.pipe(res);
    } catch (err) {
        console.error("downloadMyPayslip error:", err.message);
        return res.status(500).json({ message: "Could not fetch the payslip" });
    }
};

module.exports = {
    releasePayslips,
    listRunPayslips,
    listMyPayslips,
    downloadMyPayslip,
    nextPayslipNumber,
};
