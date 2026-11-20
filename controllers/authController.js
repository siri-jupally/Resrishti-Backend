/*
  Unified staff authentication — one front door for Admin, Manager and Employee.

  The three portals still exist (their /login endpoints and middleware are
  untouched); this just adds a single endpoint that figures out which collection
  an email belongs to and returns the role, so the frontend can show ONE login
  page and route by role afterwards.

  Why this is safe and small:
  - The JWT is role-agnostic (`{ id }`, exactly like the per-portal endpoints),
    so every existing middleware keeps working — each one looks the id up in its
    own collection. We don't touch tokens, middleware, or the token keys the app
    reads (adminToken / managerToken / employeeToken); the client stores the
    right one based on `role`.
  - Precedence Admin > Manager > Employee resolves a person who exists in more
    than one collection (e.g. a promoted person: archived Employee + active
    Manager, same email/password) to their highest ACTIVE role. A nice
    side-effect: promoted staff now log in as managers through this door.
  - Generic "Invalid credentials", archived-only -> the same "deactivated"
    message the portals use, and an identical forgot-password response whether
    or not the email exists — so this door leaks no more than the old ones.

  The CLIENT portal (external customers) is deliberately NOT part of this — it's
  a different audience with its own token kind.
*/
const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");
const Employee = require("../models/Employee");
const { forgotPassword, SENT_OK } = require("./staffPasswordResetController");

const genToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });

// Highest role first. `canArchive` marks the collections that have an `archived`
// flag (Admin does not).
const CANDIDATES = [
    { role: "admin", Model: Admin, canArchive: false },
    { role: "manager", Model: Manager, canArchive: true },
    { role: "employee", Model: Employee, canArchive: true },
];

// POST /api/auth/login  { email, password }
const unifiedLogin = async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const password = String(req.body?.password || "");
        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required" });
        }

        let sawDeactivated = false;
        for (const c of CANDIDATES) {
            const user = await c.Model.findOne({ email });
            if (!user) continue;
            if (!(await user.comparePassword(password))) continue;
            // Right password, but this identity is archived (left / promoted
            // away). Don't reject yet — a lower-precedence ACTIVE identity with
            // the same credentials may still exist (that's the promoted case).
            if (c.canArchive && user.archived) { sawDeactivated = true; continue; }

            return res.json({
                role: c.role,
                _id: user._id,
                email: user.email,
                name: user.name,
                token: genToken(user._id),
                // Admins have no setup wizard — default the flags so the
                // client's post-login branch is uniform across roles.
                isFirstLogin: user.isFirstLogin ?? false,
                isProfileComplete: user.isProfileComplete ?? true,
                hasReviewed: user.hasReviewed ?? true,
            });
        }

        // Correct password but only for an archived account, nothing active.
        if (sawDeactivated) {
            return res.status(403).json({
                message: "This account has been deactivated. Contact your administrator.",
            });
        }
        return res.status(400).json({ message: "Invalid credentials" });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
};

// POST /api/auth/forgot-password  { email }
// Find which portal owns the email, then run THAT portal's existing reset flow
// (so the emailed link points at the correct reset page). The response is
// identical whether the email exists or not, to avoid account enumeration.
const unifiedForgotPassword = async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        if (!email) return res.status(400).json({ message: "Email is required" });

        for (const c of CANDIDATES) {
            const user = await c.Model.findOne({ email }).select("_id archived").lean();
            if (user && !user.archived) {
                // Delegate — reuses token creation, email copy and portal link.
                return forgotPassword(c.role)(req, res);
            }
        }
        // Unknown, or archived-only: same body the delegated path returns.
        return res.json(SENT_OK);
    } catch (err) {
        console.error("unifiedForgotPassword error:", err.message);
        return res.status(500).json({ message: "Could not send the reset link. Please try again." });
    }
};

module.exports = { unifiedLogin, unifiedForgotPassword };
