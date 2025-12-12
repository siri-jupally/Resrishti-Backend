const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Blog = require('./models/Blog');

dotenv.config();

const slugify = (text) => {
    return text.toString().toLowerCase()
        .replace(/\s+/g, '-')           // Replace spaces with -
        .replace(/[^\w\-]+/g, '')       // Remove all non-word chars
        .replace(/\-\-+/g, '-')         // Replace multiple - with single -
        .replace(/^-+/, '')             // Trim - from start
        .replace(/-+$/, '');            // Trim - from end
};

const migrateSlugs = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');

        const blogs = await Blog.find({});
        console.log(`Found ${blogs.length} blogs to migrate.`);

        for (const blog of blogs) {
            if (!blog.slug) {
                let slug = slugify(blog.title);

                // Ensure uniqueness
                let slugExists = await Blog.findOne({ slug, _id: { $ne: blog._id } });
                let counter = 1;
                while (slugExists) {
                    slug = `${slugify(blog.title)}-${counter}`;
                    slugExists = await Blog.findOne({ slug, _id: { $ne: blog._id } });
                    counter++;
                }

                blog.slug = slug;
                await blog.save();
                console.log(`Updated blog: ${blog.title} -> ${blog.slug}`);
            } else {
                console.log(`Skipping blog (already has slug): ${blog.title}`);
            }
        }

        console.log('Migration completed.');
        process.exit();
    } catch (error) {
        console.error('Migration Error:', error);
        process.exit(1);
    }
};

migrateSlugs();
