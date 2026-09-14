/*
  add-admin.js

  Purpose:
  - Give a new email address admin access, alongside any existing admins.
    Existing admin accounts are not touched.

  Usage (from the backend folder):
    node add-admin.js <email>              # dry run
    node add-admin.js <email> --confirm    # create, with a generated password

  Notes:
  - Writes to whatever database MONGO_URI in .env points at. The dry run prints
    the database name and host first — check it before adding --confirm.
  - The password is generated, not typed, so it never lands in your shell
    history. It is printed ONCE when the account is created; copy it then.
    Once staff forgot-password is deployed, the new admin can replace it via
    "Forgot your password?" on the admin sign-in page.
  - Supersedes create-admin-direct.js for real use; that script hardcodes a
    test address and a weak password.
*/
const crypto = require("crypto");
const mongoose = require("mongoose");
const Admin = require("./models/Admin");
require("dotenv").config();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 16 characters from an unambiguous alphabet (no 0/O, 1/l/I), guaranteed to
 * contain a letter and a digit so it satisfies the reset-password rule too.
 */
const generatePassword = () => {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = letters + digits;
  const pick = (set) => set[crypto.randomInt(set.length)];
  const chars = [pick(letters), pick(digits)];
  while (chars.length < 16) chars.push(pick(all));
  // Fisher–Yates so the guaranteed letter/digit are not always at the front.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
};

const run = async () => {
  const [, , rawEmail, flag] = process.argv;
  const confirm = flag === "--confirm";

  if (!rawEmail) {
    console.log("Usage: node add-admin.js <email> [--confirm]");
    process.exit(1);
  }

  // The Admin schema lowercases and trims on save; match that for the check.
  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    console.error(`"${rawEmail}" is not a valid email address.`);
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGO_URI);
    const db = mongoose.connection;
    console.log(`\nDatabase: "${db.name}"   Host: ${db.host}`);
    console.log(confirm ? ">>> LIVE RUN <<<\n" : ">>> DRY RUN — nothing will change (add --confirm) <<<\n");

    const existing = await Admin.find({}).select("email").lean();
    console.log("Current admins:", existing.map((a) => a.email).join(", ") || "(none)");

    if (existing.some((a) => a.email === email)) {
      console.error(`\n"${email}" is already an admin — nothing to do.`);
      process.exit(1);
    }

    console.log(`\nWill add admin: ${email}`);

    if (!confirm) {
      console.log("Dry run only. Re-run with --confirm to create it.");
      process.exit(0);
    }

    const password = generatePassword();
    const admin = new Admin({ email, password }); // pre-save hook hashes it
    await admin.save();

    console.log("\nAdmin created.");
    console.log("  Email:    ", email);
    console.log("  Password: ", password);
    console.log("\nCopy the password now — it is not stored anywhere readable and will not be shown again.");
    process.exit(0);
  } catch (err) {
    console.error("Error adding admin:", err.message);
    process.exit(1);
  }
};

run();
