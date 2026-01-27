/*
  test-login.js

  Purpose:
  - Simple script to exercise the admin login endpoint locally.

  Usage:
  - Run while backend is running: `node test-login.js`
  - Assumes backend is reachable at http://localhost:5000 and an admin exists with
    the credentials set below (or change them as needed).

  Notes:
  - Intended for local development and quick verification of the /api/admin/login route.
*/
const axios = require("axios");

const testLogin = async () => {
  try {
    const res = await axios.post("http://localhost:5000/api/admin/login", {
      email: "admin@resristi.com",
      password: "admin123",
    });
    console.log("Login success:", JSON.stringify(res.data, null, 2));
  } catch (err) {
    if (err.response) {
      console.error(
        "Login failed:",
        JSON.stringify(err.response.data, null, 2)
      );
    } else {
      console.error("Login failed:", err.message);
    }
  }
};

testLogin();
