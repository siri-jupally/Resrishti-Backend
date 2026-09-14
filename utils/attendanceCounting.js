/*
  attendanceCounting — what counts as worked time.

  A worked day (present / half-day) is held back from days and hours when:

    rejected                                   turned down → never counts
    pending AND locationWithinBoundary=false   out-of-premises check-in still
                                               waiting for a manager or admin

  Everything else counts, including `approved` (an out-of-premises day that was
  approved) and `auto-approved` (on premises, or a mode with nothing to verify).

  Why the rule keys on the out-of-premises flag rather than on "pending" alone:
  the Attendance schema defaults approvalStatus to "pending", so any row written
  without an explicit decision — older data, or records created outside the
  check-in flow — would silently stop counting. The check-in flow only ever
  sets "pending" together with locationWithinBoundary=false (including an office
  check-in with no GPS), so this matches exactly the logins that need approval.

  Before this existed every summary summed `workingHours` regardless of
  approval, so an unapproved out-of-premises day paid out in full.

  Non-worked statuses (leave, holiday, absent, weekend) are not gated here.
*/

const WORKED = new Set(["present", "half-day"]);

/** An out-of-premises check-in still waiting for a decision. */
const isOutOfPremisesPending = (record) =>
    record.approvalStatus === "pending" && record.locationWithinBoundary === false;

/** Does this record's worked time count? */
const isCountedTowardHours = (record) =>
    record.approvalStatus !== "rejected" && !isOutOfPremisesPending(record);

/** Is this a worked day still waiting on a manager or admin? */
const isAwaitingApproval = (record) =>
    WORKED.has(record.status) && isOutOfPremisesPending(record);

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Worked-time totals for a set of attendance records.
 *
 * @returns {{present: number, halfDay: number, totalHours: number,
 *            pendingApproval: number, pendingHours: number, rejected: number}}
 *   `present` / `halfDay` / `totalHours` include only counted days.
 *   `pendingApproval` / `pendingHours` show what would be added on approval.
 */
const summariseWorked = (records) => {
    const out = { present: 0, halfDay: 0, totalHours: 0, pendingApproval: 0, pendingHours: 0, rejected: 0 };
    for (const r of records) {
        if (!WORKED.has(r.status)) continue;
        const hours = r.workingHours || 0;

        if (isCountedTowardHours(r)) {
            if (r.status === "present") out.present++;
            else out.halfDay++;
            out.totalHours += hours;
        } else if (isOutOfPremisesPending(r)) {
            out.pendingApproval++;
            out.pendingHours += hours;
        } else {
            out.rejected++;
        }
    }
    out.totalHours = round2(out.totalHours);
    out.pendingHours = round2(out.pendingHours);
    return out;
};

module.exports = {
    isOutOfPremisesPending,
    isCountedTowardHours,
    isAwaitingApproval,
    summariseWorked,
};
