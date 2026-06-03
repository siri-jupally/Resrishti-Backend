/*
  utils/certNumber.js — Client Management module (Phase 1, Chunk 3)

  Purpose:
  - Generate a fresh, monotonically-increasing certificate number of the form
    `CoD-YYYY-####` where YYYY is the current calendar year and #### is a
    zero-padded 4-digit sequence resetting each year.

  Atomicity:
  - Delegates to Counter.nextValue (single `findOneAndUpdate` with `$inc` +
    upsert). Two callers running at the same instant get distinct numbers.

  Format note:
  - Spec §11.3: "Format: CoD-<YYYY>-<seq> (e.g., CoD-2026-0001). Sequence is
    per-year, monotonically increasing." 4-digit zero-padding chosen to keep
    cert numbers sortable lexicographically up to 9999/year. If we ever exceed
    that in a single year, `String(seq).padStart(4, "0")` quietly emits 5
    digits (e.g. "10000") — still unique, just not aligned. Adequate for P1.

  Coordination note for parallel agents:
  - Agent H imports this helper IF it ever needs to mint a number for a
    revision cert (the original revise flow may copy the parent's number with
    a -R<n> suffix, or mint a fresh number per cert depending on the chosen
    revision strategy — final call lives with Agent H). For the auto-draft
    path in this chunk, the cert is freshly numbered.
*/

const Counter = require("../models/Counter");

/**
 * @returns {Promise<string>} e.g. "CoD-2026-0001"
 */
const generateCertNumber = async () => {
    const year = new Date().getFullYear();
    const seq = await Counter.nextValue(`cert-${year}`);
    return `CoD-${year}-${String(seq).padStart(4, "0")}`;
};

module.exports = { generateCertNumber };
