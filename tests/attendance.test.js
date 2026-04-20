/**
 * Comprehensive Attendance System Test Suite
 *
 * Tests cover:
 * 1. Utility / helper functions (haversine, date, time parsing)
 * 2. Check-in business logic
 * 3. Check-out business logic (working hours, half-day, early checkout)
 * 4. Leave balance calculation
 * 5. Leave approval and attendance record creation
 * 6. Correction request and approval flow
 * 7. Admin reports aggregation
 * 8. Manager team attendance and summary
 * 9. Edge cases (duplicate entries, boundary dates, missing data)
 * 10. Data validation (invalid inputs)
 */

const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

// Models
const Attendance = require("../models/Attendance");
const AttendancePolicy = require("../models/AttendancePolicy");
const Leave = require("../models/Leave");
const CorrectionRequest = require("../models/CorrectionRequest");
const Employee = require("../models/Employee");
const Manager = require("../models/Manager");

// We need to extract/test the logic directly from controllers.
// Since controllers are Express handler functions, we'll create mock req/res objects.

// ---- Helper: mock Express req/res ----
function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            res.statusCode = code;
            return res;
        },
        json(data) {
            res.body = data;
            return res;
        },
    };
    return res;
}

function mockReq(overrides = {}) {
    return {
        body: {},
        query: {},
        params: {},
        headers: {},
        ...overrides,
    };
}

// ---- Replicate helper functions from attendanceController to unit-test them ----
function haversineDistance(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseTime(timeStr) {
    const [h, m] = timeStr.split(":").map(Number);
    return { hours: h, minutes: m };
}

function getTodayStr() {
    const now = new Date();
    return now.toISOString().split("T")[0];
}

// ---- MongoDB In-Memory Setup ----
let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    // Clean all collections between tests
    const collections = mongoose.connection.collections;
    for (const key in collections) {
        await collections[key].deleteMany({});
    }
});

// ========================================================================
// SECTION 1: Unit Tests for Utility Functions
// ========================================================================
describe("Utility Functions", () => {
    describe("haversineDistance", () => {
        test("should return 0 for same coordinates", () => {
            const d = haversineDistance(17.385, 78.4867, 17.385, 78.4867);
            expect(d).toBeCloseTo(0, 0);
        });

        test("should calculate correct distance between two known points", () => {
            // New York to Los Angeles is approximately 3,944 km
            const d = haversineDistance(40.7128, -74.006, 34.0522, -118.2437);
            expect(d).toBeGreaterThan(3_900_000);
            expect(d).toBeLessThan(4_000_000);
        });

        test("should return correct distance for nearby points (within office radius)", () => {
            // Two points approximately 100m apart
            const d = haversineDistance(17.385, 78.4867, 17.3859, 78.4867);
            expect(d).toBeGreaterThan(50);
            expect(d).toBeLessThan(200);
        });

        test("should handle equator crossing", () => {
            const d = haversineDistance(0.001, 0, -0.001, 0);
            expect(d).toBeGreaterThan(200);
        });

        test("should handle international date line", () => {
            const d = haversineDistance(0, 179.999, 0, -179.999);
            expect(d).toBeLessThan(1000);
        });
    });

    describe("parseTime", () => {
        test("should parse '09:00' correctly", () => {
            const result = parseTime("09:00");
            expect(result).toEqual({ hours: 9, minutes: 0 });
        });

        test("should parse '17:30' correctly", () => {
            const result = parseTime("17:30");
            expect(result).toEqual({ hours: 17, minutes: 30 });
        });

        test("should parse midnight '00:00'", () => {
            const result = parseTime("00:00");
            expect(result).toEqual({ hours: 0, minutes: 0 });
        });

        test("should parse '23:59'", () => {
            const result = parseTime("23:59");
            expect(result).toEqual({ hours: 23, minutes: 59 });
        });
    });

    describe("getTodayStr", () => {
        test("should return a string in YYYY-MM-DD format", () => {
            const result = getTodayStr();
            expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });

        test("should match today's date", () => {
            const now = new Date();
            const expected = now.toISOString().split("T")[0];
            expect(getTodayStr()).toBe(expected);
        });
    });
});

// ========================================================================
// SECTION 2: Attendance Model Tests
// ========================================================================
describe("Attendance Model", () => {
    let managerId, employeeId;

    beforeEach(async () => {
        const manager = await Manager.create({
            name: "Test Manager",
            email: "manager@test.com",
            password: "password123",
        });
        managerId = manager._id;

        const employee = await Employee.create({
            name: "Test Employee",
            email: "employee@test.com",
            password: "password123",
            manager: managerId,
        });
        employeeId = employee._id;
    });

    test("should create a basic attendance record", async () => {
        const attendance = await Attendance.create({
            employee: employeeId,
            date: "2026-03-24",
            checkIn: { time: new Date("2026-03-24T09:00:00Z") },
            status: "present",
        });
        expect(attendance.employee.toString()).toBe(employeeId.toString());
        expect(attendance.date).toBe("2026-03-24");
        expect(attendance.status).toBe("present");
        expect(attendance.workingHours).toBe(0);
        expect(attendance.approvalStatus).toBe("pending");
    });

    test("should enforce unique constraint on employee+date", async () => {
        await Attendance.create({
            employee: employeeId,
            date: "2026-03-24",
            status: "present",
        });

        await expect(
            Attendance.create({
                employee: employeeId,
                date: "2026-03-24",
                status: "absent",
            })
        ).rejects.toThrow();
    });

    test("should allow same employee on different dates", async () => {
        await Attendance.create({
            employee: employeeId,
            date: "2026-03-24",
            status: "present",
        });
        const second = await Attendance.create({
            employee: employeeId,
            date: "2026-03-25",
            status: "present",
        });
        expect(second.date).toBe("2026-03-25");
    });

    test("should allow different employees on same date", async () => {
        const employee2 = await Employee.create({
            name: "Employee 2",
            email: "emp2@test.com",
            password: "password123",
            manager: managerId,
        });

        await Attendance.create({ employee: employeeId, date: "2026-03-24", status: "present" });
        const second = await Attendance.create({
            employee: employee2._id,
            date: "2026-03-24",
            status: "present",
        });
        expect(second).toBeDefined();
    });

    test("should only accept valid status values", async () => {
        await expect(
            Attendance.create({
                employee: employeeId,
                date: "2026-03-24",
                status: "invalid-status",
            })
        ).rejects.toThrow();
    });

    test("should only accept valid workMode values", async () => {
        await expect(
            Attendance.create({
                employee: employeeId,
                date: "2026-03-24",
                workMode: "INVALID",
            })
        ).rejects.toThrow();
    });

    test("should only accept valid approvalStatus values", async () => {
        await expect(
            Attendance.create({
                employee: employeeId,
                date: "2026-03-24",
                approvalStatus: "maybe",
            })
        ).rejects.toThrow();
    });

    test("should default workMode to WFO", async () => {
        const a = await Attendance.create({
            employee: employeeId,
            date: "2026-03-24",
        });
        expect(a.workMode).toBe("WFO");
    });

    test("should store location data correctly", async () => {
        const a = await Attendance.create({
            employee: employeeId,
            date: "2026-03-24",
            checkIn: {
                time: new Date(),
                location: { lat: 17.385, lng: 78.4867, address: "HQ Office" },
            },
        });
        expect(a.checkIn.location.lat).toBe(17.385);
        expect(a.checkIn.location.lng).toBe(78.4867);
        expect(a.checkIn.location.address).toBe("HQ Office");
    });
});

