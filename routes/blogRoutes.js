const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { getBlogs, getBlogById, createBlog, updateBlog, deleteBlog } = require('../controllers/blogController');
const { protect } = require('../middleware/authMiddleware');

// Configure Multer (Reuse existing configuration logic if possible, but defining here for simplicity)
// Configure Multer to use Memory Storage for S3 uploads
const storage = multer.memoryStorage();
const { uploadFile } = require('../utils/s3');

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

// Middleware to upload to S3 if a file is present
const uploadImageToS3 = async (req, res, next) => {
    if (!req.file) return next();

    try {
        const result = await uploadFile({
            folder: 'blogs',
            buffer: req.file.buffer,
            originalName: req.file.originalname,
            contentType: req.file.mimetype
        });

        // Construct public URL (Assuming standard AWS S3 public URL format)
        // Format: https://<bucket>.s3.<region>.amazonaws.com/<key>
        req.file.path = `https://${result.bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${result.key}`;
        next();
    } catch (error) {
        console.error("S3 Upload Error:", error);
        res.status(500).json({ message: 'Image upload failed' });
    }
};

router.route('/')
    .get(getBlogs)
    .post(protect, upload.single('image'), uploadImageToS3, createBlog);

router.route('/:id')
    .get(getBlogById)
    .put(protect, upload.single('image'), uploadImageToS3, updateBlog)
    .delete(protect, deleteBlog);

module.exports = router;
