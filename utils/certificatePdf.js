/*
  utils/certificatePdf.js — the per-pickup Certificate of Disposal.

  Rebuilt 2026-11-02 to match the client-supplied gold template
  ("COD - UPDATED.pdf") — the SAME visual design as the monthly Certificate of
  Disposal (utils/monthlyCodPdf.js), so a client sees one consistent document
  whether it covers a single pickup or a whole month:
    Page 1: ornate gold frame (bars + guilloche swirls + corner triangle),
            GreenEarth emblem + serif wordmark, the "CERTIFICATE OF WASTE
            COLLECTION, PROCESSING & RECYCLING" body, the collection date,
            the CPCB compliance line, and the waste details table + total.
    Page 2: Compliance Declaration, Managing Director sign-off (name + real
            signature image) and the gold medal seal.

  Data is ONE pickup's disposed waste, aggregated into the same certificate
  buckets the monthly report uses (reportCalculations.calcCod +
  wasteCategories.bucketForStream), so the two documents compute identically.

  React.createElement (no JSX — no Babel step). Decorative graphics load as
  Buffers via pdfAssets; a missing asset is skipped, never fatal.

  Exposed API (unchanged): renderCertificatePdf(cert, pickup, client) → Promise<Buffer>
*/

const React = require("react");
const {
    Document, Page, View, Text, Image, StyleSheet, renderToBuffer, Svg, Polygon,
} = require("@react-pdf/renderer");

const e = React.createElement;
const { getCertAsset } = require("./pdfAssets");
const { calcCod } = require("./reportCalculations");
const { bucketForStream, refreshCache } = require("./wasteCategories");

// ---- Theme (identical to monthlyCodPdf.js so both CoDs match) ----
const GOLD = "#C9A24A";
const GOLD_SOFT = "#E6D3A3";
const BRONZE = "#7A5F1E";    // "GreenEarth Integrated Facility"
const GOLD_WORD = "#B8860B"; // "Private Limited"
const NAVY = "#1F3864";
const INK = "#1a1a1a";

const styles = StyleSheet.create({
    page: { paddingTop: 58, paddingBottom: 56, paddingHorizontal: 58, fontSize: 10.5, color: INK, fontFamily: "Helvetica", lineHeight: 1.5 },

    // ---- gold frame (thick bars + thin inner line) ----
    frameBar: { position: "absolute", borderRadius: 7, borderColor: GOLD, borderWidth: 14, top: 15, left: 15, right: 15, bottom: 15 },
    frameInner: { position: "absolute", borderColor: GOLD_SOFT, borderWidth: 1, top: 40, left: 40, right: 40, bottom: 40 },
    swirlTR: { position: "absolute", top: 16, right: 16, width: 220, height: 205, objectFit: "contain" },
    swirlBL: { position: "absolute", bottom: 16, left: 16, width: 188, height: 275, objectFit: "contain" },
    triangleWrap: { position: "absolute", right: 16, bottom: 16, width: 140, height: 140 },

    // ---- header ----
    header: { flexDirection: "row", alignItems: "center", marginBottom: 12 },
    logo: { width: 94, height: 94, objectFit: "contain", marginRight: 16 },
    companyBlock: { flexShrink: 1 },
    companyL1: { fontSize: 23, fontFamily: "Times-Bold", color: BRONZE },
    companyL2: { fontSize: 23, fontFamily: "Times-Bold", color: GOLD_WORD, marginTop: 5 },

    title: { fontSize: 12, fontFamily: "Helvetica-Bold", color: INK, textAlign: "center", marginTop: 8, marginBottom: 12, letterSpacing: 0.2 },
    dateRow: { textAlign: "right", marginBottom: 10 },
    dateLabel: { fontSize: 10.5, fontFamily: "Helvetica-Bold" },

    para: { fontSize: 10.5, lineHeight: 1.6, marginBottom: 10, textAlign: "justify" },
    b: { fontFamily: "Helvetica-Bold" },
    period: { fontSize: 11.5, fontFamily: "Helvetica-Bold", textAlign: "center", marginVertical: 8 },

    detailsHead: { fontSize: 11, fontFamily: "Helvetica-Bold", marginTop: 14, marginBottom: 6 },

    tHead: { flexDirection: "row", marginBottom: 10 },
    tRow: { flexDirection: "row", marginBottom: 12, minHeight: 42 },
    cSl: { width: "9%" }, cType: { width: "27%" }, cQty: { width: "26%" }, cMethod: { width: "38%" },
    th: { fontSize: 10.5, fontFamily: "Helvetica-Bold" },
    td: { fontSize: 10.5, lineHeight: 1.45 },

    total: { fontSize: 11, marginTop: 10 },

    // ---- page 2 ----
    p2Head: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 8 },
    forLine: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginTop: 18 },
    signWrap: { alignItems: "center", marginTop: 48 },
    signName: { fontSize: 23, fontFamily: "Times-Italic", color: NAVY, marginBottom: 16 },
    signRole: { fontSize: 14 },
    signImg: { width: 150, height: 58, objectFit: "contain", marginTop: 6 },
    seal: { width: 110, height: 118, objectFit: "contain", marginTop: 10 },
});

