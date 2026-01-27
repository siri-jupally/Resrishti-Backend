/*
	Employee routes

	Endpoints mounted at: /api/employee

	Routes:
	- POST /login               -> loginEmployee
	- GET  /tasks               -> listTasksForEmployee (protected)
	- PATCH /tasks/:id          -> updateTaskByEmployee (protected)

	Notes:
	- Protected routes require a valid employee JWT (use protectEmployee middleware).
*/
const express = require("express");
const router = express.Router();
const {
  loginEmployee,
  listTasksForEmployee,
  updateTaskByEmployee,
  postMessageToTaskAsEmployee,
  uploadAttachmentAndPostMessageAsEmployee,
} = require("../controllers/employeeController");
const { protectEmployee } = require("../middleware/authEmployee");

router.post("/login", loginEmployee);
router.get("/tasks", protectEmployee, listTasksForEmployee);
router.patch("/tasks/:id", protectEmployee, updateTaskByEmployee);

// Threaded messages
router.post(
  "/tasks/:id/messages",
  protectEmployee,
  postMessageToTaskAsEmployee
);
router.post(
  "/tasks/:id/messages/upload",
  protectEmployee,
  uploadAttachmentAndPostMessageAsEmployee
);

module.exports = router;
