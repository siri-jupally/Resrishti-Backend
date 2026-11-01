/*
  Migration 0001 — backfill Pickup.pipelineVersion (Pickup pipeline revamp, Phase 0).

  Sets pipelineVersion = 1 on every existing pickup that doesn't have it, so all
  historical/in-flight rows are explicitly tagged as the legacy flow. The new
  7-stage flow will create pickups with pipelineVersion = 2.

  Safety:
  - IDEMPOTENT: only touches docs missing the field; re-running is a no-op.
  - NON-DESTRUCTIVE: never overwrites an existing pipelineVersion, never touches
    any other field.
  - Requires MONGO_URI to be passed explicitly (no dotenv / .env fallback) so it
    can never accidentally run against the wrong database. Point it at the test
    DB (prod copy) first; only run against prod as an explicit, reviewed step.

  Usage:
    MONGO_URI='<uri>' node scripts/migrations/0001-add-pipeline-version.js
*/
const mongoose = require("mongoose");
const Pickup = require("../../models/Pickup");

(async () => {
    const uri = process.env.MONGO_URI;
    if (!uri) {
        console.error("ABORT: MONGO_URI env var is required (pass it explicitly).");
        process.exit(1);
    }
    const host = uri.replace(/(mongodb(\+srv)?:\/\/)[^@]*@/, "$1***@");
    console.log(`[0001] connecting to ${host}`);
    await mongoose.connect(uri);

    const total = await Pickup.countDocuments();
    const missingBefore = await Pickup.countDocuments({ pipelineVersion: { $exists: false } });

    const res = await Pickup.updateMany(
        { pipelineVersion: { $exists: false } },
        { $set: { pipelineVersion: 1 } }
    );

    const v1 = await Pickup.countDocuments({ pipelineVersion: 1 });
    const v2 = await Pickup.countDocuments({ pipelineVersion: 2 });
    const stillMissing = await Pickup.countDocuments({ pipelineVersion: { $exists: false } });

    console.log(`[0001] total=${total} missingBefore=${missingBefore} modified=${res.modifiedCount}`);
    console.log(`[0001] now: pipelineVersion v1=${v1} v2=${v2} stillMissing=${stillMissing}`);
    if (stillMissing !== 0) {
        console.error("[0001] WARNING: some pickups still missing pipelineVersion");
    } else {
        console.log("[0001] OK — every pickup is tagged.");
    }
    await mongoose.disconnect();
})().catch((e) => {
    console.error("[0001] FAILED:", e);
    process.exit(1);
});