const fmtDate = (d) => {
    const date = d instanceof Date ? d : new Date(d || Date.now());
    if (isNaN(date.getTime())) return "";
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    const yy = String(date.getFullYear()).slice(-2);
    return `${dd}/${mm}/${yy}`;
};

const fmtAddress = (addr) => {
    if (!addr) return "—";
    const parts = [addr.line1, addr.line2, [addr.city, addr.state].filter(Boolean).join(", "), addr.postalCode].filter(Boolean);
    return parts.join(", ") || "—";
};

// Template prints raw integers — no thousands separators.
const fmtNum = (n) => {
    const v = Number(n) || 0;
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
};
const fmtQty = (n) => ((Number(n) || 0) > 0 ? fmtNum(n) : "—");
const fmtTotal = fmtNum;

// Decorative gold frame for a page. `blSwirl` adds the bottom-left guilloche
// (present on the template's page 2). Mirrors utils/monthlyCodPdf.js exactly.
const frame = (blSwirl) => {
    const tr = getCertAsset("cod-swirl-tr.png");
    const bl = getCertAsset("cod-swirl-bl.png");
    // Order matters: swirls (opaque white bg) are drawn FIRST so the gold border
    // and triangle paint ON TOP of them — otherwise the swirl's white box notches
    // out the frame.
    const els = [];
    if (tr) els.push(e(Image, { key: "tr", src: tr, style: styles.swirlTR, fixed: true }));
    if (blSwirl && bl) els.push(e(Image, { key: "bl", src: bl, style: styles.swirlBL, fixed: true }));
    els.push(e(View, { key: "fb", style: styles.frameBar, fixed: true }));
    els.push(e(View, { key: "fi", style: styles.frameInner, fixed: true }));
    els.push(e(View, { key: "tri", style: styles.triangleWrap, fixed: true },
        e(Svg, { viewBox: "0 0 100 100", style: { width: "100%", height: "100%" } },
            e(Polygon, { points: "100,8 100,100 8,100", fill: GOLD }))));
    return els;
};

