const express = require('express');
const router = express.Router();
const {
    loginAdmin,
    getAllTestimonials,
    updateTestimonialStatus,
    deleteTestimonial,
    seedAdmin
} = require('../controllers/adminController');
const {
    getPolicy,
    updatePolicy,
    addHoliday,
    removeHoliday,
    getReports,
} = require('../controllers/attendanceAdminController');
const {
    createManager,
    listManagers,
    updateManager,
    deleteManager,
    listAllEmployees,
    reassignEmployee,
    getAllLeaveRequests,
    adminReviewLeave,
    getOrgOverview,
} = require('../controllers/adminOrgController');
const {
    getManagersAttendance,
    getManagersSummary,
    approveAttendance: approveManagerAttendance,
    getCorrectionRequests: getManagerCorrections,
    reviewCorrection: reviewManagerCorrection,
    getLeaveRequests: getManagerLeaveRequests,
    reviewLeave: reviewManagerLeave,
} = require('../controllers/adminManagerAttendanceController');
const {
    getEmployeeProfileByAdmin,
    updateEmployeeProfileByAdmin,
    getManagerProfileByAdmin,
    updateManagerProfileByAdmin,
} = require('../controllers/profileController');
const { getEmployeeTrailByAdmin, getManagerTrailByAdmin } = require('../controllers/locationController');
const { getTaskPolicy, updateTaskPolicy } = require('../controllers/taskPolicyController');
const { protect } = require('../middleware/authMiddleware');

router.post('/login', loginAdmin);
router.post('/seed', seedAdmin); // Remove or protect in production

router.route('/testimonials')
    .get(protect, getAllTestimonials);

router.route('/testimonials/:id')
    .patch(protect, updateTestimonialStatus)
    .delete(protect, deleteTestimonial);

// Attendance policy & reports routes
router.get('/attendance/policy', protect, getPolicy);
router.put('/attendance/policy', protect, updatePolicy);
router.post('/attendance/policy/holidays', protect, addHoliday);
router.delete('/attendance/policy/holidays/:id', protect, removeHoliday);
router.get('/attendance/reports', protect, getReports);

// Manager CRUD
router.route('/managers')
    .get(protect, listManagers)
    .post(protect, createManager);
router.route('/managers/:id')
    .put(protect, updateManager)
    .delete(protect, deleteManager);

// Employee oversight
router.get('/employees', protect, listAllEmployees);
router.patch('/employees/:id/reassign', protect, reassignEmployee);

// Leave oversight & override
router.get('/leaves', protect, getAllLeaveRequests);
router.patch('/leaves/:id', protect, adminReviewLeave);

// Org overview
router.get('/org/overview', protect, getOrgOverview);

// Manager attendance oversight
router.get('/manager-attendance/team', protect, getManagersAttendance);
router.get('/manager-attendance/team/summary', protect, getManagersSummary);
router.patch('/manager-attendance/:id/approve', protect, approveManagerAttendance);
router.get('/manager-attendance/corrections', protect, getManagerCorrections);
router.patch('/manager-attendance/corrections/:id', protect, reviewManagerCorrection);
router.get('/manager-attendance/leaves', protect, getManagerLeaveRequests);
router.patch('/manager-attendance/leaves/:id', protect, reviewManagerLeave);

// Profile management
router.get('/employees/:id/profile', protect, getEmployeeProfileByAdmin);
router.patch('/employees/:id/profile', protect, updateEmployeeProfileByAdmin);
router.get('/managers/:id/profile', protect, getManagerProfileByAdmin);
router.patch('/managers/:id/profile', protect, updateManagerProfileByAdmin);

// Task policy
router.get('/task-policy', protect, getTaskPolicy);
router.put('/task-policy', protect, updateTaskPolicy);

// Location trail viewing
router.get('/location/trail/employee/:employeeId/:date', protect, getEmployeeTrailByAdmin);
router.get('/location/trail/manager/:managerId/:date', protect, getManagerTrailByAdmin);

module.exports = router;
