/*
  adminPickupController.js — Admin/Coordinator pickup triage endpoints.

  Spec reference: clientmngmt.md §7.2 + §8.1.

  Endpoints (all mounted under /api/admin/pickups behind protectTriage):
  - GET    /                            listPickups
  - GET    /:id                         getPickup
  - PATCH  /:id/accept                  acceptPickup
  - PATCH  /:id/reject                  rejectPickup
  - PATCH  /:id/reassign-supervisor     reassignSupervisor
  - PATCH  /:id/cancel                  cancelPickup
  - GET    /supervisor-pool             getSupervisorPool

  Authorization model:
  - protectTriage accepts either Admin (req.admin) or Manager with
    canCoordinate (req.manager). canTriage() below is a final gate so
    individual handlers stay self-defensive even if the middleware
    composition changes.

  Coordination note:
  - models/Pickup.js is being added in parallel by Backend D. We resolve
    the model lazily inside handlers (`require('../models/Pickup')`) so
    that this controller module can still be required by smoke tests and
    routes if Backend D's PR lands after this one.
*/
const mongoose = require("mongoose");
const Admin = require("../models/Admin");
const Manager = require("../models/Manager");
const Employee = require("../models/Employee");
const Client = require("../models/Client");
const { sendPush, notifyIfEnabled } = require("../utils/push");
const { sendEmail } = require("../utils/emailService");

// ---------- helpers ----------------------------------------------------

/**
 * Final authorization gate per handler. protectTriage already pre-screens,
 * but keeping this here means we can mount the controller behind any auth
 * shim without losing the rule.
 */
const canTriage = (req) => {
    if (req.admin) return true;
    if (req.manager && req.manager.canCoordinate) return true;
    return false;
};

/**
 * Returns the actor performing the triage action — used for evidence
 * stamping and `acceptedBy`. Admin records have no `name` field, only
 * `email`, so we fall back to email when name is absent.
 */
const actorFromReq = (req) => {
    if (req.admin) {
        return {
            userType: "Admin",
            userId: req.admin._id,
            name: req.admin.name || req.admin.email,
        };
    }
    if (req.manager) {
        return {
            userType: "Manager",
            userId: req.manager._id,
            name: req.manager.name || req.manager.email,
        };
    }
    return { userType: undefined, userId: undefined, name: "Unknown" };
};

/**
 * Map a supervisorUserType string to the corresponding Mongoose model.
 * Returns null for an unrecognized type so callers can 400 cleanly.
 */
const modelForUserType = (userType) => {
    switch (userType) {
        case "Admin":
            return Admin;
        case "Manager":
            return Manager;
        case "Employee":
            return Employee;
        default:
            return null;
    }
};

/**
 * Look up a supervisor candidate and confirm they exist + are
 * supervisor-capable. Returns { user, error } where error is a
 * `{ status, message }` to send back, or null on success.
 */
const resolveSupervisor = async (userType, userId) => {
    const Model = modelForUserType(userType);
    if (!Model) {
        return {
            user: null,
            error: { status: 400, message: "Invalid supervisorUserType" },
        };
    }
    if (!mongoose.Types.ObjectId.isValid(userId)) {
        return {
            user: null,
            error: { status: 400, message: "Invalid supervisorUserId" },
        };
    }
    const user = await Model.findById(userId).select(
        "name email phone canSupervise pushSubscription"
    );
    if (!user) {
        return {
            user: null,
            error: {
                status: 404,
                message: `${userType} not found`,
            },
        };
    }
    if (!user.canSupervise) {
        return {
            user: null,
            error: {
                status: 403,
                message: "This user is not enabled as a supervisor",
            },
        };
    }
    return { user, error: null };
};

/**
 * Build a stable supervisor snapshot from a resolved user. We keep the
 * snapshot fields (name, phone) so historical pickups remain readable
 * even after the supervisor user record is renamed or deleted.
 */
