/*
  AppReview model

  Purpose:
  - Stores the one-time, mandatory in-app review each staff user (employee /
    manager) leaves the first time they open the app after this feature ships.

  Shape:
  - rating (1-5) is required — everyone can at least tap a star, even if they
    don't want to write anything.
  - comment is optional free text.
  - reviewer is polymorphic across the two staff roles (Employee / Manager),
    with a denormalised name + email snapshot so the Admin dashboard list stays
    readable even if the user is later renamed or deleted.

  One-time guarantee:
  - A unique compound index on (reviewerRole, reviewer) makes a second review
    from the same user impossible at the database level. The controller also
    flips `hasReviewed` on the user document so the gate never re-appears.
*/
const mongoose = require("mongoose");

const appReviewSchema = new mongoose.Schema(
  {
    reviewerRole: {
      type: String,
      enum: ["employee", "manager"],
      required: true,
    },
    reviewer: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: "reviewerModel",
    },
    // Capitalised model name for refPath population (Employee / Manager).
    reviewerModel: {
      type: String,
      enum: ["Employee", "Manager"],
      required: true,
    },
    // Snapshot of who left it, so the admin list never shows a blank row.
    reviewerName: { type: String },
    reviewerEmail: { type: String },

    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true, maxlength: 2000 },
  },
  { timestamps: true }
);

// One review per user — the entire point is a single, one-time submission.
appReviewSchema.index({ reviewerRole: 1, reviewer: 1 }, { unique: true });

module.exports = mongoose.model("AppReview", appReviewSchema);