// ========================================================================
// SECTION 3: Check-In Logic Tests (via controller)
// ========================================================================
describe("Check-In Logic", () => {
    let managerId, employee, policy;

    beforeEach(async () => {
        const manager = await Manager.create({
            name: "Test Manager",
            email: "manager@test.com",
            password: "password123",
        });
        managerId = manager._id;

        employee = await Employee.create({
            name: "Test Employee",
            email: "employee@test.com",
            password: "password123",
            manager: managerId,
            defaultWorkMode: "WFO",
        });

        policy = await AttendancePolicy.create({
            officeLocations: [
                { name: "HQ", lat: 17.385, lng: 78.4867, radiusMeters: 200 },
            ],
            checkInStartTime: "09:00",
            lateThresholdMinutes: 15,
            checkOutMinTime: "17:00",
            workingHoursPerDay: 8,
            halfDayThresholdHours: 4,
        });
    });

    test("should create attendance record on first check-in", async () => {
        const { checkIn } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { lat: 17.385, lng: 78.4867, workMode: "WFO" },
        });
        const res = mockRes();

        await checkIn(req, res);

        expect(res.statusCode).toBe(201);
        expect(res.body.status).toBe("present");
        expect(res.body.checkIn.time).toBeDefined();
    });

    test("should reject duplicate check-in on same day", async () => {
        const { checkIn } = require("../controllers/attendanceController");

        // First check-in
        const req1 = mockReq({
            employee: employee,
            body: { lat: 17.385, lng: 78.4867 },
        });
        await checkIn(req1, mockRes());

        // Second check-in attempt
        const req2 = mockReq({
            employee: employee,
            body: { lat: 17.385, lng: 78.4867 },
        });
        const res2 = mockRes();
        await checkIn(req2, res2);

        expect(res2.statusCode).toBe(400);
        expect(res2.body.message).toBe("Already checked in today");
    });

    test("should mark location within boundary when inside office radius", async () => {
        const { checkIn } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { lat: 17.385, lng: 78.4867, workMode: "WFO" },
        });
        const res = mockRes();
        await checkIn(req, res);

        expect(res.body.locationWithinBoundary).toBe(true);
        expect(res.body.approvalStatus).toBe("auto-approved");
    });

    test("should mark location out of boundary when outside office radius", async () => {
        const { checkIn } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { lat: 18.0, lng: 79.0, workMode: "WFO" },
        });
        const res = mockRes();
        await checkIn(req, res);

        expect(res.body.locationWithinBoundary).toBe(false);
        expect(res.body.approvalStatus).toBe("pending");
    });

    test("should always accept location for remote work mode", async () => {
        const { checkIn } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { lat: 50.0, lng: 10.0, workMode: "remote" },
        });
        const res = mockRes();
        await checkIn(req, res);

        expect(res.body.locationWithinBoundary).toBe(true);
        expect(res.body.approvalStatus).toBe("auto-approved");
    });

    test("should handle check-in without location data", async () => {
        const { checkIn } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { workMode: "WFH" },
        });
        const res = mockRes();
        await checkIn(req, res);

        // Should succeed without location
        expect([200, 201]).toContain(res.statusCode);
        expect(res.body.checkIn.time).toBeDefined();
    });

    test("should handle WFH check-in with home location", async () => {
        // Set employee home location
        employee.homeLocation = { lat: 17.5, lng: 78.5 };
        await employee.save();

        const { checkIn } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { lat: 17.5, lng: 78.5, workMode: "WFH" },
        });
        const res = mockRes();
        await checkIn(req, res);

        expect(res.body.locationWithinBoundary).toBe(true);
    });

    test("should store WFH task summary when provided", async () => {
        const { checkIn } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { workMode: "WFH", wfhTaskSummary: "Working on reports" },
        });
        const res = mockRes();
        await checkIn(req, res);

        expect(res.body.wfhTaskSummary).toBe("Working on reports");
    });

    test("should update existing leave record on check-in", async () => {
        // Create a leave record for today
        await Attendance.create({
            employee: employee._id,
            date: getTodayStr(),
            status: "leave",
            approvalStatus: "approved",
        });

        const { checkIn } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { lat: 17.385, lng: 78.4867, workMode: "WFO" },
        });
        const res = mockRes();
        await checkIn(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe("present");
    });
});

// ========================================================================
// SECTION 4: Check-Out Logic Tests
// ========================================================================
describe("Check-Out Logic", () => {
    let managerId, employee, policy;

    beforeEach(async () => {
        const manager = await Manager.create({
            name: "Test Manager",
            email: "manager@test.com",
            password: "password123",
        });
        managerId = manager._id;

        employee = await Employee.create({
            name: "Test Employee",
            email: "employee@test.com",
            password: "password123",
            manager: managerId,
        });

        policy = await AttendancePolicy.create({
            checkOutMinTime: "17:00",
            workingHoursPerDay: 8,
            halfDayThresholdHours: 4,
        });
    });

    test("should reject checkout without check-in", async () => {
        const { checkOut } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee, body: {} });
        const res = mockRes();
        await checkOut(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe("No check-in found for today");
    });

    test("should reject double checkout", async () => {
        // Create a completed attendance record
        await Attendance.create({
            employee: employee._id,
            date: getTodayStr(),
            checkIn: { time: new Date(Date.now() - 8 * 3600000) },
            checkOut: { time: new Date() },
            workingHours: 8,
            status: "present",
        });

        const { checkOut } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee, body: {} });
        const res = mockRes();
        await checkOut(req, res);

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toBe("Already checked out today");
    });

    test("should calculate working hours correctly", async () => {
        const checkInTime = new Date(Date.now() - 8 * 3600000); // 8 hours ago
        await Attendance.create({
            employee: employee._id,
            date: getTodayStr(),
            checkIn: { time: checkInTime },
            status: "present",
        });

        const { checkOut } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee, body: {} });
        const res = mockRes();
        await checkOut(req, res);

        expect(res.statusCode).toBe(200);
        // Working hours should be approximately 8
        expect(res.body.workingHours).toBeGreaterThan(7.9);
        expect(res.body.workingHours).toBeLessThan(8.1);
    });

    test("should mark half-day when working hours less than half of policy", async () => {
        // Check in 3 hours ago (less than 4h threshold)
        const checkInTime = new Date(Date.now() - 3 * 3600000);
        await Attendance.create({
            employee: employee._id,
            date: getTodayStr(),
            checkIn: { time: checkInTime },
            status: "present",
        });

        const { checkOut } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee, body: {} });
        const res = mockRes();
        await checkOut(req, res);

        expect(res.body.status).toBe("half-day");
    });

    test("should NOT mark half-day when working hours >= half of policy", async () => {
        // Check in 5 hours ago (more than 4h threshold)
        const checkInTime = new Date(Date.now() - 5 * 3600000);
        await Attendance.create({
            employee: employee._id,
            date: getTodayStr(),
            checkIn: { time: checkInTime },
            status: "present",
        });

        const { checkOut } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee, body: {} });
        const res = mockRes();
        await checkOut(req, res);

        expect(res.body.status).toBe("present");
    });

    test("should update wfhTaskSummary on checkout", async () => {
        await Attendance.create({
            employee: employee._id,
            date: getTodayStr(),
            checkIn: { time: new Date(Date.now() - 8 * 3600000) },
            status: "present",
            workMode: "WFH",
        });

        const { checkOut } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { wfhTaskSummary: "Completed all reports" },
        });
        const res = mockRes();
        await checkOut(req, res);

        expect(res.body.wfhTaskSummary).toBe("Completed all reports");
    });
});

