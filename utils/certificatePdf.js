/*
  utils/certificatePdf.js — Client Management module (Phase 1, Chunk 3)

  Purpose:
  - Render the GreenEarth Integrated Facility Pvt Ltd
    "Certificate of Waste Collection, Processing & Recycling" as a PDF buffer
    using @react-pdf/renderer (server-side React → PDF).

  Template based on the sample shipped by the Resrishti team (see
  /Users/.../certificates/Sample COD draft.pdf and COD-Certificate-abc.pdf).

  Key design decisions confirmed with the user:
  - Fixed 7-row waste table (Wet/Organic, Plastic, Paper/Cardboard, Metal,
    Glass, E-Waste, Other Dry Waste). Always all 7 rows; empty quantities
    render as "___".
  - Hardcoded signatories: Nagaraj Yadav (Managing Director) +
    Hari Priya (Senior Consultant).
  - No certificate number visible on the PDF (kept internally).
  - Resrishti logo for now (logo-resrishti.png in assets/).
  - Approximated gold border via a double-stroke + corner ornaments.

  Why React.createElement instead of JSX:
  - This file is CommonJS. Adding JSX would require @babel/preset-react and a
    build step, which the rest of this Node/Express backend deliberately avoids.

  Exposed API:
  - `renderCertificatePdf(cert, pickup, client)` → `Promise<Buffer>`
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
    Font,
    renderToBuffer,
} = require("@react-pdf/renderer");

const e = React.createElement;

// ---- Register the script font used for the signature lines ----
// Loaded once per Node process. If the asset is missing we silently fall back
// to Times-Italic at render time (see signatureNameStyle).
let SCRIPT_FONT = "Times-Italic"; // fallback
try {
    Font.register({
        family: "PinyonScript",
        src: path.join(__dirname, "..", "assets", "PinyonScript-Regular.ttf"),
    });
    SCRIPT_FONT = "PinyonScript";
} catch (err) {
    // Keep fallback. Cert still renders cleanly.
    console.warn("Pinyon Script font registration failed, falling back to Times-Italic:", err.message);
}

// Loaded as a Buffer, not a path: react-pdf fetch()es a string src, which
// cannot resolve a filesystem path and silently dropped the logo from every
// issued certificate. See utils/pdfAssets.js.
const { getLogo } = require("./pdfAssets");

// ---- Stream mapping: our 11 internal pickup streams → 7 GreenEarth template buckets ----
const STREAM_TO_BUCKET = {
    "expired-food": "wet",
    plastic: "plastic",
    paper: "paper",
    ewaste: "ewaste",
    battery: "ewaste",
    "foam-thermocol": "other-dry",
    "dry-waste": "other-dry",
    agr: "other-dry",
    biomedical: "other-dry",
    hazardous: "other-dry",
    other: "other-dry",
};

// The seven rows that ALWAYS appear, in this exact order.
const TEMPLATE_ROWS = [
    { key: "wet", label: "Wet / Organic Waste",
      method: "Processed at our facility through composting / bio-processing" },
    { key: "plastic", label: "Plastic Waste",
      method: "Segregated and recycled at our facility" },
    { key: "paper", label: "Paper / Cardboard",
      method: "Sent to authorized recycler" },
    { key: "metal", label: "Metal Waste",
      method: "Sent to authorized recycler" },
    { key: "glass", label: "Glass Waste",
      method: "Sent to authorized recycler" },
    { key: "ewaste", label: "E-Waste",
      method: "Sent to authorized recycler" },
    { key: "other-dry", label: "Other Dry Waste",
      method: "Sent to authorized recycler" },
];

// ---- Brand / theme tokens ----
const GOLD = "#C9A24A";          // border
const GOLD_LIGHT = "#E8D69E";    // inner accent
const INK = "#1a1a2e";           // body text
const HEADER_INK = "#2a2a3a";    // headings
const TABLE_HEAD_BG = "#fdf6e3"; // soft cream like the sample
const TABLE_BORDER = "#c9a24a55";
const MUTED = "#666";

const styles = StyleSheet.create({
    // ---- Page ----
    page: {
        paddingTop: 50,
        paddingBottom: 50,
        paddingHorizontal: 50,
        fontSize: 10,
        color: INK,
        fontFamily: "Helvetica",
    },

    // ---- Gold border (approximation of the gold-wave decoration) ----
    borderOuter: {
        position: "absolute",
        top: 22, left: 22, right: 22, bottom: 22,
        borderWidth: 3,
        borderColor: GOLD,
        borderStyle: "solid",
    },
    borderInner: {
        position: "absolute",
        top: 28, left: 28, right: 28, bottom: 28,
        borderWidth: 1,
        borderColor: GOLD_LIGHT,
        borderStyle: "solid",
    },

    // ---- Header (top of page 1) ----
    headerRow: {
        flexDirection: "row",
        alignItems: "center",
        marginBottom: 22,
    },
    logoBox: {
        width: 56,
        height: 56,
        marginRight: 14,
        objectFit: "contain",
    },
    headerTextBlock: { flex: 1 },
    companyName: {
        fontSize: 18,
        fontFamily: "Helvetica-Bold",
        color: HEADER_INK,
        letterSpacing: 0.4,
    },
    companySub: {
        fontSize: 13,
        color: HEADER_INK,
        marginTop: 2,
    },

    // ---- Title ----
    title: {
        fontSize: 13,
        fontFamily: "Helvetica-Bold",
        color: HEADER_INK,
        textAlign: "center",
        marginBottom: 14,
        letterSpacing: 0.2,
    },

    // ---- Date row ----
    dateRow: {
        alignItems: "flex-end",
        marginBottom: 12,
    },
    dateLabel: {
        fontSize: 10,
        fontFamily: "Helvetica-Bold",
        color: INK,
    },

    // ---- Intro paragraphs ----
    para: {
        fontSize: 10,
        lineHeight: 1.55,
        marginBottom: 10,
        color: INK,
    },
    paraBold: { fontFamily: "Helvetica-Bold" },

    // ---- Section heading ----
    sectionHeading: {
        fontSize: 11,
        fontFamily: "Helvetica-Bold",
        color: HEADER_INK,
        marginTop: 6,
        marginBottom: 8,
    },

    // ---- Table ----
    table: {
        borderWidth: 1,
        borderColor: TABLE_BORDER,
        borderStyle: "solid",
        marginBottom: 16,
    },
    tableHead: {
        flexDirection: "row",
        backgroundColor: TABLE_HEAD_BG,
        borderBottomWidth: 1,
        borderBottomColor: TABLE_BORDER,
        borderBottomStyle: "solid",
    },
    tableHeadCell: {
        fontSize: 10,
        fontFamily: "Helvetica-Bold",
        color: HEADER_INK,
        padding: 8,
    },
    tableRow: {
        flexDirection: "row",
        borderBottomWidth: 1,
        borderBottomColor: TABLE_BORDER,
        borderBottomStyle: "solid",
    },
    tableRowLast: {
        flexDirection: "row",
    },
    tableCell: {
        fontSize: 10,
        padding: 8,
        color: INK,
    },
    colSlNo:     { width: "8%",  textAlign: "center" },
    colType:     { width: "26%" },
    colQty:      { width: "16%", textAlign: "center" },
    colUnit:     { width: "10%", textAlign: "center" },
    colMethod:   { width: "40%" },

    totalLine: {
        fontSize: 11,
        fontFamily: "Helvetica-Bold",
        color: HEADER_INK,
        marginTop: 4,
    },

    // ---- Page 2 sections ----
    page2Heading: {
        fontSize: 11,
        fontFamily: "Helvetica-Bold",
        color: HEADER_INK,
        marginTop: 4,
        marginBottom: 8,
    },
    bulletRow: {
        flexDirection: "row",
        marginBottom: 6,
        paddingLeft: 4,
    },
    bullet: {
        fontSize: 11,
        marginRight: 6,
        color: INK,
    },
    bulletBody: {
        flex: 1,
        fontSize: 10,
        lineHeight: 1.55,
        color: INK,
    },

    // ---- Signatures ----
    sigBlock: { marginTop: 36 },
    forCompany: {
        fontSize: 10,
        fontFamily: "Helvetica-Bold",
        color: HEADER_INK,
        marginBottom: 24,
    },
    sigRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "flex-end",
    },
    sigCol: {
        width: "38%",
        alignItems: "center",
    },
    sigSealCol: {
        width: "20%",
        alignItems: "center",
        justifyContent: "center",
    },
    sigName: {
        fontFamily: SCRIPT_FONT,
        fontSize: 22,
        color: "#1d3a6a",
        marginBottom: 2,
    },
    sigLine: {
        width: "90%",
        borderTopWidth: 1,
        borderTopColor: INK,
        borderTopStyle: "solid",
        marginTop: 2,
    },
    sigRole: {
        fontSize: 11,
        color: INK,
        marginTop: 6,
        textAlign: "center",
    },
    seal: {
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: GOLD,
        alignItems: "center",
        justifyContent: "center",
    },
    sealStar: {
        color: "#ffffff",
        fontSize: 22,
        fontFamily: "Helvetica-Bold",
    },
});

// ---- helpers ----

const fmtDateSlash = (d) => {
    if (!d) return "___ / ___ / ______";
    const date = d instanceof Date ? d : new Date(d);
    if (isNaN(date.getTime())) return "___ / ___ / ______";
    const dd = String(date.getUTCDate()).padStart(2, "0");
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = date.getUTCFullYear();
    return `${dd} / ${mm} / ${yyyy}`;
};

const fmtAddress = (addr) => {
    if (!addr) return "—";
    const parts = [
        addr.line1,
        addr.line2,
        [addr.city, addr.state].filter(Boolean).join(", "),
        addr.postalCode,
        addr.country,
    ].filter(Boolean);
    return parts.join(", ") || "—";
};

const fmtQty = (n) => {
    if (n === null || n === undefined || n === 0) return "___";
    const num = Number(n);
    if (!Number.isFinite(num)) return "___";
    // Sample uses whole numbers; render with up to 1 decimal only if non-integer.
    if (Number.isInteger(num)) return String(num);
    return num.toFixed(1);
};

// Aggregate the cert's line items into the 7 template buckets.
const aggregateByBucket = (lineItems) => {
    const totals = Object.create(null);
    for (const li of lineItems || []) {
        const bucket = STREAM_TO_BUCKET[li.stream];
        if (!bucket) continue;
        totals[bucket] = (totals[bucket] || 0) + (Number(li.qtyKg) || 0);
    }
    return totals;
};

// ---- template ----

const buildDoc = (cert, pickup, client) => {
    const issuedAt = cert.issuedAt || new Date();
    const dateString = fmtDateSlash(issuedAt);

    const clientName = cert.clientNameSnapshot || (client && client.name) || "____________";
    const clientAddr = fmtAddress(client && client.billingAddress);

    const lineItems = Array.isArray(cert.lineItemsSnapshot) ? cert.lineItemsSnapshot : [];
    const bucketTotals = aggregateByBucket(lineItems);
    const totalKg = cert.totalKgSnapshot !== undefined && cert.totalKgSnapshot !== null
        ? cert.totalKgSnapshot
        : lineItems.reduce((s, l) => s + (Number(l.qtyKg) || 0), 0);

    // ===== Page 1 =====

    const logo = getLogo();
    const page1Header = e(View, { style: styles.headerRow },
        // Omit the element entirely if the asset is unreadable — a cosmetic
        // image must not be able to fail a legal document.
        logo ? e(Image, { src: logo, style: styles.logoBox }) : null,
        e(View, { style: styles.headerTextBlock },
            e(Text, { style: styles.companyName }, "GreenEarth Integrated Facility"),
            e(Text, { style: styles.companySub }, "Private Limited"),
        )
    );

    const titleBlock = e(Text, { style: styles.title },
        "CERTIFICATE OF WASTE COLLECTION, PROCESSING & RECYCLING"
    );

    const dateBlock = e(View, { style: styles.dateRow },
        e(Text, { style: styles.dateLabel }, `Date: ${dateString}`)
    );

    const introPara = e(Text, { style: styles.para },
        "This is to certify that ",
        e(Text, { style: styles.paraBold }, `M/s ${clientName}`),
        ", located at ",
        e(Text, { style: styles.paraBold }, clientAddr),
        ", has handed over the following waste materials to ",
        e(Text, { style: styles.paraBold }, "GREENEARTH INTIGRATED FACILITY PVT LTD"),
        ", for ",
        e(Text, { style: styles.paraBold }, "collection, processing, recycling, and responsible disposal"),
        "."
    );

    const regulatoryPara = e(Text, { style: styles.para },
        "The waste has been handled in accordance with the guidelines of the ",
        e(Text, { style: styles.paraBold },
            "Central Pollution Control Board and the provisions of the Solid Waste Management Rules, 2016."
        )
    );

    const tableHeading = e(Text, { style: styles.sectionHeading },
        "Waste Collection & Processing Details"
    );

    // Fixed 7-row table
    const tableRows = TEMPLATE_ROWS.map((row, i) => {
        const isLast = i === TEMPLATE_ROWS.length - 1;
        const qty = bucketTotals[row.key];
        return e(View,
            { key: `r${i}`, style: isLast ? styles.tableRowLast : styles.tableRow },
            e(Text, { style: [styles.tableCell, styles.colSlNo] }, String(i + 1)),
            e(Text, { style: [styles.tableCell, styles.colType] }, row.label),
            e(Text, { style: [styles.tableCell, styles.colQty] }, fmtQty(qty)),
            e(Text, { style: [styles.tableCell, styles.colUnit] }, "Kg"),
            e(Text, { style: [styles.tableCell, styles.colMethod] }, row.method),
        );
    });

    const tableBlock = e(View, { style: styles.table },
        e(View, { style: styles.tableHead },
            e(Text, { style: [styles.tableHeadCell, styles.colSlNo] }, "Sl. No"),
            e(Text, { style: [styles.tableHeadCell, styles.colType] }, "Type of Waste"),
            e(Text, { style: [styles.tableHeadCell, styles.colQty] }, "Quantity"),
            e(Text, { style: [styles.tableHeadCell, styles.colUnit] }, "Unit"),
            e(Text, { style: [styles.tableHeadCell, styles.colMethod] }, "Processing Method"),
        ),
        ...tableRows
    );

    const totalLine = e(Text, { style: styles.totalLine },
        `Total Waste Collected: ${fmtQty(totalKg)} Kg`
    );

    // ===== Page 2 =====

    const disposalHeading = e(Text, { style: styles.page2Heading },
        "Disposal & Recycling Statement"
    );

    const bullet = (boldStart, body) =>
        e(View, { style: styles.bulletRow },
            e(Text, { style: styles.bullet }, "•"),
            e(Text, { style: styles.bulletBody },
                e(Text, { style: styles.paraBold }, boldStart),
                " ",
                body
            )
        );

    const bullets = e(View, { style: { marginBottom: 14 } },
        bullet("Wet / Organic Waste",
            "collected from the client has been processed at our facility through composting / bio-processing methods."),
        bullet("Plastic Waste",
            "has been segregated and recycled at our facility through authorized recycling processes."),
        bullet("Other recyclable materials such as paper, metal, glass, and e-waste",
            "have been transferred to authorized recyclers in accordance with our operational permissions and regulatory compliance requirements."),
    );

    const complianceHeading = e(Text, { style: styles.page2Heading },
        "Compliance Declaration"
    );

    const compliancePara = e(Text, { style: styles.para },
        "We hereby confirm that the waste collected from ",
        e(Text, { style: styles.paraBold }, clientName),
        " has been ",
        e(Text, { style: styles.paraBold },
            "handled, processed, and disposed of in an environmentally responsible manner"),
        ", ensuring compliance with applicable environmental regulations and industry best practices."
    );

    const issuancePara = e(Text, { style: styles.para },
        "This certificate is issued upon request of the client for ",
        e(Text, { style: styles.paraBold },
            "environmental compliance, sustainability reporting, and record purposes"),
        "."
    );

    const signatures = e(View, { style: styles.sigBlock },
        e(Text, { style: styles.forCompany }, "For GREENEARTH INTIGRATED FACILITY PVT LTD"),
        e(View, { style: styles.sigRow },
            // Left signatory
            e(View, { style: styles.sigCol },
                e(Text, { style: styles.sigName }, "Nagaraj Yadav"),
                e(View, { style: styles.sigLine }),
                e(Text, { style: styles.sigRole }, "Managing Director"),
            ),
            // Center seal
            e(View, { style: styles.sigSealCol },
                e(View, { style: styles.seal },
                    e(Text, { style: styles.sealStar }, "★")
                )
            ),
            // Right signatory
            e(View, { style: styles.sigCol },
                e(Text, { style: styles.sigName }, "Hari Priya"),
                e(View, { style: styles.sigLine }),
                e(Text, { style: styles.sigRole }, "Senior Consultant"),
            ),
        )
    );

    // ===== Assemble =====

    const page1 = e(Page, { size: "A4", style: styles.page },
        // Border decoration first so the content draws on top of it cleanly.
        e(View, { style: styles.borderOuter, fixed: true }),
        e(View, { style: styles.borderInner, fixed: true }),
        page1Header,
        titleBlock,
        dateBlock,
        introPara,
        regulatoryPara,
        tableHeading,
        tableBlock,
        totalLine,
    );

    const page2 = e(Page, { size: "A4", style: styles.page },
        e(View, { style: styles.borderOuter, fixed: true }),
        e(View, { style: styles.borderInner, fixed: true }),
        disposalHeading,
        bullets,
        complianceHeading,
        compliancePara,
        issuancePara,
        signatures,
    );

    return e(Document, null, page1, page2);
};

/**
 * Render the Certificate of Waste Collection, Processing & Recycling as a
 * PDF buffer.
 *
 * @param {Object} cert    Certificate document (or POJO with the same fields).
 * @param {Object} pickup  Pickup document (or POJO).
 * @param {Object} client  Client document (or POJO).
 * @returns {Promise<Buffer>}
 */
const renderCertificatePdf = async (cert, pickup, client) => {
    const doc = buildDoc(cert || {}, pickup || {}, client || {});
    return await renderToBuffer(doc);
};

module.exports = { renderCertificatePdf };
