/*
  App Review controller

  Endpoints:
  - GET  /api/employee/review/status  | /api/manager/review/status  -> getMyReviewStatus
  - POST /api/employee/review         | /api/manager/review         -> submitReview
  - GET  /api/admin/reviews                                         -> listReviews (admin)

  The staff endpoints detect the role from whichever of req.employee /
  req.manager the auth middleware populated (same pattern as
  notificationController). The admin endpoint is mounted behind `protect`.
*/
const AppReview = require("../models/AppReview");

// Resolve the acting staff user + their role from the request, or null if this
// isn't an employee/manager request.
const actorFrom = (req) => {
  if (req.employee) {
    return { doc: req.employee, role: "employee", model: "Employee" };
  }
  if (req.manager) {
    return { doc: req.manager, role: "manager", model: "Manager" };
  }
  return null;
};

// GET review status — the frontend gate calls this on load to decide whether
// to show the mandatory popup. Authoritative over any stale login payload.
const getMyReviewStatus = async (req, res) => {
  try {
    const actor = actorFrom(req);
    if (!actor) return res.status(401).json({ message: "Not authorized" });
    return res.status(200).json({ hasReviewed: !!actor.doc.hasReviewed });
  } catch (err) {
    console.error("getMyReviewStatus error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

// POST a review. Idempotent: if the user already reviewed, we don't error —
// we just report it as done so the gate closes cleanly.
const submitReview = async (req, res) => {
  try {
    const actor = actorFrom(req);
    if (!actor) return res.status(401).json({ message: "Not authorized" });

    const rating = Number(req.body?.rating);
    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res
        .status(400)
        .json({ message: "Please choose a rating from 1 to 5 stars." });
    }
    const comment = String(req.body?.comment ?? "").trim().slice(0, 2000);

    // Already reviewed? Keep it one-time — report done, change nothing.
    const existing = await AppReview.findOne({
      reviewerRole: actor.role,
      reviewer: actor.doc._id,
    });
    if (existing) {
      if (!actor.doc.hasReviewed) {
        actor.doc.hasReviewed = true;
        await actor.doc.save();
      }
      return res
        .status(200)
        .json({ message: "Review already submitted", alreadyReviewed: true });
    }

    await AppReview.create({
      reviewerRole: actor.role,
      reviewer: actor.doc._id,
      reviewerModel: actor.model,
      reviewerName: actor.doc.name || "",
      reviewerEmail: actor.doc.email || "",
      rating,
      comment,
    });

    actor.doc.hasReviewed = true;
    await actor.doc.save();

    return res.status(201).json({ message: "Thanks for your feedback!" });
  } catch (err) {
    // Unique-index race (double submit) → treat as already done, not an error.
    if (err && err.code === 11000) {
      return res
        .status(200)
        .json({ message: "Review already submitted", alreadyReviewed: true });
    }
    console.error("submitReview error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

// GET all reviews for the admin dashboard, newest first, with a summary block
// (count, average, per-star distribution, per-role counts).
const listReviews = async (req, res) => {
  try {
    const reviews = await AppReview.find({})
      .sort({ createdAt: -1 })
      .lean();

    const count = reviews.length;
    const sum = reviews.reduce((a, r) => a + (r.rating || 0), 0);
    const average = count ? Math.round((sum / count) * 10) / 10 : 0;

    const byStar = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const byRole = { employee: 0, manager: 0 };
    let withComment = 0;
    for (const r of reviews) {
      if (byStar[r.rating] !== undefined) byStar[r.rating] += 1;
      if (byRole[r.reviewerRole] !== undefined) byRole[r.reviewerRole] += 1;
      if (r.comment && r.comment.trim()) withComment += 1;
    }

    return res.status(200).json({
      summary: { count, average, byStar, byRole, withComment },
      reviews,
    });
  } catch (err) {
    console.error("listReviews error:", err);
    res.status(500).json({ message: "Server Error" });
  }
};

module.exports = { getMyReviewStatus, submitReview, listReviews };
