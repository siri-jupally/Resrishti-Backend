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
