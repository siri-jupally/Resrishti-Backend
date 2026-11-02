/*
  Client recurring pickups — schedule creation/validation + the generation job.
  The job reuses services/pickupCreation (mocked side-effects only), so a
  generated pickup is a real "requested" pickup linked to its schedule.
*/
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({ sendPush: jest.fn().mockResolvedValue({}), notifyIfEnabled: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/s3", () => ({ uploadPickupEvidence: jest.fn(), uploadFile: jest.fn(), getS3Client: jest.fn(() => ({ send: jest.fn() })) }));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const PickupSchedule = require("../models/PickupSchedule");
const wasteCategories = require("../utils/wasteCategories");
const ctrl = require("../controllers/clientPortalScheduleController");
const { generateDueForSchedule, LEAD_DAYS } = require("../services/recurringPickupJob");
const MAX_PER_RUN = 12; // mirrors MAX_PER_SCHEDULE_PER_RUN safety cap in the job

let mongod, client;
const mockRes = () => { const r = { statusCode: 200, body: null, status(c) { r.statusCode = c; return r; }, json(d) { r.body = d; return r; } }; return r; };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const todayWeekday = () => new Date().getDay();

beforeAll(async () => { mongod = await MongoMemoryServer.create(); await mongoose.connect(mongod.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongod.stop(); });
beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.all([Pickup.deleteMany({}), Client.deleteMany({}), PickupSchedule.deleteMany({})]);
    await wasteCategories.initWasteCategories(); // seeds "plastic", "paper", ...
    client = await Client.create({ name: "Acme", contactName: "A", contactEmail: "a@acme.com", contactPhone: "1", status: "active", isOnboardingComplete: true, billingAddress: { line1: "1 St", city: "Hyd", state: "TG" } });
});

const create = async (body) => { const res = mockRes(); await ctrl.createSchedule({ client, body }, res); return res; };

// A client schedule is created 'pending' and waits for admin approval; approval
// flips it to 'active', which is the only status the generation engine runs on.
// The engine reads cadence + startDate off the row, so flipping the status here
// reproduces the post-approval state without the rest of the approve plumbing.
const activate = async (id) => {
    await PickupSchedule.updateOne({ _id: id }, { $set: { status: "active" } });
    return PickupSchedule.findById(id);
};

describe("createSchedule — validation", () => {
    it("rejects a bad cadence", async () => {
        const res = await create({ cadence: { type: "yearly" }, requestedStreams: ["plastic"] });
        expect(res.statusCode).toBe(400);
    });
    it("rejects an unknown stream", async () => {
        const res = await create({ cadence: { type: "weekly", weekday: 1 }, requestedStreams: ["unobtanium"] });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/Invalid stream/);
    });
    it("rejects a start date in the past", async () => {
        const res = await create({ cadence: { type: "weekly", weekday: 1 }, requestedStreams: ["plastic"], startDate: "2020-01-01" });
        expect(res.statusCode).toBe(400);
        expect(res.body.message).toMatch(/past/i);
    });
});

