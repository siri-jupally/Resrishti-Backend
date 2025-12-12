const Testimonial = require('../models/Testimonial');

// @desc    Get all approved testimonials
// @route   GET /api/testimonials
// @access  Public
const getTestimonials = async (req, res) => {
    try {
        const testimonials = await Testimonial.find({ status: 'approved' }).sort({ createdAt: -1 });
        res.status(200).json(testimonials);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Submit a testimonial
// @route   POST /api/testimonials
// @access  Public
const submitTestimonial = async (req, res) => {
    try {
        const { name, position, company, industry, testimonial, rating } = req.body;
        const image = req.file ? req.file.path : '';

        if (!name || !position || !company || !testimonial || !rating) {
            return res.status(400).json({ message: 'Please add all required fields' });
        }

        const newTestimonial = await Testimonial.create({
            name,
            position,
            company,
            industry,
            testimonial,
            rating,
            image,
            status: 'pending' // Default is pending
        });

        res.status(201).json(newTestimonial);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getTestimonials,
    submitTestimonial
};
