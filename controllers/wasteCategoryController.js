/*
  wasteCategoryController.js — admin settings for the waste stream list.

  Mounted at /api/admin/waste-categories behind protectTriage. Reads are open
  to any triage user (a coordinator needs the labels); writes are admin-only,
  because a wrong CO2e factor changes numbers on documents clients keep.

  Nothing here deletes. A stream that is no longer collected is deactivated,
  which hides it from new pickup requests while every pickup, certificate and
  report that already references it keeps resolving.
*/
const WasteCategory = require("../models/WasteCategory");
const { CERTIFICATE_BUCKETS } = require("../models/WasteCategory");
const {
    seedCoreCategories,
    refreshCache,
    CORE_CATEGORIES,
} = require("../utils/wasteCategories");

const adminOnly = (req, res) => {
    if (!req.admin) {
        res.status(403).json({
            message: "Only an admin can change the waste category list",
        });
        return false;
    }
    return true;
};

const stamp = (req, doc) => {
    const actor = req.admin || req.manager;
    doc.updatedByName = actor?.name || actor?.email || "";
    doc.updatedByRole = req.admin ? "Admin" : "Manager";
};

// GET /api/admin/waste-categories?includeInactive=true
//
// Seeds the eleven original streams on first call, so a fresh database and an
// upgraded one look the same without a migration step.
const listWasteCategories = async (req, res) => {
    try {
        await seedCoreCategories();
        const includeInactive = String(req.query.includeInactive) === "true";
        const filter = includeInactive ? {} : { isActive: true };
        const items = await WasteCategory.find(filter)
            .sort({ sortOrder: 1, label: 1 })
            .lean();
        return res.json({ items, total: items.length, buckets: CERTIFICATE_BUCKETS });
    } catch (err) {
        console.error("listWasteCategories error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/admin/waste-categories
// body: { key, label, co2eFactorKgPerKg, certificateBucket, description, sortOrder }
const createWasteCategory = async (req, res) => {
    if (!adminOnly(req, res)) return;
    try {
        const key = String(req.body.key || "")
            .trim()
            .toLowerCase();
        const label = String(req.body.label || "").trim();
        if (!key || !label) {
            return res.status(400).json({ message: "key and label are required" });
        }
        if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(key)) {
            return res.status(400).json({
                message: "key must be lowercase letters, numbers and hyphens (2-40 characters)",
            });
        }
        const clash = await WasteCategory.findOne({ key });
        if (clash) {
            return res.status(409).json({ message: `'${key}' already exists` });
        }

        const bucket = req.body.certificateBucket || "other-dry";
        if (!CERTIFICATE_BUCKETS.includes(bucket)) {
            return res.status(400).json({
                message: `certificateBucket must be one of: ${CERTIFICATE_BUCKETS.join(", ")}`,
            });
        }
        const factor = req.body.co2eFactorKgPerKg;
        if (factor !== undefined && (!Number.isFinite(Number(factor)) || Number(factor) < 0)) {
            return res.status(400).json({ message: "co2eFactorKgPerKg must be zero or more" });
        }

        const created = await WasteCategory.create({
            key,
            label,
            description: String(req.body.description || "").trim() || undefined,
            co2eFactorKgPerKg: factor === undefined ? 0.5 : Number(factor),
            certificateBucket: bucket,
            sortOrder: Number.isFinite(Number(req.body.sortOrder))
                ? Number(req.body.sortOrder)
                : 200,
            isCore: false,
            isActive: true,
            updatedByName: req.admin?.name || req.admin?.email || "",
            updatedByRole: "Admin",
        });
        await refreshCache();
        return res.status(201).json(created);
    } catch (err) {
        console.error("createWasteCategory error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// PATCH /api/admin/waste-categories/:key
//
// `key` itself is never editable — pickups, certificates and reports point at
// it. Renaming is done through `label`.
const updateWasteCategory = async (req, res) => {
    if (!adminOnly(req, res)) return;
    try {
        const category = await WasteCategory.findOne({
            key: String(req.params.key || "").toLowerCase(),
        });
        if (!category) {
            return res.status(404).json({ message: "Waste category not found" });
        }

        if (req.body.label !== undefined) {
            const label = String(req.body.label).trim();
            if (!label) {
                return res.status(400).json({ message: "label cannot be empty" });
            }
            category.label = label;
        }
        if (req.body.description !== undefined) {
            category.description = String(req.body.description).trim();
        }
        if (req.body.co2eFactorKgPerKg !== undefined) {
            const factor = Number(req.body.co2eFactorKgPerKg);
            if (!Number.isFinite(factor) || factor < 0) {
                return res.status(400).json({ message: "co2eFactorKgPerKg must be zero or more" });
            }
            category.co2eFactorKgPerKg = factor;
        }
        if (req.body.certificateBucket !== undefined) {
            if (!CERTIFICATE_BUCKETS.includes(req.body.certificateBucket)) {
                return res.status(400).json({
                    message: `certificateBucket must be one of: ${CERTIFICATE_BUCKETS.join(", ")}`,
                });
            }
            category.certificateBucket = req.body.certificateBucket;
        }
        if (req.body.sortOrder !== undefined && Number.isFinite(Number(req.body.sortOrder))) {
            category.sortOrder = Number(req.body.sortOrder);
        }
        if (req.body.isActive !== undefined) {
            const next = req.body.isActive === true || req.body.isActive === "true";
            if (!next) {
                const remaining = await WasteCategory.countDocuments({
                    isActive: true,
                    key: { $ne: category.key },
                });
                if (remaining === 0) {
                    return res.status(409).json({
                        message: "At least one waste category must stay active",
                    });
                }
            }
            category.isActive = next;
        }

        stamp(req, category);
        await category.save();
        await refreshCache();
        return res.json(category);
    } catch (err) {
        console.error("updateWasteCategory error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// DELETE /api/admin/waste-categories/:key
//
// Only ever removes a custom stream that nothing has been recorded against.
// Core streams, and anything already used, are deactivated instead.
const deleteWasteCategory = async (req, res) => {
    if (!adminOnly(req, res)) return;
    try {
        const Pickup = require("../models/Pickup");
        const key = String(req.params.key || "").toLowerCase();
        const category = await WasteCategory.findOne({ key });
        if (!category) {
            return res.status(404).json({ message: "Waste category not found" });
        }
        if (category.isCore) {
            return res.status(409).json({
                message: "A built-in category cannot be removed — switch it off instead",
            });
        }
        const used = await Pickup.exists({
            $or: [{ "lineItems.stream": key }, { requestedStreams: key }],
        });
        if (used) {
            return res.status(409).json({
                message: "This category is already used on a pickup — switch it off instead",
            });
        }
        await category.deleteOne();
        await refreshCache();
        return res.json({ message: `'${key}' removed`, key });
    } catch (err) {
        console.error("deleteWasteCategory error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

// POST /api/admin/waste-categories/reset-factors
//
// Puts the CO2e factors back to the values shipped with the product, for when
// an edit turns out to be wrong and nobody remembers the old number.
const resetFactors = async (req, res) => {
    if (!adminOnly(req, res)) return;
    try {
        let changed = 0;
        for (const core of CORE_CATEGORIES) {
            const result = await WasteCategory.updateOne(
                { key: core.key, co2eFactorKgPerKg: { $ne: core.co2eFactorKgPerKg } },
                { $set: { co2eFactorKgPerKg: core.co2eFactorKgPerKg } }
            );
            changed += result.modifiedCount || 0;
        }
        await refreshCache();
        return res.json({ message: `Reset ${changed} factor(s) to the shipped values`, changed });
    } catch (err) {
        console.error("resetFactors error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    listWasteCategories,
    createWasteCategory,
    updateWasteCategory,
    deleteWasteCategory,
    resetFactors,
};
