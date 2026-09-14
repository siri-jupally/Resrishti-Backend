/*
  Employee authentication middleware

  Purpose:
  - Verifies a Bearer JWT from the Authorization header and attaches the Employee
    record to `req.employee` for protected employee routes.

  Usage:
  - Add `protectEmployee` to routes that require an authenticated employee.
  - Requires process.env.JWT_SECRET to be set for token verification.

  Error modes:
  - Returns 401 when token is missing/invalid or employee not found.
*/
const jwt = require("jsonwebtoken");
const Employee = require("../models/Employee");

const protectEmployee = async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.employee = await Employee.findById(decoded.id).select("-password");
      if (!req.employee)
        return res.status(401).json({ message: "Not authorized" });

      // Reject tokens minted before the password last changed. Without this a
      // password reset leaves every existing session alive for the rest of its
      // 30-day life, which defeats the point when the reset was prompted by
      // someone else having access. `iat` is in seconds; passwordChangedAt is
      // stamped 1s in the past by the pre-save hook so a token issued in the
      // same second is not caught. Accounts that have never changed their
      // password (no passwordChangedAt) are unaffected.
      if (req.employee.passwordChangedAt && decoded.iat) {
        if (decoded.iat * 1000 < req.employee.passwordChangedAt.getTime()) {
          return res.status(401).json({
            message:
              "Session expired because the password was changed. Please sign in again.",
          });
        }
      }
      next();
    } catch (err) {
      console.error(err);
      return res.status(401).json({ message: "Not authorized" });
    }
  }
  if (!token)
    return res.status(401).json({ message: "Not authorized, no token" });
};

module.exports = { protectEmployee };
