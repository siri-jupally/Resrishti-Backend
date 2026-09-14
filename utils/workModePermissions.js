/*
  workModePermissions — which attendance modes a person may use.

  Resolution order, first match wins:
    1. The person's own `workModesOverride`, if it has any entries.
    2. Their job role's `allowedWorkModes`.
    3. Unassigned — every mode.

  Why unassigned means "every mode" rather than "office only":
  - Before this existed, everyone could pick any mode. Defaulting to office-only
    would lock out every current WFH / remote user the moment it deploys, before
    an admin has had a chance to set anything. The admin tightens access by
    assigning roles; the admin UI lists who is still unassigned.

  This only decides whether a mode is *offered*. The org-wide remote-work
  policy (limits, approval) is enforced separately in utils/workModeGuard.js.
*/
const JobRole = require("../models/JobRole");
const { WORK_MODES } = require("../models/JobRole");

const MODE_LABELS = { WFO: "Office", WFH: "Work from home", remote: "Remote" };

const clean = (modes) =>
    Array.isArray(modes) ? [...new Set(modes.filter((m) => WORK_MODES.includes(m)))] : [];

/**
 * @param {Object} person  Employee or Manager document (jobRoleId may be
 *                         populated or a bare ObjectId)
 * @returns {Promise<{modes: string[], source: "override"|"role"|"unassigned", roleName: string|null}>}
 */
const resolveAllowedWorkModes = async (person) => {
    const override = clean(person?.workModesOverride);
    let role = person?.jobRoleId;

    // Accept either a populated role or a bare id.
    if (role && !role.allowedWorkModes) {
        role = await JobRole.findById(role).select("name allowedWorkModes").lean();
    }
    const roleName = role?.name || null;

    if (override.length) return { modes: override, source: "override", roleName };

    const roleModes = clean(role?.allowedWorkModes);
    if (roleModes.length) return { modes: roleModes, source: "role", roleName };

    return { modes: [...WORK_MODES], source: "unassigned", roleName };
};

/**
 * Refusal payload for a mode this person may not use, or null if allowed.
 * Shaped to return straight to the client.
 */
const checkModePermitted = async (person, workMode) => {
    const { modes, roleName } = await resolveAllowedWorkModes(person);
    if (modes.includes(workMode)) return null;
    const allowed = modes.map((m) => MODE_LABELS[m]).join(", ");
    return {
        status: 403,
        message:
            `${MODE_LABELS[workMode] || workMode} check-in isn't available for your ` +
            `${roleName ? `role (${roleName})` : "account"}. You can check in with: ${allowed}.`,
        allowedWorkModes: modes,
    };
};

module.exports = {
    MODE_LABELS,
    resolveAllowedWorkModes,
    checkModePermitted,
};
