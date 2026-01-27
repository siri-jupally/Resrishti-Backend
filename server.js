/*
  server.js - application entry point

  Purpose:
  - Express app bootstrap for the Resrishti backend.
  - Registers middleware, connects to MongoDB, and mounts API routes.

  Important env vars:
  - MONGO_URI   : MongoDB connection string
  - PORT        : Port to listen on (defaults to 4000 if not set)
  - SERVER_URL  : Public server base URL used for constructing absolute links
  - CLIENT_URL  : Frontend base URL used for redirects in non-bot requests
  - JWT_SECRET  : Secret used by JWT authentication

  Notes:
  - This file mounts manager and employee routes at /api/manager and /api/employee.
  - Keep secrets out of source control and use proper process management in production.
*/
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const dotenv = require("dotenv");

dotenv.config();
// S3 streaming for attachment downloads
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getS3Client } = require("./utils/s3");

const app = express();

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Database Connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB Connected"))
  .catch((err) => console.error("MongoDB Connection Error:", err));

// Routes
app.use("/api/testimonials", require("./routes/testimonialRoutes"));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/blogs", require("./routes/blogRoutes"));
app.use("/api/manager", require("./routes/managerRoutes"));
app.use("/api/employee", require("./routes/employeeRoutes"));

app.get("/", (req, res) => {
  res.status(200).send("Backend is running ✔");
});

// GET /api/attachments/download?bucket=<bucket>&key=<key>&fileName=<name>
// Streams the S3 object and forces download with an attachment Content-Disposition.
app.get("/api/attachments/download", async (req, res) => {
  try {
    const { bucket, key, fileName } = req.query;
    if (!bucket || !key)
      return res.status(400).json({ message: "bucket and key are required" });

    const client = getS3Client();
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    const data = await client.send(command);

    // Set headers
    const contentType = data.ContentType || "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    const name = fileName || String(key).split("/").pop() || "attachment";
    // Ensure filename is safe in header
    const safeName = String(name).replace(/[^\w\-.() ]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

    // data.Body is a stream in Node.js; pipe to response
    const stream = data.Body;
    stream.pipe(res);
  } catch (err) {
    console.error("Attachment download error:", err.message || err);
    // try to send JSON if headers not sent
    if (!res.headersSent) return res.status(500).json({ message: err.message });
    // otherwise just end
    try {
      res.end();
    } catch (e) {
      /* ignore */
    }
  }
});

// Dynamic OG Tags for Social Media Bots
const Blog = require("./models/Blog");
app.get("/blogs/:idOrSlug", async (req, res, next) => {
  const userAgent = req.headers["user-agent"] || "";
  const isBot =
    /facebookexternalhit|linkedinbot|twitterbot|whatsapp|telegrambot|googlebot|bingbot|discordbot/i.test(
      userAgent
    );

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

      if (!blog) return res.status(404).send("Blog not found");

      const imageUrl = blog.image
        ? `${process.env.SERVER_URL}/${blog.image.replace(/\\/g, "/")}`
        : `${process.env.SERVER_URL}/default-og.jpg`;
      const description =
        blog.excerpt ||
        blog.content.substring(0, 150).replace(/<[^>]*>?/gm, "");

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
      console.error("OG Tag Error:", error);
      return res.status(500).send("Server Error");
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
  res.status(500).json({ message: "Something went wrong!" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