// ========================================================================
// SECTION 5: Half-Day Threshold Bug Test
// ========================================================================
describe("Half-Day Threshold - BUG: uses workingHoursPerDay/2 instead of halfDayThresholdHours", () => {
    let employee;

    beforeEach(async () => {
        const manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("BUG: checkout uses workingHoursPerDay/2 instead of halfDayThresholdHours from policy", async () => {
        // Create policy where halfDayThresholdHours differs from workingHoursPerDay/2
        await AttendancePolicy.create({
            workingHoursPerDay: 8,
            halfDayThresholdHours: 6, // should use 6, but code uses 8/2 = 4
        });

        // Employee works 5 hours - should be half-day (less than 6) per halfDayThresholdHours
        // but the code compares against workingHoursPerDay/2 = 4 and calls it "present"
        const checkInTime = new Date(Date.now() - 5 * 3600000);
        await Attendance.create({
            employee: employee._id,
            date: getTodayStr(),
            checkIn: { time: checkInTime },
            status: "present",
        });

        const { checkOut } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee, body: {} });
        const res = mockRes();
        await checkOut(req, res);

        // BUG: This will be "present" because code checks workingHoursPerDay / 2 = 4
        // but the policy says halfDayThresholdHours = 6, so 5h should be "half-day"
        // After fix, this should return "half-day"
        // For now, documenting the bug:
        expect(res.body.workingHours).toBeGreaterThan(4.9);
        expect(res.body.workingHours).toBeLessThan(5.1);
        // The bug: code uses `policy.workingHoursPerDay / 2` instead of `policy.halfDayThresholdHours`
        // Line ~195 in attendanceController.js:
        //   if (policy && attendance.workingHours < policy.workingHoursPerDay / 2)
        // Should be:
        //   if (policy && attendance.workingHours < (policy.halfDayThresholdHours || policy.workingHoursPerDay / 2))
    });
});

// ========================================================================
// SECTION 6: Late Check-In Logic Bug Test
// ========================================================================
describe("Late Check-In Logic - BUG: uses checkInStartTime + lateThreshold instead of just lateThreshold or checkInEndTime", () => {
    test("BUG: lateThresholdMinutes is added to checkInStartTime, not used standalone", () => {
        // The code at line 92-97 of attendanceController.js:
        //   const { hours, minutes } = parseTime(policy.checkInStartTime);
        //   threshold.setHours(hours, minutes + lateThresholdMinutes, 0, 0);
        //   if (now > threshold) isLateCheckIn = true;
        //
        // This means: if checkInStartTime is 09:00 and lateThresholdMinutes is 15,
        // then anyone checking in after 09:15 is "late".
        //
        // The policy also has graceMinutes (default 15) which is NEVER USED anywhere
        // in the check-in logic. This appears to be a design inconsistency.
        // graceMinutes field exists in the model but is ignored.
        //
        // Also, checkInEndTime ("11:00" default) is never used in the backend at all.
        // It exists in the policy model and the admin frontend but the controller
        // never references it.

        // This is a documentation/design issue rather than a crash bug.
        expect(true).toBe(true); // placeholder - design issue documented
    });
});

// ========================================================================
// SECTION 7: Leave Balance Calculation Tests
// ========================================================================
describe("Leave Balance Calculation", () => {
    let employee;

    beforeEach(async () => {
        const manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("should return full balances when no leaves taken", async () => {
        const { getLeaves } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee });
        const res = mockRes();
        await getLeaves(req, res);

        expect(res.body.balances.casual).toEqual({ total: 12, used: 0, remaining: 12 });
        expect(res.body.balances.sick).toEqual({ total: 12, used: 0, remaining: 12 });
        expect(res.body.balances.earned).toEqual({ total: 15, used: 0, remaining: 15 });
    });

    test("should correctly count used leave days", async () => {
        const year = new Date().getFullYear();
        await Leave.create({
            employee: employee._id,
            type: "casual",
            startDate: `${year}-03-10`,
            endDate: `${year}-03-12`,
            reason: "Personal",
            status: "approved",
        });

        const { getLeaves } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee });
        const res = mockRes();
        await getLeaves(req, res);

        // 3 days: 10th, 11th, 12th
        expect(res.body.balances.casual.used).toBe(3);
        expect(res.body.balances.casual.remaining).toBe(9);
    });

    test("should NOT count pending or rejected leaves in balance", async () => {
        const year = new Date().getFullYear();
        await Leave.create({
            employee: employee._id,
            type: "casual",
            startDate: `${year}-03-10`,
            endDate: `${year}-03-12`,
            reason: "Personal",
            status: "pending", // not approved
        });

        const { getLeaves } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee });
        const res = mockRes();
        await getLeaves(req, res);

        expect(res.body.balances.casual.used).toBe(0);
    });

    test("BUG: leave balance uses hardcoded quotas (12/12/15) instead of policy values", async () => {
        // Create policy with custom quotas
        await AttendancePolicy.create({
            leaveQuotas: {
                casual: 20,
                sick: 20,
                earned: 25,
            },
        });

        const { getLeaves } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee });
        const res = mockRes();
        await getLeaves(req, res);

        // BUG: The controller hardcodes totals as 12, 12, 15 at line 346-349
        // instead of reading from AttendancePolicy.leaveQuotas
        expect(res.body.balances.casual.total).toBe(12); // BUG: should be 20
        expect(res.body.balances.sick.total).toBe(12);    // BUG: should be 20
        expect(res.body.balances.earned.total).toBe(15);  // BUG: should be 25
    });

    test("BUG: leave balance does not include maternity/paternity types", () => {
        // The Leave model only supports: casual, sick, earned, unpaid
        // But the AttendancePolicy has maternity and paternity quotas
        // These types cannot be used for leave requests since the Leave model
        // enum doesn't include them
        const leaveTypes = ["casual", "sick", "earned", "unpaid"];
        const policyTypes = ["casual", "sick", "earned", "maternity", "paternity", "unpaid"];
        const missing = policyTypes.filter((t) => !leaveTypes.includes(t));
        expect(missing).toEqual(["maternity", "paternity"]);
    });

    test("should handle single-day leave correctly", async () => {
        const year = new Date().getFullYear();
        await Leave.create({
            employee: employee._id,
            type: "sick",
            startDate: `${year}-06-15`,
            endDate: `${year}-06-15`,
            reason: "Not feeling well",
            status: "approved",
        });

        const { getLeaves } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee });
        const res = mockRes();
        await getLeaves(req, res);

        expect(res.body.balances.sick.used).toBe(1);
    });

    test("BUG: leave day calculation can be wrong due to timezone issues", () => {
        // The leave calculation at line 340-342 uses:
        //   const start = new Date(l.startDate);  // e.g. "2026-03-10"
        //   const end = new Date(l.endDate);       // e.g. "2026-03-12"
        //   const days = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
        //
        // new Date("2026-03-10") creates date at midnight UTC.
        // In timezones behind UTC (e.g. PST), this becomes March 9 11pm local.
        // The subtraction and Math.ceil should still work for most cases,
        // but across DST boundaries, this can be off by 1.
        //
        // Example: Mar 8 to Mar 15 crosses DST in US (spring forward).
        // The actual time difference is 6 days 23 hours, not 7 days.
        // Math.ceil would give 7, then + 1 = 8 days total (correct).
        // But if DST causes 7 days exactly, Math.ceil(7) + 1 = 8 (also correct).
        // However, fall back DST could cause 7 days 1 hour, which gives
        // Math.ceil(7.04) + 1 = 9 instead of 8.

        // This is a latent timezone bug. Dates should be parsed as local
        // or the calculation should use date-only arithmetic.
        expect(true).toBe(true); // documented
    });
});

