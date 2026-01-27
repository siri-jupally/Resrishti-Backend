const mongoose = require("mongoose");
const Admin = require("./models/Admin");
require("dotenv").config();

const list = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    const admins = await Admin.find({}).lean();
    console.log("Admins:", admins);
    process.exit(0);
  } catch (err) {
    console.error("Error listing admins:", err.message);
    process.exit(1);
  }
};

list();
