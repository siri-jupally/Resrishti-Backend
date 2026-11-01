/*
  services/recurringPickupJob.js — materialise recurring pickups.

  A daily job walks every active PickupSchedule and, for each occurrence due
  within the next LEAD_DAYS, creates a normal "requested" Pickup via the shared
  createPickupForClient path — so recurring pickups get the same validation,
  snapshots, pickupID and coordinator push as an ad-hoc client request, and the
  coordinator still accepts/assigns each one.

  Idempotent: a pickup is created at most once per (schedule, occurrence date),
  guarded by lastGeneratedDate AND a Pickup existence check. A failed creation
  does not advance the schedule, so the next run retries. Mirrors statsJob's
  setInterval + unref + boot-run shape (the only other scheduler in the app).
*/
const PickupSchedule = require("../models/PickupSchedule");
const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const { createPickupForClient } = require("./pickupCreation");
const {
    nextOccurrenceOnOrAfter, nextOccurrenceAfter, atMidnight, addDays,
} = require("../utils/recurrence");

const LEAD_DAYS = 5;                 // how far ahead to materialise an occurrence
const MAX_PER_SCHEDULE_PER_RUN = 12; // safety cap against a runaway loop

const ymd = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Generate every due pickup for ONE schedule, up to LEAD_DAYS ahead. Returns the
 * number of pickups created. Advances lastGeneratedDate/nextOccurrence and
 * auto-completes the schedule once its endDate has passed. Safe to call again
 * (e.g. right after a client creates a schedule, to produce the first pickup).
 */
const generateDueForSchedule = async (schedule, { now = new Date() } = {}) => {
    if (!schedule || schedule.status !== "active") return 0;
    const today = atMidnight(now);
    const horizon = addDays(today, LEAD_DAYS);

    const client = await Client.findById(schedule.client);
    if (!client || client.status !== "active") return 0;

    let created = 0;
    // Search after the last generated occurrence, but never before today — the
    // client self-service path refuses backdated requests, and a missed day is
    // simply skipped rather than created late.
    let fromDate = schedule.lastGeneratedDate ? addDays(schedule.lastGeneratedDate, 1) : schedule.startDate;
    if (atMidnight(fromDate) < today) fromDate = today;

    for (let i = 0; i < MAX_PER_SCHEDULE_PER_RUN; i += 1) {
        const occ = nextOccurrenceOnOrAfter(schedule.cadence, schedule.startDate, fromDate);
        if (!occ) break;

        if (schedule.endDate && occ > atMidnight(schedule.endDate)) {
            await PickupSchedule.updateOne({ _id: schedule._id }, { $set: { status: "completed", nextOccurrence: null } });
            break;
        }
        if (occ > horizon) {
            // Not due yet — keep nextOccurrence fresh for the client's display.
            await PickupSchedule.updateOne({ _id: schedule._id }, { $set: { nextOccurrence: occ } });
            break;
        }

        // Never create two pickups for the same schedule + occurrence date.
        const dup = await Pickup.exists({
            recurringScheduleId: schedule._id,
            requestedDate: { $gte: occ, $lt: addDays(occ, 1) },
        });
        if (!dup) {
            try {
                const pickup = await createPickupForClient({
                    client,
                    requestedDate: ymd(occ),
                    requestedStreams: schedule.requestedStreams,
                    clientNotes: schedule.clientNotes,
                    siteId: schedule.site ? String(schedule.site) : undefined,
                });
                await Pickup.updateOne({ _id: pickup._id }, { $set: { recurringScheduleId: schedule._id } });
                created += 1;
            } catch (err) {
                // Leave lastGeneratedDate untouched so the next run retries.
                console.error(`Recurring gen failed (schedule ${schedule._id}, ${ymd(occ)}):`, err.message);
                break;
            }
        }

        const next = nextOccurrenceAfter(schedule.cadence, schedule.startDate, occ);
        await PickupSchedule.updateOne(
            { _id: schedule._id },
            { $set: { lastGeneratedDate: occ, nextOccurrence: next }, $inc: { generatedCount: dup ? 0 : 1 } }
        );
        schedule.lastGeneratedDate = occ; // keep local copy in sync for the loop
        fromDate = addDays(occ, 1);
    }
    return created;
};

/** Walk every active schedule. Best-effort per schedule. */
const runRecurringPickups = async ({ now = new Date() } = {}) => {
    const schedules = await PickupSchedule.find({ status: "active" });
    let created = 0;
    for (const s of schedules) {
        try {
            created += await generateDueForSchedule(s, { now });
        } catch (err) {
            console.error(`Recurring schedule ${s._id} run error:`, err.message);
        }
    }
    return { created, schedules: schedules.length };
};

let _handle = null;
const startRecurringPickupJob = () => {
    if (_handle) return;
    runRecurringPickups().catch((e) => console.error("Recurring job (boot) error:", e.message));
    _handle = setInterval(() => {
        runRecurringPickups().catch((e) => console.error("Recurring job error:", e.message));
    }, 24 * 60 * 60 * 1000);
    _handle.unref();
};
const stopRecurringPickupJob = () => {
    if (_handle) { clearInterval(_handle); _handle = null; }
};

module.exports = {
    generateDueForSchedule,
    runRecurringPickups,
    startRecurringPickupJob,
    stopRecurringPickupJob,
    LEAD_DAYS,
};