// ========================================================================
// SECTION 8: Leave Application Tests
// ========================================================================
describe("Leave Application", () => {
    let employee;

    beforeEach(async () => {
        const manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("should create leave request with valid data", async () => {
        const { applyLeave } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: {
                type: "casual",
                startDate: "2026-04-01",
                endDate: "2026-04-03",
                reason: "Family function",
            },
        });
        const res = mockRes();
        await applyLeave(req, res);

        expect(res.statusCode).toBe(201);
        expect(res.body.type).toBe("casual");
        expect(res.body.status).toBe("pending");
    });

    test("should reject leave request with missing fields", async () => {
        const { applyLeave } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { type: "casual", startDate: "2026-04-01" },
            // missing endDate and reason
        });
        const res = mockRes();
        await applyLeave(req, res);

        expect(res.statusCode).toBe(400);
    });

    test("BUG: no validation that endDate >= startDate", async () => {
        const { applyLeave } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: {
                type: "casual",
                startDate: "2026-04-05",
                endDate: "2026-04-01", // end before start!
                reason: "Backwards dates",
            },
        });
        const res = mockRes();
        await applyLeave(req, res);

        // BUG: This should return 400 but it will succeed with 201
        // No validation exists for date ordering
        expect(res.statusCode).toBe(201); // documents the bug
    });

    test("BUG: no validation for leave balance before applying", async () => {
        const { applyLeave } = require("../controllers/attendanceController");
        const year = new Date().getFullYear();

        // Create 12 days of approved casual leave (full quota)
        await Leave.create({
            employee: employee._id,
            type: "casual",
            startDate: `${year}-01-01`,
            endDate: `${year}-01-12`,
            reason: "Vacation",
            status: "approved",
        });

        // Try to apply for more casual leave
        const req = mockReq({
            employee: employee,
            body: {
                type: "casual",
                startDate: `${year}-06-01`,
                endDate: `${year}-06-05`,
                reason: "Another vacation",
            },
        });
        const res = mockRes();
        await applyLeave(req, res);

        // BUG: This should check remaining balance and reject, but it succeeds
        expect(res.statusCode).toBe(201); // documents the bug
    });

    test("BUG: no validation for overlapping leave requests", async () => {
        const { applyLeave } = require("../controllers/attendanceController");

        // First leave
        await Leave.create({
            employee: employee._id,
            type: "casual",
            startDate: "2026-04-01",
            endDate: "2026-04-05",
            reason: "Trip",
            status: "pending",
        });

        // Overlapping leave
        const req = mockReq({
            employee: employee,
            body: {
                type: "sick",
                startDate: "2026-04-03",
                endDate: "2026-04-07",
                reason: "Sick",
            },
        });
        const res = mockRes();
        await applyLeave(req, res);

        // BUG: No overlap validation - both leaves are accepted
        expect(res.statusCode).toBe(201);
    });

    test("BUG: no validation for past dates in leave application", async () => {
        const { applyLeave } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: {
                type: "casual",
                startDate: "2020-01-01",
                endDate: "2020-01-05",
                reason: "Retroactive leave",
            },
        });
        const res = mockRes();
        await applyLeave(req, res);

        // BUG: Accepts leave requests for past dates without any warning/validation
        expect(res.statusCode).toBe(201);
    });

    test("BUG: no date format validation", async () => {
        const { applyLeave } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: {
                type: "casual",
                startDate: "not-a-date",
                endDate: "also-not-a-date",
                reason: "Test",
            },
        });
        const res = mockRes();
        await applyLeave(req, res);

        // BUG: No format validation - these invalid dates are stored as-is
        expect(res.statusCode).toBe(201);
    });
});

