#!/usr/bin/env node
/*
  Backfill staff codes (empNo) for existing Employees and Managers.

  New staff get an empNo automatically on creation (managerController /
  adminOrgController). Everyone who existed BEFORE that change has none, so this
  script assigns them one, in a stable order: earliest joiner gets RES-0001.

  Both collections draw from the ONE shared sequence — the generic Counter
  model under key "staffNo" (utils/staffCode.js) — because the number is also
  the biometric device User ID and must not collide across Employees and
  Managers.

  SAFETY:
  - Dry run by DEFAULT. It only writes when you pass --write.
  - It prints the database host + name it is connected to before doing anything,
    so you can confirm you are not pointed at production.
  - Idempotent: staff who already have an empNo are skipped. It also reconciles
    the Counter so it is never behind the highest code in use, so re-running
    can never hand out a duplicate.

  Usage:
      # preview against whatever MONGO_URI is set (no changes):
      MONGO_URI="<uri>" node scripts/backfillEmpNo.js

      # actually assign:
      MONGO_URI="<uri>" node scripts/backfillEmpNo.js --write

      # pin the founder (or anyone) to RES-0001, rest follow by joining date:
      MONGO_URI="<uri>" node scripts/backfillEmpNo.js --founder=nagaraj@resrishti.com --write

  Test accounts (isTestAccount: true) are skipped entirely — no code, no
  biometric enrolment.
*/
require("dotenv").config();
const mongoose = require("mongoose");

const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Counter = require("../models/Counter");
const { formatEmpCode, STAFF_SEQ_KEY } = require("../utils/staffCode");

const WRITE = process.argv.includes("--write");
const FOUNDER = (process.argv.find((a) => a.startsWith("--founder=")) || "")
    .split("=")[1]
    ?.toLowerCase() || null;

// Best-effort "when did this person join" for ordering. joiningDate is a
// YYYY-MM-DD string; fall back to createdAt, then to the ObjectId timestamp.
function joinKey(doc) {
    if (doc.joiningDate) {
        const t = Date.parse(doc.joiningDate);
        if (!Number.isNaN(t)) return t;
    }
    if (doc.createdAt) return new Date(doc.createdAt).getTime();
    return doc._id.getTimestamp().getTime();
}

const run = async () => {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
        console.error("No MONGO_URI in the environment. Aborting.");
        process.exit(1);
    }
    await mongoose.connect(uri);
    const conn = mongoose.connection;
    console.log("────────────────────────────────────────────────────────");
    console.log(` Connected to DB host: ${conn.host}`);
    console.log(` Database name:        ${conn.name}`);
    console.log(` Mode:                 ${WRITE ? "WRITE (will modify records)" : "DRY RUN (no changes)"}`);
    console.log("────────────────────────────────────────────────────────\n");

    // Staff who don't already have a code — and are NOT test accounts.
    const needsCode = {
        $and: [
            { $or: [{ empNo: { $exists: false } }, { empNo: null }] },
            { isTestAccount: { $ne: true } },
        ],
    };
    const [employees, managers] = await Promise.all([
        Employee.find(needsCode).select("name email joiningDate createdAt").lean(),
        Manager.find(needsCode).select("name email joiningDate createdAt").lean(),
    ]);
    const skippedTest =
        (await Employee.countDocuments({ isTestAccount: true })) +
        (await Manager.countDocuments({ isTestAccount: true }));

    // Highest code already in use (so we never reassign one), and the current
    // sequence position. Start from whichever is higher.
    const [maxEmp, maxMgr, counter] = await Promise.all([
        Employee.findOne({ empNo: { $ne: null } }).sort({ empNo: -1 }).select("empNo").lean(),
        Manager.findOne({ empNo: { $ne: null } }).sort({ empNo: -1 }).select("empNo").lean(),
        Counter.findOne({ key: STAFF_SEQ_KEY }).lean(),
    ]);
    const maxExisting = Math.max(maxEmp?.empNo || 0, maxMgr?.empNo || 0);
    const counterValue = counter ? counter.value : 0;
    let seq = Math.max(counterValue, maxExisting);

    const pending = [
        ...employees.map((d) => ({ kind: "employee", doc: d })),
        ...managers.map((d) => ({ kind: "manager", doc: d })),
    ].sort((a, b) => {
        // Founder (if named) sorts first so they get the lowest number (RES-0001
        // on a clean run); everyone else is ordered by joining date.
        if (FOUNDER) {
            const af = a.doc.email?.toLowerCase() === FOUNDER ? 0 : 1;
            const bf = b.doc.email?.toLowerCase() === FOUNDER ? 0 : 1;
            if (af !== bf) return af - bf;
        }
        return joinKey(a.doc) - joinKey(b.doc);
    });

    console.log(`Highest code in use:  ${maxExisting ? formatEmpCode(maxExisting) : "(none)"}`);
    console.log(`Counter at:           ${counterValue ? formatEmpCode(counterValue) : "(unset)"}`);
    console.log(`Test accounts skipped: ${skippedTest}`);
    if (FOUNDER) console.log(`Founder pinned first:  ${FOUNDER}`);
    console.log(`Need a code:          ${employees.length} employees, ${managers.length} managers\n`);

    if (pending.length === 0) {
        // Nothing to assign, but make sure the counter isn't behind the data.
        if (WRITE && counterValue < maxExisting) {
            await Counter.updateOne(
                { key: STAFF_SEQ_KEY },
                { $set: { value: maxExisting } },
                { upsert: true }
            );
            console.log(`No codes to assign. Reconciled counter to ${formatEmpCode(maxExisting)}.`);
        } else if (counterValue < maxExisting) {
            console.log(`No codes to assign. DRY RUN — would reconcile counter to ${formatEmpCode(maxExisting)}.`);
        } else {
            console.log("Nothing to assign, counter already correct. Done.");
        }
        await mongoose.disconnect();
        return;
    }

    const startFrom = seq + 1;
    const assignments = [];
    for (const { kind, doc } of pending) {
        seq += 1;
        assignments.push({ kind, id: doc._id, empNo: seq, who: doc.name || doc.email });
    }

    // Preview (first few).
    for (const a of assignments.slice(0, 8)) {
        console.log(`  ${formatEmpCode(a.empNo).padEnd(10)} → [${a.kind}] ${a.who}`);
    }
    if (assignments.length > 8) {
        console.log(`  … and ${assignments.length - 8} more, up to ${formatEmpCode(seq)}`);
    }
    console.log("");

    if (!WRITE) {
        console.log(`DRY RUN — would assign ${assignments.length} codes (${formatEmpCode(startFrom)} … ${formatEmpCode(seq)}).`);
        console.log("Re-run with --write to apply.");
        await mongoose.disconnect();
        return;
    }

    // Advance the shared counter first so concurrent/new creates never reuse a
    // number we're about to hand out, then set each record.
    await Counter.updateOne({ key: STAFF_SEQ_KEY }, { $set: { value: seq } }, { upsert: true });

    let okEmp = 0;
    let okMgr = 0;
    for (const a of assignments) {
        const Model = a.kind === "employee" ? Employee : Manager;
        await Model.updateOne({ _id: a.id }, { $set: { empNo: a.empNo } });
        if (a.kind === "employee") okEmp += 1;
        else okMgr += 1;
    }

    console.log(`✔ Assigned ${okEmp} employee codes and ${okMgr} manager codes.`);
    console.log(`  Sequence now at ${formatEmpCode(seq)}. New staff continue from ${formatEmpCode(seq + 1)}.`);
    await mongoose.disconnect();
};

run().catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
});
