/*
  utils/payslipPdf.js — the payslip a person actually receives.

  Two layouts, because the two pay models answer different questions:

    monthly   "here is your salary, and here is what was taken off it"
              — earnings, then loss of pay for unpaid days

    daily     "here is what you earned, day by day"
              — days worked × rate, plus overtime

  Showing a daily-wage worker a "loss of pay" line for days they were never
  rostered would be meaningless, and showing a salaried person a day count as
  their earnings would be wrong. So the layout follows the model.

  Everything printed comes from the payroll line's own snapshot, never from
  live data: a payslip reprinted next year must say what it said when it was
  issued.

  Built on the same @react-pdf/renderer stack as the certificates, so there is
  one PDF toolchain in this codebase rather than two.
*/
const React = require("react");
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

const INK = "#1e293b";
const MUTED = "#64748b";
const LINE = "#e2e8f0";
const BRAND = "#059669";

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

const monthLabel = (month) => {
    const [y, m] = String(month).split("-");
    return `${MONTH_NAMES[Number(m) - 1]} ${y}`;
};

// Indian grouping, without relying on Intl being present in every runtime.
const money = (n) => {
    const value = Math.round(Number(n) || 0);
    const negative = value < 0;
    const digits = String(Math.abs(value));
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    const grouped = rest
        ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`
        : last3;
    return `${negative ? "-" : ""}Rs. ${grouped}`;
};

const days = (n) => {
    const value = Number(n) || 0;
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
};

const styles = StyleSheet.create({
    page: {
        paddingTop: 40,
        paddingBottom: 48,
        paddingHorizontal: 44,
        fontSize: 9.5,
        color: INK,
        fontFamily: "Helvetica",
    },

    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "flex-start",
        borderBottomWidth: 2,
        borderBottomColor: BRAND,
        paddingBottom: 10,
        marginBottom: 14,
    },
    logo: { width: 110, objectFit: "contain" },
    companyName: { fontSize: 13, fontFamily: "Helvetica-Bold" },
    companySub: { fontSize: 8, color: MUTED, marginTop: 2 },
    slipTitle: { fontSize: 12, fontFamily: "Helvetica-Bold", textAlign: "right" },
    slipMonth: { fontSize: 9, color: MUTED, textAlign: "right", marginTop: 2 },

    // Who this is for
    identity: {
        flexDirection: "row",
        marginBottom: 14,
        borderWidth: 1,
        borderColor: LINE,
        borderRadius: 3,
    },
    identityCol: { flex: 1, padding: 8 },
    identityDivider: { borderLeftWidth: 1, borderLeftColor: LINE },
    label: { fontSize: 7.5, color: MUTED, textTransform: "uppercase", marginBottom: 2 },
    value: { fontSize: 9.5 },
    valueBold: { fontSize: 9.5, fontFamily: "Helvetica-Bold" },

    sectionTitle: {
        fontSize: 9,
        fontFamily: "Helvetica-Bold",
        textTransform: "uppercase",
        color: MUTED,
        marginBottom: 5,
    },

    // The day counts
    dayGrid: { flexDirection: "row", flexWrap: "wrap", marginBottom: 14 },
    dayCell: {
        width: "25%",
        borderWidth: 1,
        borderColor: LINE,
        padding: 6,
        marginRight: -1,
        marginBottom: -1,
    },
    dayValue: { fontSize: 12, fontFamily: "Helvetica-Bold" },
    dayLabel: { fontSize: 7.5, color: MUTED, marginTop: 1 },

    // Money
    moneyTable: { borderWidth: 1, borderColor: LINE, borderRadius: 3, marginBottom: 14 },
    moneyHead: {
        flexDirection: "row",
        backgroundColor: "#f8fafc",
        borderBottomWidth: 1,
        borderBottomColor: LINE,
        paddingVertical: 5,
        paddingHorizontal: 8,
    },
    moneyRow: {
        flexDirection: "row",
        paddingVertical: 5,
        paddingHorizontal: 8,
        borderBottomWidth: 1,
        borderBottomColor: "#f1f5f9",
    },
    moneyLabel: { flex: 1 },
    moneyNote: { flex: 1, color: MUTED, fontSize: 8.5 },
    moneyAmount: { width: 90, textAlign: "right" },
    headText: { fontSize: 8, fontFamily: "Helvetica-Bold", color: MUTED, textTransform: "uppercase" },

    netRow: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        backgroundColor: "#ecfdf5",
        borderWidth: 1,
        borderColor: "#a7f3d0",
        borderRadius: 3,
        padding: 10,
        marginBottom: 12,
    },
    netLabel: { fontSize: 10, fontFamily: "Helvetica-Bold" },
    netValue: { fontSize: 15, fontFamily: "Helvetica-Bold", color: "#047857" },

    note: {
        fontSize: 8,
        color: MUTED,
        borderTopWidth: 1,
        borderTopColor: LINE,
        paddingTop: 8,
        lineHeight: 1.4,
    },
    footer: {
        position: "absolute",
        bottom: 26,
        left: 44,
        right: 44,
        fontSize: 7.5,
        color: MUTED,
        textAlign: "center",
    },
});

const Identity = ({ line, payslipNumber }) =>
    e(View, { style: styles.identity },
        e(View, { style: styles.identityCol },
            e(Text, { style: styles.label }, "Employee"),
            e(Text, { style: styles.valueBold }, line.personName || "—"),
            e(Text, { style: [styles.value, { color: MUTED, fontSize: 8.5, marginTop: 2 }] },
                line.personEmail || ""),
        ),
        e(View, { style: [styles.identityCol, styles.identityDivider] },
            e(Text, { style: styles.label }, "Role"),
            e(Text, { style: styles.value }, line.jobRole || "—"),
            e(Text, { style: [styles.value, { color: MUTED, fontSize: 8.5, marginTop: 2 }] },
                line.department || ""),
        ),
        e(View, { style: [styles.identityCol, styles.identityDivider] },
            e(Text, { style: styles.label }, "Paid as"),
            e(Text, { style: styles.value },
                line.payModel === "monthly" ? "Monthly salary" : "Daily rate"),
            e(Text, { style: [styles.value, { color: MUTED, fontSize: 8.5, marginTop: 2 }] },
                line.employmentType ? String(line.employmentType).replace("-", " ") : ""),
        ),
        e(View, { style: [styles.identityCol, styles.identityDivider] },
            e(Text, { style: styles.label }, "Payslip no."),
            e(Text, { style: styles.value }, payslipNumber || "—"),
        ),
    );

/* The day counts that matter for this pay model. A daily-wage worker has no
   use for a "weekly-offs" figure they were never paid for. */
const DayCounts = ({ line }) => {
    const d = line.days || {};
    const cells =
        line.payModel === "monthly"
            ? [
                  ["Days in month", line.daysOnPayroll],
                  ["Paid days", line.payableDays],
                  ["Loss of pay", line.lopDays],
                  ["Worked", d.worked],
                  ["Paid leave", d.leavePaid],
                  ["Unpaid leave", d.leaveUnpaid],
                  ["Weekly-offs", d.weeklyOffs],
                  ["Holidays", d.holidays],
              ]
            : [
                  ["Days paid", line.payableDays],
                  ["Worked", d.worked],
                  ["Half-days", d.halfDays],
                  ["Overtime days", line.overtimeDays],
                  ["Paid leave", d.leavePaid],
                  ["Unpaid leave", d.leaveUnpaid],
                  ["Absent", d.absent],
                  ["Holidays", d.holidays],
              ];

    return e(View, null,
        e(Text, { style: styles.sectionTitle }, "Attendance for the month"),
        e(View, { style: styles.dayGrid },
            ...cells.map(([label, value], i) =>
                e(View, { style: styles.dayCell, key: i },
                    e(Text, { style: styles.dayValue }, days(value)),
                    e(Text, { style: styles.dayLabel }, label),
                )
            )
        ),
    );
};

const MoneyTable = ({ line }) => {
    const rows = [];

    if (line.payModel === "monthly") {
        rows.push(["Monthly salary", "Full month", line.rateAmount]);
        if (line.lopDays > 0) {
            rows.push([
                "Loss of pay",
                `${days(line.lopDays)} day(s) x ${money(line.perDayRate)}`,
                -(line.rateAmount - line.basePay),
            ]);
        }
    } else {
        rows.push([
            "Days worked",
            `${days(line.payableDays)} day(s) x ${money(line.perDayRate)}`,
            line.basePay,
        ]);
    }

    if (line.overtimePay) {
        rows.push([
            "Overtime",
            `${days(line.overtimeDays)} day(s) worked on a weekly-off`,
            line.overtimePay,
        ]);
    }

    for (const entry of line.adjustmentEntries || []) {
        rows.push([
            String(entry.category || "adjustment").replace("-", " "),
            entry.reason || "",
            entry.amount,
        ]);
    }

    if (line.deductions) {
        rows.push(["Deductions", "", -Math.abs(line.deductions)]);
    }

    return e(View, { style: styles.moneyTable },
        e(View, { style: styles.moneyHead },
            e(Text, { style: [styles.moneyLabel, styles.headText] }, "Item"),
            e(Text, { style: [styles.moneyNote, styles.headText] }, "How it was worked out"),
            e(Text, { style: [styles.moneyAmount, styles.headText] }, "Amount"),
        ),
        ...rows.map(([label, note, amount], i) =>
            e(View, { style: styles.moneyRow, key: i },
                e(Text, { style: styles.moneyLabel }, String(label)),
                e(Text, { style: styles.moneyNote }, String(note || "")),
                e(Text, { style: styles.moneyAmount }, money(amount)),
            )
        ),
    );
};

const PayslipDocument = ({ line, payslipNumber, note, company }) =>
    e(Document, {
        title: `Payslip ${payslipNumber || ""} ${line.personName || ""}`.trim(),
        author: company,
    },
        e(Page, { size: "A4", style: styles.page },
            e(View, { style: styles.header },
                e(View, null,
                    getLogo() ? e(Image, { style: styles.logo, src: getLogo() }) : null,
                    e(Text, { style: styles.companyName }, company),
                    e(Text, { style: styles.companySub }, "Payslip — confidential"),
                ),
                e(View, null,
                    e(Text, { style: styles.slipTitle }, "PAYSLIP"),
                    e(Text, { style: styles.slipMonth }, monthLabel(line.month)),
                ),
            ),

            e(Identity, { line, payslipNumber }),
            e(DayCounts, { line }),

            e(Text, { style: styles.sectionTitle }, "Earnings and deductions"),
            e(MoneyTable, { line }),

            e(View, { style: styles.netRow },
                e(Text, { style: styles.netLabel }, "Net pay"),
                e(Text, { style: styles.netValue }, money(line.net)),
            ),

            note ? e(Text, { style: styles.note }, note) : null,

            e(Text, { style: styles.footer, fixed: true },
                "This is a computer-generated payslip and does not require a signature."),
        )
    );

/**
 * Render one payslip.
 * @param {Object} line            a PayrollLine, as a plain object
 * @param {Object} options         { payslipNumber, note, company }
 * @returns {Promise<Buffer>}
 */
const renderPayslipPdf = async (line, options = {}) =>
    renderToBuffer(
        e(PayslipDocument, {
            line,
            payslipNumber: options.payslipNumber,
            note: options.note,
            company: options.company || "GreenEarth Integrated Facility Pvt Ltd",
        })
    );

module.exports = { renderPayslipPdf, money, monthLabel };
