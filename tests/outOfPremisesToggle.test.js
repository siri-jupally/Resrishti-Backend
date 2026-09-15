/**
 * Admin toggle: allowOutOfPremisesOfficeCheckIn.
 *
 *   ON  (default) — office check-in from outside premises is saved as pending
 *   OFF           — it is refused outright
 *
 * Drives the real check-in handlers end to end. The selfie upload and push
 * notifications are mocked; the older check-in tests fail precisely because
 * they don't attach a photo, so these supply one.
 */
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

jest.mock("../utils/s3", () => ({
    uploadCheckinPhoto: jest.fn().mockResolvedValue({ key: "checkin-photos/test.jpg", bucket: "test" }),
}));
jest.mock("../utils/push", () => ({
    sendPush: jest.fn().mockResolvedValue({}),
    notifyIfEnabled: jest.fn().mockResolvedValue({}),
}));

const Attendance = require("../models/Attendance");
const ManagerAttendance = require("../models/ManagerAttendance");
const AttendancePolicy = require("../models/AttendancePolicy");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const { checkIn: employeeCheckIn } = require("../controllers/attendanceController");
const { checkIn: managerCheckIn } = require("../controllers/managerSelfAttendanceController");

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

const PHOTO = { buffer: Buffer.from("fake-jpeg"), mimetype: "image/jpeg" };
const OFFICE = { name: "HQ", lat: 17.385, lng: 78.4867, radiusMeters: 200 };
const INSIDE = { lat: 17.385, lng: 78.4867 };
const OUTSIDE = { lat: 17.5, lng: 78.6 }; // well over 10 km away
const today = () => new Date().toISOString().split("T")[0];

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

let manager;
let employee;

beforeEach(async () => {
    await Promise.all([
        Attendance.deleteMany({}),
        ManagerAttendance.deleteMany({}),
        AttendancePolicy.deleteMany({}),
        Employee.deleteMany({}),
        Manager.deleteMany({}),
    ]);
    manager = await Manager.create({ name: "M", email: "m@test.com", password: "secret123" });
    employee = await Employee.create({
        name: "E", email: "e@test.com", password: "secret123", manager: manager._id,
    });
});

const setPolicy = (fields = {}) =>
    AttendancePolicy.create({
        officeLocations: [OFFICE],
        // Keep the late-check-in and WFH gates out of the way of these tests.
        checkInStartTime: "00:00",
        lateThresholdMinutes: 1439,
        requireApprovalForWfh: false,
        ...fields,
    });

const empCheckIn = async (body) => {
    const res = mockRes();
    await employeeCheckIn({ file: PHOTO, body, employee }, res);
    return res;
};

describe("out-of-premises office check-in toggle — employees", () => {
    test("ON by default: outside premises is saved as pending", async () => {
        await setPolicy();
        const res = await empCheckIn({ workMode: "WFO", ...OUTSIDE });
        expect([200, 201]).toContain(res.statusCode);
        expect(res.body.approvalStatus).toBe("pending");
        expect(res.body.locationWithinBoundary).toBe(false);
    });

    test("OFF: outside premises is refused and nothing is saved", async () => {
        await setPolicy({ allowOutOfPremisesOfficeCheckIn: false });
        const res = await empCheckIn({ workMode: "WFO", ...OUTSIDE });
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe("outside_premises");
        expect(await Attendance.countDocuments()).toBe(0);
    });

    test("OFF: no GPS is refused with a location message", async () => {
        await setPolicy({ allowOutOfPremisesOfficeCheckIn: false });
        const res = await empCheckIn({ workMode: "WFO" });
        expect(res.statusCode).toBe(403);
        expect(res.body.code).toBe("location_required");
        expect(res.body.message).toMatch(/location/i);
    });

    test("OFF: on premises still checks in and is auto-approved", async () => {
        await setPolicy({ allowOutOfPremisesOfficeCheckIn: false });
        const res = await empCheckIn({ workMode: "WFO", ...INSIDE });
        expect([200, 201]).toContain(res.statusCode);
        expect(res.body.approvalStatus).toBe("auto-approved");
    });

    test("OFF: no office locations configured does not block anyone", async () => {
        await setPolicy({ allowOutOfPremisesOfficeCheckIn: false, officeLocations: [] });
        const res = await empCheckIn({ workMode: "WFO", ...OUTSIDE });
        expect([200, 201]).toContain(res.statusCode);
    });

    test("OFF: WFH check-ins are unaffected", async () => {
        await setPolicy({ allowOutOfPremisesOfficeCheckIn: false });
        const res = await empCheckIn({ workMode: "WFH", ...OUTSIDE });
        expect([200, 201]).toContain(res.statusCode);
    });

    test("OFF: an additional session from outside premises is refused too", async () => {
        await setPolicy({ allowOutOfPremisesOfficeCheckIn: false, allowMultipleCheckIns: true });
        // A first session today, already checked out.
        await Attendance.create({
            employee: employee._id,
            date: today(),
            status: "present",
            workMode: "WFO",
            approvalStatus: "auto-approved",
            checkIn: { time: new Date(Date.now() - 3 * 3600e3) },
            checkOut: { time: new Date(Date.now() - 3600e3) },
        });
        const res = await empCheckIn({ workMode: "WFO", ...OUTSIDE });
        expect(res.statusCode).toBe(403);
        const record = await Attendance.findOne({ employee: employee._id, date: today() });
        expect(record.approvalStatus).toBe("auto-approved"); // untouched
    });
});

describe("out-of-premises office check-in toggle — managers", () => {
    const mgrCheckIn = async (body) => {
        const res = mockRes();
        await managerCheckIn({ file: PHOTO, body, manager }, res);
        return res;
    };

    test("ON: outside premises is saved as pending", async () => {
        await setPolicy();
        const res = await mgrCheckIn({ workMode: "WFO", ...OUTSIDE });
        expect([200, 201]).toContain(res.statusCode);
        expect(res.body.approvalStatus).toBe("pending");
    });

    test("OFF: outside premises is refused", async () => {
        await setPolicy({ allowOutOfPremisesOfficeCheckIn: false });
        const res = await mgrCheckIn({ workMode: "WFO", ...OUTSIDE });
        expect(res.statusCode).toBe(403);
        expect(await ManagerAttendance.countDocuments()).toBe(0);
    });
});
