/*
  wasteCategoryRoutes.js — admin settings for the waste stream list.

  Mounted at /api/admin/waste-categories (see server.js). protectTriage lets
  admins and coordinator-tagged managers read the list; the controller limits
  every write to admins.
*/
const express = require("express");
const router = express.Router();

const { protectTriage } = require("../middleware/authTriage");
const {
    listWasteCategories,
    createWasteCategory,
    updateWasteCategory,
    deleteWasteCategory,
    resetFactors,
} = require("../controllers/wasteCategoryController");

// Declared before /:key so the literal path is not read as a key.
router.post("/reset-factors", protectTriage, resetFactors);

router.get("/", protectTriage, listWasteCategories);
router.post("/", protectTriage, createWasteCategory);
router.patch("/:key", protectTriage, updateWasteCategory);
router.delete("/:key", protectTriage, deleteWasteCategory);

module.exports = router;
