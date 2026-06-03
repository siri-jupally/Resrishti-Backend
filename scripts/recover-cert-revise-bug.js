#!/usr/bin/env node
/*
  One-shot recovery script for the cert revise bug.

  Run once after pulling the model + controller fix:

      node scripts/recover-cert-revise-bug.js

  What it does:
  1. Drops the old field-level unique index on `certNumber` (the new model
     uses a compound unique on (certNumber, revision) — both can't coexist).
  2. Re-creates the compound index so future revises succeed.
  3. Recovers any certificate that got stranded in `superseded` status by the
     buggy revise flow — i.e. a cert whose status is 'superseded' but which is
     NOT referenced as a `supersedes` target by any other cert. Those are the
     ones that were flipped to superseded but the new draft never got created.
     Flip them back to 'sent' so the user can retry revise.

  Idempotent: safe to run multiple times.
*/
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
    if (!process.env.MONGO_URI) {
        console.error("MONGO_URI not set — set it in .env");
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGO_URI);
    const Certificate = require("../models/Certificate");
    const coll = Certificate.collection;

    // 1. Drop the old single-field unique index if it still exists.
    const existing = await coll.indexes();
    const old = existing.find((i) => i.name === "certNumber_1");
    if (old) {
        console.log("Dropping old unique index: certNumber_1");
        await coll.dropIndex("certNumber_1");
    } else {
        console.log("Old certNumber_1 index already absent.");
    }

    // 2. Ensure the compound index exists (Mongoose will create on next save,
    //    but we trigger it explicitly here so the recovery step below is safe).
    await Certificate.syncIndexes();
    console.log("Indexes synced.");

    // 3. Recover stranded 'superseded' certs.
    const stranded = await Certificate.find({ status: "superseded" });
    let recovered = 0;
    for (const cert of stranded) {
        const child = await Certificate.findOne({ supersedes: cert._id });
        if (!child) {
            console.log(`Recovering ${cert.certNumber} (rev ${cert.revision}) → sent`);
            cert.status = "sent";
            await cert.save();
            recovered += 1;
        }
    }
    console.log(`Recovered ${recovered} cert(s).`);

    await mongoose.disconnect();
    console.log("Done.");
})().catch((err) => {
    console.error("Recovery failed:", err);
    process.exit(1);
});
