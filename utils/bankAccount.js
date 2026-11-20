/*
  bankAccount.js — the one place a person's salary account is changed.

  Changing the account a salary is paid into, especially shortly before payday,
  is the classic salary-redirect fraud. So every change goes through here: the
  old account's last four digits are kept in `bankHistory` with who changed it,
  `bankUpdatedAt` is stamped (a payroll run reads that to flag an account that
  moved after it was generated), and the person is emailed that it happened.

  Both the self-service profile editor (controllers/profileController.js) and
  the accountant's payroll screen (controllers/payrollProfileController.js) call
  these, so the safeguards can never drift apart between the two paths.
*/
const { sendEmail } = require("./emailService");

const BANK_FIELDS = ["accountHolderName", "accountNumber", "ifsc", "bankName", "branch"];

/**
 * Apply a bank-account change to a person document (Employee/Manager), writing
 * the audit trail. Mutates `user`; the caller still saves it. Returns true if
 * anything actually changed (so the caller knows whether to notify).
 *
 *   user       a Mongoose Employee/Manager doc
 *   incoming   the new bank fields — an object, or a JSON string (multipart)
 *   actorName  who is making the change, for the history entry
 */
const applyBankChange = (user, incoming, actorName) => {
    // Multipart form-data flattens everything to strings, so the profile form
    // sends `bank` as a JSON string. Parse it back before the object guard, or
    // the whole bank block is silently dropped.
    if (typeof incoming === "string") {
        try { incoming = JSON.parse(incoming); }
        catch { return false; }
    }
    if (!incoming || typeof incoming !== "object") return false;

    const next = {};
    for (const f of BANK_FIELDS) {
        if (incoming[f] !== undefined) next[f] = String(incoming[f] || "").trim();
    }
    if (Object.keys(next).length === 0) return false;

    const before = user.bank ? (user.bank.toObject ? user.bank.toObject() : user.bank) : {};
    const merged = { ...before, ...next };

    if (BANK_FIELDS.every((f) => (merged[f] || "") === (before[f] || ""))) return false;

    // Only the account identity matters for the audit trail — a corrected
    // spelling of the bank's name is not a redirect.
    const identityChanged =
        (merged.accountNumber || "") !== (before.accountNumber || "") ||
        (merged.ifsc || "") !== (before.ifsc || "");

    if (identityChanged && before.accountNumber) {
        user.bankHistory = user.bankHistory || [];
        user.bankHistory.push({
            accountNumberLast4: String(before.accountNumber).slice(-4),
            ifsc: before.ifsc,
            bankName: before.bankName,
            changedAt: new Date(),
            changedByName: actorName,
        });
    }

    user.bank = merged;
    user.bankUpdatedAt = new Date();
    return true;
};

/** Tell the person their salary account changed. Best-effort — a failed mail
 *  must never fail the save that triggered it. */
const notifyBankChange = async (user) => {
    try {
        await sendEmail(
            user.email,
            "Your salary account was updated",
            undefined,
            `<p>Hello ${user.name || ""},</p>
             <p>The bank account your salary is paid into was just changed on your
             ReSrishti profile. Payments will now go to the account ending
             <strong>${String(user.bank?.accountNumber || "").slice(-4)}</strong>.</p>
             <p>If you did not make this change, tell your administrator straight away.</p>`
        );
    } catch (err) {
        console.error("Bank-change email failed:", err.message);
    }
};

module.exports = { BANK_FIELDS, applyBankChange, notifyBankChange };
