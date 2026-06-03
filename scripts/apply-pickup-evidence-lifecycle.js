#!/usr/bin/env node
/*
  Apply the S3 bucket lifecycle rule that auto-deletes pickup-evidence photos
  after 30 days. Run once per environment after configuring AWS credentials and
  S3_BUCKET_NAME in the backend .env file.

  Usage:
    node scripts/apply-pickup-evidence-lifecycle.js

  The rule is idempotent — re-running it overwrites only the
  `pickup-evidence-30d-expiry` rule and preserves any other existing rules
  (e.g., the 7-day check-in-photo rule).
*/
require("dotenv").config();
const { applyPickupEvidenceLifecycle } = require("../utils/s3");

(async () => {
    try {
        const { bucket, ruleId } = await applyPickupEvidenceLifecycle();
        console.log(`✅ Applied lifecycle rule "${ruleId}" to s3://${bucket}/pickup-evidence/ — objects auto-delete after 30 days.`);
    } catch (err) {
        console.error("❌ Failed to apply lifecycle rule:", err.message);
        console.error("\nFallback: apply manually via AWS Console:");
        console.error("  S3 > <your-bucket> > Management > Lifecycle rules > Create rule");
        console.error("    Prefix: pickup-evidence/");
        console.error("    Expire current versions: 30 days\n");
        process.exit(1);
    }
})();
