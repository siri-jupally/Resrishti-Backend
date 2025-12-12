const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { getBlogs, getBlogById, createBlog, updateBlog, deleteBlog } = require('../controllers/blogController');
const { protect } = require('../middleware/authMiddleware');

// Configure Multer (Reuse existing configuration logic if possible, but defining here for simplicity)
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/');
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|webp/;
        const mimetype = filetypes.test(file.mimetype);
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        if (mimetype && extname) {
            return cb(null, true);
        }
        cb(new Error('Only images are allowed'));
    }
});

router.route('/')
    .get(getBlogs)
    .post(protect, upload.single('image'), createBlog);

router.route('/:id')
    .get(getBlogById)
    .put(protect, upload.single('image'), updateBlog)
    .delete(protect, deleteBlog);

module.exports = router;
