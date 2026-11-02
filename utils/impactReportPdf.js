/*
  utils/impactReportPdf.js — "Environmental Impact Report"

  Rebuilt 2026-11-01 to match the client-supplied template
  ("Environmental impact certificate- UPDATED.pdf"):
    - Navy double-ruled frame with corner brackets
    - Boxed letterhead: GreenEarth emblem + company name
    - "Environmental Impact Report" title (navy)
    - "This is to certify that:" + client name (red, centered)
    - Intro line, Location, Reporting Month
    - 3-column green indicator table (Water / Energy / Trees / Air Pollutants)
      with the matching emoji-style icon beside each row
    - Three blue headline stat tiles (total kg, % recycled, % circular) each
      with an icon
    - Authorized Signatory (C Nagaraj Yadav) + signature image + Date rule

  The four indicator rows are FIXED and always render (even at zero) so an
  auditor comparing two months sees the same shape of document. The CO₂e row
  that previously appeared is intentionally omitted — the supplied template
  shows exactly these four indicators.

  React.createElement (not JSX): this backend has no Babel/JSX build step.
  All graphics load as Buffers via pdfAssets (a string src breaks react-pdf's
  fetch()); a missing asset is skipped, never fatal.
*/

const React = require("react");
const path = require("path");
const {
    Document, Page, View, Text, Image, StyleSheet, renderToBuffer, Font,
} = require("@react-pdf/renderer");

const e = React.createElement;
const { getCertAsset } = require("./pdfAssets");

// Rounded display font matching the template's headings. Falls back to
// Helvetica-Bold if the asset is missing. Registered once per process.
// Bold rounded display font matching the template's headings. Quicksand-Bold
// gives the rounded + BOLD weight the template uses; falls back to Helvetica-Bold
// (still bold) if it can't load.
let FONT_ROUND = "Helvetica-Bold";
try {
    Font.register({ family: "QuicksandBold", src: path.join(__dirname, "..", "assets", "cert", "Quicksand-Bold.woff") });
    FONT_ROUND = "QuicksandBold";
} catch (err) {
    console.warn("Quicksand-Bold font registration failed, using Helvetica-Bold:", err.message);
}
// Never hyphenate/break words mid-word (keeps labels like "Circular Economy" clean).
Font.registerHyphenationCallback((word) => [word]);

// ---- Theme ----
const NAVY = "#1F3864";
const GREEN_LINE = "#80AD4B";   // table rules (olive-green, matches template)
const BLUE_STAT = "#2E75B6";    // headline numbers
const RED = "#C00000";
const INK = "#1a1a1a";

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// Indicator rows, in the template's order. `key` indexes impactSnapshot;
// `icon` is the asset beside the row.
const INDICATOR_ROWS = [
    { key: "waterSaved", label: "Water Saved", unit: "Liters", icon: "icon-water.png" },
    { key: "energySaved", label: "Energy Saved", unit: "kWh", icon: "icon-energy.png" },
    { key: "treesSaved", label: "Trees Saved", unit: "Trees", icon: "icon-trees.png" },
    { key: "airPollutants", label: "Air Pollutants Reduced", unit: "Kg", icon: "icon-air.png" },
];

const HEAD_H = 42;   // table header row height
const ROW_H = 50;    // table data row height

