/*
  utils/reportFactors.js — factors for the two monthly client reports.

  Single source of truth for every multiplier used by the Environmental Impact
  Report and the GHG Emission Report. Nothing else in the codebase should hold
  a hard-coded factor: when the client supplies official figures, this file is
  the only edit.

  Provenance:
  - IMPACT_FACTORS were decoded from the client's own "Impact sheet.xlsx".
  - GHG_FACTORS were reverse-engineered from the client's sample GHG document
    and verified against all four sample buildings:
        HDC2  0.51 t → -0.06 / 1.87 / 1.81
        HDC3  2.20 t → -0.25 / 8.05 / 7.80
        HDC4  0.56 t → -0.06 / 2.05 / 1.98
        HDC5  1.06 t → -0.12 / 3.88 / 3.76
    Three of the four rows reproduce exactly. HDC4 lands on 1.99 where the
    sample prints 1.98 — that is a display artifact, not a factor error: the
    sample shows tonnage rounded to 2dp, and the only underlying tonnage that
    reproduces ALL THREE of its printed values for that row is ~0.5588-0.5599
    (which itself displays as "0.56"). Feeding the rounded 0.56 back in is what
    shifts the last decimal. Do not "correct" prodEndOfLifePerTon to chase it —
    doing so would break the three rows that currently match exactly.
  - The sample's reference links (EPA WARM / EPA equivalencies / myclimate) are
    reproduced on the last page of the rendered GHG report.

  Units:
  - IMPACT_FACTORS are per 1 KG of material recycled.
  - GHG_FACTORS are per 1 TON of organic/food waste. Report inputs are in kg
    and converted once, in reportCalculations.
*/

// --- Environmental Impact report: savings per 1 KG recycled ---------------
// energy(kWh), oil(L), landfill(ft3), air(kg), water(L), trees(count)
const IMPACT_FACTORS = {
    Plastic: { energy: 5.774, oil: 2.593, landfill: 0.81, air: 2.5, water: 18.17, trees: 0 },
    Paper: { energy: 4.1, oil: 1.4384, landfill: 0.0891, air: 0.0272, water: 26.4978, trees: 0.017 },
    Cardboard: { energy: 0.39, oil: 0.1741, landfill: 0.243, air: 1, water: 26.4978, trees: 0.017 },
    Metal: { energy: 0, oil: 0, landfill: 0, air: 0, water: 0, trees: 0 },
    "E-waste": { energy: 4.123779, oil: 1.85324644, landfill: 0.260361, air: 0.50409844, water: 3.653987, trees: 0 },
};

// Display order on the report.
const IMPACT_MATERIALS = ["Plastic", "Paper", "Cardboard", "Metal", "E-waste"];

/*
  Pickup stream → impact material.

  The internal Pickup enum has 11 streams; the client's impact sheet has 5
  materials. Streams with no entry here still count toward TOTAL WASTE
  RECYCLED (the client did hand us that waste) but contribute zero to the
  savings indicators, because we have no defensible factor for them. That is
  deliberate: inventing a factor would put an unsupportable number on a
  document the client shows to auditors.

  `battery → E-waste` mirrors the existing CoD template's STREAM_TO_BUCKET
  mapping in certificatePdf.js, so the two documents agree with each other.

  There is no `cardboard` or `metal` pickup stream today. Both stay in
  IMPACT_FACTORS so that adding those streams later is a one-line change here.
*/
const STREAM_TO_IMPACT_MATERIAL = {
    plastic: "Plastic",
    paper: "Paper",
    ewaste: "E-waste",
    battery: "E-waste",
    // Unmapped (count toward total, zero savings):
    //   biomedical, foam-thermocol, dry-waste, agr, expired-food,
    //   hazardous, other
};

// --- GHG report: MTCO2E per 1 TON of organic/food waste -------------------
const GHG_FACTORS = {
    // Net GHG emitted by composting the waste. Negative in the sample.
    compostEmissionPerTon: -0.113,
    // GHG that WOULD have been emitted producing the virgin equivalent.
    productionPerTon: 3.66,
    // Production + end-of-life impact avoided — the headline savings driver.
    prodEndOfLifePerTon: 3.545,
};

/*
  Which pickup streams count as "organic / food waste" for the GHG report.

  The sample document is explicitly about organic waste "sent for
  Composting/Bio methylated", so only genuinely compostable streams belong
  here. `expired-food` is the only current stream that qualifies. If the
  client later confirms that another stream (e.g. `agr` agricultural residue)
  is composted at the facility, add it here and every GHG report picks it up.
*/
const GHG_ORGANIC_STREAMS = ["expired-food"];

const KG_PER_TON = 1000;

module.exports = {
    IMPACT_FACTORS,
    IMPACT_MATERIALS,
    STREAM_TO_IMPACT_MATERIAL,
    GHG_FACTORS,
    GHG_ORGANIC_STREAMS,
    KG_PER_TON,
};
