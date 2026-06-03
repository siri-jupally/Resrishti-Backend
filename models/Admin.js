const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema({
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
    pushSubscription: { type: Object },

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
});

adminSchema.methods.comparePassword = async function (candidatePassword) {
    const cleaned = String(candidatePassword ?? '').trim();
    if (!cleaned || !this.password) return false;
    return await bcrypt.compare(cleaned, this.password);
};

module.exports = mongoose.model('Admin', adminSchema);
