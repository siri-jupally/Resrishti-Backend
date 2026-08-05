/*
  Manager routes

  Endpoints mounted at: /api/manager

  Routes:
  - POST /login               -> loginManager
  - POST /employees           -> createEmployee (protected)
  - GET  /employees           -> listEmployees (protected)
  - POST /tasks               -> createTask (protected)
  - GET  /tasks               -> listTasks (protected)
  - Attendance & Leave management routes (protected)

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
  deleteTask,
} = require("../controllers/managerController");
const { getTaskPolicy } = require("../controllers/taskPolicyController");
const {
  getTeamAttendance,
  getTeamSummary,
  getEmployeeCalendar,
  approveAttendance,
  setEmployeeWorkMode,
  getCorrectionRequests,
  reviewCorrection,
  getLeaveRequests,
  reviewLeave,
} = require("../controllers/attendanceManagerController");
const selfAttendance = require("../controllers/managerSelfAttendanceController");
const { subscribe } = require("../controllers/notificationController");
const {
  managerChangePassword,
  getManagerProfile,
  updateManagerProfile,
  getEmployeeProfileByManager,
  updateEmployeeProfileByManager,
  upload: profileUpload,
} = require("../controllers/profileController");
const { managerBatchLocations, getEmployeeTrail } = require("../controllers/locationController");
const { protectManager } = require("../middleware/authManager");
const { getIo } = require("../socketHandler");


router.post("/login", loginManager);
router.post("/employees", protectManager, createEmployee);
router.get("/employees", protectManager, listEmployees);
router.delete("/employees/:id", protectManager, deleteEmployee);
router.patch("/employees/:id", protectManager, updateEmployee);
router.post("/tasks", protectManager, createTask);
router.get("/tasks", protectManager, listTasks);
router.delete("/tasks/:id", protectManager, deleteTask);
router.get("/task-policy", protectManager, getTaskPolicy);

// Threaded messages
router.post("/tasks/:id/messages", protectManager, postMessageToTaskAsManager);
router.post(
  "/tasks/:id/messages/upload",
  protectManager,
  uploadAttachmentAndPostMessageAsManager
);

// Attendance routes
router.get("/attendance/team", protectManager, getTeamAttendance);
router.get("/attendance/team/summary", protectManager, getTeamSummary);
router.get("/attendance/employee/:employeeId/calendar", protectManager, getEmployeeCalendar);
router.patch("/attendance/:id/approve", protectManager, approveAttendance);
router.patch("/employees/:id/workmode", protectManager, setEmployeeWorkMode);
router.get("/attendance/corrections", protectManager, getCorrectionRequests);
router.patch("/attendance/corrections/:id", protectManager, reviewCorrection);

// Leave routes
router.get("/leaves", protectManager, getLeaveRequests);
router.patch("/leaves/:id", protectManager, reviewLeave);

// Manager self-attendance routes
router.post("/self-attendance/checkin", protectManager, selfAttendance.checkInUpload, selfAttendance.checkIn);
router.post("/self-attendance/checkout", protectManager, selfAttendance.checkOut);
router.get("/self-attendance/today", protectManager, selfAttendance.getToday);
router.get("/self-attendance/calendar", protectManager, selfAttendance.getCalendar);
router.post("/self-attendance/correction", protectManager, selfAttendance.submitCorrection);
router.get("/self-attendance/corrections", protectManager, selfAttendance.getCorrections);
router.get("/self-attendance/leaves", protectManager, selfAttendance.getLeaves);
router.post("/self-attendance/leaves", protectManager, selfAttendance.applyLeave);
router.get("/self-attendance/policy", protectManager, selfAttendance.getPolicy);

// Profile routes
router.post("/profile/change-password", protectManager, managerChangePassword);
router.get("/profile", protectManager, getManagerProfile);
router.put("/profile", protectManager, profileUpload.fields([
  { name: "profilePhoto", maxCount: 1 },
  { name: "idProofDocument", maxCount: 1 },
]), updateManagerProfile);
router.get("/employees/:id/profile", protectManager, getEmployeeProfileByManager);
router.patch("/employees/:id/profile", protectManager, updateEmployeeProfileByManager);

// Location tracking
router.post("/location/batch", protectManager, managerBatchLocations);
router.get("/location/trail/:employeeId/:date", protectManager, getEmployeeTrail);

router.post("/subscribe", protectManager, subscribe);

module.exports = router;
