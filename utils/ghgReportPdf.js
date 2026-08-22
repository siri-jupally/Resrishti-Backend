/*
  utils/ghgReportPdf.js — renders the "Green House Gases Emission Report".

  Reproduces the structure of the client's 5-page sample document:
    p1  Cover      — logo, company name, "GREEN HOUSE GASES EMISSION REPORT <MONTH> - <YEAR>"
    p2  Waste Generated Report — per-site food-waste bar chart + total statement
    p3  Month Overview        — 6-metric aggregate bar chart + net savings statement
    p4  Emissions & Saving    — per-site table + grouped bar chart
    p5  Thank You + EPA/myclimate references

  Charts:
  - @react-pdf/renderer has no charting primitive, so bars are plain Views with
    computed pixel heights drawn from a zero baseline. This keeps the PDF fully
    vector/text (no rasterised chart image), so it stays crisp at any zoom and
    the file stays small.
  - `barChart` handles negative values — `totalGHG` is negative in the sample
    (composting avoids more than it emits), so the baseline sits above the
    axis floor whenever any series goes below zero.

  Why React.createElement instead of JSX: CommonJS backend with no Babel step,
  matching certificatePdf.js.
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

// ---- Theme (matches the sample's green/gold deck) ----
const DEEP_GREEN = "#0B3D2E";
const GREEN = "#2E7D32";
const LEAF = "#7DBB42";
const GOLD = "#B08D3F";
const INK = "#1a1a1a";
const MUTED = "#666";
const GRID = "#DDDDDD";
const BAR_BLUE = "#9DC3E6";

const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

const styles = StyleSheet.create({
    page: {
        paddingTop: 44,
        paddingBottom: 44,
        paddingHorizontal: 44,
        fontSize: 9,
        color: INK,
        fontFamily: "Helvetica",
    },

    // Corner ornaments echoing the sample's chevron decoration.
    cornerTL: {
        position: "absolute", top: 0, left: 0,
        width: 130, height: 96,
        backgroundColor: DEEP_GREEN,
    },
    cornerTLAccent: {
        position: "absolute", top: 0, left: 96,
        width: 22, height: 62,
        backgroundColor: GOLD,
    },
    cornerBR: {
        position: "absolute", bottom: 0, right: 0,
        width: 130, height: 96,
        backgroundColor: DEEP_GREEN,
    },
    cornerBRAccent: {
        position: "absolute", bottom: 0, right: 96,
        width: 22, height: 62,
        backgroundColor: GOLD,
    },

    // ---- Cover ----
    coverWrap: {
        marginTop: 110,
        alignItems: "center",
    },
    coverLogo: { width: 108, height: 108, objectFit: "contain", marginBottom: 10 },
    coverCompany: {
        fontSize: 13,
        color: "#8B5E2B",
        textAlign: "center",
        marginBottom: 46,
        lineHeight: 1.4,
    },
    coverRule: {
        borderTopWidth: 1,
        borderTopColor: GRID,
        width: "100%",
        marginBottom: 26,
    },
    coverTitle: {
        fontSize: 21,
        fontFamily: "Times-Bold",
        color: DEEP_GREEN,
        textAlign: "center",
        lineHeight: 1.4,
        marginBottom: 26,
    },

    // ---- Content pages ----
    pageTitle: {
        fontSize: 17,
        fontFamily: "Helvetica-Bold",
        color: GREEN,
        textAlign: "center",
        marginBottom: 18,
    },
    chartCaption: {
        fontSize: 9,
        color: MUTED,
        textAlign: "center",
        marginBottom: 8,
    },

    // ---- Chart ----
    chartOuter: { flexDirection: "row", marginBottom: 14 },
    yAxis: { width: 26, justifyContent: "space-between", alignItems: "flex-end", paddingRight: 4 },
    yTick: { fontSize: 6.5, color: MUTED },
    plotWrap: { flex: 1 },
    plot: { flexDirection: "row", alignItems: "flex-end", borderLeftWidth: 0.5, borderLeftColor: GRID },
    gridLine: { position: "absolute", left: 0, right: 0, borderTopWidth: 0.5, borderTopColor: GRID },
    barSlot: { flex: 1, alignItems: "center", justifyContent: "flex-end" },
    bar: { width: "52%" },
    xAxisLine: { borderTopWidth: 0.5, borderTopColor: "#999" },
    xLabels: { flexDirection: "row", marginTop: 3 },
    xLabel: { flex: 1, fontSize: 6.5, color: MUTED, textAlign: "center", lineHeight: 1.2 },

    // ---- Callout boxes (page 2) ----
    calloutWrap: { marginTop: 6, alignItems: "center" },
    callout: {
        borderWidth: 1,
        borderColor: GREEN,
        borderRadius: 5,
        paddingVertical: 5,
        paddingHorizontal: 14,
        marginBottom: 5,
        minWidth: 190,
    },
    calloutText: { fontSize: 10, textAlign: "center" },

    // ---- Statement box ----
    statement: {
        marginTop: 14,
        borderWidth: 0.75,
        borderColor: GRID,
        padding: 12,
    },
    statementText: { fontSize: 10, textAlign: "center", lineHeight: 1.5 },
    bold: { fontFamily: "Helvetica-Bold" },

    // ---- Table (page 4) ----
    table: { marginBottom: 16 },
    tHead: { flexDirection: "row", backgroundColor: "#EAEFEA" },
    tHeadCell: {
        fontSize: 7,
        fontFamily: "Helvetica-Bold",
        padding: 5,
        textAlign: "center",
    },
    tRow: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: GRID },
    tRowAlt: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: GRID, backgroundColor: "#F7F9F7" },
    tCell: { fontSize: 8, padding: 5, textAlign: "right" },
    tCellLabel: { fontSize: 8, padding: 5, fontFamily: "Helvetica-Bold", textAlign: "left" },
    tTotalRow: { flexDirection: "row", borderTopWidth: 1, borderTopColor: GREEN, backgroundColor: "#EAEFEA" },
    tTotalCell: { fontSize: 8, padding: 5, fontFamily: "Helvetica-Bold", textAlign: "right" },
    colSite: { width: "20%" },
    colNum: { width: "16%" },

    // ---- Legend ----
    legendRow: { flexDirection: "row", justifyContent: "center", marginTop: 6, flexWrap: "wrap" },
    legendItem: { flexDirection: "row", alignItems: "center", marginHorizontal: 7, marginBottom: 3 },
    legendSwatch: { width: 8, height: 8, marginRight: 3 },
    legendLabel: { fontSize: 6.5, color: MUTED },

    // ---- Thank you ----
    thanksTitle: {
        fontSize: 30,
        color: LEAF,
        textAlign: "center",
        marginTop: 150,
        marginBottom: 26,
    },
    refLabel: { fontSize: 10, fontFamily: "Helvetica-Bold", textAlign: "center", marginBottom: 8 },
    refLink: { fontSize: 9, color: "#1155CC", textAlign: "center", marginBottom: 8 },

    footNote: {
        position: "absolute",
        bottom: 22,
        left: 44,
        right: 44,
        fontSize: 6.5,
        color: MUTED,
        textAlign: "center",
    },
});

const fmt = (n, d = 2) => {
    const v = Number(n) || 0;
    return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString("en-IN", {
        minimumFractionDigits: 0,
        maximumFractionDigits: d,
    });
};

/**
 * Vertical bar chart drawn from layout primitives.
 *
 * Handles negative values by placing the zero baseline proportionally: bars
 * above zero grow up from it, bars below grow down. Without this the sample's
 * negative `totalGHG` column would render as a zero-height stub.
 *
 * @param {Array<{label: string, value: number, color?: string}>} data
 * @param {number} height plot height in pt
 */
