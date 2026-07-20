import PDFDocument from "pdfkit";

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const dataFor = (document) => document.snapshot || document.data || {};
const csvCell = (value = "") => { const text = String(value ?? "").replace(/\r?\n/g, " "); const safe = /^[=+\-@]/.test(text) ? `'${text}` : text; return `"${safe.replaceAll('"', '""')}"`; };
const csv = (rows) => `${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
const minor = (value) => (Math.round(Number(value) || 0) / 100).toFixed(2);
const dateOnly = (value, fallback) => datePattern.test(String(value || "")) ? String(value) : fallback;
const dayDifference = (later, earlier) => Math.floor((new Date(`${later}T12:00:00Z`) - new Date(`${earlier}T12:00:00Z`)) / 86400000);

export function agingReport(documents, { asOf = new Date().toISOString().slice(0, 10) } = {}) {
  const reportDate = dateOnly(asOf, new Date().toISOString().slice(0, 10));
  const rows = documents.filter((document) => document.document_type === "invoice" && !["draft", "void", "paid", "refunded"].includes(document.status) && Number(document.balance_due_minor) > 0).map((document) => {
    const data = dataFor(document); const dueDate = dateOnly(data.due_date, reportDate); const days = dayDifference(reportDate, dueDate); const bucket = days <= 0 ? "Current" : days <= 30 ? "1-30 days" : days <= 60 ? "31-60 days" : days <= 90 ? "61-90 days" : "90+ days";
    return { document_id: document.id, number: document.number, customer: data.customer?.name || "No customer", email: data.customer?.email || "", currency: data.currency || "ZAR", due_date: dueDate, days_overdue: Math.max(0, days), bucket, balance_minor: Number(document.balance_due_minor) || 0, status: document.status };
  }).sort((a, b) => b.days_overdue - a.days_overdue || a.number.localeCompare(b.number));
  const totals = rows.reduce((groups, row) => { const group = groups[row.currency] ||= { currency: row.currency, total_minor: 0, buckets: { Current: 0, "1-30 days": 0, "31-60 days": 0, "61-90 days": 0, "90+ days": 0 } }; group.total_minor += row.balance_minor; group.buckets[row.bucket] += row.balance_minor; return groups; }, {});
  return { as_of: reportDate, rows, totals: Object.values(totals) };
}

export function taxReport(documents, { from, to } = {}) {
  const fromDate = datePattern.test(String(from || "")) ? String(from) : null; const toDate = datePattern.test(String(to || "")) ? String(to) : null; const rows = [];
  for (const document of documents.filter((item) => item.document_type === "invoice" && !["draft", "void"].includes(item.status))) {
    const data = dataFor(document); const issueDate = dateOnly(data.issue_date, ""); if ((fromDate && issueDate < fromDate) || (toDate && issueDate > toDate)) continue;
    const breakdown = document.totals?.tax_breakdown?.length ? document.totals.tax_breakdown : [{ tax_bps: null, taxable_minor: Number(document.totals?.subtotal_minor || 0) - Number(document.totals?.discount_minor || 0), tax_minor: Number(document.totals?.tax_minor || 0) }];
    for (const tax of breakdown) rows.push({ number: document.number, issue_date: issueDate, customer: data.customer?.name || "No customer", currency: data.currency || "ZAR", tax_bps: tax.tax_bps, taxable_minor: Number(tax.taxable_minor || 0), tax_minor: Number(tax.tax_minor || 0), total_minor: Number(document.totals?.total_minor || 0), status: document.status });
  }
  const totals = rows.reduce((groups, row) => { const key = `${row.currency}:${row.tax_bps ?? "mixed"}`; const group = groups[key] ||= { currency: row.currency, tax_bps: row.tax_bps, taxable_minor: 0, tax_minor: 0 }; group.taxable_minor += row.taxable_minor; group.tax_minor += row.tax_minor; return groups; }, {});
  return { from: fromDate, to: toDate, rows, totals: Object.values(totals).sort((a, b) => a.currency.localeCompare(b.currency) || Number(a.tax_bps) - Number(b.tax_bps)) };
}

export function collectionForecast(documents, { asOf = new Date().toISOString().slice(0, 10) } = {}) {
  const reportDate = dateOnly(asOf, new Date().toISOString().slice(0, 10));
  const rows = documents.filter((document) => document.document_type === "invoice" && !["draft", "void", "paid", "refunded"].includes(document.status) && Number(document.balance_due_minor) > 0).map((document) => {
    const data = dataFor(document); const dueDate = dateOnly(data.due_date, reportDate); const daysUntilDue = dayDifference(dueDate, reportDate);
    const bucket = daysUntilDue < 0 ? "Overdue" : daysUntilDue <= 7 ? "Next 7 days" : daysUntilDue <= 30 ? "8-30 days" : daysUntilDue <= 60 ? "31-60 days" : daysUntilDue <= 90 ? "61-90 days" : "90+ days";
    return { document_id: document.id, number: document.number, customer: data.customer?.name || "No customer", currency: data.currency || "ZAR", due_date: dueDate, days_until_due: daysUntilDue, bucket, balance_minor: Number(document.balance_due_minor) || 0, status: document.status };
  }).sort((a, b) => a.due_date.localeCompare(b.due_date) || a.number.localeCompare(b.number));
  const totals = rows.reduce((groups, row) => { const group = groups[row.currency] ||= { currency: row.currency, total_minor: 0, buckets: { Overdue: 0, "Next 7 days": 0, "8-30 days": 0, "31-60 days": 0, "61-90 days": 0, "90+ days": 0 } }; group.total_minor += row.balance_minor; group.buckets[row.bucket] += row.balance_minor; return groups; }, {});
  return { as_of: reportDate, rows, totals: Object.values(totals) };
}

export function agingCsv(report) { return csv([["As of", "Invoice", "Customer", "Email", "Due date", "Days overdue", "Aging bucket", "Currency", "Balance", "Status"], ...report.rows.map((row) => [report.as_of, row.number, row.customer, row.email, row.due_date, row.days_overdue, row.bucket, row.currency, minor(row.balance_minor), row.status])]); }
export function taxCsv(report) { return csv([["Invoice", "Issue date", "Customer", "Currency", "Tax rate %", "Taxable amount", "Tax amount", "Invoice total", "Status"], ...report.rows.map((row) => [row.number, row.issue_date, row.customer, row.currency, row.tax_bps === null ? "Mixed" : (row.tax_bps / 100).toFixed(2), minor(row.taxable_minor), minor(row.tax_minor), minor(row.total_minor), row.status])]); }
export function collectionForecastCsv(report) { return csv([["As of", "Invoice", "Customer", "Due date", "Days until due", "Forecast bucket", "Currency", "Expected collection", "Status"], ...report.rows.map((row) => [report.as_of, row.number, row.customer, row.due_date, row.days_until_due, row.bucket, row.currency, minor(row.balance_minor), row.status])]); }

export function renderReceivablesReportPdf(report, profile, response) {
  const pdf = new PDFDocument({ size: "A4", margin: 46, info: { Title: `Receivables aging as of ${report.as_of}`, Author: profile.name || "Forma" } });
  response.type("application/pdf").attachment(`forma-receivables-aging-${report.as_of}.pdf`); pdf.pipe(response);
  pdf.fontSize(10).fillColor("#6941c6").text("FORMA RECEIVABLES"); pdf.moveDown(0.5).fontSize(22).fillColor("#101828").text("Accounts receivable aging"); pdf.fontSize(10).fillColor("#667085").text(`${profile.name || "Forma business"} · As of ${report.as_of}`); pdf.moveDown(1.2);
  for (const total of report.totals) { pdf.fontSize(11).fillColor("#344054").text(`${total.currency} outstanding: ${minor(total.total_minor)}`); pdf.fontSize(8).fillColor("#667085").text(Object.entries(total.buckets).map(([bucket, value]) => `${bucket}: ${minor(value)}`).join("   ")); pdf.moveDown(0.8); }
  pdf.moveDown(0.5); const widths = [80, 150, 70, 70, 75]; const headers = ["Invoice", "Customer", "Due", "Bucket", "Balance"];
  const row = (values, header = false) => { const top = pdf.y; values.forEach((value, index) => pdf.font(header ? "Helvetica-Bold" : "Helvetica").fontSize(header ? 8 : 7.5).fillColor(header ? "#344054" : "#475467").text(String(value), 46 + widths.slice(0, index).reduce((sum, width) => sum + width, 0), top, { width: widths[index] - 7, ellipsis: true })); pdf.y = top + (header ? 19 : 22); if (!header) pdf.moveTo(46, pdf.y - 5).lineTo(549, pdf.y - 5).strokeColor("#eaecf0").stroke(); };
  row(headers, true);
  for (const item of report.rows) { if (pdf.y > 760) { pdf.addPage(); row(headers, true); } row([item.number, item.customer, item.due_date, item.bucket, `${item.currency} ${minor(item.balance_minor)}`]); }
  if (!report.rows.length) pdf.fontSize(10).fillColor("#667085").text("No outstanding invoices for this date.");
  pdf.end();
}