const buildSupervisorSnapshot = ({ user, userType, assignedBy }) => ({
    userType,
    userId: user._id,
    name: user.name || user.email || "Resrishti team",
    phone: user.phone || user.email || "",
    assignedAt: new Date(),
    assignedBy,
});

/**
 * Map a supervisor userType to the dashboard route segment used in
 * push-notification `data.url`. Keeps the supervisor's push link
 * landing on the right dashboard.
 */
const dashboardPathForSupervisor = (userType) => {
    if (userType === "Admin") return "/admin/dashboard";
    if (userType === "Manager") return "/manager/dashboard";
    return "/employee/dashboard";
};

/**
 * Branded HTML email shell matching the onboarding email pattern
 * (emerald `#059669` header on `#f6f8f7` page, 560px card, slate text).
 */
const brandedEmail = ({ heading, bodyHtml, ctaText, ctaUrl, footerNote }) => {
    const cta = ctaUrl
        ? `<p style="margin:24px 0;text-align:center;">
             <a href="${ctaUrl}" style="display:inline-block;background:#059669;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 28px;border-radius:8px;">${ctaText || "View details"}</a>
           </p>`
        : "";

    return `
<!DOCTYPE html>
<html>
  <head><meta charset="UTF-8" /><title>${heading}</title></head>
  <body style="margin:0;padding:0;background:#f6f8f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f7;padding:32px 16px;">
      <tr><td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,23,42,0.06);">
          <tr><td style="background:#059669;padding:24px 32px;color:#ffffff;">
            <div style="font-size:20px;font-weight:700;letter-spacing:-0.01em;">Resrishti</div>
            <div style="font-size:13px;opacity:0.85;margin-top:2px;">Sustainable waste management</div>
          </td></tr>
          <tr><td style="padding:32px;">
            <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#0f172a;">${heading}</h1>
            ${bodyHtml}
            ${cta}
          </td></tr>
          <tr><td style="background:#f8fafc;padding:16px 32px;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0;">
            ${footerNote || "You're receiving this email because your organization uses Resrishti for waste management."}
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`.trim();
};

/**
 * Best-effort push to a single subscription. Errors are swallowed and
 * logged — push failures must never block the underlying admin action.
 */
const safePush = async (subscription, payload) => {
    if (!subscription) return;
    try {
        await notifyIfEnabled("attendance", subscription, payload);
    } catch (err) {
        console.error("pickup push error:", err);
    }
};

/**
 * Best-effort email. sendEmail() already swallows its own errors but we
 * still wrap to log a consistent prefix.
 */
const safeEmail = async (to, subject, text, html) => {
    if (!to) return;
    try {
        await sendEmail(to, subject, text, html);
    } catch (err) {
        console.error("pickup email error:", err);
    }
};

/**
 * Format a Date (or string) as `YYYY-MM-DD HH:mm` in IST-friendly local
 * style for human-readable emails. Falls back to ISO if parsing fails.
 */
const formatScheduledFor = (value) => {
    try {
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return String(value);
        const opts = {
            year: "numeric",
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
        };
        return d.toLocaleString("en-IN", opts);
    } catch {
        return String(value);
    }
};

// ---------- handlers ---------------------------------------------------

/**
 * GET /api/admin/pickups
 *
 * Filters: status, supervisor, client, from, to.
 * - `status` accepts a CSV ("requested,accepted") for the "show me
 *   everything pending triage" use case.
 * - Date filter applies to `requestedDate` (when the client wants the
 *   pickup), NOT `createdAt`, which is what the coordinator queue cares
 *   about.
 * Pagination: limit (default 50, max 200) + offset.
 */
