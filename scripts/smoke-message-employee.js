/*
  scripts/smoke-message-employee.js

  Purpose:
  - Quick end-to-end smoke test for the new employee message endpoints.

  What it does:
  1) Logs in as an employee
  2) Finds one task assigned to that employee
  3) Posts a text message to /api/employee/tasks/:id/messages

  Usage:
  - Start backend server (PORT=5000)
  - Ensure you have an employee account + at least one task assigned
  - Set env vars:
      EMPLOYEE_EMAIL
      EMPLOYEE_PASSWORD
  - Run: node scripts/smoke-message-employee.js
*/

const axios = require("axios");

const baseUrl = process.env.BASE_URL || "http://localhost:5000";

const main = async () => {
  const email = process.env.EMPLOYEE_EMAIL;
  const password = process.env.EMPLOYEE_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Missing EMPLOYEE_EMAIL or EMPLOYEE_PASSWORD env var. Set them and rerun."
    );
  }

  const login = await axios.post(`${baseUrl}/api/employee/login`, {
    email,
    password,
  });

  const token = login.data.token;
  if (!token) throw new Error("Login did not return a token");

  const tasksRes = await axios.get(`${baseUrl}/api/employee/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const tasks = tasksRes.data;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error("Employee has no assigned tasks to test against.");
  }

  const task = tasks[0];
  const taskId = task._id;

  const messageRes = await axios.post(
    `${baseUrl}/api/employee/tasks/${taskId}/messages`,
    { text: `Smoke test message @ ${new Date().toISOString()}` },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const updated = messageRes.data;
  console.log("OK: posted message");
  console.log("Task:", updated._id);
  console.log(
    "messages length:",
    updated.messages ? updated.messages.length : 0
  );
};

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err.response?.data || err.message);
  process.exit(1);
});
