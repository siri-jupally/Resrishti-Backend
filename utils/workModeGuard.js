/*
  workModeGuard — enforces the remote-work policy at check-in.

  Until this existed, `wfhEnabled` and `maxWfhDaysPerMonth` were stored on
  AttendancePolicy and shown in the admin UI but never read by the check-in
  controllers, so an employee could mark themselves WFH or remote every day of
  the month regardless of the configured limits.

  Three gates, applied in order, cheapest first:

    1. Is the mode switched on at all?              (wfhEnabled / remoteEnabled)
    2. Is there an approved request covering today?  (requireApprovalFor*)
    3. Is the employee under their monthly quota?    (max*DaysPerMonth)

  Order matters for the message the employee sees: telling someone "remote work
  is disabled" is more useful than "you have used 5 of 5 days" when the mode is
  off entirely.

  WFO always passes — working from the office is the default and never
  restricted.
*/

const WorkModeRequest = require("../models/WorkModeRequest");

/** Per-mode policy field names, so the two modes share one code path. */
const MODE_CONFIG = {
    WFH: {
        label: "Work from home",
        enabledField: "wfhEnabled",
        limitField: "maxWfhDaysPerMonth",
        approvalField: "requireApprovalForWfh",
        defaultLimit: 8,
    },
    remote: {
        label: "Remote work",
        enabledField: "remoteEnabled",
        limitField: "maxRemoteDaysPerMonth",
        approvalField: "requireApprovalForRemote",
        defaultLimit: 5,
    },
};

/** First and last day of the calendar month containing `dateStr`, inclusive. */
const monthBounds = (dateStr) => {
    const [y, m] = String(dateStr).split("-").map(Number);
    const pad = (n) => String(n).padStart(2, "0");
    const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month
    return { start: `${y}-${pad(m)}-01`, end: `${y}-${pad(m)}-${pad(lastDay)}` };
};

/**
 * Count days this employee has already used in `workMode` during the month
 * containing `date`.
 *
 * `date` itself is excluded: an employee checking in again on a day already
 * recorded as WFH (a second session, or a re-check-in) must not have that day
 * counted twice and be blocked from their own current day.
 */
const countUsedDaysThisMonth = async (Attendance, employeeId, workMode, date) => {
    const { start, end } = monthBounds(date);
    return Attendance.countDocuments({
        employee: employeeId,
        workMode,
        date: { $gte: start, $lte: end, $ne: date },
    });
};

/** Is there an approved request covering `date` for this employee and mode? */
const hasApprovalFor = async (employeeId, workMode, date) =>
    WorkModeRequest.exists({
        employee: employeeId,
        workMode,
        status: "approved",
        startDate: { $lte: date },
        endDate: { $gte: date },
    });

/**
 * Decide whether an employee may check in with the given work mode today.
 *
 * @param {Object}  args
 * @param {Object}  args.policy      AttendancePolicy document (may be null)
 * @param {Object}  args.Attendance  Attendance model, injected so this helper
 *                                   has no opinion about employee vs manager
 * @param {String}  args.employeeId
 * @param {String}  args.workMode    "WFO" | "WFH" | "remote"
 * @param {String}  args.date        YYYY-MM-DD
 * @returns {Promise<{allowed: boolean, status?: number, message?: string}>}
 *          `allowed: true` means proceed. Otherwise `status` and `message` are
 *          ready to return straight to the client.
 */
const checkWorkModeAllowed = async ({ policy, Attendance, employeeId, workMode, date }) => {
    const config = MODE_CONFIG[workMode];

    // WFO, or an unrecognised mode the schema will reject anyway — nothing to enforce.
    if (!config) return { allowed: true };

    // No policy configured yet: allow rather than lock everyone out of check-in.
    if (!policy) return { allowed: true };

    // ---- 1. Mode switched off entirely
    if (policy[config.enabledField] === false) {
        return {
            allowed: false,
            status: 403,
            message: `${config.label} is currently disabled by your organization. Please check in from the office.`,
        };
    }

    // ---- 2. Prior approval required
    if (policy[config.approvalField] !== false) {
        const approved = await hasApprovalFor(employeeId, workMode, date);
        if (!approved) {
            return {
                allowed: false,
                status: 403,
                message: `${config.label} needs approval before you check in. Raise a request for ${date} and ask your manager to approve it.`,
            };
        }
    }

    // ---- 3. Monthly quota. 0 (or a negative value) means "no cap".
    const limit = policy[config.limitField] ?? config.defaultLimit;
    if (limit > 0) {
        const used = await countUsedDaysThisMonth(Attendance, employeeId, workMode, date);
        if (used >= limit) {
            return {
                allowed: false,
                status: 403,
                message: `You have used all ${limit} ${config.label.toLowerCase()} days for this month (${used} used). Please check in from the office.`,
            };
        }
    }

    return { allowed: true };
};

/**
 * Remaining allowance per mode, for display in the employee's attendance screen
 * so they can see where they stand before they try to check in.
 */
const getWorkModeUsage = async ({ policy, Attendance, employeeId, date }) => {
    const usage = {};
    for (const [mode, config] of Object.entries(MODE_CONFIG)) {
        const limit = policy?.[config.limitField] ?? config.defaultLimit;
        const used = await countUsedDaysThisMonth(Attendance, employeeId, mode, date);
        usage[mode] = {
            enabled: policy ? policy[config.enabledField] !== false : true,
            requiresApproval: policy ? policy[config.approvalField] !== false : true,
            limit,
            used,
            remaining: limit > 0 ? Math.max(0, limit - used) : null, // null = uncapped
        };
    }
    return usage;
};

module.exports = {
    MODE_CONFIG,
    checkWorkModeAllowed,
    getWorkModeUsage,
    countUsedDaysThisMonth,
    monthBounds,
};
