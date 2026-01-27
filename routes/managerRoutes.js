/*
  Manager routes

  Endpoints mounted at: /api/manager

  Routes:
  - POST /login               -> loginManager
  - POST /employees           -> createEmployee (protected)
  - GET  /employees           -> listEmployees (protected)
  - POST /tasks               -> createTask (protected)
  - GET  /tasks               -> listTasks (protected)

  Notes:
  - Protected routes require a valid manager JWT (use protectManager middleware).
*/
const express = require("express");
const router = express.Router();
const {
  loginManager,
  createEmployee,
  listEmployees,
  createTask,
  listTasks,
  postMessageToTaskAsManager,
  uploadAttachmentAndPostMessageAsManager,
  deleteEmployee,
  updateEmployee,
} = require("../controllers/managerController");
const { protectManager } = require("../middleware/authManager");

router.post("/login", loginManager);
router.post("/employees", protectManager, createEmployee);
router.get("/employees", protectManager, listEmployees);
router.delete("/employees/:id", protectManager, deleteEmployee);
router.patch("/employees/:id", protectManager, updateEmployee);
router.post("/tasks", protectManager, createTask);
router.get("/tasks", protectManager, listTasks);

// Threaded messages
router.post("/tasks/:id/messages", protectManager, postMessageToTaskAsManager);
router.post(
  "/tasks/:id/messages/upload",
  protectManager,
  uploadAttachmentAndPostMessageAsManager
);

module.exports = router;
