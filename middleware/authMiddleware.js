const jwt = require('jsonwebtoken');
const Admin = require('../models/Admin');

const protect = async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith('Bearer')
    ) {
        try {
            // Get token from header
            token = req.headers.authorization.split(' ')[1];

            // Verify token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);

            // Get admin from the token
            req.admin = await Admin.findById(decoded.id).select('-password');
            if (!req.admin) {
                return res.status(401).json({ message: 'Not authorized' });
            }

            // Reject tokens minted before the last password change, so a reset
            // ends sessions on every other device. See middleware/authEmployee.js.
            if (req.admin.passwordChangedAt && decoded.iat) {
                if (decoded.iat * 1000 < req.admin.passwordChangedAt.getTime()) {
                    return res.status(401).json({
                        message:
                            'Session expired because the password was changed. Please sign in again.',
                    });
                }
            }

            next();
        } catch (error) {
            console.error(error);
            res.status(401).json({ message: 'Not authorized' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'Not authorized, no token' });
    }
};

module.exports = { protect };
