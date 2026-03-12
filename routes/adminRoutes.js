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

module.exports = router;
