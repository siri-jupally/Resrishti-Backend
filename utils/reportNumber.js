/*
  utils/reportNumber.js — numbering for the two monthly client reports.

  Format:
      IMP-<YYYY>-<####>   Environmental Impact Report
      GHG-<YYYY>-<####>   Green House Gases Emission Report

  Mirrors utils/certNumber.js (`CoD-YYYY-####`) so all three client-facing
  documents read consistently, and reuses the same atomic Counter so two
  managers generating at the same instant can never collide.

  Sequence keys are per-type AND per-year (`report-impact-2026`), so the two
  report types number independently and both reset each January.

  Revisions do NOT consume a new number — a revised report keeps its number and
  bumps `revision`, exactly like Certificate. The (number, revision) pair is
  what the unique index enforces.
*/

const Counter = require("../models/Counter");

const PREFIX_BY_TYPE = {
    impact: "IMP",
    ghg: "GHG",
};

/**
 * @param {"impact"|"ghg"} type
 * @param {number} [year] Defaults to the current calendar year. Passed
 *        explicitly by the controller so a report generated in early January
 *        for December's period is numbered against the period's year, not
 *        today's.
 * @returns {Promise<string>} e.g. "IMP-2026-0001"
 */
const generateReportNumber = async (type, year) => {
    const prefix = PREFIX_BY_TYPE[type];
    if (!prefix) {
        throw new Error(`Unknown report type: ${type}`);
    }
    const y = Number.isInteger(year) ? year : new Date().getFullYear();
    const seq = await Counter.nextValue(`report-${type}-${y}`);
    return `${prefix}-${y}-${String(seq).padStart(4, "0")}`;
};

module.exports = { generateReportNumber, PREFIX_BY_TYPE };
