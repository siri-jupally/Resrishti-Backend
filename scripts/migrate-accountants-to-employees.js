#!/usr/bin/env node
/*
  Turn the old accountant logins into assignments on employee records.

  The accountant used to be an account of its own, with its own email and
  password and its own login page. It is now a job tag on an employee
  (`canPreparePayroll`), reached with the employee's ordinary credentials.

  Without this script, deploying that change silently takes payroll away from
  whoever was doing it: their login stops working and nobody holds the tag.

  For each active accountant, it looks for a member of staff with the same
  email — an employee first, then a manager — and sets the tag on them. An
  accountant whose email matches nobody cannot be migrated: there is no record
  to assign. Those are reported so an admin can assign the right person by hand.

  Nothing is deleted. The accountants collection is left exactly as it is, so
  this can be re-run and so the old rows remain available if a name needs
  looking up. The login path is already gone from the code, so the rows cannot
  be used to sign in either way.

  Run once per environment after deploying:

      node scripts/migrate-accountants-to-employees.js
      node scripts/migrate-accountants-to-employees.js --dry
*/
require("dotenv").config();
const mongoose = require("mongoose");

const Accountant = require("../models/Accountant");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");

const DRY = process.argv.includes("--dry");

const run = async () => {
    const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!uri) {
        console.error("No MONGO_URI in the environment.");
        process.exit(1);
    }
    await mongoose.connect(uri);
    console.log(`Connected to ${mongoose.connection.name}${DRY ? " (dry run)" : ""}\n`);

    const accountants = await Accountant.find({}).select("name email isActive").lean();
    if (accountants.length === 0) {
        console.log("No accountant logins to migrate. Nothing to do.");
        await mongoose.disconnect();
        return;
    }

    const assigned = [];
    const skippedInactive = [];
    const unmatched = [];
    const alreadyTagged = [];

    for (const acc of accountants) {
        // Somebody whose access had already been removed should not get it
        // back as a side effect of the migration.
        if (acc.isActive === false) {
            skippedInactive.push(acc.email);
            continue;
        }

        // Employee first, because that is the common case; a manager is a
        // member of staff who manages people and is equally assignable.
        const person =
            (await Employee.findOne({ email: acc.email })) ||
            (await Manager.findOne({ email: acc.email }));
        if (!person) {
            unmatched.push(acc.email);
            continue;
        }
        const kind = person.constructor.modelName;
        if (person.canPreparePayroll) {
            alreadyTagged.push(`${acc.email} (${kind})`);
            continue;
        }

        if (!DRY) {
            person.canPreparePayroll = true;
            person.payrollAssignedAt = new Date();
            person.payrollAssignedByName = "migration from accountant logins";
            await person.save();
        }
        assigned.push(`${person.name || person.email} <${acc.email}> (${kind})`);
    }

    const list = (label, rows) => {
        if (rows.length === 0) return;
        console.log(`${label} (${rows.length}):`);
        rows.forEach((r) => console.log(`  - ${r}`));
        console.log("");
    };

    list(DRY ? "Would be assigned" : "Assigned as payroll accountants", assigned);
    list("Already assigned, left alone", alreadyTagged);
    list("Inactive, deliberately not assigned", skippedInactive);
    list("NO MATCHING EMPLOYEE — assign somebody by hand", unmatched);

    if (unmatched.length > 0) {
        console.log(
            "An accountant with no staff record cannot be migrated: there is\n" +
            "nothing to put the tag on. Either the person is on the staff list\n" +
            "under a different email, or they were only ever an accountant.\n" +
            "Assign the right person under Payroll → Setup → Accountants.\n"
        );
    }

    console.log(
        `${accountants.length} accountant login(s) examined, ` +
        `${assigned.length} ${DRY ? "would be " : ""}assigned.`
    );
    await mongoose.disconnect();
};

run().catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
});
