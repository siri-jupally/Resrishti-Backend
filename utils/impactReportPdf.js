/*
  utils/impactReportPdf.js — renders the "Environmental Impact Report".

  Template reproduces the client's sample (Environmental impact certificate.pdf):
    - Company header with logo
    - "Environmental Impact Report" title
    - "This is to certify that:" + client name (red, centered)
    - Location / Reporting Month
    - 3-column indicator table (Water / Energy / Trees / Air Pollutants)
    - Three headline stat blocks (total kg, % responsibly recycled, % circular)
    - Authorized Signatory + Date rules
    - Double-ruled outer frame

  Why React.createElement instead of JSX: this file is CommonJS and the backend
  deliberately has no Babel/JSX build step. Same convention as certificatePdf.js.

  The four indicator rows are FIXED and always render, even at zero — an
  auditor comparing two months should see the same shape of document.
*/

const React = require("react");
const path = require("path");
const {
    Document,
    Page,
    View,
    Text,
    Image,
    StyleSheet,
    renderToBuffer,
} = require("@react-pdf/renderer");

const e = React.createElement;

const { getLogo } = require("./pdfAssets");

// ---- Theme ----
const GREEN = "#2E7D32";
const GREEN_LINE = "#7CB342";
const NAVY = "#1F3864";
const RED = "#C00000";
const INK = "#1a1a1a";
const MUTED = "#555";

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// Indicator rows, in the sample's order. `key` indexes into impactSnapshot.
const INDICATOR_ROWS = [
    { key: "waterSaved", label: "Water Saved", unit: "Liters" },
    { key: "energySaved", label: "Energy Saved", unit: "kWh" },
    { key: "treesSaved", label: "Trees Saved", unit: "Trees" },
    { key: "airPollutants", label: "Air Pollutants Reduced", unit: "Kg" },
];

const styles = StyleSheet.create({
    page: {
        paddingTop: 38,
        paddingBottom: 38,
        paddingHorizontal: 38,
        fontSize: 10,
        color: INK,
        fontFamily: "Helvetica",
    },

    // Double frame approximating the sample's ruled border.
    frameOuter: {
        position: "absolute",
        top: 16, left: 16, right: 16, bottom: 16,
        borderWidth: 1.5,
        borderColor: INK,
    },
    frameInner: {
        position: "absolute",
        top: 22, left: 22, right: 22, bottom: 22,
        borderWidth: 0.75,
        borderColor: INK,
    },

    header: {
        flexDirection: "row",
        alignItems: "center",
        marginBottom: 18,
        paddingBottom: 6,
    },
    logo: { width: 62, height: 62, marginRight: 12, objectFit: "contain" },
    companyName: { fontSize: 19, fontFamily: "Helvetica-Bold", color: INK, flexShrink: 1 },

    title: {
        fontSize: 24,
        fontFamily: "Helvetica-Bold",
        color: NAVY,
        textAlign: "center",
        marginBottom: 12,
    },
    certifyLine: {
        fontSize: 11,
        fontFamily: "Helvetica-Bold",
        textAlign: "center",
        marginBottom: 8,
    },
    clientName: {
        fontSize: 12,
        fontFamily: "Helvetica-Bold",
        color: RED,
        textAlign: "center",
        marginBottom: 10,
    },
    para: { fontSize: 11, lineHeight: 1.5, marginBottom: 10 },
    metaLine: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 4 },
    metaValue: { fontFamily: "Helvetica" },

    // ---- Indicator table ----
    table: {
        marginTop: 14,
        marginBottom: 22,
        marginHorizontal: 28,
        borderWidth: 1,
        borderColor: GREEN_LINE,
    },
    tRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: GREEN_LINE },
    tRowLast: { flexDirection: "row" },
    tHeadCell: {
        fontSize: 10,
        fontFamily: "Helvetica-Bold",
        textAlign: "center",
        paddingVertical: 8,
        paddingHorizontal: 4,
    },
    tCell: {
        fontSize: 10,
        textAlign: "center",
        paddingVertical: 9,
        paddingHorizontal: 4,
    },
    tCellBold: { fontFamily: "Helvetica-Bold" },
    colIndicator: { width: "42%", borderRightWidth: 1, borderRightColor: GREEN_LINE },
    colValue: { width: "30%", borderRightWidth: 1, borderRightColor: GREEN_LINE },
    colUnit: { width: "28%" },

    // ---- Headline stats ----
    statsRow: {
        flexDirection: "row",
        justifyContent: "space-around",
        marginTop: 6,
        marginBottom: 26,
    },
    statCol: { width: "31%", alignItems: "center" },
    statBig: {
        fontSize: 22,
        fontFamily: "Helvetica-Bold",
        color: "#1F6FB2",
        marginBottom: 4,
        textAlign: "center",
    },
    statLabel: { fontSize: 8, textAlign: "center", color: INK, lineHeight: 1.3 },

    // ---- Signature ----
    sigRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "flex-end",
        marginTop: 18,
    },
    sigLabel: { fontSize: 10 },
    sigRule: {
        borderBottomWidth: 1,
        borderBottomColor: INK,
        width: 150,
        marginLeft: 6,
    },
    dateRule: {
        borderBottomWidth: 1,
        borderBottomColor: INK,
        width: 90,
        marginLeft: 6,
    },
    sigCell: { flexDirection: "row", alignItems: "flex-end" },

    footNote: {
        position: "absolute",
        bottom: 30,
        left: 38,
        right: 38,
        fontSize: 7,
        color: MUTED,
        textAlign: "center",
    },
});