const styles = StyleSheet.create({
    page: {
        paddingTop: 34, paddingBottom: 30, paddingHorizontal: 40,
        fontSize: 10, color: INK, fontFamily: "Helvetica",
    },

    // ---- Double navy frame + corner brackets ----
    frameOuter: { position: "absolute", top: 16, left: 16, right: 16, bottom: 16, borderWidth: 1.6, borderColor: NAVY },
    frameInner: { position: "absolute", top: 21, left: 21, right: 21, bottom: 21, borderWidth: 0.7, borderColor: NAVY },

    // ---- Letterhead ----
    headRow: { flexDirection: "row", alignItems: "center", borderBottomWidth: 1.4, borderBottomColor: NAVY, paddingBottom: 8, marginBottom: 2 },
    logoCell: { width: 78, alignItems: "center", borderRightWidth: 1.4, borderRightColor: NAVY, paddingRight: 8 },
    logo: { width: 64, height: 64, objectFit: "contain" },
    company: { flex: 1, fontSize: 20, fontFamily: FONT_ROUND, color: "#111", textAlign: "center", letterSpacing: 1.4 },

    title: { fontSize: 25, fontFamily: FONT_ROUND, color: NAVY, textAlign: "center", letterSpacing: 3, marginTop: 16, marginBottom: 10 },
    certify: { fontSize: 12, fontFamily: "Helvetica-Bold", color: NAVY, textAlign: "center", marginBottom: 8 },
    clientName: { fontSize: 12, fontFamily: "Helvetica-Bold", color: RED, textAlign: "center", marginBottom: 10 },
    para: { fontSize: 11, lineHeight: 1.5, marginBottom: 10 },
    metaLine: { fontSize: 11.5, fontFamily: "Helvetica-Bold", marginBottom: 3 },
    metaValue: { fontFamily: "Helvetica" },

    // ---- Indicator table + icon rail ----
    tableWrap: { flexDirection: "row", marginTop: 10, marginBottom: 20, alignItems: "flex-start", justifyContent: "center" },
    table: { width: 312, borderWidth: 1.5, borderColor: GREEN_LINE },
    headRowT: { flexDirection: "row", height: HEAD_H },
    dataRow: { flexDirection: "row", height: ROW_H, borderTopWidth: 1.5, borderTopColor: GREEN_LINE },
    cellIndicator: { width: "42%", borderRightWidth: 1.5, borderRightColor: GREEN_LINE, justifyContent: "center", paddingHorizontal: 6 },
    cellValue: { width: "30%", borderRightWidth: 1.5, borderRightColor: GREEN_LINE, justifyContent: "center" },
    cellUnit: { width: "28%", justifyContent: "center" },
    thText: { fontSize: 11.5, fontFamily: "Helvetica-Bold", textAlign: "center" },
    indText: { fontSize: 11.5, fontFamily: "Helvetica-Bold", textAlign: "center" },
    valText: { fontSize: 11.5, fontFamily: "Helvetica-Bold", textAlign: "center" },
    unitText: { fontSize: 11.5, fontFamily: "Helvetica-Bold", textAlign: "center" },
    iconRail: { width: 84, marginLeft: 12 },
    iconSpacer: { height: HEAD_H },
    iconCell: { height: ROW_H, alignItems: "center", justifyContent: "center" },
    rowIcon: { width: 48, height: 48, objectFit: "contain" },

    // ---- Headline stat tiles ----
    stats: { flexDirection: "row", justifyContent: "space-between", marginTop: 4, marginBottom: 18, paddingHorizontal: 6 },
    statCol: { width: "32%", alignItems: "center" },
    statBig: { fontSize: 23, fontFamily: FONT_ROUND, color: BLUE_STAT, marginBottom: 3, textAlign: "center" },
    statLabel: { fontSize: 8.5, color: BLUE_STAT, textAlign: "center", lineHeight: 1.25, marginBottom: 6 },
    statIcon: { width: 80, height: 74, objectFit: "contain", marginTop: 4 },

    // ---- Signature footer ----
    sigRow: { flexDirection: "row", alignItems: "flex-end", marginTop: 6 },
    sigLabel: { fontSize: 11 },
    sigName: { fontSize: 11, fontFamily: "Helvetica-Bold", marginLeft: 3 },
    sigImg: { width: 92, height: 30, objectFit: "contain", marginHorizontal: 8 },
    dateLabel: { fontSize: 11, marginLeft: 8 },
    dateRule: { borderBottomWidth: 1, borderBottomColor: INK, width: 120, marginLeft: 4, marginBottom: 2 },

    // corner brackets
    br: { position: "absolute", borderColor: NAVY },
});

// thousands separators, up to 2dp, no trailing .00
const fmt = (n) => {
    const v = Number(n) || 0;
    const r = Math.round(v * 100) / 100;
    return r.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};

// Four L-shaped corner brackets just inside the inner frame.
const cornerBrackets = () => {
    const len = 16, off = 27, t = 1.4;
    const mk = (k, style) => e(View, { key: k, style: [styles.br, style] });
    return [
        // top-left
        mk("tl-h", { top: off, left: off, width: len, borderTopWidth: t }),
        mk("tl-v", { top: off, left: off, height: len, borderLeftWidth: t }),
        // top-right
        mk("tr-h", { top: off, right: off, width: len, borderTopWidth: t }),
        mk("tr-v", { top: off, right: off, height: len, borderRightWidth: t }),
        // bottom-left
        mk("bl-h", { bottom: off, left: off, width: len, borderBottomWidth: t }),
        mk("bl-v", { bottom: off, left: off, height: len, borderLeftWidth: t }),
        // bottom-right
        mk("br-h", { bottom: off, right: off, width: len, borderBottomWidth: t }),
        mk("br-v", { bottom: off, right: off, height: len, borderRightWidth: t }),
    ];
};

