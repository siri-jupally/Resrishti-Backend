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
const { ipKeyGenerator } = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const dotenv = require("dotenv");

dotenv.config();
// S3 streaming for attachment downloads
const { GetObjectCommand } = require("@aws-sdk/client-s3");
const { getS3Client } = require("./utils/s3");

const app = express();
const http = require("http");
const { initSocket } = require("./socketHandler");
const server = http.createServer(app);
const io = initSocket(server);

// Trust the reverse proxy (Render/Heroku/Nginx/Cloudflare/etc.) so req.ip resolves
// to the real client IP via X-Forwarded-For. Without this, every request appears
// to come from the proxy IP and ALL users share a single rate-limit bucket.
app.set("trust proxy", 1);

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// Rate Limiting
//
// Two-tier strategy:
//   1. apiLimiter   — generous per-IP limit on /api/* to absorb normal app traffic
//                     (login + checkin + polling + location batch + profile loads).
//                     Authenticated requests are keyed by user id so multiple users
//                     behind the same office NAT don't share a bucket.
//   2. loginLimiter — strict per-IP+identifier limit on the three /login endpoints,
//                     which is where brute-force protection actually matters.
//
// Static /uploads and non-API routes are intentionally NOT rate-limited.
const ipKey = (req) => {
  // Prefer the real client IP. ipv6Subnet groups IPv6 addresses to /56 to avoid
  // a single client cycling through addresses and trivially bypassing limits.
  return ipKeyGenerator(req.ip);
};

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute window
  limit: 300, // 300 req/min/user (or /IP for unauthenticated) — well above normal usage
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // Skip CORS preflight so browsers don't burn quota before the real call.
  skip: (req) => req.method === "OPTIONS",
  // Key by user id when authenticated; fall back to client IP otherwise.
  keyGenerator: (req) => {
    const auth = req.headers.authorization;
    if (auth && auth.startsWith("Bearer ")) {
      try {
        const payload = jwt.decode(auth.slice(7));
        if (payload && payload.id) return `u:${payload.id}`;
      } catch (e) {
        // fall through to IP
      }
    }
    return `ip:${ipKey(req)}`;
  },
  message: { message: "High traffic right now. Please try again in a moment." },
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 30, // 30 login attempts per 15 min per IP+email — protects against brute force
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true, // successful logins don't count toward the limit
  keyGenerator: (req) => {
    const email = (req.body && (req.body.email || req.body.username)) || "";
    return `login:${ipKey(req)}:${String(email).toLowerCase()}`;
  },
  message: { message: "Too many login attempts from this device. Please wait a few minutes and try again." },
});

app.use("/api", apiLimiter);
app.post(
  [
    "/api/employee/login",
    "/api/manager/login",
    "/api/admin/login",
    "/api/client/login",
  ],
  loginLimiter
);

// Database Connection
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB Connected");
    // Fix stale sparse indexes on LocationTrail (one-time migration)
    try {
      const col = mongoose.connection.collection("locationtrails");
      const indexes = await col.indexes();
      for (const idx of indexes) {
        if (
          idx.sparse === true &&
          idx.unique === true &&
          (idx.key?.employee || idx.key?.manager)
        ) {
          await col.dropIndex(idx.name);
          console.log(`Dropped stale index: ${idx.name}`);
        }
      }
    } catch (e) {
      // Collection may not exist yet — that's fine
      if (e.codeName !== "NamespaceNotFound") console.error("Index migration:", e.message);
    }

    // Backfill missing allowMultipleCheckIns field on legacy AttendancePolicy docs.
    // Mongoose schema defaults only apply on insert, not to existing docs that lack the field.
    try {
      const policies = mongoose.connection.collection("attendancepolicies");
      const result = await policies.updateMany(
        { allowMultipleCheckIns: { $exists: false } },
        { $set: { allowMultipleCheckIns: false } }
      );
      if (result.modifiedCount > 0) {
        console.log(`Backfilled allowMultipleCheckIns on ${result.modifiedCount} policy doc(s)`);
      }
    } catch (e) {
      if (e.codeName !== "NamespaceNotFound") console.error("Policy backfill:", e.message);
    }
  })
  .catch((err) => console.error("MongoDB Connection Error:", err));