const barChart = (data, { height = 150, color = LEAF, ticks = 5, key = "c" } = {}) => {
    const values = data.map((d) => Number(d.value) || 0);
    const rawMax = Math.max(0, ...values);
    const rawMin = Math.min(0, ...values);
    // Pad the top so the tallest bar doesn't touch the frame.
    const max = rawMax === 0 && rawMin === 0 ? 1 : rawMax * 1.1;
    const min = rawMin * 1.1;
    const span = max - min || 1;

    const zeroFromBottom = ((0 - min) / span) * height;

    const tickVals = [];
    for (let i = 0; i <= ticks; i++) {
        tickVals.push(max - (span * i) / ticks);
    }

    const bars = data.map((d, i) => {
        const v = Number(d.value) || 0;
        const h = (Math.abs(v) / span) * height;
        // Positive bars sit on the baseline; negative ones hang below it.
        const offset = v >= 0 ? zeroFromBottom : zeroFromBottom - h;
        return e(View, { key: `${key}b${i}`, style: styles.barSlot },
            e(View, {
                style: [
                    styles.bar,
                    {
                        height: Math.max(h, v === 0 ? 0 : 0.6),
                        backgroundColor: d.color || color,
                        marginBottom: offset,
                    },
                ],
            })
        );
    });

    const gridLines = tickVals.map((t, i) =>
        e(View, {
            key: `${key}g${i}`,
            style: [styles.gridLine, { bottom: ((t - min) / span) * height }],
        })
    );

    return e(View, { style: styles.chartOuter },
        // Y axis ticks
        e(View, { style: [styles.yAxis, { height }] },
            ...tickVals.map((t, i) =>
                e(Text, { key: `${key}t${i}`, style: styles.yTick }, fmt(t, 1))
            )
        ),
        e(View, { style: styles.plotWrap },
            e(View, { style: [styles.plot, { height }] }, ...gridLines, ...bars),
            e(View, { style: styles.xAxisLine }),
            e(View, { style: styles.xLabels },
                ...data.map((d, i) =>
                    e(Text, { key: `${key}x${i}`, style: styles.xLabel }, d.label)
                )
            )
        )
    );
};