const buildDoc = (report, client) => {
    const snap = report.impactSnapshot || {};
    const clientName = report.clientNameSnapshot || client.name || "—";
    const monthLabel = report.periodMonth && report.periodYear
        ? `${MONTHS[report.periodMonth - 1]} ${report.periodYear}` : "—";
    const addr = client.billingAddress || {};
    const location = [addr.city, addr.state].filter(Boolean).join(", ") || addr.line1 || "—";

    const logo = getCertAsset("cert-logo.png");
    const sig = getCertAsset("cert-signature.png");

    const header = e(View, { style: styles.headRow },
        e(View, { style: styles.logoCell }, logo ? e(Image, { src: logo, style: styles.logo }) : null),
        e(Text, { style: styles.company }, "GreenEarth Integrated Facility Pvt Ltd"),
    );

    // table
    const headerRow = e(View, { style: styles.headRowT },
        e(View, { style: styles.cellIndicator }, e(Text, { style: styles.thText }, "Environmental Indicator")),
        e(View, { style: styles.cellValue }, e(Text, { style: styles.thText }, "Impact Achieved")),
        e(View, { style: styles.cellUnit }, e(Text, { style: styles.thText }, "Unit")),
    );
    const dataRows = INDICATOR_ROWS.map((row) =>
        e(View, { key: row.key, style: styles.dataRow },
            e(View, { style: styles.cellIndicator }, e(Text, { style: styles.indText }, row.label)),
            e(View, { style: styles.cellValue }, e(Text, { style: styles.valText }, fmt(snap[row.key]))),
            e(View, { style: styles.cellUnit }, e(Text, { style: styles.unitText }, row.unit)),
        )
    );
    const table = e(View, { style: styles.table }, headerRow, ...dataRows);

    const iconRail = e(View, { style: styles.iconRail },
        e(View, { style: styles.iconSpacer }),
        ...INDICATOR_ROWS.map((row) => {
            const ic = getCertAsset(row.icon);
            return e(View, { key: row.key, style: styles.iconCell },
                ic ? e(Image, { src: ic, style: styles.rowIcon }) : null);
        })
    );

    const statTile = (big, label, iconFile) => {
        const ic = getCertAsset(iconFile);
        return e(View, { style: styles.statCol },
            e(Text, { style: styles.statBig }, big),
            e(Text, { style: styles.statLabel }, label),
            ic ? e(Image, { src: ic, style: styles.statIcon }) : null,
        );
    };

    const stats = e(View, { style: styles.stats },
        statTile(`${fmt(snap.totalWasteKg)} KG`, "TOTAL WASTE RECYCLED", "icon-recycled.png"),
        statTile("100 %", "WASTE RESPONSIBLY RECYCLED", "icon-globe.png"),
        statTile("100 %", "Material Reintroduced into Circular Economy", "icon-circular.png"),
    );

    const signature = e(View, { style: styles.sigRow },
        e(Text, { style: styles.sigLabel }, "Authorized Signatory:"),
        e(Text, { style: styles.sigName }, "C Nagaraj Yadav"),
        sig ? e(Image, { src: sig, style: styles.sigImg }) : null,
        e(Text, { style: styles.dateLabel }, "Date:"),
        e(View, { style: styles.dateRule }),
    );

    const page = e(Page, { size: "A4", style: styles.page },
        e(View, { style: styles.frameOuter, fixed: true }),
        e(View, { style: styles.frameInner, fixed: true }),
        ...cornerBrackets(),
        header,
        e(Text, { style: styles.title }, "Environmental Impact Report"),
        e(Text, { style: styles.certify }, "This is to certify that:"),
        e(Text, { style: styles.clientName }, clientName),
        e(Text, { style: styles.para },
            "has responsibly processed and disposed of the below-mentioned quantities, thereby ",
            "contributing to environmental sustainability and the well-being of the environment."),
        e(Text, { style: styles.metaLine }, "Location: ", e(Text, { style: styles.metaValue }, location)),
        e(Text, { style: styles.metaLine }, "Reporting Month: ", e(Text, { style: styles.metaValue }, monthLabel)),
        e(View, { style: styles.tableWrap }, table, iconRail),
        stats,
        signature,
    );

    return e(Document, null, page);
};

const renderImpactReportPdf = async (report, client) =>
    renderToBuffer(buildDoc(report || {}, client || {}));

module.exports = { renderImpactReportPdf, INDICATOR_ROWS };
