/**
 * Backdating a pickup.
 *
 * Staff can date a pickup in the past to record a collection that already
 * happened. A client requesting their own pickup cannot, whatever they post —
 * that is the guard worth pinning down, because the flag travels in the request
 * body and the two flows share one creation service.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));
jest.mock("../utils/s3", () => ({
    uploadPickupEvidence: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    uploadFile: jest.fn().mockResolvedValue({ key: "k", bucket: "b" }),
    getS3Client: jest.fn(),
    deleteS3Object: jest.fn().mockResolvedValue({}),
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Pickup = require("../models/Pickup");
const Client = require("../models/Client");
const { createPickupForClient } = require("../services/pickupCreation");

let mongod;
let client;

const ACTOR = { userType: "Employee", userId: new mongoose.Types.ObjectId(), name: "Agent A" };

const dayOffset = (n) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
};
const dayOf = (iso) => new Date(iso).toISOString().slice(0, 10);

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
    client = await Client.create({
        name: "Acme Waste", contactName: "A", contactEmail: "a@test.com",
        contactPhone: "9999999999", status: "active",
        billingAddress: { line1: "1 Road", city: "Hyderabad" },
    });
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});
beforeEach(async () => { await Pickup.deleteMany({}); });

const create = (opts) =>
    createPickupForClient({
        client,
        requestedStreams: ["plastic"],
        ...opts,
    });

// ───────────────────────── staff backdating ─────────────────────────

describe("a staff member recording a past collection", () => {
    test("can date it in the past with the flag", async () => {
        const when = dayOffset(-5);
        const pickup = await create({
            requestedDate: when,
            createdByActor: ACTOR,
            assignToActor: true,
            allowPastDate: true,
        });

        expect(dayOf(pickup.requestedDate)).toBe(when);
        // Self-assign mirrors acceptPickup, so the schedule follows the request.
        expect(dayOf(pickup.scheduledDate)).toBe(when);
    });

    test("the audit entry says it was backdated", async () => {
        const pickup = await create({
            requestedDate: dayOffset(-3),
            createdByActor: ACTOR,
            assignToActor: true,
            allowPastDate: true,
        });

        expect(pickup.evidence[0].notes).toMatch(/backdated/i);
    });

    test("today is not marked as backdated", async () => {
        const pickup = await create({
            requestedDate: dayOffset(0),
            createdByActor: ACTOR,
            assignToActor: true,
            allowPastDate: true,
        });

        expect(pickup.evidence[0].notes).not.toMatch(/backdated/i);
    });

    test("without the flag a past date is still refused", async () => {
        await expect(
            create({ requestedDate: dayOffset(-1), createdByActor: ACTOR, assignToActor: true })
        ).rejects.toThrow(/cannot be in the past/i);
    });

    test("a future date still works, flag or no flag", async () => {
        const when = dayOffset(4);
        for (const allowPastDate of [true, false]) {
            const pickup = await create({
                requestedDate: when, createdByActor: ACTOR, assignToActor: true, allowPastDate,
            });
            expect(dayOf(pickup.requestedDate)).toBe(when);
        }
    });

    test("a mistyped year is caught by the one-year floor", async () => {
        const tenYearsBack = new Date();
        tenYearsBack.setFullYear(tenYearsBack.getFullYear() - 10);
        await expect(
            create({
                requestedDate: tenYearsBack.toISOString().slice(0, 10),
                createdByActor: ACTOR,
                assignToActor: true,
                allowPastDate: true,
            })
        ).rejects.toThrow(/more than 1 year/i);
    });

    test("just inside a year back is allowed", async () => {
        const d = new Date();
        d.setHours(12, 0, 0, 0);
        d.setFullYear(d.getFullYear() - 1);
        d.setDate(d.getDate() + 2);          // 2 days inside the floor
        const when = d.toISOString().slice(0, 10);

        const pickup = await create({
            requestedDate: when, createdByActor: ACTOR, assignToActor: true, allowPastDate: true,
        });
        expect(dayOf(pickup.requestedDate)).toBe(when);
    });
});

// ───────────────────── the client can never backdate ─────────────────────

describe("a client requesting their own pickup", () => {
    test("cannot backdate even when the flag is posted", async () => {
        // No createdByActor — this is the client self-service path. The flag
        // must be ignored rather than trusted.
        await expect(
            create({ requestedDate: dayOffset(-1), allowPastDate: true })
        ).rejects.toThrow(/cannot be in the past/i);
    });

    test("today and later are unaffected", async () => {
        for (const n of [0, 1, 30]) {
            const pickup = await create({ requestedDate: dayOffset(n) });
            expect(dayOf(pickup.requestedDate)).toBe(dayOffset(n));
            expect(pickup.status).toBe("requested");
            // The client path writes no audit entry, as before.
            expect(pickup.evidence.length).toBe(0);
        }
    });
});