// Routes
app.use("/api/testimonials", require("./routes/testimonialRoutes"));
app.use("/api/admin", require("./routes/adminRoutes"));
app.use("/api/admin/clients", require("./routes/clientRoutes"));
app.use("/api/blogs", require("./routes/blogRoutes"));
app.use("/api/manager", require("./routes/managerRoutes"));
app.use("/api/employee", require("./routes/employeeRoutes"));
// Client portal (external customers). The onboarding sub-router (Backend B)
// is mounted separately at `/api/client/onboarding` — Express picks the
// longer prefix first so the two coexist without conflict.
app.use("/api/client", require("./routes/clientPortalRoutes"));
// Client portal pickup endpoints (Backend D). Mounted at a more specific
// path than `/api/client` so Express resolves it first.
app.use("/api/client/pickups", require("./routes/clientPortalPickupRoutes"));

// Client Management module — admin/coordinator pickup triage endpoints
// (Phase 1, Chunk 2). Auth via protectTriage (Admin OR Manager+canCoordinate).
app.use("/api/admin/pickups", require("./routes/adminPickupRoutes"));
// Supervisor pool — exposed at the spec'd path /api/admin/supervisor-pool.
const { protectTriage } = require("./middleware/authTriage");
const { getSupervisorPool } = require("./controllers/adminPickupController");
app.get("/api/admin/supervisor-pool", protectTriage, getSupervisorPool);

// Client Management module — onboarding routes (Phase 1).
// `adminRouter` extends the /api/admin/clients prefix with the
// resend-onboarding action. `publicRouter` is the unauthenticated
// magic-link portal surface — the token in the body IS the credential.
const onboardingRoutes = require("./routes/onboardingRoutes");
app.use("/api/admin/clients", onboardingRoutes.adminRouter);
app.use("/api/client/onboarding", onboardingRoutes.publicRouter);

// Client Management module — supervisor field-execution routes (Phase 1, Chunk 2).
// The same controller is mounted under each of the three role prefixes; each
// instance is guarded by the role's own auth middleware. The controller reads
// whichever of req.employee / req.manager / req.admin the middleware set, so
// any user with `canSupervise: true` can advance pickups assigned to them.
const supervisorPickupRoutes = require("./routes/supervisorPickupRoutes");
app.use(
  "/api/employee/my-pickups",
  supervisorPickupRoutes(require("./middleware/authEmployee").protectEmployee)
);
app.use(
  "/api/manager/my-pickups",
  supervisorPickupRoutes(require("./middleware/authManager").protectManager)
);
app.use(
  "/api/admin/my-pickups",
  supervisorPickupRoutes(require("./middleware/authMiddleware").protect)
);

// Client Management module — manager/coordinator certificate workflow
// (Phase 1, Chunk 3). Issue / send / revise the rendered CoD PDFs. Same
// protectTriage gate as /api/admin/pickups (Admin OR Manager+canCoordinate).
app.use("/api/manager/certificates", require("./routes/certificateRoutes"));

// Client Management module — public live-stats endpoint (Phase 1, Chunk 3).
// Unauthenticated; reads from the StatsSnapshot cache recomputed every 15 min
// by services/statsJob.js. See clientmngmt.md §7.6, §12.
app.use("/api/public", require("./routes/publicStatsRoutes"));

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

    // Check for inline viewing request
    const disposition = req.query.inline === "true" ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"`);

    // Allow this response to be embedded in <iframe>/<img> from any origin
    // (the rest of the app sets a global helmet COEP/CORP that would otherwise
    // block cross-port PDF previews in the manager certificate panel).
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
    res.removeHeader("X-Frame-Options");
    // Override helmet's default CSP which sets `frame-ancestors 'self'` and
    // blocks the cert PDF preview iframe in the manager dashboard.
    res.setHeader("Content-Security-Policy", "frame-ancestors *");

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

      let imageUrl = blog.image || "default-og.jpg";

      // If it's a relative path (local upload), prepend server URL
      if (imageUrl && !imageUrl.startsWith("http")) {
        imageUrl = `${process.env.SERVER_URL}/${imageUrl.replace(/\\/g, "/")}`;
      } else if (!imageUrl && !blog.image) {
        // Fallback if generic default
        imageUrl = `${process.env.SERVER_URL}/default-og.jpg`;
      }

      // If it is ALREADY an http/s URL (S3), we use it as is.

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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Client Management module — start the public-stats recompute job (Phase 1,
// Chunk 3). Runs once on boot then every 15 min. Wrapped in try/catch so a
// require-time crash (e.g. missing model) can never take the server down.
// See services/statsJob.js + clientmngmt.md §12.1.
try {
  require("./services/statsJob").startStatsJob();
} catch (err) {
  console.error("Failed to start stats job:", err.message);
}
// test change
