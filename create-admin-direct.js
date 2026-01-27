/*
  create-admin-direct.js

  Purpose:
  - Utility script to create a test Admin user directly in the database.

  Usage:
  - Run from backend folder with Node: `node create-admin-direct.js`
  - Requires MONGO_URI in .env to connect.

  Notes:
  - Convenience script for local development. Do not run blindly in production.
*/
const mongoose = require("mongoose");
const Admin = require("./models/Admin");
require("dotenv").config();

const create = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const email = "admin@resristi.com";
    const password = "admin123";
    const exists = await Admin.findOne({ email });
    if (exists) {
      console.log("Admin already exists:", exists);
      process.exit(0);
    }
    const admin = new Admin({ email, password });
    await admin.save();
    console.log("Admin created:", { _id: admin._id, email: admin.email });
    process.exit(0);
  } catch (err) {
    console.error("Error creating admin:", err);
    process.exit(1);
  }
};

create();
