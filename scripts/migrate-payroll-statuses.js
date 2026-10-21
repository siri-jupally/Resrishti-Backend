#!/usr/bin/env node
/*
  Map existing payroll runs onto the five-status model.

  The lifecycle used to be draft → review → approved → locked. It is now
  draft → pending-approval → approved → paid → closed, which renames two of
  them:

      review  →  pending-approval
      locked  →  closed

  `draft` and `approved` keep their meaning. Nothing becomes `paid`: that
  status means the money has been confirmed out, and for a run that predates
  payment tracking we have no evidence of that — a previously locked month is
  a finished month, which is `closed`.

  Run once per environment after deploying:

      node scripts/migrate-payroll-statuses.js

  Idempotent — a second run finds nothing to do. Reports what it changed and
  leaves everything else alone. Pass --dry to see the counts without writing.
*/
require("dotenv").config();
const mongoose = require("mongoose");

const RENAMES = [
    ["review", "pending-approval"],
    ["locked", "closed"],
];

(async () => {
    const dry = process.argv.includes("--dry");
    if (!process.env.MONGO_URI) {
        console.error("MONGO_URI is not set");
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);
    const runs = mongoose.connection.collection("payrollruns");

    // Read through the driver rather than the model: the model's enum no
    // longer contains the old values, so a Mongoose query would refuse them.
    console.log(`db: ${mongoose.connection.name}${dry ? "  (dry run)" : ""}`);

    let total = 0;
    for (const [from, to] of RENAMES) {
        const count = await runs.countDocuments({ status: from });
        total += count;
        if (count === 0) {
            console.log(`  ${from.padEnd(16)} → ${to.padEnd(16)} nothing to change`);
            continue;
        }
        if (dry) {
            console.log(`  ${from.padEnd(16)} → ${to.padEnd(16)} ${count} run(s) would change`);
            continue;
        }
        const res = await runs.updateMany({ status: from }, { $set: { status: to } });
        console.log(`  ${from.padEnd(16)} → ${to.padEnd(16)} ${res.modifiedCount} run(s) changed`);
    }

    // `lockedAt` / `lockedBy` were the end-of-cycle stamps; they are now
    // closedAt / closedBy. Copied rather than moved, so a rollback still has
    // the originals to read.
    if (!dry) {
        const withLockStamp = await runs.countDocuments({ lockedAt: { $exists: true } });
        if (withLockStamp > 0) {
            const res = await runs.updateMany(
                { lockedAt: { $exists: true }, closedAt: { $exists: false } },
                [{ $set: { closedAt: "$lockedAt", closedBy: "$lockedBy" } }]
            );
            console.log(`  lockedAt → closedAt      ${res.modifiedCount} run(s) stamped`);
        }
    }

    // Anything left on a value the enum does not know would fail to load.
    const unknown = await runs
        .aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])
        .toArray();
    const valid = new Set(["draft", "pending-approval", "approved", "paid", "closed"]);
    const strays = unknown.filter((u) => !valid.has(u._id));
    if (strays.length > 0) {
        console.warn("\n  ⚠ runs on an unrecognised status — these will not load:");
        strays.forEach((u) => console.warn(`      ${u._id}: ${u.n}`));
    } else {
        console.log("\n  every run is on one of the five statuses");
    }

    console.log(
        total === 0
            ? "\nNothing needed migrating."
            : `\n${dry ? "Would migrate" : "Migrated"} ${total} run(s).`
    );
    await mongoose.disconnect();
})().catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
});