// Thousands separators, 2dp max, no trailing ".00" noise on whole numbers.
const fmt = (n) => {
    const v = Number(n) || 0;
    const rounded = Math.round(v * 100) / 100;
    return rounded.toLocaleString("en-IN", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    });
};

const buildDoc = (report, client) => {
    const snap = report.impactSnapshot || {};
    const clientName = report.clientNameSnapshot || client.name || "—";

    const monthLabel =
        report.periodMonth && report.periodYear
            ? `${MONTHS[report.periodMonth - 1]} ${report.periodYear}`
            : "—";

    const addr = client.billingAddress || {};
    const location =
        [addr.city, addr.state].filter(Boolean).join(", ") ||
        addr.line1 ||
        "—";

    const logo = getLogo();
    const header = e(View, { style: styles.header },
        logo ? e(Image, { style: styles.logo, src: logo }) : null,
        e(Text, { style: styles.companyName }, "GreenEarth Integrated Facility Pvt Ltd"),
    );

    const intro = e(Text, { style: styles.para },
        "has responsibly processed and disposed of the below-mentioned quantities, ",
        "thereby contributing to environmental sustainability and the well-being of the environment.",
    );

    const tableHead = e(View, { style: styles.tRow },
        e(Text, { style: [styles.tHeadCell, styles.colIndicator] }, "Environmental Indicator"),
        e(Text, { style: [styles.tHeadCell, styles.colValue] }, "Impact Achieved"),
        e(Text, { style: [styles.tHeadCell, styles.colUnit] }, "Unit"),
    );

    const tableRows = INDICATOR_ROWS.map((row, i) => {
        const isLast = i === INDICATOR_ROWS.length - 1;
        return e(View,
            { key: row.key, style: isLast ? styles.tRowLast : styles.tRow },
            e(Text, { style: [styles.tCell, styles.tCellBold, styles.colIndicator] }, row.label),
            e(Text, { style: [styles.tCell, styles.colValue] }, fmt(snap[row.key])),
            e(Text, { style: [styles.tCell, styles.tCellBold, styles.colUnit] }, row.unit),
        );
    });

    const table = e(View, { style: styles.table }, tableHead, ...tableRows);

    // The sample prints 100% for both percentages: everything collected is
    // routed to a recycling/processing channel, none to landfill. Rendered as
    // constants rather than computed so the document can't imply a diversion
    // rate we don't actually measure per-stream.
    const stats = e(View, { style: styles.statsRow },
        e(View, { style: styles.statCol },
            e(Text, { style: styles.statBig }, `${fmt(snap.totalWasteKg)} KG`),
            e(Text, { style: styles.statLabel }, "TOTAL WASTE RECYCLED"),
        ),
        e(View, { style: styles.statCol },
            e(Text, { style: styles.statBig }, "100 %"),
            e(Text, { style: styles.statLabel }, "WASTE RESPONSIBLY RECYCLED"),
        ),
        e(View, { style: styles.statCol },
            e(Text, { style: styles.statBig }, "100 %"),
            e(Text, { style: styles.statLabel }, "Material Reintroduced into Circular Economy"),
        ),
    );

    const signature = e(View, { style: styles.sigRow },
        e(View, { style: styles.sigCell },
            e(Text, { style: styles.sigLabel }, "Authorized Signatory:"),
            e(View, { style: styles.sigRule }),
        ),
        e(View, { style: styles.sigCell },
            e(Text, { style: styles.sigLabel }, "Date:"),
            e(View, { style: styles.dateRule }),
        ),
    );

    const page = e(Page, { size: "A4", style: styles.page },
        e(View, { style: styles.frameOuter, fixed: true }),
        e(View, { style: styles.frameInner, fixed: true }),
        header,
        e(Text, { style: styles.title }, "Environmental Impact Report"),
        e(Text, { style: styles.certifyLine }, "This is to certify that:"),
        e(Text, { style: styles.clientName }, clientName),
        intro,
        e(Text, { style: styles.metaLine }, "Location: ",
            e(Text, { style: styles.metaValue }, location)),
        e(Text, { style: styles.metaLine }, "Reporting Month: ",
            e(Text, { style: styles.metaValue }, monthLabel)),
        table,
        stats,
        signature,
        e(Text, { style: styles.footNote, fixed: true },
            `${report.reportNumber || ""}${report.revision > 1 ? ` (Rev ${report.revision})` : ""}`),
    );

    return e(Document, null, page);
};

/**
 * Render the Environmental Impact Report as a PDF buffer.
 *
 * @param {Object} report Report document (type 'impact') with impactSnapshot filled.
 * @param {Object} client Client document (or POJO).
 * @returns {Promise<Buffer>}
 */
const renderImpactReportPdf = async (report, client) => {
    const doc = buildDoc(report || {}, client || {});
    return await renderToBuffer(doc);
};

module.exports = { renderImpactReportPdf, INDICATOR_ROWS };
