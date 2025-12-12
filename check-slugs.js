const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Blog = require('./models/Blog');

dotenv.config();

const checkSlugs = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('MongoDB Connected');

        const blogs = await Blog.find({});
        console.log(`Found ${blogs.length} blogs.`);

        blogs.forEach(b => {
            console.log(`Title: ${b.title}`);
            console.log(`ID: ${b._id}`);
            console.log(`Slug: ${b.slug}`);
            console.log('---');
        });

        process.exit();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
};

checkSlugs();