const listPickups = async (req, res) => {
    if (!canTriage(req)) {
        return res.status(403).json({ message: "Not authorized" });
    }
    const Pickup = require("../models/Pickup");

    try {
        const { status, supervisor, client, from, to } = req.query;
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const offset = Number(req.query.offset) || 0;

        const filter = {};
        if (status) {
            const parts = String(status)
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            filter.status = parts.length > 1 ? { $in: parts } : parts[0];
        }
        if (supervisor && mongoose.Types.ObjectId.isValid(supervisor)) {
            filter["supervisor.userId"] = supervisor;
        }
        if (client && mongoose.Types.ObjectId.isValid(client)) {
            filter.client = client;
        }
        if (from || to) {
            filter.requestedDate = {};
            if (from) {
                const f = new Date(from);
                if (!Number.isNaN(f.getTime())) filter.requestedDate.$gte = f;
            }
            if (to) {
                const t = new Date(to);
                if (!Number.isNaN(t.getTime())) filter.requestedDate.$lte = t;
            }
            // Drop the field if both parses failed to avoid `{}` matching
            // every doc with requestedDate set.
            if (Object.keys(filter.requestedDate).length === 0) {
                delete filter.requestedDate;
            }
        }

        const [items, total] = await Promise.all([
            Pickup.find(filter)
                .populate(
                    "client",
                    "name contactName contactPhone billingAddress"
                )
                .sort({ createdAt: -1 })
                .skip(offset)
                .limit(limit)
                .lean(),
            Pickup.countDocuments(filter),
        ]);

        return res.json({ items, total, limit, offset });
    } catch (err) {
        console.error("listPickups error:", err);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * GET /api/admin/pickups/:id
 * Full pickup with populated client + (best-effort) certificate.
 */
const getPickup = async (req, res) => {
    if (!canTriage(req)) {
        return res.status(403).json({ message: "Not authorized" });
    }
    const Pickup = require("../models/Pickup");

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid pickup id" });
        }

        let query = Pickup.findById(req.params.id).populate(
            "client",
            "name contactName contactEmail contactPhone billingAddress"
        );

        // Certificate model is built by a later phase; populate is
        // wrapped so we don't blow up before that model ships.
        try {
            require("../models/Certificate");
            query = query.populate("certificate");
        } catch (_) {
            // Certificate model not registered yet — skip.
        }

        const pickup = await query.exec();
        if (!pickup) {
            return res.status(404).json({ message: "Pickup not found" });
        }
        return res.json(pickup);
    } catch (err) {
        console.error("getPickup error:", err);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * PATCH /api/admin/pickups/:id/accept
 * Accept a pickup AND assign a supervisor in one atomic move.
 *
 * Validations enforced in order so the most actionable error wins:
 *   1. scheduledDate parseable + not in the past
 *   2. supervisorUserType valid enum
 *   3. supervisor user resolves AND has canSupervise: true
 *   4. pickup is currently in `requested` status
 *
 * Side effects: push to assigned supervisor + portal-banner-and-email
 * to client. Both are best-effort and never block the state change.
 */
const acceptPickup = async (req, res) => {
    if (!canTriage(req)) {
        return res.status(403).json({ message: "Not authorized" });
    }
    const Pickup = require("../models/Pickup");

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid pickup id" });
        }

        const { scheduledDate, supervisorUserType, supervisorUserId } =
            req.body || {};

        // 1. scheduledDate parse + future check
        if (!scheduledDate) {
            return res
                .status(400)
                .json({ message: "scheduledDate is required" });
        }
        const scheduled = new Date(scheduledDate);
        if (Number.isNaN(scheduled.getTime())) {
            return res
                .status(400)
                .json({ message: "scheduledDate is not a valid date" });
        }
        if (scheduled.getTime() < Date.now()) {
            return res
                .status(400)
                .json({ message: "scheduledDate cannot be in the past" });
        }

        // 2. + 3. supervisor validations
        if (!supervisorUserType || !supervisorUserId) {
            return res.status(400).json({
                message:
                    "supervisorUserType and supervisorUserId are required",
            });
        }
        if (
            !["Admin", "Manager", "Employee"].includes(supervisorUserType)
        ) {
            return res
                .status(400)
                .json({ message: "Invalid supervisorUserType" });
        }
        const { user: supervisorUser, error: supervisorError } =
            await resolveSupervisor(supervisorUserType, supervisorUserId);
        if (supervisorError) {
            return res
                .status(supervisorError.status)
                .json({ message: supervisorError.message });
        }

        // 4. pickup state check
        const pickup = await Pickup.findById(req.params.id).populate(
            "client",
            "name contactName contactEmail contactPhone pushSubscription"
        );
        if (!pickup) {
            return res.status(404).json({ message: "Pickup not found" });
        }
        if (pickup.status !== "requested") {
            return res.status(409).json({
                message: `Pickup cannot be accepted from status '${pickup.status}'`,
            });
        }

        const actor = actorFromReq(req);
        const now = new Date();

        pickup.status = "accepted";
        pickup.scheduledDate = scheduled;
        pickup.acceptedAt = now;
        pickup.acceptedBy = actor;
        pickup.supervisor = buildSupervisorSnapshot({
            user: supervisorUser,
            userType: supervisorUserType,
            assignedBy: actor.userId,
        });
        pickup.evidence = pickup.evidence || [];
        pickup.evidence.push({
            status: "accepted",
            at: now,
            by: actor,
        });

        await pickup.save();

        // ------- Side effects: push + email --------
        const dashboardPath = dashboardPathForSupervisor(supervisorUserType);
        const supervisorPushUrl = `${dashboardPath}?tab=mypickups&id=${pickup._id}`;
        await safePush(supervisorUser.pushSubscription, {
            title: "New Pickup Assignment",
            body: `${pickup.client?.name || "Client"} pickup ${pickup.pickupID} on ${formatScheduledFor(scheduled)}`,
            icon: "/android-chrome-512x512.png",
            tag: `pickup-assigned-${pickup._id}`,
            data: { url: supervisorPushUrl },
        });

        // Client gets portal-banner push + email
        if (pickup.client) {
            await safePush(pickup.client.pushSubscription, {
                title: "Your pickup is scheduled",
                body: `Pickup ${pickup.pickupID} scheduled for ${formatScheduledFor(scheduled)}. Supervisor: ${pickup.supervisor.name}`,
                icon: "/android-chrome-512x512.png",
                tag: `pickup-update-${pickup._id}`,
                data: { url: `/client/pickups/${pickup._id}` },
            });

            const clientBase =
                process.env.CLIENT_URL || "http://localhost:5173";
            const ctaUrl = `${clientBase}/client/pickups/${pickup._id}`;
            const subject = "Your pickup is scheduled";
            const bodyHtml = `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  Hi ${pickup.client.contactName || "there"},
                </p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  Your pickup request <strong>${pickup.pickupID}</strong> has been accepted.
                </p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:#0f172a;">
                  <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Scheduled for:</td><td style="padding:4px 0;"><strong>${formatScheduledFor(scheduled)}</strong></td></tr>
                  <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Supervisor:</td><td style="padding:4px 0;"><strong>${pickup.supervisor.name}</strong></td></tr>
                  <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Supervisor phone:</td><td style="padding:4px 0;"><strong>${pickup.supervisor.phone || "—"}</strong></td></tr>
                </table>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#475569;">
                  You'll receive status updates as our team progresses through the pickup. You can also track everything from your client portal.
                </p>
            `;
            const html = brandedEmail({
                heading: "Pickup scheduled",
                bodyHtml,
                ctaText: "View pickup details",
                ctaUrl,
                footerNote:
                    "Reply to this email or contact your account manager if anything looks off.",
            });
            const text = [
                `Hi ${pickup.client.contactName || "there"},`,
                ``,
                `Your pickup request ${pickup.pickupID} has been accepted.`,
                `Scheduled for: ${formatScheduledFor(scheduled)}`,
                `Supervisor: ${pickup.supervisor.name} (${pickup.supervisor.phone || "phone tba"})`,
                ``,
                `View details: ${ctaUrl}`,
                ``,
                `— The Resrishti Team`,
            ].join("\n");
            await safeEmail(pickup.client.contactEmail, subject, text, html);
        }

        return res.json(pickup);
    } catch (err) {
        console.error("acceptPickup error:", err);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * PATCH /api/admin/pickups/:id/reject
 * Reject a still-pending request with a mandatory reason (≥10 chars).
 */
const rejectPickup = async (req, res) => {
    if (!canTriage(req)) {
        return res.status(403).json({ message: "Not authorized" });
    }
    const Pickup = require("../models/Pickup");

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid pickup id" });
        }
        const { rejectionReason } = req.body || {};
        const reason = String(rejectionReason || "").trim();
        if (reason.length < 10) {
            return res.status(400).json({
                message:
                    "rejectionReason is required and must be at least 10 characters",
            });
        }

        const pickup = await Pickup.findById(req.params.id).populate(
            "client",
            "name contactName contactEmail pushSubscription"
        );
        if (!pickup) {
            return res.status(404).json({ message: "Pickup not found" });
        }
        if (pickup.status !== "requested") {
            return res.status(409).json({
                message: `Pickup cannot be rejected from status '${pickup.status}'`,
            });
        }

        const actor = actorFromReq(req);
        const now = new Date();
        pickup.status = "rejected";
        pickup.rejectionReason = reason;
        pickup.evidence = pickup.evidence || [];
        pickup.evidence.push({
            status: "rejected",
            notes: reason,
            at: now,
            by: actor,
        });
        await pickup.save();

        if (pickup.client) {
            await safePush(pickup.client.pushSubscription, {
                title: "Pickup request update",
                body: `Pickup ${pickup.pickupID} could not be scheduled. Tap for details.`,
                icon: "/android-chrome-512x512.png",
                tag: `pickup-update-${pickup._id}`,
                data: { url: `/client/pickups/${pickup._id}` },
            });

            const clientBase =
                process.env.CLIENT_URL || "http://localhost:5173";
            const ctaUrl = `${clientBase}/client/pickups/${pickup._id}`;
            const subject = "Pickup request update";
            const bodyHtml = `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  Hi ${pickup.client.contactName || "there"},
                </p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  Unfortunately we couldn't schedule pickup <strong>${pickup.pickupID}</strong> at this time.
                </p>
                <div style="margin:0 0 16px;padding:12px 16px;background:#f1f5f9;border-left:3px solid #059669;border-radius:6px;font-size:14px;color:#334155;">
                  <strong style="color:#0f172a;">Reason:</strong><br/>
                  ${reason}
                </div>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#475569;">
                  Reach out to your account manager — they can help reschedule or look at alternatives.
                </p>
            `;
            const html = brandedEmail({
                heading: "We couldn't schedule this pickup",
                bodyHtml,
                ctaText: "Open client portal",
                ctaUrl,
            });
            const text = [
                `Hi ${pickup.client.contactName || "there"},`,
                ``,
                `Unfortunately we couldn't schedule pickup ${pickup.pickupID} at this time.`,
                `Reason: ${reason}`,
                ``,
                `View details: ${ctaUrl}`,
                ``,
                `— The Resrishti Team`,
            ].join("\n");
            await safeEmail(pickup.client.contactEmail, subject, text, html);
        }

        return res.json(pickup);
    } catch (err) {
        console.error("rejectPickup error:", err);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * PATCH /api/admin/pickups/:id/reassign-supervisor
 *
 * Allowed across the mid-flight statuses: accepted, scheduled, en-route,
 * at-client, picked-up, at-facility. We refuse once the pickup is into
 * waste-data entry (weighed onward) to keep the data-entry actor stable.
 *
 * Notifies BOTH the old and the new supervisor; the client is also
 * notified since the supervisor contact info is shown in their portal.
 */
const reassignSupervisor = async (req, res) => {
    if (!canTriage(req)) {
        return res.status(403).json({ message: "Not authorized" });
    }
    const Pickup = require("../models/Pickup");

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid pickup id" });
        }
        const { supervisorUserType, supervisorUserId, reason } =
            req.body || {};

        const reasonStr = String(reason || "").trim();
        if (!reasonStr) {
            return res
                .status(400)
                .json({ message: "reason is required for reassignment" });
        }
        if (!supervisorUserType || !supervisorUserId) {
            return res.status(400).json({
                message:
                    "supervisorUserType and supervisorUserId are required",
            });
        }
        if (
            !["Admin", "Manager", "Employee"].includes(supervisorUserType)
        ) {
            return res
                .status(400)
                .json({ message: "Invalid supervisorUserType" });
        }

        const allowedStatuses = [
            "accepted",
            "scheduled",
            "en-route",
            "at-client",
            "picked-up",
            "at-facility",
        ];

        const pickup = await Pickup.findById(req.params.id).populate(
            "client",
            "name contactName contactEmail contactPhone pushSubscription"
        );
        if (!pickup) {
            return res.status(404).json({ message: "Pickup not found" });
        }
        if (!allowedStatuses.includes(pickup.status)) {
            return res.status(409).json({
                message: `Supervisor cannot be reassigned from status '${pickup.status}'`,
            });
        }

        const { user: newSupervisor, error: supervisorError } =
            await resolveSupervisor(supervisorUserType, supervisorUserId);
        if (supervisorError) {
            return res
                .status(supervisorError.status)
                .json({ message: supervisorError.message });
        }

        // Snapshot the OLD supervisor before overwriting so we can notify.
        const oldSupervisor = pickup.supervisor
            ? { ...pickup.supervisor.toObject?.() ?? pickup.supervisor }
            : null;

        const actor = actorFromReq(req);
        const now = new Date();
        pickup.supervisor = buildSupervisorSnapshot({
            user: newSupervisor,
            userType: supervisorUserType,
            assignedBy: actor.userId,
        });
        pickup.evidence = pickup.evidence || [];
        pickup.evidence.push({
            // Not in the pickup status enum — evidence.status is a free
            // String, so we use it for a custom audit verb here.
            status: "supervisor-reassigned",
            notes: reasonStr,
            at: now,
            by: actor,
        });
        await pickup.save();

        // ---- notify OLD supervisor (best-effort lookup) ----
        if (oldSupervisor && oldSupervisor.userId && oldSupervisor.userType) {
            const OldModel = modelForUserType(oldSupervisor.userType);
            if (OldModel) {
                try {
                    const oldUser = await OldModel.findById(
                        oldSupervisor.userId
                    ).select("pushSubscription");
                    if (oldUser) {
                        await safePush(oldUser.pushSubscription, {
                            title: "Pickup reassigned",
                            body: `You've been reassigned off pickup ${pickup.pickupID}.`,
                            icon: "/android-chrome-512x512.png",
                            tag: `pickup-reassigned-${pickup._id}`,
                            data: {
                                url: `${dashboardPathForSupervisor(oldSupervisor.userType)}?tab=mypickups`,
                            },
                        });
                    }
                } catch (e) {
                    console.error("Old supervisor push lookup failed:", e);
                }
            }
        }

        // ---- notify NEW supervisor ----
        const newDashboardPath =
            dashboardPathForSupervisor(supervisorUserType);
        await safePush(newSupervisor.pushSubscription, {
            title: "New Pickup Assignment",
            body: `${pickup.client?.name || "Client"} pickup ${pickup.pickupID}${pickup.scheduledDate ? " on " + formatScheduledFor(pickup.scheduledDate) : ""}`,
            icon: "/android-chrome-512x512.png",
            tag: `pickup-assigned-${pickup._id}`,
            data: {
                url: `${newDashboardPath}?tab=mypickups&id=${pickup._id}`,
            },
        });

        // ---- notify CLIENT (portal shows supervisor info) ----
        if (pickup.client) {
            await safePush(pickup.client.pushSubscription, {
                title: "Pickup supervisor updated",
                body: `Pickup ${pickup.pickupID}: new supervisor ${pickup.supervisor.name} (${pickup.supervisor.phone || "phone tba"})`,
                icon: "/android-chrome-512x512.png",
                tag: `pickup-update-${pickup._id}`,
                data: { url: `/client/pickups/${pickup._id}` },
            });

            const clientBase =
                process.env.CLIENT_URL || "http://localhost:5173";
            const ctaUrl = `${clientBase}/client/pickups/${pickup._id}`;
            const subject = "Pickup supervisor updated";
            const bodyHtml = `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  Hi ${pickup.client.contactName || "there"},
                </p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  The supervisor for pickup <strong>${pickup.pickupID}</strong> has changed.
                </p>
                <table cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:#0f172a;">
                  <tr><td style="padding:4px 12px 4px 0;color:#64748b;">New supervisor:</td><td style="padding:4px 0;"><strong>${pickup.supervisor.name}</strong></td></tr>
                  <tr><td style="padding:4px 12px 4px 0;color:#64748b;">Phone:</td><td style="padding:4px 0;"><strong>${pickup.supervisor.phone || "—"}</strong></td></tr>
                </table>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#475569;">
                  Everything else (scheduled date, address, streams) stays the same.
                </p>
            `;
            const html = brandedEmail({
                heading: "Supervisor updated",
                bodyHtml,
                ctaText: "View pickup details",
                ctaUrl,
            });
            const text = [
                `Hi ${pickup.client.contactName || "there"},`,
                ``,
                `The supervisor for pickup ${pickup.pickupID} has changed.`,
                `New supervisor: ${pickup.supervisor.name} (${pickup.supervisor.phone || "phone tba"})`,
                ``,
                `View details: ${ctaUrl}`,
                ``,
                `— The Resrishti Team`,
            ].join("\n");
            await safeEmail(pickup.client.contactEmail, subject, text, html);
        }

        return res.json(pickup);
    } catch (err) {
        console.error("reassignSupervisor error:", err);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * PATCH /api/admin/pickups/:id/cancel
 *
 * Triage-side cancellation (admin/coordinator-initiated). Refused if the
 * pickup has already reached terminal states (cert-sent, cancelled,
 * rejected) — those should stay immutable for the audit trail.
 */
const cancelPickup = async (req, res) => {
    if (!canTriage(req)) {
        return res.status(403).json({ message: "Not authorized" });
    }
    const Pickup = require("../models/Pickup");

    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ message: "Invalid pickup id" });
        }
        const { cancelledReason } = req.body || {};
        const reason = String(cancelledReason || "").trim();
        if (!reason) {
            return res
                .status(400)
                .json({ message: "cancelledReason is required" });
        }

        const terminal = ["cert-sent", "cancelled", "rejected"];

        const pickup = await Pickup.findById(req.params.id).populate(
            "client",
            "name contactName contactEmail pushSubscription"
        );
        if (!pickup) {
            return res.status(404).json({ message: "Pickup not found" });
        }
        if (terminal.includes(pickup.status)) {
            return res.status(409).json({
                message: `Pickup is already in terminal status '${pickup.status}'`,
            });
        }

        const actor = actorFromReq(req);
        const now = new Date();
        pickup.status = "cancelled";
        pickup.cancelledReason = reason;
        pickup.evidence = pickup.evidence || [];
        pickup.evidence.push({
            status: "cancelled",
            notes: reason,
            at: now,
            by: actor,
        });
        await pickup.save();

        // ---- notify CLIENT ----
        if (pickup.client) {
            await safePush(pickup.client.pushSubscription, {
                title: "Pickup cancelled",
                body: `Pickup ${pickup.pickupID} has been cancelled.`,
                icon: "/android-chrome-512x512.png",
                tag: `pickup-update-${pickup._id}`,
                data: { url: `/client/pickups/${pickup._id}` },
            });

            const clientBase =
                process.env.CLIENT_URL || "http://localhost:5173";
            const ctaUrl = `${clientBase}/client/pickups/${pickup._id}`;
            const subject = "Pickup cancelled";
            const bodyHtml = `
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  Hi ${pickup.client.contactName || "there"},
                </p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                  Pickup <strong>${pickup.pickupID}</strong> has been cancelled by our team.
                </p>
                <div style="margin:0 0 16px;padding:12px 16px;background:#f1f5f9;border-left:3px solid #059669;border-radius:6px;font-size:14px;color:#334155;">
                  <strong style="color:#0f172a;">Reason:</strong><br/>
                  ${reason}
                </div>
                <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#475569;">
                  You can request a new pickup any time from the client portal.
                </p>
            `;
            const html = brandedEmail({
                heading: "Pickup cancelled",
                bodyHtml,
                ctaText: "Open client portal",
                ctaUrl,
            });
            const text = [
                `Hi ${pickup.client.contactName || "there"},`,
                ``,
                `Pickup ${pickup.pickupID} has been cancelled.`,
                `Reason: ${reason}`,
                ``,
                `Open portal: ${ctaUrl}`,
                ``,
                `— The Resrishti Team`,
            ].join("\n");
            await safeEmail(pickup.client.contactEmail, subject, text, html);
        }

        // ---- notify SUPERVISOR (if one was assigned) ----
        if (pickup.supervisor && pickup.supervisor.userId && pickup.supervisor.userType) {
            const SupervisorModel = modelForUserType(pickup.supervisor.userType);
            if (SupervisorModel) {
                try {
                    const supUser = await SupervisorModel.findById(
                        pickup.supervisor.userId
                    ).select("pushSubscription");
                    if (supUser) {
                        await safePush(supUser.pushSubscription, {
                            title: "Pickup cancelled",
                            body: `Pickup ${pickup.pickupID} has been cancelled. Reason: ${reason}`,
                            icon: "/android-chrome-512x512.png",
                            tag: `pickup-cancelled-${pickup._id}`,
                            data: {
                                url: `${dashboardPathForSupervisor(pickup.supervisor.userType)}?tab=mypickups`,
                            },
                        });
                    }
                } catch (e) {
                    console.error("Supervisor cancel push failed:", e);
                }
            }
        }

        return res.json(pickup);
    } catch (err) {
        console.error("cancelPickup error:", err);
        return res.status(500).json({ message: err.message });
    }
};

