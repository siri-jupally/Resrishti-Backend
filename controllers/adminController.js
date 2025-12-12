const Admin = require('../models/Admin');
const Testimonial = require('../models/Testimonial');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Generate JWT
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: '30d',
    });
};

// @desc    Authenticate admin
// @route   POST /api/admin/login
// @access  Public
const loginAdmin = async (req, res) => {
    const { email, password } = req.body;

    try {
        // Check for admin email
        const admin = await Admin.findOne({ email });

        if (admin && (await admin.comparePassword(password))) {
            res.json({
                _id: admin.id,
                email: admin.email,
                token: generateToken(admin._id),
            });
        } else {
            res.status(400).json({ message: 'Invalid credentials' });
        }
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get all testimonials (pending, approved, rejected)
// @route   GET /api/admin/testimonials
// @access  Private
const getAllTestimonials = async (req, res) => {
    try {
        const testimonials = await Testimonial.find().sort({ createdAt: -1 });
        res.status(200).json(testimonials);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update testimonial status
// @route   PATCH /api/admin/testimonials/:id
// @access  Private
const updateTestimonialStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const testimonial = await Testimonial.findById(req.params.id);

        if (!testimonial) {
            return res.status(404).json({ message: 'Testimonial not found' });
        }

        if (!['pending', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        testimonial.status = status;
        await testimonial.save();

        res.status(200).json(testimonial);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Delete testimonial
// @route   DELETE /api/admin/testimonials/:id
// @access  Private
const deleteTestimonial = async (req, res) => {
    try {
        const testimonial = await Testimonial.findById(req.params.id);

        if (!testimonial) {
            return res.status(404).json({ message: 'Testimonial not found' });
        }

        await testimonial.deleteOne();

        res.status(200).json({ id: req.params.id });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Create initial admin (Seeding)
// @route   POST /api/admin/seed
// @access  Public (Should be protected or removed in production)
const seedAdmin = async (req, res) => {
    try {
        const { email, password } = req.body;
        const adminExists = await Admin.findOne({ email });
        if (adminExists) {
            return res.status(400).json({ message: 'Admin already exists' });
        }
        const admin = await Admin.create({ email, password });
        res.status(201).json({
            _id: admin.id,
            email: admin.email,
            token: generateToken(admin._id)
        });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
}

module.exports = {
    loginAdmin,
    getAllTestimonials,
    updateTestimonialStatus,
    deleteTestimonial,
    seedAdmin
};
