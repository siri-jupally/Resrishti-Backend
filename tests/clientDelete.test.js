/**
 * Deleting a client, and what the list shows afterwards.
 *
 * Pressing Delete used to archive the client and leave it sitting in the list,
 * which read as the delete having silently failed. Now: a client with nothing
 * of record behind it is removed outright, one with pickups / certificates /
 * reports is archived because those documents cannot be orphaned, and archived
 * clients are hidden unless they are asked for.
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
}));
jest.mock("../socketHandler", () => ({ getIo: () => ({ to: () => ({ emit: () => {} }) }) }));

const Client = require("../models/Client");
const Pickup = require("../models/Pickup");
const Certificate = require("../models/Certificate");
const Site = require("../models/Site");
const OnboardingToken = require("../models/OnboardingToken");

const clients = require("../controllers/clientController");

let mongod;

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) { res.statusCode = code; return res; },
        json(data) { res.body = data; return res; },
    };
    return res;
}
const mockReq = (o = {}) => ({ body: {}, params: {}, query: {}, ...o });

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

let n = 0;
const makeClient = (fields = {}) => {
    n += 1;
    return Client.create({
        name: `Client ${n}`,
        contactName: "Contact",
        contactEmail: `c${n}@test.com`,
        contactPhone: "9999999999",
        status: "active",
        ...fields,
    });
};

const makePickup = (client) =>
    Pickup.create({
        pickupID: `PU-DEL-${Math.random().toString(16).slice(2, 8).toUpperCase()}`,
        client: client._id,
        clientNameSnapshot: client.name,
        status: "scheduled",
    });

beforeEach(async () => {
    await Promise.all([
        Client.deleteMany({}), Pickup.deleteMany({}), Certificate.deleteMany({}),
        Site.deleteMany({}), OnboardingToken.deleteMany({}),
    ]);
});

const del = async (client) => {
    const res = mockRes();
    await clients.deleteClient(
        mockReq({ params: { id: String(client._id) }, admin: { _id: new mongoose.Types.ObjectId() } }),
        res
    );
    return res;
};

const list = async (query = {}) => {
    const res = mockRes();
    await clients.listClients(mockReq({ query }), res);
    return res;
};

// ───────────────────── a client with no history ─────────────────────

describe("deleting a client with nothing on record", () => {
    test("is a real delete, not an archive", async () => {
        const client = await makeClient();
        const res = await del(client);

        expect(res.statusCode).toBe(200);
        expect(res.body.mode).toBe("deleted");
        expect(await Client.findById(client._id)).toBeNull();
    });

    test("takes the client's own locations and invites with it", async () => {
        const client = await makeClient();
        await Site.create({ client: client._id, name: "HQ", address: "1 Road" });
        await OnboardingToken.create({
            client: client._id,
            token: `tok-${Math.random().toString(16).slice(2)}`,
            expiresAt: new Date(Date.now() + 3600_000),
        });

        await del(client);

        // Orphaned sites would otherwise sit in the collection for good, with
        // no client to reach them from.
        expect(await Site.countDocuments({ client: client._id })).toBe(0);
        expect(await OnboardingToken.countDocuments({ client: client._id })).toBe(0);
    });
});

// ──────────────────── a client with history ────────────────────

describe("deleting a client that has history", () => {
    test("a client with a pickup is archived, not removed", async () => {
        const client = await makeClient();
        await makePickup(client);

        const res = await del(client);

        expect(res.body.mode).toBe("archived");
        expect(res.body.references.pickups).toBe(1);
        const after = await Client.findById(client._id);
        expect(after).not.toBeNull();
        expect(after.status).toBe("churned");
    });

    test("the pickup survives — that is the whole point", async () => {
        const client = await makeClient();
        const pickup = await makePickup(client);

        await del(client);

        expect(await Pickup.findById(pickup._id)).not.toBeNull();
    });

    test("a client with a certificate is archived even with no pickups", async () => {
        const client = await makeClient();
        await Certificate.create({
            certNumber: "CERT-DEL-1",
            revision: 1,
            pickup: new mongoose.Types.ObjectId(),
            client: client._id,
            status: "sent",
            totalKgSnapshot: 10,
            clientNameSnapshot: client.name,
            pickupDateSnapshot: new Date(),
        });

        const res = await del(client);

        expect(res.body.mode).toBe("archived");
        expect(res.body.references.certificates).toBe(1);
    });

    test("an archived client can still be restored", async () => {
        const client = await makeClient({ isOnboardingComplete: true });
        await makePickup(client);
        await del(client);

        const res = mockRes();
        await clients.restoreClient(mockReq({ params: { id: String(client._id) } }), res);

        expect(res.statusCode).toBe(200);
        expect((await Client.findById(client._id)).status).toBe("active");
    });
});

// ───────────────────────── what the list shows ─────────────────────────

describe("the clients list", () => {
    test("leaves archived clients out by default", async () => {
        const live = await makeClient();
        const archived = await makeClient();
        await makePickup(archived);
        await del(archived);

        const res = await list();
        const names = res.body.items.map((c) => c.name);
        expect(names).toContain(live.name);
        expect(names).not.toContain(archived.name);
        expect(res.body.total).toBe(1);
    });

    test("shows them when they are asked for", async () => {
        const archived = await makeClient();
        await makePickup(archived);
        await del(archived);

        const res = await list({ status: "churned" });
        expect(res.body.items.map((c) => c.name)).toEqual([archived.name]);
    });

    test("another status filter still works as before", async () => {
        await makeClient({ status: "active" });
        await makeClient({ status: "paused" });

        const res = await list({ status: "paused" });
        expect(res.body.total).toBe(1);
        expect(res.body.items[0].status).toBe("paused");
    });

    test("a search does not resurface archived clients", async () => {
        const archived = await makeClient({ name: "Findable Archived Co" });
        await makePickup(archived);
        await del(archived);

        const res = await list({ search: "Findable" });
        expect(res.body.total).toBe(0);
    });
});
