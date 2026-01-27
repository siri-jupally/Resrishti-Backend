/*
  Manager authentication middleware

  Purpose:
  - Verifies a Bearer JWT from the Authorization header and attaches the Manager
    record to `req.manager` for protected routes.

  Usage:
  - Add `protectManager` as middleware on routes that require manager authentication.
  - Relies on process.env.JWT_SECRET to verify tokens.

  Error modes:
  - Returns 401 when the token is missing, invalid, or when the manager cannot be found.
*/
const jwt = require("jsonwebtoken");
const Manager = require("../models/Manager");

const protectManager = async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      token = req.headers.authorization.split(" ")[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.manager = await Manager.findById(decoded.id).select("-password");
      if (!req.manager)
        return res.status(401).json({ message: "Not authorized" });
      next();
    } catch (err) {
      console.error(err);
      return res.status(401).json({ message: "Not authorized" });
    }
  }
  if (!token)
    return res.status(401).json({ message: "Not authorized, no token" });
};

module.exports = { protectManager };
