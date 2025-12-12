const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');

dotenv.config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Database Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.error('MongoDB Connection Error:', err));

// Routes
app.use('/api/testimonials', require('./routes/testimonialRoutes'));
app.use('/api/admin', require('./routes/adminRoutes'));
app.use('/api/blogs', require('./routes/blogRoutes'));

app.get("/", (req, res) => {
  res.status(200).send("Backend is running ✔");
});

// Dynamic OG Tags for Social Media Bots
const Blog = require('./models/Blog');
app.get('/blogs/:idOrSlug', async (req, res, next) => {
  const userAgent = req.headers['user-agent'] || '';
  const isBot = /facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegrambot|googlebot|bingbot|discordbot/i.test(userAgent);

  if (isBot) {
    try {
      const { idOrSlug } = req.params;
      let blog;

      if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
        blog = await Blog.findById(idOrSlug);
      }

      if (!blog) {
        blog = await Blog.findOne({ slug: idOrSlug });
      }

      if (!blog) return res.status(404).send('Blog not found');

      const imageUrl = blog.image ? `${process.env.SERVER_URL}/${blog.image.replace(/\\/g, '/')}` : `${process.env.SERVER_URL}/default-og.jpg`;
      const description = blog.excerpt || blog.content.substring(0, 150).replace(/<[^>]*>?/gm, '');

      const html = `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>${blog.title}</title>
                    <meta property="og:title" content="${blog.title}" />
                    <meta property="og:description" content="${description}" />
                    <meta property="og:image" content="${imageUrl}" />
                    <meta property="og:url" content="${process.env.SERVER_URL}/blogs/${blog.slug}" />
                    <meta property="og:type" content="article" />
                    <meta name="twitter:card" content="summary_large_image" />
                </head>
                <body>
                    <h1>${blog.title}</h1>
                    <p>${description}</p>
                    <img src="${imageUrl}" alt="${blog.title}" />
                </body>
                </html>
            `;
      return res.send(html);
    } catch (error) {
      console.error('OG Tag Error:', error);
      return res.status(500).send('Server Error');
    }
  }

  // If not a bot, redirect to the frontend with the same param (slug or ID)
  // Note: In a real production setup with Nginx, this might be handled differently,
  // but for this setup, we redirect to the React app.
  res.redirect(`${process.env.CLIENT_URL}/blogs/${req.params.idOrSlug}`);
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
