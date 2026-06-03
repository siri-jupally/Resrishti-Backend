/*
  Client authentication middleware — Client Management module (Phase 1)

  Purpose:
  - Verifies a Bearer JWT issued by `/api/client/login` and attaches the Client
    record to `req.client` for protected client-portal routes.

  Token contract (see clientmngmt.md §7.7 and §10.3):
  - Payload: `{ id: client._id, kind: 'client' }` signed with `process.env.JWT_SECRET`.
  - The `kind` claim is what separates client tokens from internal (admin/manager/employee)
    tokens. Internal middlewares never set `kind === 'client'`, so this middleware rejects
    any token whose `kind` is not exactly `'client'`. That prevents an employee/manager/admin
    token (which has no `kind` claim — `kind` is `undefined`) from being replayed against
    client-portal routes, and vice versa once the internal middlewares add their own
    `kind` rejections.

  Account-state guard:
  - If `client.status !== 'active'` (e.g., still `pending-onboarding`, or paused/churned
    after admin action), return 403 with `{ message: 'Account inactive' }`. This is what
    keeps a churned client from continuing to use a still-valid JWT until expiry.

  Error modes:
  - 401 `{ message: 'Not authorized, no token' }` — Authorization header missing
  - 401 `{ message: 'Not authorized' }`           — token invalid, wrong kind, or
                                                     client record not found
  - 403 `{ message: 'Account inactive' }`         — client found but status !== 'active'
*/
const jwt = require("jsonwebtoken");
const Client = require("../models/Client");

const protectClient = async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Kind-check: reject any token that isn't explicitly a client token.
      // An employee/manager/admin token will have `kind === undefined`, which
      // is not equal to 'client' — so this rejects those too. Critical security
      // boundary: prevents internal users from accessing client-portal data.
      if (decoded.kind !== "client") {
        return res.status(401).json({ message: "Not authorized" });
      }

      // passwordHash is `select: false` at the schema level, so it stays
      // excluded automatically — no need for `.select('-passwordHash')`.
      req.client = await Client.findById(decoded.id);
      if (!req.client)
        return res.status(401).json({ message: "Not authorized" });

      // Block paused / churned / still-pending-onboarding clients from using
      // an otherwise-valid JWT.
      if (req.client.status !== "active") {
        return res.status(403).json({ message: "Account inactive" });
      }

      return next();
    } catch (err) {
      console.error(err);
      return res.status(401).json({ message: "Not authorized" });
    }
  }
  if (!token)
    return res.status(401).json({ message: "Not authorized, no token" });
};

module.exports = { protectClient };