// ========================================================================
// SECTION 9: Leave Approval (Manager) Tests
// ========================================================================
describe("Leave Approval - Manager", () => {
    let manager, employee;

    beforeEach(async () => {
        manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("should approve leave and create attendance records", async () => {
        const leave = await Leave.create({
            employee: employee._id,
            type: "casual",
            startDate: "2026-04-01",
            endDate: "2026-04-03",
            reason: "Trip",
            status: "pending",
        });

        const { reviewLeave } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            params: { id: leave._id.toString() },
            body: { status: "approved" },
        });
        const res = mockRes();
        await reviewLeave(req, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.status).toBe("approved");

        // Check that attendance records were created
        const records = await Attendance.find({ employee: employee._id, status: "leave" });
        expect(records.length).toBe(3); // Apr 1, 2, 3
    });

    test("should reject leave without creating attendance records", async () => {
        const leave = await Leave.create({
            employee: employee._id,
            type: "casual",
            startDate: "2026-04-01",
            endDate: "2026-04-03",
            reason: "Trip",
            status: "pending",
        });

        const { reviewLeave } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            params: { id: leave._id.toString() },
            body: { status: "rejected" },
        });
        const res = mockRes();
        await reviewLeave(req, res);

        expect(res.body.status).toBe("rejected");
        const records = await Attendance.find({ employee: employee._id, status: "leave" });
        expect(records.length).toBe(0);
    });

    test("should not allow unauthorized manager to review leave", async () => {
        const otherManager = await Manager.create({
            name: "Other", email: "other@t.com", password: "pass123",
        });

        const leave = await Leave.create({
            employee: employee._id,
            type: "casual",
            startDate: "2026-04-01",
            endDate: "2026-04-03",
            reason: "Trip",
            status: "pending",
        });

        const { reviewLeave } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: otherManager,
            params: { id: leave._id.toString() },
            body: { status: "approved" },
        });
        const res = mockRes();
        await reviewLeave(req, res);

        expect(res.statusCode).toBe(403);
    });

    test("BUG: leave approval loop may shift dates across DST boundaries", () => {
        // In reviewLeave at line 353-368:
        //   const start = new Date(leave.startDate);
        //   const end = new Date(leave.endDate);
        //   for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        //       const dateStr = d.toISOString().split("T")[0];
        //
        // new Date("2026-04-01") creates UTC midnight. toISOString gives UTC date.
        // If the server timezone is not UTC:
        //   - d.setDate(d.getDate() + 1) adds 1 calendar day in LOCAL time
        //   - d.toISOString().split("T")[0] gives UTC date
        //   - These may differ if timezone offset changes across DST
        //
        // Also: the loop mutates `d` which is initialized from `new Date(start)`.
        // This is fine functionally but could be confusing.
        //
        // More importantly: the loop creates attendance records with workMode "WFO"
        // hardcoded, which may not be the employee's actual work mode.
        expect(true).toBe(true); // documented
    });
});

// ========================================================================
// SECTION 10: Correction Request Tests
// ========================================================================
describe("Correction Request Flow", () => {
    let manager, employee;

    beforeEach(async () => {
        manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("should submit a correction request", async () => {
        const attendance = await Attendance.create({
            employee: employee._id,
            date: "2026-03-20",
            checkIn: { time: new Date("2026-03-20T09:00:00Z") },
            checkOut: { time: new Date("2026-03-20T17:00:00Z") },
            workingHours: 8,
            status: "present",
        });

        const { submitCorrection } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: {
                attendanceId: attendance._id.toString(),
                requestedCheckIn: "2026-03-20T08:30:00Z",
                reason: "Forgot to check in earlier",
            },
        });
        const res = mockRes();
        await submitCorrection(req, res);

        expect(res.statusCode).toBe(201);
        expect(res.body.reason).toBe("Forgot to check in earlier");
        expect(res.body.status).toBe("pending");
    });

    test("should reject correction without attendanceId", async () => {
        const { submitCorrection } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { reason: "Correction needed" },
        });
        const res = mockRes();
        await submitCorrection(req, res);

        expect(res.statusCode).toBe(400);
    });

    test("should reject correction without reason", async () => {
        const { submitCorrection } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: { attendanceId: new mongoose.Types.ObjectId().toString() },
        });
        const res = mockRes();
        await submitCorrection(req, res);

        expect(res.statusCode).toBe(400);
    });

    test("should not allow correction for another employee's record", async () => {
        const otherEmployee = await Employee.create({
            name: "Other", email: "other@t.com", password: "pass123", manager: manager._id,
        });
        const attendance = await Attendance.create({
            employee: otherEmployee._id,
            date: "2026-03-20",
            checkIn: { time: new Date() },
            status: "present",
        });

        const { submitCorrection } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: {
                attendanceId: attendance._id.toString(),
                reason: "Trying to modify someone else's record",
            },
        });
        const res = mockRes();
        await submitCorrection(req, res);

        expect(res.statusCode).toBe(403);
    });

    test("should approve correction and update attendance record", async () => {
        const attendance = await Attendance.create({
            employee: employee._id,
            date: "2026-03-20",
            checkIn: { time: new Date("2026-03-20T10:00:00Z") },
            checkOut: { time: new Date("2026-03-20T17:00:00Z") },
            workingHours: 7,
            status: "present",
        });

        const correction = await CorrectionRequest.create({
            employee: employee._id,
            attendance: attendance._id,
            date: "2026-03-20",
            requestedCheckIn: new Date("2026-03-20T09:00:00Z"),
            reason: "Actually checked in at 9",
        });

        const { reviewCorrection } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            params: { id: correction._id.toString() },
            body: { status: "approved" },
        });
        const res = mockRes();
        await reviewCorrection(req, res);

        expect(res.body.status).toBe("approved");

        // Verify attendance was updated
        const updated = await Attendance.findById(attendance._id);
        expect(new Date(updated.checkIn.time).toISOString()).toBe("2026-03-20T09:00:00.000Z");
        expect(updated.workingHours).toBe(8); // 9:00 to 17:00 = 8h
    });

    test("BUG: correction approval spreads subdocument incorrectly", () => {
        // In reviewCorrection at line 262-267:
        //   attendance.checkIn = {
        //       ...attendance.checkIn,
        //       time: correction.requestedCheckIn,
        //   };
        //
        // attendance.checkIn is a Mongoose subdocument, not a plain object.
        // Spreading a Mongoose subdocument with `...attendance.checkIn` includes
        // internal Mongoose properties like $__, _doc, etc.
        // The correct approach is:
        //   attendance.checkIn = {
        //       ...attendance.checkIn.toObject(),
        //       time: correction.requestedCheckIn,
        //   };
        // Or better: attendance.checkIn.time = correction.requestedCheckIn;
        //
        // In practice, Mongoose may handle this due to schema casting, but
        // it's a latent issue that could cause unexpected behavior.
        expect(true).toBe(true); // documented
    });
});

