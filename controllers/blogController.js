const Blog = require('../models/Blog');
const mongoose = require('mongoose');

// Helper to slugify text
const slugify = (text) => {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start
        .replace(/-+$/, '');            // Trim - from end
};

// @desc    Get all blogs
// @route   GET /api/blogs
// @access  Public
const getBlogs = async (req, res) => {
    try {
        const blogs = await Blog.find().sort({ createdAt: -1 });
        res.status(200).json(blogs);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Get single blog by ID or Slug
// @route   GET /api/blogs/:idOrSlug
// @access  Public
const getBlogById = async (req, res) => {
    try {
        const { id } = req.params;
        let blog;

        // Check if it's a valid ObjectId
        if (mongoose.Types.ObjectId.isValid(id)) {
            blog = await Blog.findById(id);
        }

        // If not found by ID or not a valid ID, try finding by slug
        if (!blog) {
            blog = await Blog.findOne({ slug: id });
        }

        if (!blog) {
            return res.status(404).json({ message: 'Blog not found' });
        }
        res.status(200).json(blog);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Create a blog
// @route   POST /api/blogs
// @access  Private (Admin)
const createBlog = async (req, res) => {
    try {
        const { title, excerpt, content, author, category, tags } = req.body;
        const image = req.file ? req.file.path : '';

        if (!title || !excerpt || !content || !author || !category) {
            return res.status(400).json({ message: 'Please add all required fields' });
        }

        // Generate Slug
        let slug = slugify(title);
        // Ensure uniqueness
        let slugExists = await Blog.findOne({ slug });
        let counter = 1;
        while (slugExists) {
            slug = `${slugify(title)}-${counter}`;
            slugExists = await Blog.findOne({ slug });
            counter++;
        }

        // Parse tags if sent as string (from FormData)
        let parsedTags = tags;
        if (typeof tags === 'string') {
            parsedTags = tags.split(',').map(tag => tag.trim());
        }

        const blog = await Blog.create({
            title,
            slug,
            excerpt,
            content,
            author,
            category,
            image,
            tags: parsedTags
        });

        res.status(201).json(blog);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Update a blog
// @route   PUT /api/blogs/:id
// @access  Private (Admin)
const updateBlog = async (req, res) => {
    try {
        const { title, excerpt, content, author, category, tags } = req.body;

        let updateData = {
            title,
            excerpt,
            content,
            author,
            category
        };

        if (req.file) {
            updateData.image = req.file.path;
        }

        if (tags) {
            // Parse tags if sent as string
            if (typeof tags === 'string') {
                updateData.tags = tags.split(',').map(tag => tag.trim());
            } else {
                updateData.tags = tags;
            }
        }

        // Optionally update slug if title changes, but often better to keep stable URLs.
        // For now, we won't auto-update slug to avoid breaking existing links.

        const blog = await Blog.findByIdAndUpdate(req.params.id, updateData, { new: true });

        if (!blog) {
            return res.status(404).json({ message: 'Blog not found' });
        }

        res.status(200).json(blog);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

// @desc    Delete a blog
// @route   DELETE /api/blogs/:id
// @access  Private (Admin)
const deleteBlog = async (req, res) => {
    try {
        const blog = await Blog.findByIdAndDelete(req.params.id);

        if (!blog) {
            return res.status(404).json({ message: 'Blog not found' });
        }

        res.status(200).json({ message: 'Blog deleted' });
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};

module.exports = {
    getBlogs,
    getBlogById,
    createBlog,
    updateBlog,
    deleteBlog
};