/**
 * GET /api/admin/supervisor-pool
 *
 * Returns the union of Admin + Manager + Employee users with
 * `canSupervise: true` — drives the Assign-Supervisor dropdown on the
 * triage screen. Three collections are queried in parallel.
 */
const getSupervisorPool = async (req, res) => {
    if (!canTriage(req)) {
        return res.status(403).json({ message: "Not authorized" });
    }
    try {
        const [admins, managers, employees] = await Promise.all([
            Admin.find({ canSupervise: true })
                .select("_id name email phone")
                .lean(),
            Manager.find({ canSupervise: true })
                .select("_id name email phone")
                .lean(),
            Employee.find({ canSupervise: true })
                .select("_id name email phone")
                .lean(),
        ]);

        const tag = (userType) => (u) => ({
            userType,
            _id: u._id,
            name: u.name || u.email || "",
            email: u.email || "",
            phone: u.phone || "",
        });

        const pool = [
            ...admins.map(tag("Admin")),
            ...managers.map(tag("Manager")),
            ...employees.map(tag("Employee")),
        ].sort((a, b) =>
            String(a.name).localeCompare(String(b.name), undefined, {
                sensitivity: "base",
            })
        );

        return res.json(pool);
    } catch (err) {
        console.error("getSupervisorPool error:", err);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    listPickups,
    getPickup,
    acceptPickup,
    rejectPickup,
    reassignSupervisor,
    cancelPickup,
    getSupervisorPool,
};