describe("createSchedule — generation", () => {
    it("is created pending, then generates the first due pickup once active (linked, requested)", async () => {
        const res = await create({ cadence: { type: "weekly", weekday: todayWeekday() }, requestedStreams: ["plastic", "paper"] });
        expect(res.statusCode).toBe(201);
        expect(res.body.status).toBe("pending"); // client schedules await admin approval
        expect(await Pickup.countDocuments({ recurringScheduleId: res.body._id })).toBe(0); // nothing until active

        const schedule = await activate(res.body._id);
        await generateDueForSchedule(schedule);

        const pickups = await Pickup.find({ recurringScheduleId: res.body._id }).sort({ requestedDate: 1 });
        // Weekly: today plus one per week inside the LEAD_DAYS horizon.
        expect(pickups).toHaveLength(Math.floor(LEAD_DAYS / 7) + 1);
        expect(pickups[0].status).toBe("requested");
        expect(pickups[0].requestedStreams).toEqual(["plastic", "paper"]);
        expect(ymd(pickups[0].requestedDate)).toBe(ymd(new Date())); // the first is due today
    });

    it("is idempotent — re-running makes no duplicate", async () => {
        const res = await create({ cadence: { type: "weekly", weekday: todayWeekday() }, requestedStreams: ["plastic"] });
        const schedule = await activate(res.body._id);
        await generateDueForSchedule(schedule);
        const afterFirst = await Pickup.countDocuments({ recurringScheduleId: res.body._id });
        await generateDueForSchedule(schedule);
        expect(await Pickup.countDocuments({ recurringScheduleId: res.body._id })).toBe(afterFirst); // unchanged
    });

    it("materialises occurrences within the lead window, capped per run (daily)", async () => {
        const res = await create({ cadence: { type: "everyNDays", intervalDays: 1 }, requestedStreams: ["plastic"] });
        expect(res.statusCode).toBe(201);
        const schedule = await activate(res.body._id);
        await generateDueForSchedule(schedule);
        // Daily would be LEAD_DAYS+1 occurrences, but one run is capped at MAX_PER_RUN.
        expect(await Pickup.countDocuments({ recurringScheduleId: res.body._id })).toBe(Math.min(LEAD_DAYS + 1, MAX_PER_RUN));
    });

    it("stops at endDate and marks the schedule completed", async () => {
        const today = ymd(new Date());
        const res = await create({ cadence: { type: "everyNDays", intervalDays: 1 }, requestedStreams: ["plastic"], startDate: today, endDate: today });
        expect(res.statusCode).toBe(201);
        const schedule = await activate(res.body._id);
        await generateDueForSchedule(schedule);
        expect(await Pickup.countDocuments({ recurringScheduleId: res.body._id })).toBe(1); // only today
        const fresh = await PickupSchedule.findById(res.body._id);
        expect(fresh.status).toBe("completed");
    });
});

describe("pause / resume / cancel", () => {
    it("pause stops generation; resume catches up; cancel is terminal", async () => {
        const created = await create({ cadence: { type: "everyNDays", intervalDays: 1 }, requestedStreams: ["plastic"] });
        const id = created.body._id;
        const active = await activate(id);          // admin approval → active
        await generateDueForSchedule(active);       // materialise the first run

        // pause
        const p = mockRes(); await ctrl.pauseSchedule({ client, params: { id } }, p);
        expect(p.statusCode).toBe(200);
        expect(p.body.status).toBe("paused");
        const before = await Pickup.countDocuments({ recurringScheduleId: id });
        const sched = await PickupSchedule.findById(id);
        expect(await generateDueForSchedule(sched)).toBe(0); // paused → nothing
        expect(await Pickup.countDocuments({ recurringScheduleId: id })).toBe(before);

        // resume
        const r = mockRes(); await ctrl.resumeSchedule({ client, params: { id } }, r);
        expect(r.statusCode).toBe(200);
        expect(r.body.status).toBe("active");

        // cancel
        const c = mockRes(); await ctrl.cancelSchedule({ client, params: { id } }, c);
        expect(c.statusCode).toBe(200);
        expect(c.body.status).toBe("cancelled");
        const c2 = mockRes(); await ctrl.cancelSchedule({ client, params: { id } }, c2);
        expect(c2.statusCode).toBe(409);
    });

    it("a client cannot touch another client's schedule", async () => {
        const created = await create({ cadence: { type: "weekly", weekday: 1 }, requestedStreams: ["plastic"] });
        const other = await Client.create({ name: "Beta", contactName: "B", contactEmail: "b@beta.com", contactPhone: "2", status: "active", isOnboardingComplete: true });
        const res = mockRes();
        await ctrl.cancelSchedule({ client: other, params: { id: created.body._id } }, res);
        expect(res.statusCode).toBe(404);
    });
});
