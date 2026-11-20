const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
    // Carried over when an admin is created by promoting a manager, so the
    // person still has a display name. Optional — seeded/legacy admins have none.
    name: { type: String, trim: true },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true
    },
    password: {
        type: String,
        required: true
    },
    // See models/Employee.js — rejects JWTs older than the last password change
    // so a reset ends every other session.
    passwordChangedAt: { type: Date },
    pushSubscription: { type: Object },

    // Set when this admin was created by promoting a manager, so the person's
    // history on the old Manager/Employee records can be traced from here.
    promotedFromManager: { type: mongoose.Schema.Types.ObjectId, ref: "Manager" },
    promotedAt: { type: Date },

    // Client-Management module — job tags (not roles).
    // Admins default to canCoordinate=true (they triage incoming requests).
    canSupervise: { type: Boolean, default: false },
    canCoordinate: { type: Boolean, default: true },
});

// See Employee.js — trim symmetrically on hash + compare so whitespace baked
// in during form copy-paste / autofill doesn't lock the user out later.
adminSchema.pre('save', async function () {
    if (!this.isModified('password')) return;
    const cleaned = String(this.password ?? '').trim();
    if (!cleaned) throw new Error('Password cannot be empty or whitespace-only');
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(cleaned, salt);

    // One second in the past — see models/Employee.js for why.
    this.passwordChangedAt = new Date(Date.now() - 1000);
});

adminSchema.methods.comparePassword = async function (candidatePassword) {
    const cleaned = String(candidatePassword ?? '').trim();
    if (!cleaned || !this.password) return false;
    return await bcrypt.compare(cleaned, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
