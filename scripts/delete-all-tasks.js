/**
 * scripts/delete-all-tasks.js
 *
 * Deletes ALL documents from the Task collection.
 *
 * Safety:
 * - Requires `--yes` flag OR an interactive confirmation prompt.
 * - Uses `MONGO_URI` from `.env`.
 *
 * Usage:
 *   node scripts/delete-all-tasks.js --yes
 */

require("dotenv").config();

const mongoose = require("mongoose");
const readline = require("readline");

const Task = require("../models/Task");

function askYesNo(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(
        String(answer || "")
          .trim()
          .toLowerCase()
      );
    });
  });
}

async function main() {
  const mongoUri = process.env.MONGO_URI;
  if (!mongoUri) {
    console.error("Missing MONGO_URI in environment (.env). Aborting.");
    process.exit(1);
  }

  const forceYes = process.argv.includes("--yes");
  if (!forceYes) {
    const answer = await askYesNo(
      'This will permanently delete ALL tasks. Type "delete" to continue: '
    );
    if (answer !== "delete") {
      console.log("Aborted. No tasks were deleted.");
      process.exit(0);
    }
  }

  await mongoose.connect(mongoUri);

  const before = await Task.countDocuments();
  const res = await Task.deleteMany({});
  const after = await Task.countDocuments();

  console.log(
    JSON.stringify(
      {
        ok: true,
        deletedCount: res.deletedCount ?? null,
        before,
        after,
      },
      null,
      2
    )
  );

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Delete tasks failed:", err);
  process.exit(1);
});
