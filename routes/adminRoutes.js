const express = require('express');
const router = express.Router();
const {
    loginAdmin,
    getAllTestimonials,
    updateTestimonialStatus,
    deleteTestimonial,
    seedAdmin
} = require('../controllers/adminController');
const { protect } = require('../middleware/authMiddleware');

router.post('/login', loginAdmin);
router.post('/seed', seedAdmin); // Remove or protect in production

router.route('/testimonials')
    .get(protect, getAllTestimonials);

router.route('/testimonials/:id')
    .patch(protect, updateTestimonialStatus)
    .delete(protect, deleteTestimonial);

module.exports = router;
