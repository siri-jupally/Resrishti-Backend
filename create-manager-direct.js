/*
  create-manager-direct.js

  Purpose:
  - Utility script to create a test Manager directly in the database.

  Usage:
  - Run from backend folder with NODE: `node create-manager-direct.js`
  - Requires MONGO_URI in .env to connect.

  Notes:
  - This is a convenience script for local development and seeding. Do not
    run in production without reviewing fields/passwords.
*/
const mongoose = require("mongoose");
const Manager = require("./models/Manager");
require("dotenv").config();

const create = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const email = "manager@example.com";
    const password = "manager123";
    const name = "Manager One";
    const exists = await Manager.findOne({ email });
    if (exists) {
      console.log("Manager already exists:", exists);
      process.exit(0);
    }
    const manager = new Manager({ name, email, password });
    await manager.save();
    console.log("Manager created:", { _id: manager._id, email: manager.email });
    process.exit(0);
  } catch (err) {
    console.error("Error creating manager:", err);
    process.exit(1);
  }
};

create();
