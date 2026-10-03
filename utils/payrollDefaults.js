/*
  utils/payrollDefaults.js — the settings and paid-day policies payroll needs
  in order to exist at all, seeded on first use.

  Same pattern as the waste categories: seed what is missing, never overwrite
  what somebody has edited. An office that changes the overtime multiplier
  keeps that change across restarts and deploys.
*/
const PayrollSettings = require("../models/PayrollSettings");
const PaidDayPolicy = require("../models/PaidDayPolicy");

// Two arrangements cover the workforce as described: roughly half the staff
// are daily-wage, some casual and some regular.
const CORE_POLICIES = [
    {
        name: "Casual — work only",
        description:
            "Paid strictly for days worked. Weekly-offs and holidays are not paid. Typical for casual daily labour.",
        payWeeklyOff: false,
        payHoliday: false,
        payApprovedLeave: false,
        appliesTo: ["daily"],
        sortOrder: 10,
    },
    {
        name: "Regular — weekly-off paid",
        description:
            "Paid for days worked plus weekly-offs and holidays. Typical for regular daily-wage staff kept on through the month.",
        payWeeklyOff: true,
        payHoliday: true,
        payApprovedLeave: true,
        appliesTo: ["daily"],
        sortOrder: 20,
    },
    {
        name: "Salaried — everything paid",
        description:
            "Weekly-offs, holidays and approved paid leave are all paid; only unpaid absence is deducted. The normal arrangement for monthly staff.",
        payWeeklyOff: true,
        payHoliday: true,
        payApprovedLeave: true,
        appliesTo: ["monthly"],
        sortOrder: 30,
    },
];

/** The settings document, created with its defaults the first time it is asked for. */
const getSettings = async () => {
    let settings = await PayrollSettings.findOne({ key: "global" });
    if (!settings) settings = await PayrollSettings.create({ key: "global" });
    return settings;
};

/** Insert any missing core policy. Never touches one that already exists. */
const seedPaidDayPolicies = async () => {
    const existing = await PaidDayPolicy.find({}, "name").lean();
    const have = new Set(existing.map((p) => p.name));
    const missing = CORE_POLICIES.filter((p) => !have.has(p.name)).map((p) => ({
        ...p,
        isSeeded: true,
        isActive: true,
    }));
    if (missing.length > 0) await PaidDayPolicy.insertMany(missing, { ordered: false });
    return missing.length;
};

/** Called once after the Mongo connection opens. */
const initPayroll = async () => {
    await getSettings();
    return seedPaidDayPolicies();
};

/**
 * The default policy for a pay model, used when somebody is tagged without
 * choosing one. Daily-wage defaults to work-only: the safer of the two, since
 * paying for a weekly-off that was not agreed is harder to claw back than to
 * add.
 */
const defaultPolicyFor = async (payModel) => {
    const name = payModel === "monthly" ? "Salaried — everything paid" : "Casual — work only";
    return PaidDayPolicy.findOne({ name });
};

module.exports = {
    CORE_POLICIES,
    getSettings,
    seedPaidDayPolicies,
    initPayroll,
    defaultPolicyFor,
};