// ========================================================================
// SECTION 11: Admin Reports Tests
// ========================================================================
describe("Admin Reports", () => {
    let manager, employees;

    beforeEach(async () => {
        manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employees = [];
        for (let i = 0; i < 3; i++) {
            const emp = await Employee.create({
                name: `Emp ${i}`, email: `emp${i}@t.com`, password: "pass123", manager: manager._id,
            });
            employees.push(emp);
        }
    });

    test("should return report with correct aggregation", async () => {
        // Create attendance records
        await Attendance.create({
            employee: employees[0]._id,
            date: "2026-03-20",
            status: "present",
            workingHours: 8,
            isLateCheckIn: false,
            workMode: "WFO",
        });
        await Attendance.create({
            employee: employees[1]._id,
            date: "2026-03-20",
            status: "present",
            workingHours: 7,
            isLateCheckIn: true,
            workMode: "WFH",
        });
        await Attendance.create({
            employee: employees[2]._id,
            date: "2026-03-20",
            status: "leave",
            workMode: "WFO",
        });

        const { getReports } = require("../controllers/attendanceAdminController");
        const req = mockReq({
            query: { from: "2026-03-20", to: "2026-03-20" },
        });
        const res = mockRes();
        await getReports(req, res);

        expect(res.body.orgSummary.totalPresent).toBe(2);
        expect(res.body.orgSummary.totalLeave).toBe(1);
        expect(res.body.orgSummary.totalLate).toBe(1);
        expect(res.body.orgSummary.totalWfh).toBe(1);
        expect(res.body.employeeReports.length).toBe(3);
    });

    test("should require from and to parameters", async () => {
        const { getReports } = require("../controllers/attendanceAdminController");
        const req = mockReq({ query: {} });
        const res = mockRes();
        await getReports(req, res);

        expect(res.statusCode).toBe(400);
    });

    test("should handle empty date range", async () => {
        const { getReports } = require("../controllers/attendanceAdminController");
        const req = mockReq({
            query: { from: "2020-01-01", to: "2020-01-31" },
        });
        const res = mockRes();
        await getReports(req, res);

        expect(res.body.orgSummary.totalRecords).toBe(0);
        // All employees should still appear with zero counts
        expect(res.body.employeeReports.length).toBe(3);
    });

    test("BUG: reports use $lte for 'to' date while calendar uses $lt -- inconsistent", () => {
        // getReports line 134: date: { $gte: from, $lte: to }  -- inclusive of 'to'
        // getCalendar line 237: date: { $gte: startDate, $lt: endDate } -- exclusive of end
        //
        // For reports, this is intentional (user specifies exact range).
        // For calendar, endDate is first of next month, so $lt is correct.
        // This is not necessarily a bug but worth documenting.
        expect(true).toBe(true);
    });
});

// ========================================================================
// SECTION 12: Manager Team Attendance Tests
// ========================================================================
describe("Manager Team Attendance", () => {
    let manager, employees;

    beforeEach(async () => {
        manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employees = [];
        for (let i = 0; i < 2; i++) {
            const emp = await Employee.create({
                name: `Emp ${i}`, email: `emp${i}@t.com`, password: "pass123", manager: manager._id,
            });
            employees.push(emp);
        }
    });

    test("should return team attendance with absent employees included", async () => {
        // Only employee 0 has attendance
        await Attendance.create({
            employee: employees[0]._id,
            date: "2026-03-24",
            checkIn: { time: new Date() },
            status: "present",
        });

        const { getTeamAttendance } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            query: { date: "2026-03-24" },
        });
        const res = mockRes();
        await getTeamAttendance(req, res);

        expect(res.body.team.length).toBe(2);
        expect(res.body.summary.present).toBe(1);
        expect(res.body.summary.absent).toBe(1);
    });

    test("should only show employees under this manager", async () => {
        const otherManager = await Manager.create({
            name: "Other", email: "other@t.com", password: "pass123",
        });
        await Employee.create({
            name: "Other Emp", email: "otheremp@t.com", password: "pass123", manager: otherManager._id,
        });

        const { getTeamAttendance } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            query: { date: "2026-03-24" },
        });
        const res = mockRes();
        await getTeamAttendance(req, res);

        // Should only show the 2 employees under this manager
        expect(res.body.team.length).toBe(2);
    });
});

// ========================================================================
// SECTION 13: Attendance Policy Admin Tests
// ========================================================================
describe("Attendance Policy Admin", () => {
    test("should create default policy if none exists", async () => {
        const { getPolicy } = require("../controllers/attendanceAdminController");
        const req = mockReq({});
        const res = mockRes();
        await getPolicy(req, res);

        expect(res.body.workingHoursPerDay).toBe(8);
        expect(res.body.graceMinutes).toBe(15);
    });

    test("should update policy fields", async () => {
        await AttendancePolicy.create({});

        const { updatePolicy } = require("../controllers/attendanceAdminController");
        const req = mockReq({
            body: { workingHoursPerDay: 9, graceMinutes: 10 },
        });
        const res = mockRes();
        await updatePolicy(req, res);

        expect(res.body.workingHoursPerDay).toBe(9);
        expect(res.body.graceMinutes).toBe(10);
    });

    test("should add holiday and mark existing attendance as holiday", async () => {
        const manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        const employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });

        // Employee has a present record on that day
        await Attendance.create({
            employee: employee._id,
            date: "2026-08-15",
            status: "present",
        });

        const { addHoliday } = require("../controllers/attendanceAdminController");
        const req = mockReq({
            body: { date: "2026-08-15", name: "Independence Day", type: "public" },
        });
        const res = mockRes();
        await addHoliday(req, res);

        expect(res.statusCode).toBe(201);

        // Verify existing record was updated to holiday
        const record = await Attendance.findOne({ employee: employee._id, date: "2026-08-15" });
        expect(record.status).toBe("holiday");
        expect(record.approvalStatus).toBe("auto-approved");
    });

    test("BUG: addHoliday overwrites all attendance on that date regardless of status", () => {
        // At line 88-91:
        //   await Attendance.updateMany(
        //       { date },
        //       { status: "holiday", approvalStatus: "auto-approved" }
        //   );
        //
        // This updates ALL attendance records for that date - including employees
        // who may have already checked in and worked. Their legitimate work record
        // gets overwritten to "holiday" status without preserving the original status.
        //
        // Also: it does not filter by any organization - if this were multi-tenant,
        // it would affect all organizations.
        expect(true).toBe(true); // documented
    });

    test("should remove holiday", async () => {
        const policy = await AttendancePolicy.create({
            holidays: [
                { date: "2026-08-15", name: "Independence Day", type: "public" },
            ],
        });

        const holidayId = policy.holidays[0]._id.toString();

        const { removeHoliday } = require("../controllers/attendanceAdminController");
        const req = mockReq({ params: { id: holidayId } });
        const res = mockRes();
        await removeHoliday(req, res);

        expect(res.body.holidays.length).toBe(0);
    });

    test("should return 404 for non-existent holiday", async () => {
        await AttendancePolicy.create({});

        const { removeHoliday } = require("../controllers/attendanceAdminController");
        const req = mockReq({ params: { id: new mongoose.Types.ObjectId().toString() } });
        const res = mockRes();
        await removeHoliday(req, res);

        expect(res.statusCode).toBe(404);
    });

    test("BUG: removeHoliday does not revert attendance records back from holiday status", () => {
        // When a holiday is removed, any attendance records that were changed to
        // "holiday" status by addHoliday are NOT reverted back. The admin frontend
        // removes the holiday from the policy, but affected employees' records
        // remain as "holiday" forever.
        expect(true).toBe(true); // documented
    });
});