const buildDoc = (cert, pickup, client, snap) => {
    const rows = Array.isArray(snap.rows) ? snap.rows.filter((r) => Number(r.qtyKg) > 0) : [];
    const clientName = cert.clientNameSnapshot || (client && client.name) || "Client";
    // The collection date for a single pickup: the frozen snapshot, else the
    // live pickup's scheduled date, else the issue date.
    const collectionDate = cert.pickupDateSnapshot || (pickup && pickup.scheduledDate) || cert.issuedAt;
    const dateStr = fmtDate(cert.issuedAt || cert.createdAt);
    const address = fmtAddress(client && client.billingAddress);

    const logo = getCertAsset("cert-logo.png");
    const sig = getCertAsset("cert-signature.png");
    const seal = getCertAsset("cod-seal.png");

    // ===== Page 1 =====
    const header = e(View, { style: styles.header },
        logo ? e(Image, { src: logo, style: styles.logo }) : null,
        e(View, { style: styles.companyBlock },
            e(Text, { style: styles.companyL1 }, "GreenEarth Integrated Facility"),
            e(Text, { style: styles.companyL2 }, "Private Limited"),
        ),
    );

    const body = e(Text, { style: styles.para },
        "This is to certify that ", e(Text, { style: styles.b }, clientName),
        " located at ", e(Text, { style: styles.b }, address),
        ", has handed over the following waste materials to ",
        e(Text, { style: styles.b }, "GREENEARTH INTEGRATED FACILITY PVT LTD"),
        ", for ", e(Text, { style: styles.b }, "collection, processing, responsible disposal"), ".",
    );

    const cpcb = e(Text, { style: styles.para },
        "The waste has been handled in accordance with the guidelines of the ",
        e(Text, { style: styles.b }, "Central Pollution Control Board"),
        " and the provisions of the ",
        e(Text, { style: styles.b }, "Solid Waste Management Rules, 2026."),
    );

    const tableHead = e(View, { style: styles.tHead },
        e(Text, { style: [styles.th, styles.cSl] }, "Sl. No"),
        e(Text, { style: [styles.th, styles.cType] }, "Type of Waste"),
        e(Text, { style: [styles.th, styles.cQty] }, "Quantity/KG"),
        e(Text, { style: [styles.th, styles.cMethod] }, "Processing Method"),
    );
    const tableRows = rows.map((r, i) =>
        e(View, { key: r.key || i, style: styles.tRow },
            e(Text, { style: [styles.td, styles.cSl] }, String(i + 1)),
            e(Text, { style: [styles.td, styles.cType] }, r.label),
            e(Text, { style: [styles.td, styles.cQty] }, fmtQty(r.qtyKg)),
            e(Text, { style: [styles.td, styles.cMethod] }, r.method),
        )
    );

    const page1 = e(Page, { size: "A4", style: styles.page },
        ...frame(false),
        header,
        e(Text, { style: styles.title }, "CERTIFICATE OF WASTE COLLECTION, PROCESSING & RECYCLING"),
        e(Text, { style: styles.dateRow }, e(Text, { style: styles.dateLabel }, "Date: "), dateStr),
        body,
        e(Text, { style: styles.period }, `Date of Collection: ${fmtDate(collectionDate)}`),
        cpcb,
        e(Text, { style: styles.detailsHead }, "Waste Collection & Processing Details"),
        e(View, null, tableHead, ...tableRows),
        e(Text, { style: styles.total }, `Total waste Collected : ${fmtTotal(snap.totalKg)}`),
    );

    // ===== Page 2 =====
    const page2 = e(Page, { size: "A4", style: styles.page },
        ...frame(true),
        e(Text, { style: styles.p2Head }, "Compliance Declaration"),
        e(Text, { style: styles.para },
            "We hereby confirm that the waste collected from ", e(Text, { style: styles.b }, clientName),
            " has been ", e(Text, { style: styles.b }, "handled, processed, and disposed of in an environmentally responsible manner"),
            ", ensuring compliance with applicable environmental regulations and industry best practices."),
        e(Text, { style: styles.para },
            "This certificate is issued upon request of the client for ",
            e(Text, { style: styles.b }, "environmental compliance, sustainability reporting, and record purposes"), "."),
        e(Text, { style: styles.forLine }, "For GREENEARTH INTEGRATED FACILITY PVT LTD"),
        e(View, { style: styles.signWrap },
            e(Text, { style: styles.signName }, "C Nagaraj Yadav"),
            e(Text, { style: styles.signRole }, "Managing Director"),
            sig ? e(Image, { src: sig, style: styles.signImg }) : null,
            seal ? e(Image, { src: seal, style: styles.seal }) : null,
        ),
    );

    return e(Document, null, page1, page2);
};

/**
 * Render the per-pickup Certificate of Disposal as a PDF buffer.
 * @param {Object} cert    Certificate document (or POJO with the same fields).
 * @param {Object} pickup  Pickup document (or POJO).
 * @param {Object} client  Client document (or POJO).
 * @returns {Promise<Buffer>}
 */
const renderCertificatePdf = async (cert, pickup, client) => {
    const c = cert || {};
    // Load the waste-category registry so bucketForStream resolves to real
    // buckets (else everything falls into "other-dry"). Mirrors the monthly
    // report's buildSnapshot. Non-fatal if it fails.
    try { await refreshCache(); } catch (_) { /* cold cache → best-effort buckets */ }
    // Aggregate this pickup's frozen line items into the shared CoD buckets —
    // the exact function + bucket map the monthly CoD report uses.
    const snap = calcCod(
        [{ lineItems: Array.isArray(c.lineItemsSnapshot) ? c.lineItemsSnapshot : [] }],
        bucketForStream
    );
    return await renderToBuffer(buildDoc(c, pickup || {}, client || {}, snap));
};

module.exports = { renderCertificatePdf };
