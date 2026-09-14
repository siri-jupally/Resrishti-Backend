/**
 * Staff "forgot password" flow — Employee / Manager / Admin.
 *
 * Covers the security properties that matter for a reset link:
 *   - tokens stored hashed, never plaintext
 *   - single use, 15-minute expiry
 *   - requesting a new link invalidates older ones
 *   - a token for one role cannot be replayed against another
 *   - no account enumeration on the forgot-password endpoint
 *   - the password actually changes, and old sessions are invalidated
 */
const crypto = require("crypto");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const Employee = require("../models/Employee");
const Manager = require("../models/Manager");
const Admin = require("../models/Admin");
const PasswordResetToken = require("../models/PasswordResetToken");

const reset = require("../controllers/staffPasswordResetController");

// sendEmail is fire-and-forget in the controller; stub it so tests neither hit
// SMTP nor depend on it succeeding.
jest.mock("../utils/emailService", () => ({ sendEmail: jest.fn().mockResolvedValue({}) }));

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

const mockReq = (overrides = {}) => ({ body: {}, params: {}, query: {}, ip: "1.2.3.4", ...overrides });

const hashToken = (raw) => crypto.createHash("sha256").update(String(raw)).digest("hex");

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Promise.all([
        Employee.deleteMany({}),
        Manager.deleteMany({}),
        Admin.deleteMany({}),
        PasswordResetToken.deleteMany({}),
    ]);
});

/** Run forgot-password and return the raw token that would have been emailed. */
async function requestReset(roleKey, email) {
    const res = mockRes();
    await reset.forgotPassword(roleKey)(mockReq({ body: { email } }), res);
    return res;
}

/**
 * The controller never returns the raw token (correctly — it is emailed).
 * Tests need it, so mint one the same way and store its hash, matching what
 * forgotPassword does.
 */
async function issueTokenFor(userType, userId, { expiresInMs = 15 * 60 * 1000 } = {}) {
    const raw = crypto.randomBytes(32).toString("hex");
    await PasswordResetToken.create({
        userType,
        userId,
        tokenHash: hashToken(raw),
        expiresAt: new Date(Date.now() + expiresInMs),
    });
    return raw;
}

