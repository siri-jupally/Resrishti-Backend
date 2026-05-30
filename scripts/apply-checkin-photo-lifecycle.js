#!/usr/bin/env node
/*
  Apply the S3 bucket lifecycle rule that auto-deletes check-in selfie photos
  after 7 days. Run once per environment after configuring AWS credentials and
  S3_BUCKET_NAME in the backend .env file.

  Usage:
    node scripts/apply-checkin-photo-lifecycle.js

  The rule is idempotent — re-running it overwrites only the
  `checkin-photos-7d-expiry` rule and preserves any other existing rules.
*/
require("dotenv").config();
const { applyCheckinPhotoLifecycle } = require("../utils/s3");

(async () => {
    try {
        const { bucket, ruleId } = await applyCheckinPhotoLifecycle();
        console.log(`✅ Applied lifecycle rule "${ruleId}" to s3://${bucket}/checkin-photos/ — objects auto-delete after 7 days.`);
    } catch (err) {
        console.error("❌ Failed to apply lifecycle rule:", err.message);
        console.error("\nFallback: apply manually via AWS Console:");
        console.error("  S3 > <your-bucket> > Management > Lifecycle rules > Create rule");
        console.error("    Prefix: checkin-photos/");
        console.error("    Expire current versions: 7 days\n");
        process.exit(1);
    }
})();