const corners = () => [
    e(View, { key: "ctl", style: styles.cornerTL, fixed: true }),
    e(View, { key: "ctla", style: styles.cornerTLAccent, fixed: true }),
    e(View, { key: "cbr", style: styles.cornerBR, fixed: true }),
    e(View, { key: "cbra", style: styles.cornerBRAccent, fixed: true }),
];

const buildDoc = (report, client) => {
    const snap = report.ghgSnapshot || {};
    const rows = snap.rows || [];
    const totals = snap.totals || {};
    const clientName = report.clientNameSnapshot || client.name || "—";

    const monthName = report.periodMonth ? MONTHS[report.periodMonth - 1] : "";
    const monthLabel = `${monthName} ${report.periodYear || ""}`.trim();

    const footer = e(Text, { style: styles.footNote, fixed: true },
        `${report.reportNumber || ""}${report.revision > 1 ? ` (Rev ${report.revision})` : ""}  |  ${clientName}  |  ${monthLabel}`
    );

    // ===== Page 1 — Cover =====
    const cover = e(Page, { size: "A4", style: styles.page },
        ...corners(),
        e(View, { style: styles.coverWrap },
            getLogo() ? e(Image, { style: styles.coverLogo, src: getLogo() }) : null,
            e(Text, { style: styles.coverCompany }, "GreenEarth Integrated\nFacility Private Limited"),
            e(View, { style: styles.coverRule }),
            e(Text, { style: styles.coverTitle },
                `GREEN HOUSE GASES EMISSION\nREPORT ${monthName.toUpperCase()} - ${report.periodYear || ""}`),
            e(View, { style: styles.coverRule }),
        ),
    );

    // ===== Page 2 — Waste Generated Report =====
    const wasteChart = barChart(
        rows.map((r) => ({ label: r.siteName, value: r.foodWasteTons })),
        { height: 150, color: BAR_BLUE, key: "w" }
    );

    const callouts = e(View, { style: styles.calloutWrap },
        ...rows.map((r, i) =>
            e(View, { key: `co${i}`, style: styles.callout },
                e(Text, { style: styles.calloutText }, `${r.siteName} (${fmt(r.foodWasteTons)} Tons)`)
            )
        )
    );

    const siteCount = rows.length;
    const page2 = e(Page, { size: "A4", style: styles.page },
        ...corners(),
        e(Text, { style: styles.pageTitle }, "Waste Generated Report"),
        e(Text, { style: styles.chartCaption }, "Generated food waste in tons"),
        wasteChart,
        callouts,
        e(View, { style: styles.statement },
            e(Text, { style: styles.statementText },
                `Total quantity of organic waste from ${siteCount} ${siteCount === 1 ? "location" : "locations"} of `,
                e(Text, { style: styles.bold }, clientName),
                " sent for Composting/Bio methylated in ",
                e(Text, { style: styles.bold }, monthLabel),
                " is ",
                e(Text, { style: styles.bold }, `${fmt(totals.foodWasteTons)} tons`),
                "."
            )
        ),
        footer,
    );

    // ===== Page 3 — Month overview =====
    const overviewData = [
        { label: "Generated food\nwaste in tons", value: totals.foodWasteTons },
        { label: "Composted", value: totals.composted },
        { label: "Total GHG\nEmissions\n(MTCO2E)", value: totals.totalGHG },
        { label: "GHG Emissions\nfrom Production\n(MTCO2E)", value: totals.production },
        { label: "Production +\nEnd-of-Life\nImpact (MTCO2E)", value: totals.prodEndOfLife },
    ];

    const page3 = e(Page, { size: "A4", style: styles.page },
        ...corners(),
        e(Text, { style: styles.pageTitle }, `${monthLabel} report Overview`),
        barChart(overviewData, { height: 190, color: LEAF, key: "o" }),
        e(View, { style: styles.statement },
            e(Text, { style: styles.statementText },
                "Total Net GHG Savings in the month of ",
                e(Text, { style: styles.bold }, monthLabel),
                ": ",
                e(Text, { style: styles.bold }, `${fmt(snap.netGHGSavings)} tons`),
            ),
        ),
        footer,
    );

    // ===== Page 4 — Emissions table + grouped chart =====
    const headerRow = e(View, { style: styles.tHead },
        e(Text, { style: [styles.tHeadCell, styles.colSite] }, ""),
        e(Text, { style: [styles.tHeadCell, styles.colNum] }, "Generated food waste in tons"),
        e(Text, { style: [styles.tHeadCell, styles.colNum] }, "Composted"),
        e(Text, { style: [styles.tHeadCell, styles.colNum] }, "Total GHG Emissions (MTCO2E)"),
        e(Text, { style: [styles.tHeadCell, styles.colNum] }, "GHG Emissions from Production (MTCO2E)"),
        e(Text, { style: [styles.tHeadCell, styles.colNum] }, "Production + End-of-Life Impact (MTCO2E)"),
    );

    const bodyRows = rows.map((r, i) =>
        e(View, { key: `tr${i}`, style: i % 2 ? styles.tRowAlt : styles.tRow },
            e(Text, { style: [styles.tCellLabel, styles.colSite] }, r.siteName),
            e(Text, { style: [styles.tCell, styles.colNum] }, fmt(r.foodWasteTons)),
            e(Text, { style: [styles.tCell, styles.colNum] }, fmt(r.composted)),
            e(Text, { style: [styles.tCell, styles.colNum] }, fmt(r.totalGHG)),
            e(Text, { style: [styles.tCell, styles.colNum] }, fmt(r.production)),
            e(Text, { style: [styles.tCell, styles.colNum] }, fmt(r.prodEndOfLife)),
        )
    );

    const totalRow = e(View, { style: styles.tTotalRow },
        e(Text, { style: [styles.tCellLabel, styles.colSite] }, "Total"),
        e(Text, { style: [styles.tTotalCell, styles.colNum] }, fmt(totals.foodWasteTons)),
        e(Text, { style: [styles.tTotalCell, styles.colNum] }, fmt(totals.composted)),
        e(Text, { style: [styles.tTotalCell, styles.colNum] }, fmt(totals.totalGHG)),
        e(Text, { style: [styles.tTotalCell, styles.colNum] }, fmt(totals.production)),
        e(Text, { style: [styles.tTotalCell, styles.colNum] }, fmt(totals.prodEndOfLife)),
    );

    // Per-site comparison of the headline metric.
    const perSiteChart = barChart(
        rows.map((r) => ({ label: r.siteName, value: r.prodEndOfLife })),
        { height: 130, color: GREEN, key: "p" }
    );

    const page4 = e(Page, { size: "A4", style: styles.page },
        ...corners(),
        e(Text, { style: styles.pageTitle },
            "GHG Emissions and Saving for the Generated Organic/Food Waste"),
        e(View, { style: styles.table }, headerRow, ...bodyRows, totalRow),
        e(Text, { style: styles.chartCaption },
            "Production + End-of-Life Impact avoided, by location (MTCO2E)"),
        perSiteChart,
        e(View, { style: styles.legendRow },
            e(View, { style: styles.legendItem },
                e(View, { style: [styles.legendSwatch, { backgroundColor: GREEN }] }),
                e(Text, { style: styles.legendLabel }, "Production + End-of-Life Impact (MTCO2E)"),
            ),
        ),
        footer,
    );

    // ===== Page 5 — Thank you / references =====
    const page5 = e(Page, { size: "A4", style: styles.page },
        ...corners(),
        e(Text, { style: styles.thanksTitle }, "Thank You!"),
        e(Text, { style: styles.refLabel }, "For reference:"),
        e(Text, { style: styles.refLink },
            "https://www.epa.gov/energy/greenhouse-gas-equivalencies-calculator"),
        e(Text, { style: styles.refLink },
            "https://co2.myclimate.org/en/portfolios?calculation_id=5959649"),
        e(Text, { style: styles.refLink },
            "https://www.epa.gov/warm/versions-waste-reduction-model-warm#15"),
        footer,
    );

    return e(Document, null, cover, page2, page3, page4, page5);
};

/**
 * Render the Green House Gases Emission Report as a PDF buffer.
 *
 * @param {Object} report Report document (type 'ghg') with ghgSnapshot filled.
 * @param {Object} client Client document (or POJO).
 * @returns {Promise<Buffer>}
 */
const renderGhgReportPdf = async (report, client) => {
    const doc = buildDoc(report || {}, client || {});
    return await renderToBuffer(doc);
};

module.exports = { renderGhgReportPdf };
