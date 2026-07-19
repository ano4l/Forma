import PDFDocument from "pdfkit";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { templateFor } from "./templates.js";

const money = (minor, currency = "ZAR") => new Intl.NumberFormat("en-ZA", { style: "currency", currency }).format((minor || 0) / 100);
const labelFor = (type) => type === "quote" ? "Quote" : type === "receipt" ? "Receipt" : "Invoice";

function writeDocumentPdf(document, response, { logo } = {}) {
  const data = document.snapshot || { ...document.data, totals: document.totals };
  const totals = data.totals || document.totals;
  const template = templateFor(data.template_id || "classic");
  const doc = new PDFDocument({ size: data.page_size || "A4", margin: 48, bufferPages: true, info: { Title: `${data.document_title || labelFor(document.document_type)} ${document.number}`, Author: data.supplier?.name || "VirtuKey Forma" } });
  doc.pipe(response);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 48;
  const right = pageWidth - margin;
  const ink = "#101828";
  const muted = "#667085";
  const line = "#e4e7ec";
  const accent = data.accent || template.accent;
  const dense = template.density === "compact";
  let y = margin;

  const header = () => {
    y = margin;
    let logoDrawn = false;
    try {
      if (!logo) throw new Error("No renderable logo supplied");
      doc.image(logo, margin, y, { fit: [34, 34], align: "center", valign: "center" });
      logoDrawn = true;
    } catch (e) {
      // Fallback if image load fails
    }
    if (!logoDrawn) {
      doc.fillColor(accent).roundedRect(margin, y, 34, 34, 4).fill();
      doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(13).text((data.supplier?.name || "F").slice(0, 1).toUpperCase(), margin + 11, y + 10);
    }
    doc.fillColor(ink).font(template.font).fontSize(dense ? 20 : 24).text(data.document_title || labelFor(document.document_type), margin, y + 48);
    doc.fillColor(muted).font("Helvetica").fontSize(9).text(document.number, margin, y + 77);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(11).text(data.supplier?.name || "", pageWidth * 0.58, y + 2, { width: right - pageWidth * 0.58, align: "right" });
    doc.fillColor(muted).font("Helvetica").fontSize(8.5).text([data.supplier?.address, data.supplier?.email, data.supplier?.vat_number ? `VAT ${data.supplier.vat_number}` : ""].filter(Boolean).join("\n"), pageWidth * 0.58, y + 18, { width: right - pageWidth * 0.58, align: "right" });
    y += dense ? 100 : 112;
  };
  const details = () => {
    const height = document.document_type === "receipt" ? 70 : 88;
    doc.roundedRect(margin, y, right - margin, height, 4).strokeColor(line).stroke();
    doc.fillColor(muted).font("Helvetica-Bold").fontSize(7.5).text(document.document_type === "receipt" ? "RECEIVED FROM" : "BILLED TO", margin + 14, y + 14);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(9.5).text(data.customer?.name || "", margin + 14, y + 29, { width: pageWidth * 0.42 });
    doc.fillColor(muted).font("Helvetica").fontSize(8.5).text([data.customer?.email, data.customer?.address].filter(Boolean).join("\n"), margin + 14, y + 44, { width: pageWidth * 0.42, height: height - 47 });
    const metaX = pageWidth * 0.62;
    doc.fillColor(muted).font("Helvetica-Bold").fontSize(7.5).text("ISSUE DATE", metaX, y + 14).text(document.document_type === "receipt" ? "PAYMENT METHOD" : "DUE DATE", metaX + 92, y + 14);
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(8.5).text(data.issue_date || "", metaX, y + 29).text(document.document_type === "receipt" ? data.payment_method || "" : data.due_date || "", metaX + 92, y + 29, { width: right - (metaX + 92), align: "right" });
    y += height + 28;
  };
  const tableHeader = () => {
    doc.fillColor("#f9fafb").rect(margin, y, right - margin, 24).fill();
    const columns = { description: margin + 12, qty: pageWidth * 0.57, rate: pageWidth * 0.68, total: pageWidth * 0.82 };
    doc.fillColor(muted).font("Helvetica-Bold").fontSize(7.5).text("DESCRIPTION", columns.description, y + 8).text("QTY", columns.qty, y + 8, { width: 38, align: "right" }).text("RATE", columns.rate, y + 8, { width: 72, align: "right" }).text("TOTAL", columns.total, y + 8, { width: right - columns.total, align: "right" });
    y += 32;
    return columns;
  };
  const newTablePage = () => { doc.addPage(); header(); tableHeader(); };

  header(); details(); let columns = tableHeader();
  const lines = totals.lines || [];
  for (const item of lines) {
    const descriptionHeight = Math.max(18, doc.heightOfString(item.description || "", { width: columns.qty - columns.description - 20 }));
    const rowHeight = Math.max(dense ? 28 : 38, descriptionHeight + 15);
    if (y + rowHeight > pageHeight - 155) { newTablePage(); columns = { description: margin + 12, qty: pageWidth * 0.57, rate: pageWidth * 0.68, total: pageWidth * 0.82 }; }
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(8.5).text(item.description || "", columns.description, y, { width: columns.qty - columns.description - 20 });
    if (item.product_id) doc.fillColor(muted).font("Helvetica").fontSize(7.5).text("Saved item", columns.description, y + descriptionHeight + 2);
    doc.fillColor(ink).font("Helvetica").fontSize(8.5).text(String(item.quantity), columns.qty, y + 2, { width: 38, align: "right" }).text(money(item.unit_price_minor, data.currency), columns.rate, y + 2, { width: 72, align: "right" }).text(money(item.total_minor, data.currency), columns.total, y + 2, { width: right - columns.total, align: "right" });
    y += rowHeight; doc.strokeColor(line).moveTo(margin, y - 7).lineTo(right, y - 7).stroke();
  }
  if (y > pageHeight - 220) { doc.addPage(); header(); }
  const totalX = pageWidth * 0.62;
  const totalRow = (label, value, strong = false) => { doc.fillColor(strong ? ink : muted).font(strong ? "Helvetica-Bold" : "Helvetica").fontSize(strong ? 11 : 8.5).text(label, totalX, y, { width: 100 }).text(money(value, data.currency), totalX + 105, y, { width: right - (totalX + 105), align: "right" }); y += strong ? 25 : 17; };
  totalRow("Subtotal", totals.subtotal_minor);
  totalRow("Discount", -totals.discount_minor);
  (totals.tax_breakdown || [{ tax_bps: 0, tax_minor: totals.tax_minor }])
    .filter((tax) => tax.tax_bps || tax.tax_minor)
    .forEach((tax) => totalRow(`Tax ${tax.tax_bps / 100}%`, tax.tax_minor));
  if (totals.shipping_minor) totalRow("Shipping", totals.shipping_minor);
  doc.strokeColor(line).moveTo(totalX, y).lineTo(right, y).stroke(); y += 11;
  totalRow(document.document_type === "receipt" ? "Amount received" : document.amount_paid_minor ? "Balance due" : "Total due", document.document_type === "receipt" ? totals.total_minor : document.balance_due_minor ?? totals.total_minor, true);
  const paymentLabel = document.document_type === "receipt" ? "Payment details" : "Payment instructions";
  if (y > pageHeight - 130) { doc.addPage(); header(); }
  y += 12; doc.fillColor(ink).font("Helvetica-Bold").fontSize(8.5).text(paymentLabel, margin, y);
  doc.fillColor(muted).font("Helvetica").fontSize(8.5).text(data.payment_details || data.payment_method || "", margin, y + 14, { width: pageWidth * 0.48 });
  if (data.notes) { doc.fillColor(ink).font("Helvetica-Bold").text("Notes", margin, y + 48); doc.fillColor(muted).font("Helvetica").text(data.notes, margin, y + 62, { width: right - margin, height: 44, ellipsis: true }); }
  if (data.signature) doc.fillColor(ink).font("Helvetica-Oblique").fontSize(9).text(data.signature, pageWidth * 0.58, pageHeight - 82, { width: right - pageWidth * 0.58, align: "right" });
  if (data.footer) doc.fillColor(muted).font("Helvetica").fontSize(7.5).text(data.footer, margin, pageHeight - 34, { width: right - margin, align: "center" });
  const pages = doc.bufferedPageRange();
  for (let page = pages.start; page < pages.start + pages.count; page += 1) { doc.switchToPage(page); doc.fillColor("#98a2b3").font("Helvetica").fontSize(7.5).text(`${document.number} | Page ${page + 1} of ${pages.count}`, margin, doc.page.height - 22, { width: doc.page.width - margin * 2, align: "center" }); }
  doc.end();
}

export function createDocumentPdf(document, response, options) {
  response.setHeader("Content-Type", "application/pdf");
  response.setHeader("Content-Disposition", `attachment; filename="${document.number}.pdf"`);
  writeDocumentPdf(document, response, options);
}

export async function renderDocumentPdf(document, options) {
  const stream = new PassThrough(); const chunks = [];
  stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const finished = once(stream, "end");
  writeDocumentPdf(document, stream, options);
  await finished;
  return Buffer.concat(chunks);
}

export const createInvoicePdf = createDocumentPdf;
