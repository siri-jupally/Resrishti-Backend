/*
  Employee routes

  Endpoints mounted at: /api/employee

  Routes:
  - POST /login               -> loginEmployee
  - GET  /tasks               -> listTasksForEmployee (protected)
  - PATCH /tasks/:id          -> updateTaskByEmployee (protected)
  - Attendance & Leave routes (protected)

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
const {
  checkIn,
  checkInUpload,
  checkOut,
  getToday,
  getCalendar,
  submitCorrection,
  getCorrections,
  getLeaves,
  applyLeave,
  getPolicy,
} = require("../controllers/attendanceController");
const { subscribe } = require("../controllers/notificationController");
const {
  employeeChangePassword,
  getEmployeeProfile,
  updateEmployeeProfile,
  upload: profileUpload,
} = require("../controllers/profileController");
const { employeeBatchLocations } = require("../controllers/locationController");
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

// Attendance routes
router.post("/attendance/checkin", protectEmployee, checkInUpload, checkIn);
router.post("/attendance/checkout", protectEmployee, checkOut);
router.get("/attendance/today", protectEmployee, getToday);
router.get("/attendance/calendar", protectEmployee, getCalendar);
router.post("/attendance/correction", protectEmployee, submitCorrection);
router.get("/attendance/corrections", protectEmployee, getCorrections);
router.get("/attendance/policy", protectEmployee, getPolicy);

// Leave routes
router.get("/leaves", protectEmployee, getLeaves);
router.post("/leaves", protectEmployee, applyLeave);

// Profile routes
router.post("/profile/change-password", protectEmployee, employeeChangePassword);
router.get("/profile", protectEmployee, getEmployeeProfile);
router.put("/profile", protectEmployee, profileUpload.fields([
  { name: "profilePhoto", maxCount: 1 },
  { name: "idProofDocument", maxCount: 1 },
]), updateEmployeeProfile);

// Location tracking
router.post("/location/batch", protectEmployee, employeeBatchLocations);

router.post("/subscribe", protectEmployee, subscribe);

module.exports = router;