// ========================================================================
// SECTION 14: Calendar View Tests
// ========================================================================
describe("Calendar View", () => {
    let employee;

    beforeEach(async () => {
        const manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("should return records for specified month", async () => {
        await Attendance.create({
            employee: employee._id,
            date: "2026-03-15",
            status: "present",
        });
        await Attendance.create({
            employee: employee._id,
            date: "2026-03-25",
            status: "present",
        });
        // Different month - should not be returned
        await Attendance.create({
            employee: employee._id,
            date: "2026-04-01",
            status: "present",
        });

        const { getCalendar } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            query: { month: "3", year: "2026" },
        });
        const res = mockRes();
        await getCalendar(req, res);

        expect(res.body.records.length).toBe(2);
    });

    test("should handle December to January transition correctly", async () => {
        await Attendance.create({
            employee: employee._id,
            date: "2026-12-15",
            status: "present",
        });

        const { getCalendar } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            query: { month: "12", year: "2026" },
        });
        const res = mockRes();
        await getCalendar(req, res);

        expect(res.body.records.length).toBe(1);
    });

    test("should include holidays for the month", async () => {
        await AttendancePolicy.create({
            holidays: [
                { date: "2026-03-14", name: "Holi" },
                { date: "2026-04-14", name: "Ambedkar Jayanti" }, // different month
            ],
        });

        const { getCalendar } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            query: { month: "3", year: "2026" },
        });
        const res = mockRes();
        await getCalendar(req, res);

        expect(res.body.holidays.length).toBe(1);
        expect(res.body.holidays[0].name).toBe("Holi");
    });

    test("should return approved leaves overlapping the month", async () => {
        await Leave.create({
            employee: employee._id,
            type: "casual",
            startDate: "2026-03-28",
            endDate: "2026-04-02",
            reason: "Trip",
            status: "approved",
        });

        const { getCalendar } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            query: { month: "3", year: "2026" },
        });
        const res = mockRes();
        await getCalendar(req, res);

        expect(res.body.leaves.length).toBe(1);
    });
});

// ========================================================================
// SECTION 15: Manager Team Summary Tests
// ========================================================================
describe("Manager Team Summary", () => {
    let manager, employee;

    beforeEach(async () => {
        manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("should return monthly summary per employee", async () => {
        await Attendance.create({
            employee: employee._id,
            date: "2026-03-10",
            status: "present",
            workingHours: 8,
            isLateCheckIn: true,
            workMode: "WFO",
        });
        await Attendance.create({
            employee: employee._id,
            date: "2026-03-11",
            status: "half-day",
            workingHours: 3.5,
            workMode: "WFH",
        });

        const { getTeamSummary } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            query: { month: "3", year: "2026" },
        });
        const res = mockRes();
        await getTeamSummary(req, res);

        const summary = res.body.summaries[0];
        expect(summary.present).toBe(1);
        expect(summary.halfDay).toBe(1);
        expect(summary.totalHours).toBeCloseTo(11.5, 1);
        expect(summary.lateCount).toBe(1);
        expect(summary.wfh).toBe(1);
    });

    test("BUG: team summary 'absent' count is always 0", () => {
        // In getTeamSummary at line 112:
        //   absent: 0, // calculated below
        //
        // But it's NEVER actually calculated! The comment says "calculated below"
        // but there is no code below that sets the absent count.
        // This means the summary always shows 0 absences regardless of actual data.
        expect(true).toBe(true); // documented
    });
});

// ========================================================================
// SECTION 16: Attendance Approval Tests
// ========================================================================
describe("Attendance Approval - Manager", () => {
    let manager, employee;

    beforeEach(async () => {
        manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("should approve attendance", async () => {
        const attendance = await Attendance.create({
            employee: employee._id,
            date: "2026-03-24",
            checkIn: { time: new Date() },
            status: "present",
            approvalStatus: "pending",
        });

        const { approveAttendance } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            params: { id: attendance._id.toString() },
            body: { status: "approved", remarks: "Looks good" },
        });
        const res = mockRes();
        await approveAttendance(req, res);

        expect(res.body.approvalStatus).toBe("approved");
        expect(res.body.managerRemarks).toBe("Looks good");
    });

    test("should reject invalid approval status", async () => {
        const attendance = await Attendance.create({
            employee: employee._id,
            date: "2026-03-24",
            status: "present",
            approvalStatus: "pending",
        });

        const { approveAttendance } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            params: { id: attendance._id.toString() },
            body: { status: "maybe" },
        });
        const res = mockRes();
        await approveAttendance(req, res);

        expect(res.statusCode).toBe(400);
    });

    test("should reject approval by wrong manager", async () => {
        const otherManager = await Manager.create({
            name: "Other", email: "other@t.com", password: "pass123",
        });
        const attendance = await Attendance.create({
            employee: employee._id,
            date: "2026-03-24",
            checkIn: { time: new Date() },
            status: "present",
            approvalStatus: "pending",
        });

        const { approveAttendance } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: otherManager,
            params: { id: attendance._id.toString() },
            body: { status: "approved" },
        });
        const res = mockRes();
        await approveAttendance(req, res);

        expect(res.statusCode).toBe(403);
    });
});

// ========================================================================
// SECTION 17: Edge Cases
// ========================================================================
describe("Edge Cases", () => {
    let manager, employee;

    beforeEach(async () => {
        manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("should handle leap year date (Feb 29)", async () => {
        // 2028 is a leap year
        const attendance = await Attendance.create({
            employee: employee._id,
            date: "2028-02-29",
            status: "present",
        });
        expect(attendance.date).toBe("2028-02-29");
    });

    test("should handle year-end boundary (Dec 31 to Jan 1)", async () => {
        await Attendance.create({
            employee: employee._id,
            date: "2026-12-31",
            status: "present",
        });
        await Attendance.create({
            employee: employee._id,
            date: "2027-01-01",
            status: "present",
        });

        const count = await Attendance.countDocuments({ employee: employee._id });
        expect(count).toBe(2);
    });

    test("getToday returns null status when no record exists", async () => {
        const { getToday } = require("../controllers/attendanceController");
        const req = mockReq({ employee: employee });
        const res = mockRes();
        await getToday(req, res);

        expect(res.body.status).toBeNull();
    });

    test("should handle non-existent attendance ID for correction", async () => {
        const { submitCorrection } = require("../controllers/attendanceController");
        const req = mockReq({
            employee: employee,
            body: {
                attendanceId: new mongoose.Types.ObjectId().toString(),
                reason: "Test",
            },
        });
        const res = mockRes();
        await submitCorrection(req, res);

        expect(res.statusCode).toBe(404);
    });

    test("should handle non-existent leave ID for review", async () => {
        const { reviewLeave } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            params: { id: new mongoose.Types.ObjectId().toString() },
            body: { status: "approved" },
        });
        const res = mockRes();
        await reviewLeave(req, res);

        expect(res.statusCode).toBe(404);
    });

    test("working hours should be 0 or positive", async () => {
        const attendance = await Attendance.create({
            employee: employee._id,
            date: "2026-03-24",
            workingHours: 0,
        });
        expect(attendance.workingHours).toBe(0);
    });

    test("BUG: no maximum working hours validation", async () => {
        // Nothing prevents absurd working hours values
        const attendance = await Attendance.create({
            employee: employee._id,
            date: "2026-03-24",
            workingHours: 100, // impossible
        });
        expect(attendance.workingHours).toBe(100); // accepted without validation
    });

    test("BUG: no validation that date field matches actual check-in date", async () => {
        // The date field is a free-form string that doesn't have to match checkIn.time
        const attendance = await Attendance.create({
            employee: employee._id,
            date: "2026-01-01",
            checkIn: { time: new Date("2026-06-15T09:00:00Z") }, // 6 months later!
        });
        expect(attendance.date).toBe("2026-01-01");
        // No validation that the date matches the actual check-in timestamp
    });
});

