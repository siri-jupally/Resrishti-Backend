/*
  Site model — Client Management module (multi-branch support)

  Purpose:
  - A Site is one physical location/building belonging to a Client. In the
    client's own GHG report these appear as "HDC2", "HDC3", "HDC4", "HDC5" —
    the per-building rows of the emissions table and the comparison chart.
  - Phase 1 shipped with `Client` as a single flat org ("one client = one
    contact, multi-branch deferred to Phase 3" — see Client.js). The monthly
    GHG report is the thing that forces multi-branch to exist: without a Site
    entity there is nothing to group the per-building breakdown by.

  Relationship:
      Client 1 ──── N Site 1 ──── N Pickup

  Pickups carry BOTH `site` (a live ref, for grouping/reporting) and
  `siteNameSnapshot` (frozen at request time). The snapshot is what the
  rendered PDF uses, so renaming a site later never rewrites history on a
  report that was already issued — same reasoning as clientNameSnapshot.

  Deletion:
  - Sites are never hard-deleted once pickups reference them; `isActive: false`
    retires a site while keeping historical reports reproducible. The admin
    controller enforces this.

  Indexes:
  - `{ client: 1, name: 1 }` unique — two buildings of the same client can't
    share a name, otherwise the GHG table would show two identical rows.
  - `{ client: 1, isActive: 1 }` for the "pick a site" dropdowns.
*/

const mongoose = require("mongoose");

const siteSchema = new mongoose.Schema(
    {
        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            required: true,
        },

        // Display name as it should appear in the GHG report rows, e.g. "HDC2".
        // Kept free-text: the client's own building naming is theirs to choose.
        name: { type: String, required: true, trim: true },

        // Optional longer label for internal lists, e.g. "Hyderabad Campus 2".
        description: { type: String, trim: true },

        address: {
            line1: String,
            line2: String,
            city: String,
            state: String,
            postalCode: String,
            country: { type: String, default: "India" },
        },

        // Optional site-level contact (the client's facility manager). Falls
        // back to the Client's main contact when absent.
        contactName: { type: String, trim: true },
        contactPhone: { type: String, trim: true },

        // Soft-retire instead of delete — see header.
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

// A client cannot have two sites with the same name — the GHG per-building
// table keys off the name, so duplicates would render as ambiguous rows.
siteSchema.index({ client: 1, name: 1 }, { unique: true });
siteSchema.index({ client: 1, isActive: 1 });

module.exports = mongoose.model("Site", siteSchema);
