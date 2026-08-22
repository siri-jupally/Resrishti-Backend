/*
  siteController.js — Admin CRUD for client Sites (buildings / branches).

  A Site is one physical location of a Client. The monthly GHG report groups
  its per-building table and chart by Site, so this is the data entry point
  that makes that report possible.

  Endpoints (mounted at /api/admin/sites behind admin `protect`):
    GET    /?clientId=   listSites
    POST   /             createSite
    GET    /:id          getSite
    PATCH  /:id          updateSite
    DELETE /:id          deleteSite   (soft-retires when pickups reference it)

  Plus a read-only client-portal view (mounted separately, see
  clientPortalController.listMySites) so a client can pick which of their
  buildings a pickup is coming from.

  Delete semantics:
  - Hard delete ONLY when no pickup has ever referenced the site. Otherwise
    the site is retired (`isActive: false`). Deleting a referenced site would
    orphan historical pickups and silently change the row labels on GHG
    reports that were already issued — those must stay reproducible.
*/

const mongoose = require("mongoose");
const Site = require("../models/Site");
const Client = require("../models/Client");
const Pickup = require("../models/Pickup");

/** GET /api/admin/sites?clientId=&includeInactive= */
const listSites = async (req, res) => {
    try {
        const filter = {};
        if (req.query.clientId) {
            if (!mongoose.Types.ObjectId.isValid(req.query.clientId)) {
                return res.status(400).json({ message: "Invalid clientId" });
            }
            filter.client = req.query.clientId;
        }
        // Retired sites are hidden unless explicitly asked for — they still
        // exist so historical reports stay readable.
        if (req.query.includeInactive !== "true") filter.isActive = true;

        const sites = await Site.find(filter)
            .sort({ name: 1 })
            .populate("client", "name")
            .lean();

        return res.json({ items: sites, total: sites.length });
    } catch (err) {
        console.error("listSites error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/** POST /api/admin/sites  body: { client, name, description?, address?, contact* } */
const createSite = async (req, res) => {
    try {
        const { client, name } = req.body || {};
        if (!mongoose.Types.ObjectId.isValid(client)) {
            return res.status(400).json({ message: "Valid client is required" });
        }
        if (!name || !String(name).trim()) {
            return res.status(400).json({ message: "Site name is required" });
        }

        const clientDoc = await Client.findById(client).lean();
        if (!clientDoc) return res.status(404).json({ message: "Client not found" });

        const site = await Site.create({
            client,
            name: String(name).trim(),
            description: req.body.description,
            address: req.body.address,
            contactName: req.body.contactName,
            contactPhone: req.body.contactPhone,
        });

        return res.status(201).json({ site });
    } catch (err) {
        if (err && err.code === 11000) {
            return res.status(409).json({
                message: "This client already has a site with that name",
            });
        }
        console.error("createSite error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/** GET /api/admin/sites/:id */
const getSite = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid site id" });
        }
        const site = await Site.findById(id).populate("client", "name").lean();
        if (!site) return res.status(404).json({ message: "Site not found" });

        const pickupCount = await Pickup.countDocuments({ site: id });
        return res.json({ site, pickupCount });
    } catch (err) {
        console.error("getSite error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/** PATCH /api/admin/sites/:id */
const updateSite = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid site id" });
        }
        const site = await Site.findById(id);
        if (!site) return res.status(404).json({ message: "Site not found" });

        // `client` is deliberately NOT reassignable: moving a site between
        // clients would retroactively move tonnage between two clients'
        // issued reports.
        const editable = [
            "name",
            "description",
            "address",
            "contactName",
            "contactPhone",
            "isActive",
        ];
        for (const field of editable) {
            if (Object.prototype.hasOwnProperty.call(req.body || {}, field)) {
                site[field] = req.body[field];
            }
        }

        await site.save();
        return res.json({ site });
    } catch (err) {
        if (err && err.code === 11000) {
            return res.status(409).json({
                message: "This client already has a site with that name",
            });
        }
        console.error("updateSite error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

/** DELETE /api/admin/sites/:id — hard delete only if unreferenced. */
const deleteSite = async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid site id" });
        }
        const site = await Site.findById(id);
        if (!site) return res.status(404).json({ message: "Site not found" });

        const pickupCount = await Pickup.countDocuments({ site: id });
        if (pickupCount > 0) {
            site.isActive = false;
            await site.save();
            return res.json({
                site,
                retired: true,
                message: `Site retired rather than deleted — ${pickupCount} pickup(s) reference it and their reports must stay reproducible.`,
            });
        }

        await site.deleteOne();
        return res.json({ deleted: true, _id: id });
    } catch (err) {
        console.error("deleteSite error:", err.message);
        return res.status(500).json({ message: err.message });
    }
};

module.exports = {
    listSites,
    createSite,
    getSite,
    updateSite,
    deleteSite,
};