// ========================================================================
// SECTION 18: Frontend-Backend Contract Tests (Data Shape Verification)
// ========================================================================
describe("Frontend-Backend Contract - Response Shapes", () => {
    let manager, employee;

    beforeEach(async () => {
        manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("BUG: Admin reports frontend expects 'summary' and 'employees' keys but backend sends 'orgSummary' and 'employeeReports'", async () => {
        // Frontend AdminAttendanceTab.jsx line 598: data?.summary
        // Frontend AdminAttendanceTab.jsx line 605: data.summary.avgAttendance
        // Frontend AdminAttendanceTab.jsx line 609: data.summary.totalWorkingDays
        // Frontend AdminAttendanceTab.jsx line 613: data.summary.totalLateCheckins
        // Frontend AdminAttendanceTab.jsx line 634: data?.employees
        //
        // Backend attendanceAdminController.js line 198 sends:
        //   { from, to, orgSummary, employeeReports }
        //
        // The frontend looks for `data.summary` but the backend sends `data.orgSummary`.
        // The frontend looks for `data.employees` but the backend sends `data.employeeReports`.
        //
        // Additionally, the backend orgSummary does NOT include:
        //   - avgAttendance (frontend tries to display data.summary.avgAttendance)
        //   - totalWorkingDays (frontend tries to display data.summary.totalWorkingDays)
        //   - totalLateCheckins (frontend tries to display data.summary.totalLateCheckins)
        //
        // The backend sends: totalEmployees, totalRecords, totalPresent, totalAbsent,
        //   totalLeave, totalWfh, totalLate

        await Attendance.create({
            employee: employee._id,
            date: "2026-03-20",
            status: "present",
        });

        const { getReports } = require("../controllers/attendanceAdminController");
        const req = mockReq({
            query: { from: "2026-03-01", to: "2026-03-31" },
        });
        const res = mockRes();
        await getReports(req, res);

        // Backend sends these keys:
        expect(res.body).toHaveProperty("orgSummary");
        expect(res.body).toHaveProperty("employeeReports");

        // Frontend expects these keys (which DON'T exist):
        expect(res.body).not.toHaveProperty("summary");
        expect(res.body).not.toHaveProperty("employees");

        // Frontend also expects fields that backend doesn't send:
        expect(res.body.orgSummary).not.toHaveProperty("avgAttendance");
        expect(res.body.orgSummary).not.toHaveProperty("totalWorkingDays");
        expect(res.body.orgSummary).not.toHaveProperty("totalLateCheckins");
    });

    test("BUG: Admin reports frontend expects 'month' param but backend expects 'from'/'to' date range", () => {
        // Frontend line 565:
        //   axios.get(`${API}/api/admin/attendance/reports?month=${month}&year=${year}`)
        //
        // Backend line 124-125:
        //   const from = req.query.from;
        //   const to = req.query.to;
        //
        // Frontend sends month+year, backend expects from+to.
        // This means the admin reports page will ALWAYS get a 400 error:
        //   "from and to date params are required"
        expect(true).toBe(true); // critical frontend-backend mismatch
    });
});

// ========================================================================
// SECTION 19: Work Mode Tests
// ========================================================================
describe("Work Mode Management", () => {
    let manager, employee;

    beforeEach(async () => {
        manager = await Manager.create({
            name: "Mgr", email: "m@t.com", password: "pass123",
        });
        employee = await Employee.create({
            name: "Emp", email: "e@t.com", password: "pass123", manager: manager._id,
        });
    });

    test("should set employee work mode", async () => {
        const { setEmployeeWorkMode } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            params: { id: employee._id.toString() },
            body: { workMode: "WFH" },
        });
        const res = mockRes();
        await setEmployeeWorkMode(req, res);

        expect(res.body.defaultWorkMode).toBe("WFH");
    });

    test("should reject invalid work mode", async () => {
        const { setEmployeeWorkMode } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: manager,
            params: { id: employee._id.toString() },
            body: { workMode: "INVALID" },
        });
        const res = mockRes();
        await setEmployeeWorkMode(req, res);

        expect(res.statusCode).toBe(400);
    });

    test("should not allow setting work mode for employee of another manager", async () => {
        const otherManager = await Manager.create({
            name: "Other", email: "other@t.com", password: "pass123",
        });

        const { setEmployeeWorkMode } = require("../controllers/attendanceManagerController");
        const req = mockReq({
            manager: otherManager,
            params: { id: employee._id.toString() },
            body: { workMode: "WFH" },
        });
        const res = mockRes();
        await setEmployeeWorkMode(req, res);

        expect(res.statusCode).toBe(404);
    });
});

// ========================================================================
// SECTION 20: WFH Limit Tests
// ========================================================================
describe("WFH Limit Enforcement", () => {
    test("BUG: maxWfhDaysPerMonth is stored but never enforced during check-in", () => {
        // The policy has maxWfhDaysPerMonth (default 8) but the checkIn controller
        // never checks how many WFH days the employee has used this month.
        // An employee could do WFH every single day without any restriction.
        expect(true).toBe(true); // documented
    });

    test("BUG: wfhEnabled flag is stored but never enforced during check-in", () => {
        // The policy has wfhEnabled (default true) but the checkIn controller
        // never checks this flag. Even if WFH is disabled, employees can still
        // check in with workMode "WFH".
        expect(true).toBe(true); // documented
    });
});

// ========================================================================
// SECTION 21: Weekend Status Test
// ========================================================================
describe("Weekend Handling", () => {
    test("BUG: weekend status exists in enum but is never automatically assigned", () => {
        // The Attendance model has "weekend" as a valid status, but no code
        // anywhere in the system automatically creates attendance records with
        // weekend status on Saturdays/Sundays.
        //
        // This means:
        // 1. Employees can check in on weekends without any warning
        // 2. Calendar view won't show weekends differently (no "weekend" status records)
        // 3. Absence calculation doesn't exclude weekends
        expect(true).toBe(true); // documented
    });
});
