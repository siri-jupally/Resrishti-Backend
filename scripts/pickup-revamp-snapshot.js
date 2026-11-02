/*
  Pickup-revamp data snapshot (read-only).

  Prints a JSON snapshot of the aggregates the revamp must not silently break.
  Run it against the test DB (prod copy) to capture a baseline, then re-run after
  each phase and diff. Reports must stay identical; dashboard/public impact is the
  only number expected to change (P3), and by a known amount.

  Usage:
    MONGO_URI='<uri>' node scripts/pickup-revamp-snapshot.js > docs/pickup-revamp/baseline.json
*/
const mongoose = require("mongoose");
const Pickup = require("../models/Pickup");
const Certificate = require("../models/Certificate");
const Report = require("../models/Report");
const { CLOSED_EQUIVALENT_STATUSES } = Pickup;

const byField = async (Model, field) => {
    const rows = await Model.aggregate([{ $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
    return rows.reduce((o, r) => { o[r._id ?? "null"] = r.n; return o; }, {});
};
const sumKg = async (match) => {
    const r = await Pickup.aggregate([
        { $match: match },
        { $group: { _id: null, kg: { $sum: "$totalKg" }, n: { $sum: 1 } } },
    ]);
    return r[0] ? { count: r[0].n, totalKg: Math.round(r[0].kg * 100) / 100 } : { count: 0, totalKg: 0 };
};

(async () => {
    const uri = process.env.MONGO_URI;
    if (!uri) { console.error("ABORT: MONGO_URI required"); process.exit(1); }
    await mongoose.connect(uri);

    const snapshot = {
        capturedAt: new Date().toISOString(),
        db: uri.replace(/(mongodb(\+srv)?:\/\/)[^@]*@/, "$1***@"),
        pickups: {
            total: await Pickup.countDocuments(),
            byStatus: await byField(Pickup, "status"),
            byPipelineVersion: await byField(Pickup, "pipelineVersion"),
        },
        // What reports / impact SHOULD count (closed-equivalent).
        closedEquivalent: await sumKg({ status: { $in: CLOSED_EQUIVALENT_STATUSES } }),
        // What the client dashboard + public stats count TODAY (cert-gated).
        certGatedToday: await sumKg({ status: { $in: ["cert-issued", "cert-sent"] } }),
        certificates: {
            total: await Certificate.countDocuments(),
            byStatus: await byField(Certificate, "status"),
        },
        reports: {
            total: await Report.countDocuments(),
            byType: await byField(Report, "type"),
            byStatus: await byField(Report, "status"),
        },
    };
    snapshot.p3ExpectedImpactJump = {
        note: "After P3, dashboard/public impact moves from certGatedToday -> closedEquivalent.",
        fromCount: snapshot.certGatedToday.count,
        toCount: snapshot.closedEquivalent.count,
        fromKg: snapshot.certGatedToday.totalKg,
        toKg: snapshot.closedEquivalent.totalKg,
    };

    console.log(JSON.stringify(snapshot, null, 2));
    await mongoose.disconnect();
})().catch((e) => { console.error("snapshot FAILED:", e); process.exit(1); });