describe("Staff password reset", () => {
    let employee;

    beforeEach(async () => {
        // Employee.manager is required by the schema.
        const owningManager = await Manager.create({
            name: "Owning Manager",
            email: "owner@test.com",
            password: "oldpass1",
        });
        employee = await Employee.create({
            name: "Test Employee",
            email: "emp@test.com",
            password: "oldpass1",
            manager: owningManager._id,
        });
    });

    // ---- forgot-password -------------------------------------------------

    test("creates a reset token for a known email", async () => {
        const res = await requestReset("employee", "emp@test.com");
        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);

        const tokens = await PasswordResetToken.find({ userType: "Employee" });
        expect(tokens).toHaveLength(1);
        expect(tokens[0].userId.toString()).toBe(employee._id.toString());
    });

    test("stores the token hashed, never in plaintext", async () => {
        await requestReset("employee", "emp@test.com");
        const token = await PasswordResetToken.findOne({ userType: "Employee" });
        // 64 hex chars = sha256 digest.
        expect(token.tokenHash).toMatch(/^[a-f0-9]{64}$/);
        expect(token.toObject()).not.toHaveProperty("token");
    });

    test("gives the same answer for an unknown email (no enumeration)", async () => {
        const known = await requestReset("employee", "emp@test.com");
        const unknown = await requestReset("employee", "nobody@test.com");

        expect(unknown.statusCode).toBe(known.statusCode);
        expect(unknown.body).toEqual(known.body);
        // ...and no token was created for the address that does not exist.
        expect(await PasswordResetToken.countDocuments({})).toBe(1);
    });

    test("matches the email case-insensitively", async () => {
        await requestReset("employee", "EMP@TEST.COM");
        expect(await PasswordResetToken.countDocuments({ userType: "Employee" })).toBe(1);
    });

    test("rejects an empty email", async () => {
        const res = await requestReset("employee", "");
        expect(res.statusCode).toBe(400);
    });

    test("requesting again invalidates the previous link", async () => {
        const first = await issueTokenFor("Employee", employee._id);
        await requestReset("employee", "emp@test.com");

        const verify = mockRes();
        await reset.verifyResetToken("employee")(mockReq({ params: { token: first } }), verify);
        expect(verify.statusCode).toBe(410);
    });

    // ---- verify ----------------------------------------------------------

    test("verifies a live token and returns the account email", async () => {
        const raw = await issueTokenFor("Employee", employee._id);
        const res = mockRes();
        await reset.verifyResetToken("employee")(mockReq({ params: { token: raw } }), res);
        expect(res.statusCode).toBe(200);
        expect(res.body.email).toBe("emp@test.com");
    });

    test("404s an unknown token", async () => {
        const res = mockRes();
        await reset.verifyResetToken("employee")(mockReq({ params: { token: "nope" } }), res);
        expect(res.statusCode).toBe(404);
    });

    test("410s an expired token", async () => {
        const raw = await issueTokenFor("Employee", employee._id, { expiresInMs: -1000 });
        const res = mockRes();
        await reset.verifyResetToken("employee")(mockReq({ params: { token: raw } }), res);
        expect(res.statusCode).toBe(410);
        expect(res.body.message).toMatch(/expired/i);
    });

    // ---- reset -----------------------------------------------------------

    test("changes the password and lets the new one authenticate", async () => {
        const raw = await issueTokenFor("Employee", employee._id);
        const res = mockRes();
        await reset.resetPassword("employee")(
            mockReq({ body: { token: raw, password: "newpass1" } }),
            res
        );
        expect(res.statusCode).toBe(200);

        const updated = await Employee.findById(employee._id);
        expect(await updated.comparePassword("newpass1")).toBe(true);
        expect(await updated.comparePassword("oldpass1")).toBe(false);
    });

    test("stamps passwordChangedAt so existing sessions are rejected", async () => {
        const raw = await issueTokenFor("Employee", employee._id);
        await reset.resetPassword("employee")(
            mockReq({ body: { token: raw, password: "newpass1" } }),
            mockRes()
        );

        const after = await Employee.findById(employee._id);
        expect(after.passwordChangedAt).toBeInstanceOf(Date);

        // Replicate the comparison middleware/authEmployee.js makes. A JWT
        // minted a minute before the reset must now be stale...
        const staleIat = Math.floor((Date.now() - 60_000) / 1000);
        expect(staleIat * 1000).toBeLessThan(after.passwordChangedAt.getTime());

        // ...while one minted now must still be accepted. This is what the
        // deliberate 1-second backdate in the pre-save hook protects: without
        // it, the token issued by the very next login could be rejected.
        const freshIat = Math.floor(Date.now() / 1000);
        expect(freshIat * 1000).toBeGreaterThanOrEqual(after.passwordChangedAt.getTime());
    });

    test("burns the token so it cannot be reused", async () => {
        const raw = await issueTokenFor("Employee", employee._id);
        await reset.resetPassword("employee")(
            mockReq({ body: { token: raw, password: "newpass1" } }),
            mockRes()
        );

        const second = mockRes();
        await reset.resetPassword("employee")(
            mockReq({ body: { token: raw, password: "another1" } }),
            second
        );
        expect(second.statusCode).toBe(410);
        expect(second.body.message).toMatch(/already been used/i);
    });

    test("will not reset with an expired token", async () => {
        const raw = await issueTokenFor("Employee", employee._id, { expiresInMs: -1000 });
        const res = mockRes();
        await reset.resetPassword("employee")(
            mockReq({ body: { token: raw, password: "newpass1" } }),
            res
        );
        expect(res.statusCode).toBe(410);
        const unchanged = await Employee.findById(employee._id);
        expect(await unchanged.comparePassword("oldpass1")).toBe(true);
    });

    test.each([
        ["too short", "ab1"],
        ["letters only", "abcdefgh"],
        ["numbers only", "12345678"],
        ["empty", ""],
    ])("rejects a weak password (%s)", async (_label, password) => {
        const raw = await issueTokenFor("Employee", employee._id);
        const res = mockRes();
        await reset.resetPassword("employee")(mockReq({ body: { token: raw, password } }), res);
        expect(res.statusCode).toBe(400);
        const unchanged = await Employee.findById(employee._id);
        expect(await unchanged.comparePassword("oldpass1")).toBe(true);
    });

    test("clears isFirstLogin so the user is not sent back to setup", async () => {
        await Employee.findByIdAndUpdate(employee._id, { isFirstLogin: true });
        const raw = await issueTokenFor("Employee", employee._id);
        await reset.resetPassword("employee")(
            mockReq({ body: { token: raw, password: "newpass1" } }),
            mockRes()
        );
        const updated = await Employee.findById(employee._id);
        expect(updated.isFirstLogin).toBe(false);
    });

    // ---- cross-role isolation -------------------------------------------

    test("an employee token cannot be replayed against the manager endpoint", async () => {
        const raw = await issueTokenFor("Employee", employee._id);
        const res = mockRes();
        await reset.verifyResetToken("manager")(mockReq({ params: { token: raw } }), res);
        expect(res.statusCode).toBe(404);
    });

    test("an employee token cannot reset a manager password", async () => {
        const raw = await issueTokenFor("Employee", employee._id);
        const res = mockRes();
        await reset.resetPassword("manager")(
            mockReq({ body: { token: raw, password: "newpass1" } }),
            res
        );
        expect(res.statusCode).toBe(404);
    });

    test("the same email in two roles gets independent tokens", async () => {
        await Manager.create({ name: "Same Email", email: "emp@test.com", password: "oldpass1" });
        await requestReset("employee", "emp@test.com");
        await requestReset("manager", "emp@test.com");

        expect(await PasswordResetToken.countDocuments({ userType: "Employee" })).toBe(1);
        expect(await PasswordResetToken.countDocuments({ userType: "Manager" })).toBe(1);
    });

    // ---- other roles work the same --------------------------------------

    test("works for managers", async () => {
        const manager = await Manager.create({
            name: "Test Manager", email: "mgr@test.com", password: "oldpass1",
        });
        const raw = await issueTokenFor("Manager", manager._id);
        await reset.resetPassword("manager")(
            mockReq({ body: { token: raw, password: "newpass1" } }),
            mockRes()
        );
        const updated = await Manager.findById(manager._id);
        expect(await updated.comparePassword("newpass1")).toBe(true);
    });

    test("works for admins", async () => {
        const admin = await Admin.create({ email: "admin@test.com", password: "oldpass1" });
        const raw = await issueTokenFor("Admin", admin._id);
        await reset.resetPassword("admin")(
            mockReq({ body: { token: raw, password: "newpass1" } }),
            mockRes()
        );
        const updated = await Admin.findById(admin._id);
        expect(await updated.comparePassword("newpass1")).toBe(true);
    });
});
