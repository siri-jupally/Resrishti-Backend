/*
  scripts/probe-route.js

  Purpose:
  - Probe the new message endpoint without auth.

  Expected:
  - 401 (Not authorized) => route exists
  - 404 (Not Found)      => route not registered / wrong URL / wrong server
*/

const axios = require("axios");

const baseUrl = process.env.BASE_URL || "http://localhost:5000";
const taskId = process.env.TASK_ID || "6953e6c4213814b090f638cb";

(async () => {
  try {
    await axios.post(`${baseUrl}/api/employee/tasks/${taskId}/messages`, {
      text: "ping",
    });
    console.log("Unexpected success without auth");
  } catch (e) {
    console.log("STATUS", e.response?.status);
    console.log("DATA", e.response?.data);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
