const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));

const state = { route: location.hash.slice(1) || "documents", invoices: [], customers: [], products: [], current: null, audit: [], customerQuery: "", productQuery: "", invoiceQuery: "", invoiceStatus: "all", saveTimer: null, savePromise: null, editRevision: 0, savedRevision: 0, saving: false, saveError: false, touched: new Set(), expandedLines: new Set(), documents: [], document: null, templates: [], profile: {}, paymentMethods: [], emailTemplates: [], brandingPresets: [], numberPrefixes: {}, settingsEmailPurpose: "", documentQuery: "", documentType: "all", documentCustomerQuery: "", documentProductQuery: "", quickText: "", quickParsed: null, documentSaving: false, documentSaveError: false, documentSaveTimer: null, documentSavePromise: null, documentEditRevision: 0, documentSavedRevision: 0, documentEmailHistory: [], documentUndo: null, recurringSchedules: [], reminderRules: [], dueReminders: [] };
const routes = [
  ["dashboard", "grid", "Dashboard", "Workspace"],
  ["documents", "file", "Documents", "Workspace"],
  ["quick-create", "plus", "Quick create", "Workspace"],
  ["recurring", "copy", "Recurring", "Workspace"],
  ["reminders", "bell", "Reminders", "Workspace"],
  ["invoices", "file", "Invoices", "Workspace"],
  ["customers", "users", "Customers", "Manage"],
  ["products", "box", "Products", "Manage"],
  ["reports", "chart", "Reports", "Insights"],
  ["settings", "settings", "Settings", "System"]
];

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("json") ? await response.json() : null;
  if (!response.ok) { const error = new Error(payload?.error?.message || `Request failed (${response.status})`); error.details = payload?.error?.details; error.status = response.status; throw error; }
  return payload?.data ?? payload;
}

const money = (minor = 0, currency = state.document?.data?.currency || state.current?.data?.currency || "ZAR") => new Intl.NumberFormat("en-ZA", { style: "currency", currency, minimumFractionDigits: 2 }).format(minor / 100);
const dateLabel = (value) => value ? new Intl.DateTimeFormat("en-ZA", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`)) : "Not set";
const initials = (name = "") => name.split(/\s+/).map((word) => word[0]).join("").slice(0, 2).toUpperCase() || "--";
const lineMath = (item) => { const gross = Math.round((Number(item.quantity) || 0) * (Number(item.unit_price_minor) || 0)); const discount = Math.round(gross * (Number(item.discount_bps) || 0) / 10000); const tax = Math.round((gross - discount) * (Number(item.tax_bps) || 0) / 10000); return { gross, discount, tax, total: gross - discount + tax }; };
const isPristineTrailingItem = (item = {}) => !item.product_id && !String(item.description || "").trim() && Number(item.quantity) === 1 && (Number(item.unit_price_minor) || 0) === 0 && Number(item.tax_bps) === 1500 && (Number(item.discount_bps) || 0) === 0;
const effectiveItems = () => { const items = [...(state.current?.data.items || [])]; while (items.length && isPristineTrailingItem(items.at(-1))) items.pop(); return items; };
const localTotals = () => { const lines = effectiveItems().map((item) => ({ ...item, ...lineMath(item), total_minor: lineMath(item).total })); return { lines, subtotal_minor: lines.reduce((sum, item) => sum + item.gross, 0), discount_minor: lines.reduce((sum, item) => sum + item.discount, 0), tax_minor: lines.reduce((sum, item) => sum + item.tax, 0), shipping_minor: Number(state.current?.data.shipping_minor) || 0, total_minor: lines.reduce((sum, item) => sum + item.total, 0) + (Number(state.current?.data.shipping_minor) || 0) }; };

function clientReadyChecks() {
  const data = state.current?.data || {};
  const totals = localTotals();
  const supplier = data.supplier || {};
  const customer = data.customer || {};
  return [
    ["Invoice title", /invoice/i.test(data.document_title || "")],
    ["Supplier identity and address", Boolean(supplier.name && supplier.address)],
    ["Supplier VAT number", !supplier.vat_registered || Boolean(supplier.vat_number)],
    ["Customer identity and address", Boolean(customer.name && customer.address)],
    ["Recipient VAT number, when applicable", !customer.vat_registered || Boolean(customer.vat_number)],
    ["Serial number and issue date", Boolean(data.number && data.issue_date)],
    ["At least one valid line item", totals.lines.length > 0 && totals.lines.every((item) => item.description?.trim() && item.quantity > 0 && item.unit_price_minor >= 0)],
    ["Value, VAT and total calculated", totals.total_minor >= 0]
  ].map(([label, complete]) => ({ label, complete }));
}

function toast(message, tone = "") { const el = document.createElement("div"); el.className = `toast ${tone}`; el.textContent = message; $("#toasts").append(el); setTimeout(() => el.remove(), 3200); }
function setRoute(route) { state.route = route; state.documentRouteId = route === "document-editor" ? state.document?.id || null : null; location.hash = route === "document-editor" && state.documentRouteId ? `document-editor/${state.documentRouteId}` : route; $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); render(); }

function renderNav() {
  let group = "";
  $("#nav").innerHTML = routes.map(([id, glyph, label, section]) => {
    const heading = group !== section ? `<div class="nav-label">${section}</div>` : ""; group = section;
    const count = id === "invoices" ? `<span class="count">${state.invoices.filter((item) => item.status === "draft").length}</span>` : id === "recurring" && state.recurringSchedules.filter((item) => item.active).length ? `<span class="count">${state.recurringSchedules.filter((item) => item.active).length}</span>` : id === "reminders" && state.dueReminders.length ? `<span class="count">${state.dueReminders.length}</span>` : "";
    return `${heading}<button class="nav-item ${state.route === id ? "active" : ""}" data-route="${id}">${icon(glyph)}${label}${count}</button>`;
  }).join("");
  const current = routes.find(([id]) => id === state.route) || (state.route === "document-editor" ? ["document-editor", "file", "Documents"] : routes[0]);
  $("#crumbs").innerHTML = `<span>Forma</span>${icon("chevron")}<b>${current[2]}</b>`;
}

function pageHead(eyebrow, title, lead, actions = "") { return `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${lead}</p></div><div class="head-actions">${actions}</div></div>`; }
function field(label, path, value, options = {}) {
  const { type = "text", span = "", placeholder = "", suffix = "", min = "", step = "", disabled = false, required = false } = options;
  const touched = state.touched.has(path);
  const invalid = required && touched && !String(value ?? "").trim();
  return `<div class="field ${span} ${touched ? "touched" : ""}"><label for="${path.replaceAll(".", "-")}">${label}${required ? " *" : ""}</label><div class="input-wrap ${invalid ? "invalid" : ""}"><input id="${path.replaceAll(".", "-")}" data-path="${path}" type="${type}" value="${escapeHtml(value ?? "")}" placeholder="${escapeHtml(placeholder)}" ${min !== "" ? `min="${min}"` : ""} ${step !== "" ? `step="${step}"` : ""} ${disabled ? "disabled" : ""}>${suffix ? `<span class="suffix">${suffix}</span>` : ""}</div>${required ? `<span class="field-error">${label} is required</span>` : ""}</div>`;
}

function saveStateMarkup() { if (state.saveError) return `<span class="save-state error">Could not save</span>`; if (state.saving) return `<span class="save-state saving"><i></i>Saving...</span>`; return `<span class="save-state"><i></i>Saved ${state.current ? new Date(state.current.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>`; }

const auditLabels = { created: "Invoice created", updated: "Draft updated", finalized: "Invoice finalized", sent: "Send recorded", paid: "Marked paid", voided: "Invoice voided", void: "Invoice voided" };
function auditMarkup() {
  if (!state.audit.length) return `<div class="audit-empty">No activity recorded yet.</div>`;
  return `<ol class="audit-list">${state.audit.slice(-20).reverse().map((event) => `<li class="audit-event"><span class="audit-icon ${event.type}">${icon(event.type === "voided" || event.type === "void" ? "x" : "check")}</span><span><strong>${escapeHtml(auditLabels[event.type] || event.type)}</strong><time datetime="${escapeHtml(event.created_at)}">${new Date(event.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}</time>${event.type === "sent" ? `<small>Recorded locally; external email is not configured.</small>` : ""}</span></li>`).join("")}</ol>`;
}

function editorTotalsMarkup(totals) {
  return `<div class="editor-totals" aria-live="polite"><div><span>Subtotal</span><strong data-editor-total="subtotal">${money(totals.subtotal_minor)}</strong></div><div><span>Discount</span><strong data-editor-total="discount">-${money(totals.discount_minor)}</strong></div><div><span>VAT</span><strong data-editor-total="tax">${money(totals.tax_minor)}</strong></div><div><span>Shipping</span><strong data-editor-total="shipping">${money(totals.shipping_minor)}</strong></div><div class="balance"><span>Balance due</span><strong data-editor-total="balance">${money(totals.total_minor)}</strong></div></div>`;
}

function renderInvoice() {
  if (!state.current) return `<div class="loading-state"><span class="spinner"></span><strong>Loading draft</strong></div>`;
  const invoice = state.current;
  const data = invoice.data;
  const locked = invoice.status !== "draft";
  const totals = localTotals();
  const checks = clientReadyChecks();
  const done = checks.filter((item) => item.complete).length;
  const selectedCustomer = state.customers.find((item) => item.id === data.customer_id);
  const recentCustomers = state.customers.filter((item) => !state.customerQuery || `${item.name} ${item.email}`.toLowerCase().includes(state.customerQuery.toLowerCase())).slice(0, 6);
  const productResults = state.products.filter((item) => !state.productQuery || `${item.name} ${item.description}`.toLowerCase().includes(state.productQuery.toLowerCase())).slice(0, 5);
  const lifecycleMenu = ["finalized", "sent"].includes(invoice.status) ? `<details class="action-menu"><summary class="icon-btn" aria-label="More invoice actions">${icon("more")}</summary><div class="action-menu-pop"><button data-mark-paid>${icon("check")}Mark paid</button><button class="danger" data-void>${icon("trash")}Void invoice</button></div></details>` : "";
  const actions = locked
    ? `${saveStateMarkup()}<span class="status ${invoice.status}">${invoice.status}</span><button class="btn" data-download>${icon("download")}Download PDF</button><button class="btn" data-fullscreen-preview>${icon("maximize")}Full screen</button><button class="btn" data-duplicate>${icon("copy")}Duplicate</button>${lifecycleMenu}`
    : `${saveStateMarkup()}<span class="status draft">Draft</span><button class="btn" data-download>${icon("download")}PDF</button><button class="btn" data-fullscreen-preview>${icon("maximize")}Full screen</button><button class="btn" data-save>${icon("check")}Save draft</button><button class="btn primary" data-review>${icon("send")}Review & send</button>`;
  return `<div class="page invoice-page">
    ${pageHead("Invoices / New invoice", locked ? `${escapeHtml(invoice.number)}` : "Create an invoice", locked ? "Financial details are locked. Duplicate this invoice to make changes." : "Everything you need to create a correct invoice, in the order you need it.", actions)}
    <div class="composer">
      <div class="editor">
        <div class="flowbar"><button class="flow-step active" data-page="customer"><span>1</span>Who is this for?</button><button class="flow-step" data-page="items"><span>2</span>What are you billing?</button><button class="flow-step" data-page="payment"><span>3</span>When will they pay?</button></div>
        <div class="form-pages">
          <div class="form-page active" id="page-customer">
            <section class="section-card">
              <div class="section-head"><div class="section-title"><span class="section-number">1</span><div><h2>Who is this for?</h2><p>Choose a recent customer or create one without leaving the invoice.</p></div></div>${!locked ? `<button class="btn" data-new-customer>${icon("plus")}New customer</button>` : ""}</div>
              ${selectedCustomer ? `<div class="selected-customer"><span class="customer-avatar">${initials(selectedCustomer.name)}</span><div><strong>${escapeHtml(selectedCustomer.name)}</strong><span>${escapeHtml(selectedCustomer.email)} · ${escapeHtml(selectedCustomer.country)}</span><span>${escapeHtml(selectedCustomer.address)}</span></div>${!locked ? `<button class="link-btn" data-change-customer>Change</button>` : ""}</div>` : `<div class="input-wrap customer-search">${icon("search")}<input id="customerSearch" aria-label="Search customers" placeholder="Search by company or email" value="${escapeHtml(state.customerQuery)}" autocomplete="off"></div><div class="recent-label">Recent customers</div><div class="customer-list">${recentCustomers.map((customer) => `<button class="customer-option" data-customer="${customer.id}"><span class="customer-avatar">${initials(customer.name)}</span><span><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.email)}</small><small>${customer.terms_days} day terms · ${customer.currency}</small></span></button>`).join("")}</div>`}
            </section>
            <div class="form-navigation"><button class="btn" data-next-page="items">${icon("chevron")}Next</button></div>
          </div>
          <div class="form-page" id="page-items">
            <section class="section-card">
              <div class="section-head"><div class="section-title"><span class="section-number">2</span><div><h2>What are you billing?</h2><p>Add saved products or type a custom service. Totals update as you work.</p></div></div></div>
              ${!locked ? `<div class="product-picker"><div class="input-wrap">${icon("search")}<input id="productSearch" aria-label="Search saved products or services" placeholder="Search saved products or services" value="${escapeHtml(state.productQuery)}" autocomplete="off"></div>${state.productQuery ? `<div class="product-menu">${productResults.length ? productResults.map((product) => `<button class="product-result" data-product="${product.id}"><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.description)}</small></span><strong>${money(product.unit_price_minor, product.currency)}</strong></button>`).join("") : `<button class="product-result" data-custom-item><span><strong>Add “${escapeHtml(state.productQuery)}” as a custom item</strong><small>You can save it to the catalog later.</small></span>${icon("plus")}</button>`}</div>` : ""}</div>` : ""}
              <div class="line-list">${data.items.length ? data.items.map((item, index) => lineCard(item, index, locked)).join("") : `<div class="empty-state"><div><span class="section-number" style="margin:auto">${icon("box")}</span><h3>No items yet</h3><p>Search a saved product above or add a custom line.</p><button class="btn primary" data-custom-item>${icon("plus")}Add first item</button></div></div>`}</div>
              ${!locked && data.items.length ? `<div class="line-add"><button class="btn" data-custom-item>${icon("plus")}Add custom item</button><span class="kbd-hint">Tip: press Enter in the last description to add another row</span></div>` : ""}
              ${editorTotalsMarkup(totals)}
            </section>
            <div class="form-navigation"><button class="btn" data-prev-page="customer">Previous</button><button class="btn" data-next-page="payment">${icon("chevron")}Next</button></div>
          </div>
          <div class="form-page" id="page-payment">
            <section class="section-card">
              <div class="section-head"><div class="section-title"><span class="section-number">3</span><div><h2>When and how will they pay?</h2><p>Terms calculate the due date automatically. Override it only when needed.</p></div></div></div>
              <div class="field-grid">
                ${field("Invoice number", "number", data.number, { suffix: "Auto", disabled: locked, required: true })}
                ${field("Issue date", "issue_date", data.issue_date, { type: "date", disabled: locked, required: true })}
                <div class="field span-2"><label>Payment terms</label><div class="terms">${[0,7,14,30,60].map((days) => `<button class="term-chip ${data.terms_days === days ? "active" : ""}" data-terms="${days}" ${locked ? "disabled" : ""}>${days === 0 ? "Due now" : `Net ${days}`}</button>`).join("")}</div></div>
                ${field("Due date", "due_date", data.due_date, { type: "date", disabled: locked, required: true })}
                <div class="field"><label for="invoiceCurrency">Currency</label><div class="input-wrap"><select id="invoiceCurrency" data-select-path="currency" ${locked ? "disabled" : ""}>${["ZAR","USD","EUR","GBP"].map((value) => `<option ${data.currency === value ? "selected" : ""}>${value}</option>`).join("")}</select></div></div>
                <div class="field"><label for="paymentMethod">Payment method</label><div class="input-wrap"><select id="paymentMethod" data-select-path="payment_method" ${locked ? "disabled" : ""}>${["Bank transfer","Card payment","Cash","Other"].map((value) => `<option ${data.payment_method === value ? "selected" : ""}>${value}</option>`).join("")}</select></div></div>
                ${field("PO / reference", "po_number", data.po_number, { placeholder: "Optional", disabled: locked })}
              </div>
            </section>
            <details class="options"><summary>More options <span>Notes, payment details, shipping, VAT and attachments</span>${icon("chevron")}</summary><div class="options-body"><div class="field-grid">
              ${field("Document title", "document_title", data.document_title, { disabled: locked, required: true })}
              ${field("Shipping", "shipping_display", (data.shipping_minor / 100).toFixed(2), { type: "number", min: 0, step: ".01", disabled: locked, suffix: data.currency })}
              ${field("Payment details", "payment_details", data.payment_details, { span: "span-2", disabled: locked })}
              <div class="field span-2"><label for="customerNotes">Customer note</label><textarea id="customerNotes" data-path="notes" rows="3" ${locked ? "disabled" : ""}>${escapeHtml(data.notes)}</textarea></div>
              ${field("Supplier name", "supplier.name", data.supplier.name, { disabled: locked, required: true })}
              ${field("Supplier VAT number", "supplier.vat_number", data.supplier.vat_number, { disabled: locked })}
              ${field("Supplier address", "supplier.address", data.supplier.address, { span: "span-2", disabled: locked, required: true })}
              <div class="field span-2"><label>Attachments</label><button class="dropzone" type="button" data-attach ${locked ? "disabled" : ""}>Drop files here or choose a file · Metadata is stored locally</button></div>
              ${invoiceAttachmentsMarkup(data, locked)}
            </div></div></details>
            <div class="form-navigation"><button class="btn" data-prev-page="items">Previous</button></div>
          </div>
        </div>
      </div>
      <aside class="preview-rail"><div class="readiness">${readinessMarkup(checks, done)}</div><div class="paper-wrap"><div class="paper" id="paper">${paperMarkup(data, totals)}</div></div></aside>
    </div>
    <div class="mobile-totalbar"><div><span>Balance due</span><strong id="mobileTotal">${money(totals.total_minor)}</strong></div><button class="btn" data-preview>${icon("file")}Preview</button><button class="btn primary" data-review ${locked ? "disabled" : ""}>Review</button></div>
  </div>`;
}

function lineCard(item, index, locked) {
  const result = lineMath(item);
  const expanded = state.expandedLines.has(index);
  return `<article class="line-card" data-line="${index}" data-expanded="${expanded}">
    ${lineField("Description", "description", item.description, index, { disabled: locked })}
    ${lineField("Qty", "quantity", item.quantity, index, { type: "number", min: 0.01, step: .01, disabled: locked })}
    ${lineField("Unit price", "unit_price_display", (item.unit_price_minor / 100).toFixed(2), index, { type: "number", min: 0, step: .01, className: "price-field", disabled: locked })}
    ${lineField("Tax", "tax_percent", (item.tax_bps / 100).toFixed(2), index, { type: "number", min: 0, step: .01, suffix: "%", className: "tax-field", disabled: locked })}
    ${lineField("Discount", "discount_percent", (item.discount_bps / 100).toFixed(2), index, { type: "number", min: 0, step: .01, suffix: "%", className: "discount-field", disabled: locked })}
    <div class="line-total" data-line-total="${index}">${money(result.total)}</div>
    <div class="line-actions"><button class="icon-btn line-expand" data-toggle-line="${index}" aria-label="${expanded ? "Hide" : "Show"} all fields for ${escapeHtml(item.description || `item ${index + 1}`)}" aria-expanded="${expanded}">${icon("chevron")}</button>${locked ? "" : `<button class="icon-btn" data-copy-line="${index}" aria-label="Duplicate ${escapeHtml(item.description || `item ${index + 1}`)}">${icon("copy")}</button><button class="icon-btn delete" data-delete-line="${index}" aria-label="Delete ${escapeHtml(item.description || `item ${index + 1}`)}">${icon("trash")}</button>`}</div>
  </article>`;
}
function lineField(label, key, value, index, options = {}) { const id = `line-${index}-${key}`; return `<div class="field ${options.className || ""}"><label for="${id}">${label}</label><div class="input-wrap">${key === "unit_price_display" ? `<span class="suffix">${state.current.data.currency}</span>` : ""}<input id="${id}" data-line-index="${index}" data-line-key="${key}" aria-label="${label} for invoice item ${index + 1}" type="${options.type || "text"}" value="${escapeHtml(value)}" ${options.min !== undefined ? `min="${options.min}"` : ""} ${options.step !== undefined ? `step="${options.step}"` : ""} ${options.disabled ? "disabled" : ""}>${options.suffix ? `<span class="suffix">${options.suffix}</span>` : ""}</div></div>`; }
function readinessMarkup(checks, done) { const ready = done === checks.length; return `<div class="readiness-top"><strong>${ready ? "Ready to send" : "Invoice readiness"}</strong><span class="ready-count">${done}/${checks.length}</span></div><div class="ready-bar"><span style="width:${done / checks.length * 100}%"></span></div><p class="ready-text">${ready ? "All required invoice details are present." : `${checks.length - done} item${checks.length - done === 1 ? "" : "s"} still need attention before finalizing.`}</p>`; }

function paperMarkup(data, totals) {
  const customer = data.customer || {};
  const supplier = data.supplier || {};
  const logoUrl = String(supplier.logo_url || state.profile.logo_url || "/VKT-logo.png").trim();
  const logoMarkup = logoUrl && /^(https?:\/\/|data:image\/|\/)/i.test(logoUrl)
    ? `<img src="${escapeHtml(logoUrl)}" alt="" class="paper-logo-image" style="height:100%; width:100%; object-fit:contain;">`
    : escapeHtml((supplier.name || "F").slice(0, 1).toUpperCase());
  return `<div class="paper-head"><span class="paper-logo" style="display:flex;align-items:center;justify-content:center;overflow:hidden;padding:2px;">${logoMarkup}</span><div class="paper-brand"><strong>${escapeHtml(supplier.name || "Your company")}</strong>${escapeHtml(supplier.address || "Add your business address")}<br>${supplier.vat_number ? `VAT ${escapeHtml(supplier.vat_number)}` : ""}</div></div>
    <h3>${escapeHtml(data.document_title || "Invoice")}</h3><span class="paper-number">${escapeHtml(data.number || "Draft")}</span>
    <div class="paper-meta"><div><span class="paper-label">Billed to</span><div class="paper-value">${escapeHtml(customer.name || "Choose a customer")}<br>${escapeHtml(customer.address || "")}</div></div><div><span class="paper-label">Issued</span><div class="paper-value">${dateLabel(data.issue_date)}</div></div><div><span class="paper-label">Due</span><div class="paper-value">${dateLabel(data.due_date)}</div></div></div>
    <div class="paper-table"><div class="paper-row head"><span>Description</span><span>Qty</span><span>Rate</span><span>Total</span></div>${totals.lines.length ? totals.lines.map((item) => `<div class="paper-row"><span>${escapeHtml(item.description || "Untitled item")}</span><span>${item.quantity}</span><span>${money(item.unit_price_minor, data.currency)}</span><span>${money(item.total_minor, data.currency)}</span></div>`).join("") : `<div class="paper-row"><span>No line items yet</span><span>-</span><span>-</span><span>-</span></div>`}</div>
    <div class="paper-totals"><div class="paper-total-row"><span>Subtotal</span><span>${money(totals.subtotal_minor, data.currency)}</span></div>${totals.discount_minor ? `<div class="paper-total-row"><span>Discount</span><span>-${money(totals.discount_minor, data.currency)}</span></div>` : ""}<div class="paper-total-row"><span>VAT</span><span>${money(totals.tax_minor, data.currency)}</span></div>${totals.shipping_minor ? `<div class="paper-total-row"><span>Shipping</span><span>${money(totals.shipping_minor, data.currency)}</span></div>` : ""}<div class="paper-total-row grand"><span>Balance due</span><span>${money(totals.total_minor, data.currency)}</span></div></div>
    <div class="paper-foot"><div><strong>Payment details</strong>${escapeHtml(data.payment_details || data.payment_method || "")}</div><div><strong>Reference</strong>${escapeHtml(data.po_number || data.number || "")}</div></div>`;
}

function renderInvoices() {
  const query = state.invoiceQuery.trim().toLowerCase();
  const filtered = state.invoices.filter((invoice) => (state.invoiceStatus === "all" || invoice.status === state.invoiceStatus) && (!query || `${invoice.number} ${invoice.data.customer?.name || ""} ${invoice.data.customer?.email || ""}`.toLowerCase().includes(query)));
  return `<div class="page">${pageHead("Receivables", "Invoices", "Search, filter and act on every invoice in the local ledger.", `<button class="btn primary" data-new-invoice>${icon("plus")}New invoice</button>`)}<div class="invoice-filters"><div class="input-wrap">${icon("search")}<input id="invoiceSearch" aria-label="Search invoices" placeholder="Search invoice, customer or email" value="${escapeHtml(state.invoiceQuery)}"></div><div class="input-wrap"><select id="invoiceStatus" aria-label="Filter invoices by status"><option value="all">All statuses</option>${["draft","finalized","sent","paid","void"].map((status) => `<option value="${status}" ${state.invoiceStatus === status ? "selected" : ""}>${status[0].toUpperCase() + status.slice(1)}</option>`).join("")}</select></div><span class="filter-count">${filtered.length} of ${state.invoices.length}</span></div><section class="table-card invoice-table"><div class="data-row head"><span>Invoice</span><span>Customer</span><span>Amount</span><span>Due</span><span>Status</span><span></span></div>${filtered.length ? filtered.map((invoice) => `<div class="data-row"><span><strong>${escapeHtml(invoice.number)}</strong><small>${dateLabel(invoice.data.issue_date)}</small></span><span><strong>${escapeHtml(invoice.data.customer?.name || "No customer")}</strong><small>${escapeHtml(invoice.data.customer?.email || "")}</small></span><strong>${money(invoice.totals.total_minor, invoice.data.currency)}</strong><span><strong>${dateLabel(invoice.data.due_date)}</strong><small>${invoice.status === "paid" ? "Settled" : invoice.status === "void" ? "Closed" : "Payment due"}</small></span><span><span class="status ${invoice.status}">${invoice.status}</span></span><button class="btn" data-open-invoice="${invoice.id}">Open</button></div>`).join("") : `<div class="table-empty"><strong>No matching invoices</strong><span>Adjust the search or status filter.</span></div>`}</section></div>`;
}
function renderDashboard() {
  const paid = state.invoices.filter((i) => i.status === "paid").reduce((sum, i) => sum + i.totals.total_minor, 0);
  const open = state.invoices.filter((i) => ["sent","finalized"].includes(i.status)).reduce((sum, i) => sum + i.totals.total_minor, 0);
  return `<div class="page">${pageHead("Command center", "Good morning, Alex", "A clear view of billing activity and the work that needs attention.", `<button class="btn primary" data-new-invoice>${icon("plus")}Create invoice</button>`)}<div class="dashboard-grid">${[["Collected",money(paid),"Paid invoices"],["Outstanding",money(open),"Awaiting payment"],["Drafts",state.invoices.filter(i=>i.status==="draft").length,"Ready to continue"],["Customers",state.customers.length,"Active records"]].map(([label,value,note])=>`<section class="metric-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></section>`).join("")}</div><div class="split-grid"><section class="panel"><h2>Recent invoices</h2><p class="panel-sub">Continue a draft or review a completed invoice.</p>${state.invoices.slice(0,5).map(i=>`<div class="activity-row"><span><strong>${escapeHtml(i.number)}</strong><small>${escapeHtml(i.data.customer?.name||"No customer")}</small></span><span><strong>${money(i.totals.total_minor,i.data.currency)}</strong><small class="status ${i.status}">${i.status}</small></span></div>`).join("")}</section><section class="panel"><h2>Quick start</h2><p class="panel-sub">The fastest routes into billing.</p><button class="btn primary" style="width:100%;margin-bottom:8px" data-new-invoice>${icon("plus")}Blank invoice</button><button class="btn" style="width:100%" data-duplicate-latest>${icon("copy")}Duplicate latest invoice</button></section></div></div>`;
}
function renderReports() {
  const invoices = state.documents.filter((document) => document.document_type === "invoice" && document.status !== "void");
  const issued = invoices.filter((document) => document.status !== "draft");
  const billed = issued.reduce((sum, document) => sum + documentTotal(document), 0);
  const collected = issued.reduce((sum, document) => sum + Number(document.amount_paid_minor || 0), 0);
  const outstanding = invoices.filter((document) => !["draft", "paid"].includes(document.status)).reduce((sum, document) => sum + Number(document.balance_due_minor ?? documentTotal(document)), 0);
  const tax = issued.reduce((sum, document) => sum + Number(document.totals?.tax_minor || 0), 0);
  const entries = [...state.documents].filter((document) => document.status !== "void").sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).slice(0, 8);
  return `<div class="page reports-page">${pageHead("Insights", "Receivables report", "A ledger-level view of billed, collected, outstanding, and tax amounts from your saved documents.", `<button class="btn primary" data-export-receivables>${icon("download")}Export CSV</button>`)}<div class="dashboard-grid report-metrics">${[["Billed", money(billed), "Issued invoices"], ["Collected", money(collected), "Recorded payments"], ["Outstanding", money(outstanding), "Open invoice balances"], ["Tax recorded", money(tax), "Across issued invoices"]].map(([label, value, note]) => `<section class="metric-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></section>`).join("")}</div><section class="panel report-export-note"><div><h2>Receivables ledger export</h2><p class="panel-sub">Download a spreadsheet-safe CSV with document numbers, amounts, balances, payment state, dates, and recurring-schedule lineage.</p></div><button class="btn" data-export-receivables>${icon("download")}Download CSV</button></section><section class="table-card invoice-table report-table"><div class="data-row head"><span>Document</span><span>Customer</span><span>Total</span><span>Balance</span><span>Status</span><span></span></div>${entries.length ? entries.map((document) => `<div class="data-row"><span><strong>${escapeHtml(document.number)}</strong><small>${documentTypeLabel(document.document_type)} &middot; ${dateLabel(document.data?.issue_date)}</small></span><span><strong>${escapeHtml(documentCustomer(document))}</strong><small>${escapeHtml(document.data?.currency || "ZAR")}</small></span><strong>${money(documentTotal(document), document.data?.currency)}</strong><span><strong>${money(document.balance_due_minor ?? documentTotal(document), document.data?.currency)}</strong><small>Balance due</small></span><span><span class="status ${escapeHtml(document.status)}">${escapeHtml(document.status)}</span></span><button class="btn" data-open-document="${escapeHtml(document.id)}">Open</button></div>`).join("") : `<div class="table-empty"><strong>No receivables data yet</strong><span>Create and issue invoices to populate this report.</span></div>`}</section></div>`;
}
function renderDirectory(type) {
  const customers = type === "customers";
  const rows = customers ? state.customers : state.products;
  return `<div class="page">${pageHead("Manage", customers ? "Customers" : "Products", customers ? "Billing identities, defaults and payment terms." : "Reusable products and services for faster invoices.", `<button class="btn primary" ${customers ? "data-new-customer" : "data-new-product"}>${icon("plus")}New ${customers ? "customer" : "product"}</button>`)}<section class="table-card">${rows.map((row) => customers ? `<div class="data-row"><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.email)}</small></span><span>${escapeHtml(row.address)}</span><span>${row.currency}</span><span>${row.terms_days} days</span><span>${row.vat_number || "No VAT"}</span><button class="btn" data-invoice-customer="${row.id}">Invoice</button></div>` : `<div class="data-row"><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.description)}</small></span><span>${money(row.unit_price_minor,row.currency)}</span><span>${row.tax_bps/100}% VAT</span><span>${row.currency}</span><span></span><button class="btn" data-use-product="${row.id}">Use</button></div>`).join("")}</section></div>`;
}
const documentTypeLabel = (type = "invoice") => ({ invoice: "Invoice", quote: "Quote", receipt: "Receipt" }[type] || type);
const documentCustomer = (document) => document?.data?.customer?.name || document?.data?.customer_name || "No customer";
const documentTotal = (document) => document?.totals?.total_minor ?? document?.data?.total_minor ?? 0;
const simpleInput = (label, id, value = "", type = "text", options = {}) => {
  const disabled = options.disabled || (id.startsWith("document") && state.document && state.document.status !== "draft");
  return `<div class="field ${options.span || ""}"><label for="${id}">${label}</label><div class="input-wrap"><input id="${id}" type="${type}" value="${escapeHtml(value ?? "")}" ${options.placeholder ? `placeholder="${escapeHtml(options.placeholder)}"` : ""} ${options.min !== undefined ? `min="${options.min}"` : ""} ${options.step !== undefined ? `step="${options.step}"` : ""} ${disabled ? "disabled" : ""}>${options.suffix ? `<span class="suffix">${escapeHtml(options.suffix)}</span>` : ""}</div></div>`;
};
const documentTemplate = (document) => state.templates.find((item) => item.id === document?.data?.template_id) || state.templates[0] || { id: "classic", name: "Classic", accent: "#7f56d9", density: "comfortable" };
function genericTotals(data = {}) {
  const lines = (data.items || []).map((item) => {
    const gross = Math.round((Number(item.quantity) || 0) * (Number(item.unit_price_minor) || 0));
    const discount = Math.round(gross * Math.max(0, Number(item.discount_bps) || 0) / 10000);
    const taxable = gross - discount;
    return { ...item, gross, discount, taxable };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.gross, 0);
  const lineDiscount = lines.reduce((sum, line) => sum + line.discount, 0);
  const taxableBeforeDocumentDiscount = lines.reduce((sum, line) => sum + line.taxable, 0);
  const documentDiscountBps = Math.min(10000, Math.max(0, Math.round(Number(data.document_discount_bps) || 0)));
  const documentDiscount = Math.round(taxableBeforeDocumentDiscount * documentDiscountBps / 10000);
  let allocatedDocumentDiscount = 0;
  const calculatedLines = lines.map((line, index) => {
    const remaining = documentDiscount - allocatedDocumentDiscount;
    const allocation = index === lines.length - 1 ? remaining : Math.min(remaining, Math.round(documentDiscount * line.taxable / Math.max(1, taxableBeforeDocumentDiscount)));
    allocatedDocumentDiscount += allocation;
    const taxableAfterDocumentDiscount = line.taxable - allocation;
    const tax = Math.round(taxableAfterDocumentDiscount * Math.max(0, Number(line.tax_bps) || 0) / 10000);
    return { ...line, document_discount: allocation, tax, total: taxableAfterDocumentDiscount + tax };
  });
  const taxBreakdown = Object.values(calculatedLines.reduce((groups, line) => { const key = String(line.tax_bps || 0); const group = groups[key] ||= { tax_bps: Number(line.tax_bps) || 0, taxable: 0, tax: 0 }; group.taxable += line.taxable - line.document_discount; group.tax += line.tax; return groups; }, {})).sort((a, b) => a.tax_bps - b.tax_bps);
  const shipping = Math.max(0, Math.round(Number(data.shipping_minor) || 0));
  return { lines: calculatedLines, subtotal, lineDiscount, documentDiscountBps, documentDiscount, discount: lineDiscount + documentDiscount, tax: calculatedLines.reduce((sum, line) => sum + line.tax, 0), taxBreakdown, shipping, total: calculatedLines.reduce((sum, line) => sum + line.total, 0) + shipping };
}
function documentAttachmentsMarkup(document, draft) {
  const attachments = document.data?.attachments || [];
  return `<div class="field span-2 document-attachments"><label for="documentAttachmentFile">Attachments</label>${draft ? `<div class="attachment-upload"><input id="documentAttachmentFile" type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/svg+xml"><button type="button" class="btn" data-upload-document-attachment>${icon("plus")}Upload</button></div><small>PDF, PNG, JPG, WebP, or safe SVG up to 10 MB.</small>` : `<small>Attachments are locked with this issued document.</small>`}<div class="attachment-list">${attachments.length ? attachments.map((attachment) => `<div class="attachment-row"><a href="${escapeHtml(attachment.url || "#")}" target="_blank" rel="noopener">${icon("file")}<span><strong>${escapeHtml(attachment.name || "Attachment")}</strong><small>${escapeHtml(attachment.content_type || "File")} · ${Number(attachment.byte_size || 0).toLocaleString()} bytes</small></span></a>${draft ? `<button type="button" class="icon-btn" data-remove-document-attachment="${escapeHtml(attachment.asset_id)}" aria-label="Remove ${escapeHtml(attachment.name || "attachment")}">${icon("trash")}</button>` : ""}</div>`).join("") : `<small class="attachment-empty">No supporting files attached.</small>`}</div></div>`;
}
function invoiceAttachmentsMarkup(data, locked) {
  const attachments = data.attachments || [];
  return `<div class="field span-2"><label for="invoiceAttachmentFile">Attachments</label>${locked ? `<small>Attachments are locked with this issued invoice.</small>` : `<div class="attachment-upload"><input id="invoiceAttachmentFile" type="file" accept="application/pdf,image/png,image/jpeg,image/webp,image/svg+xml"><button type="button" class="btn" data-upload-invoice-attachment>${icon("plus")}Upload</button></div><small>PDF, PNG, JPG, WebP, or safe SVG up to 10 MB.</small>`}<div class="attachment-list">${attachments.length ? attachments.map((attachment) => `<div class="attachment-row"><a href="${escapeHtml(attachment.url || "#")}" target="_blank" rel="noopener">${icon("file")}<span><strong>${escapeHtml(attachment.name || "Attachment")}</strong><small>${escapeHtml(attachment.content_type || "File")} · ${Number(attachment.byte_size || 0).toLocaleString()} bytes</small></span></a>${locked ? "" : `<button type="button" class="icon-btn" data-remove-invoice-attachment="${escapeHtml(attachment.asset_id)}" aria-label="Remove ${escapeHtml(attachment.name || "attachment")}">${icon("trash")}</button>`}</div>`).join("") : `<small class="attachment-empty">No supporting files attached.</small>`}</div></div>`;
}
function genericPaperMarkup(document) {
  const data = document.data || {};
  const template = documentTemplate(document);
  const totals = genericTotals(data);
  const label = documentTypeLabel(document.document_type);
  const dateLabelText = document.document_type === "quote" ? "Valid until" : document.document_type === "receipt" ? "Payment date" : "Due date";
  const logoUrl = String(data.supplier?.logo_url || state.profile.logo_url || "/VKT-logo.png").trim();
  const mark = logoUrl && /^(https?:\/\/|data:image\/|\/)/i.test(logoUrl) ? `<img class="generic-paper-logo-image" src="${escapeHtml(logoUrl)}" alt="">` : escapeHtml((data.supplier?.name || "F").slice(0, 1));
  return `<div class="generic-paper template-${escapeHtml(template.id)}" style="--document-accent:${escapeHtml(data.accent || template.accent || "#7f56d9")}">
    <div class="generic-paper-head"><div class="generic-paper-mark">${mark}</div><div><span class="generic-eyebrow">${label}</span><h3>${escapeHtml(data.document_title || label)}</h3><small>${escapeHtml(data.number || document.number)}</small></div><div class="generic-paper-business"><strong>${escapeHtml(data.supplier?.name || state.profile.name || "Business name")}</strong><span>${escapeHtml(data.supplier?.address || state.profile.address || "")}</span></div></div>
    <div class="generic-paper-meta"><div><span>Bill to</span><strong>${escapeHtml(data.customer?.name || "Choose a client")}</strong><small>${escapeHtml(data.customer?.email || data.customer?.address || "")}</small></div><div><span>Issued</span><strong>${escapeHtml(data.issue_date || "-")}</strong></div><div><span>${dateLabelText}</span><strong>${escapeHtml(document.document_type === "receipt" ? data.issue_date || "-" : data.due_date || data.expiry_date || "-")}</strong></div></div>
    <div class="generic-paper-table"><div class="generic-paper-row head"><span>Description</span><span>Qty</span><span>Rate</span><span>Total</span></div>${totals.lines.length ? totals.lines.map((line) => `<div class="generic-paper-row"><span><strong>${escapeHtml(line.description || "Untitled item")}</strong>${line.detail ? `<small>${escapeHtml(line.detail)}</small>` : ""}</span><span>${escapeHtml(line.quantity || 0)}</span><span>${money(line.unit_price_minor, data.currency)}</span><span>${money(line.total, data.currency)}</span></div>`).join("") : `<div class="generic-paper-empty">Add your first line item</div>`}</div>
    <div class="generic-paper-totals"><div><span>Subtotal</span><strong>${money(totals.subtotal, data.currency)}</strong></div>${totals.discount ? `<div><span>Discount</span><strong>-${money(totals.discount, data.currency)}</strong></div>` : ""}${totals.taxBreakdown.filter((tax) => tax.tax_bps || tax.tax).map((tax) => `<div><span>Tax ${tax.tax_bps / 100}%</span><strong>${money(tax.tax, data.currency)}</strong></div>`).join("")}<div class="grand"><span>${document.document_type === "receipt" ? "Amount received" : "Total"}</span><strong>${money(totals.total, data.currency)}</strong></div></div>
    <div class="generic-paper-foot"><div>${data.footer ? escapeHtml(data.footer) : escapeHtml(data.notes || "Thank you for your business.")}</div><div>${data.signature ? `Signed: ${escapeHtml(data.signature)}` : ""}</div></div>
  </div>`;
}

function renderDocuments() {
  const query = state.documentQuery.trim().toLowerCase();
  const filtered = state.documents.filter((document) => (state.documentType === "all" || document.document_type === state.documentType) && (!query || `${document.number} ${documentCustomer(document)} ${document.document_type}`.toLowerCase().includes(query)));
  return `<div class="page">${pageHead("Receivables", "Documents", "Invoices, quotes and receipts in one operational ledger.", `<button class="btn" data-quick-route>${icon("plus")}Quick create</button><button class="btn primary" data-new-document>${icon("plus")}New document</button>`)}
    <div class="invoice-filters document-filters"><div class="input-wrap">${icon("search")}<input id="documentSearch" aria-label="Search documents" placeholder="Search number, customer or type" value="${escapeHtml(state.documentQuery)}"></div><div class="input-wrap"><select id="documentType" aria-label="Filter document type"><option value="all">All types</option>${["invoice", "quote", "receipt"].map((type) => `<option value="${type}" ${state.documentType === type ? "selected" : ""}>${documentTypeLabel(type)}s</option>`).join("")}</select></div><span class="filter-count">${filtered.length} of ${state.documents.length}</span></div>
    <section class="table-card invoice-table document-table"><div class="data-row head"><span>Document</span><span>Customer</span><span>Amount</span><span>Updated</span><span>Status</span><span></span></div>${filtered.length ? filtered.map((document) => `<div class="data-row"><span><strong>${escapeHtml(document.number)}</strong><small>${documentTypeLabel(document.document_type)}</small></span><span><strong>${escapeHtml(documentCustomer(document))}</strong><small>${escapeHtml(document.data?.customer?.email || "")}</small></span><strong>${money(documentTotal(document), document.data?.currency)}</strong><span><strong>${dateLabel((document.updated_at || "").slice(0, 10))}</strong><small>${document.document_type}</small></span><span><span class="status ${escapeHtml(document.status)}">${escapeHtml(document.status)}</span></span><button class="btn" data-open-document="${document.id}">Open</button></div>`).join("") : `<div class="table-empty"><strong>No matching documents</strong><span>Create a quote, invoice or payment receipt to get started.</span></div>`}</section></div>`;
}

function renderRecurring() {
  const schedules = state.recurringSchedules || [];
  const active = schedules.filter((schedule) => schedule.active);
  const due = active.filter((schedule) => schedule.next_run_on <= new Date().toISOString().slice(0, 10));
  const frequencyLabel = (frequency) => ({ weekly: "Weekly", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" }[frequency] || frequency);
  return `<div class="page recurring-page">${pageHead("Receivables", "Recurring invoices", "Turn a completed invoice structure into a controlled, reviewable recurring draft schedule.", `<button class="btn" data-new-recurring>${icon("plus")}New schedule</button><button class="btn primary" data-run-all-recurring ${due.length ? "" : "disabled"}>${icon("copy")}Generate due${due.length ? ` (${due.length})` : ""}</button>`) }
    <section class="recurring-overview"><div><span>Active schedules</span><strong>${active.length}</strong></div><div><span>Due now</span><strong>${due.length}</strong></div><div><span>Drafts generated</span><strong>${schedules.reduce((sum, schedule) => sum + Number(schedule.generated_count || 0), 0)}</strong></div></section>
    <section class="recurring-list">${schedules.length ? schedules.map((schedule) => { const latest = schedule.runs?.[0]; const currency = schedule.data?.currency || "ZAR"; const amount = schedule.data ? genericTotals(schedule.data).total : 0; return `<article class="recurring-card ${schedule.active ? "" : "paused"}"><div class="recurring-card-main"><div class="recurring-card-title"><div class="recurring-mark">${icon("copy")}</div><div><h2>${escapeHtml(schedule.name)}</h2><p>${escapeHtml(schedule.data?.customer?.name || "No client selected")} <span aria-hidden="true">&middot;</span> ${frequencyLabel(schedule.frequency)}</p></div></div><div class="recurring-amount"><strong>${money(amount, currency)}</strong><span>per invoice</span></div></div><div class="recurring-meta"><span><b>Next run</b>${dateLabel(schedule.next_run_on)}</span><span><b>Terms</b>${Number(schedule.data?.terms_days || 0)} days</span><span><b>Generated</b>${Number(schedule.generated_count || 0)} drafts</span><span><b>Latest</b>${latest ? `${escapeHtml(latest.number)} ${latest.status}` : "Not generated"}</span></div><div class="recurring-actions"><span class="status ${schedule.active ? "sent" : "void"}">${schedule.active ? "active" : "paused"}</span>${latest ? `<button class="btn" data-open-document="${escapeHtml(latest.document_id)}">Open latest</button>` : ""}<button class="btn" data-edit-recurring="${escapeHtml(schedule.id)}">Edit</button><button class="btn" data-run-recurring="${escapeHtml(schedule.id)}" ${schedule.active && schedule.next_run_on <= new Date().toISOString().slice(0, 10) ? "" : "disabled"}>Generate due</button><button class="btn" data-toggle-recurring="${escapeHtml(schedule.id)}">${schedule.active ? "Pause" : "Resume"}</button></div></article>`; }).join("") : `<section class="panel recurring-empty"><div class="recurring-mark">${icon("copy")}</div><h2>No recurring schedules yet</h2><p>Start from an existing invoice to carry forward its customer, items, tax, template, and payment details.</p><button class="btn primary" data-new-recurring>${icon("plus")}Create schedule</button></section>`}</section>
  </div>`;
}

function renderReminders() {
  const reminders = state.dueReminders || [];
  const rules = state.reminderRules || [];
  const active = rules.filter((rule) => rule.active);
  const totalDue = reminders.reduce((sum, reminder) => sum + Number(reminder.balance_due_minor || reminder.document?.balance_due_minor || 0), 0);
  const timing = (rule) => rule.offset_days < 0 ? `${Math.abs(rule.offset_days)} days before due` : rule.offset_days === 0 ? "On due date" : `${rule.offset_days} days overdue`;
  const purposeLabel = (purpose) => String(purpose || "").replaceAll("_", " ");
  return `<div class="page reminders-page">${pageHead("Receivables", "Payment reminders", "Preview and send scheduled invoice reminders before, on, or after the due date.", `<button class="btn" data-refresh-reminders>${icon("search")}Refresh</button><button class="btn primary" data-run-reminders ${reminders.length ? "" : "disabled"}>${icon("send")}Send due${reminders.length ? ` (${reminders.length})` : ""}</button>`)}
    <section class="recurring-overview reminder-overview"><div><span>Active policies</span><strong>${active.length}</strong></div><div><span>Due reminders</span><strong>${reminders.length}</strong></div><div><span>Balance in queue</span><strong>${money(totalDue)}</strong></div></section>
    <div class="reminder-grid"><section class="panel reminder-policy"><div class="settings-panel-head"><div><h2>Reminder policy</h2><p class="panel-sub">Rules are evaluated once per invoice due date. Catch-up sends only the latest due reminder and records older missed steps as skipped.</p></div><span class="settings-kicker">Dunning</span></div><div class="reminder-rule-list">${rules.map((rule) => `<article class="reminder-rule ${rule.active ? "" : "paused"}"><span class="recurring-mark">${icon("bell")}</span><div><strong>${escapeHtml(rule.label)}</strong><small>${timing(rule)} &middot; ${purposeLabel(rule.purpose)}</small></div><button class="btn" data-toggle-reminder-rule="${escapeHtml(rule.id)}">${rule.active ? "Pause" : "Resume"}</button></article>`).join("") || `<p class="panel-sub">No reminder policies configured.</p>`}</div></section>
    <section class="panel reminder-queue"><div class="settings-panel-head"><div><h2>Due queue</h2><p class="panel-sub">Only open invoices with a balance due and a customer email can be sent.</p></div><span class="settings-kicker">Preview</span></div>${reminders.length ? `<div class="reminder-list">${reminders.map((reminder) => { const document = reminder.document || {}; const customer = reminder.customer || document.data?.customer || {}; const blocked = !customer.email; return `<article class="reminder-card ${blocked ? "blocked" : ""}"><div class="reminder-card-main"><div><strong>${escapeHtml(document.number || "Invoice")}</strong><small>${escapeHtml(customer.name || "No customer")} &middot; ${escapeHtml(customer.email || "missing email")}</small></div><span class="status ${reminder.days_overdue > 0 ? "overdue" : "sent"}">${reminder.days_overdue > 0 ? `${reminder.days_overdue} days overdue` : "upcoming"}</span></div><div class="recurring-meta"><span><b>Rule</b>${escapeHtml(reminder.rule?.label || "Reminder")}</span><span><b>Scheduled</b>${dateLabel(reminder.scheduled_for)}</span><span><b>Due date</b>${dateLabel(reminder.due_date)}</span><span><b>Balance</b>${money(reminder.balance_due_minor, reminder.currency)}</span></div><div class="recurring-actions">${blocked ? `<span class="email-error">Add a customer email before sending.</span>` : `<span class="panel-sub">${reminder.skipped_rules?.length ? `${reminder.skipped_rules.length} older step${reminder.skipped_rules.length === 1 ? "" : "s"} will be skipped` : "Ready to send"}</span>`}<button class="btn" data-open-document="${escapeHtml(document.id || "")}">Open invoice</button></div></article>`; }).join("")}</div>` : `<section class="recurring-empty"><div class="recurring-mark">${icon("bell")}</div><h2>No reminders due</h2><p>Open invoice balances will appear here when a policy date is reached.</p></section>`}</section></div>
  </div>`;
}

function documentActionMarkup(document) {
  const type = document.document_type;
  const status = document.status;
  const action = (name, label, primary = false) => `<button class="btn ${primary ? "primary" : ""}" data-document-action="${name}">${label}</button>`;
  const actions = [];
  if (type === "quote" && status === "draft") actions.push(action("email", `${icon("send")}Send quote`, true));
  else if (type === "receipt" && status === "draft") actions.push(action("finalize", `${icon("check")}Issue receipt`, true));
  else if (type === "invoice" && status === "draft") actions.push(action("finalize", `${icon("check")}Finalize invoice`, true), action("email", `${icon("send")}Send invoice`));
  else actions.push(action("email", `${icon("send")}Compose email`));
  if (type === "quote" && status === "sent") actions.push(action("accept", "Accept"), action("decline", "Decline"));
  if (type === "quote" && status === "accepted") actions.push(action("convert", `${icon("copy")}Convert to invoice`, true));
  if (type === "invoice" && ["finalized", "sent", "partially_paid", "overdue"].includes(status)) actions.push(action("payment", `${icon("check")}Record payment`, true));
  if (type === "invoice") actions.push(action("recurring", `${icon("copy")}Make recurring`));
  if (!["void", "voided", "paid", "converted"].includes(status)) actions.push(action("void", `${icon("trash")}Void`));
  return actions.join("");
}
function emailHistoryMarkup() {
  const attempts = state.documentEmailHistory || [];
  if (!attempts.length) return `<p class="panel-sub">No delivery attempts recorded yet.</p>`;
  return `<div class="email-history">${attempts.slice(0, 5).map((attempt) => { const accepted = String(attempt.provider_status || "").startsWith("accepted"); const recipients = (attempt.recipients || []).join(", ") || "No recipient"; return `<div class="email-history-row ${accepted ? "accepted" : "failed"}"><span><strong>${accepted ? "Accepted" : "Not delivered"}</strong><small>${escapeHtml(recipients)} · ${escapeHtml(attempt.provider || "provider")} · ${new Date(attempt.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}</small>${attempt.provider_error ? `<small class="email-error">${escapeHtml(attempt.provider_error)}</small>` : ""}</span>${accepted ? "" : `<button class="link-btn" data-retry-document-email>Retry</button>`}</div>`; }).join("")}</div>`;
}

function renderDocumentEditor() {
  const document = state.document;
  if (!document) return `<div class="page"><div class="loading-state"><span class="spinner"></span><strong>Loading document</strong></div></div>`;
  const data = document.data || {};
  const items = data.items || [];
  const templateOptions = state.templates.map((template) => `<option value="${escapeHtml(template.id || template.key || template.name || "")}" ${(data.template_id === (template.id || template.key)) ? "selected" : ""}>${escapeHtml(template.name || template.title || template.id || "Template")}</option>`).join("");
  const draft = document.status === "draft";
  const template = documentTemplate(document);
  const totals = genericTotals(data);
  const customerQuery = state.documentCustomerQuery.trim().toLowerCase();
  const customerMatches = state.customers.filter((customer) => !customerQuery || `${customer.name} ${customer.email} ${customer.address}`.toLowerCase().includes(customerQuery)).slice(0, 4);
  const productQuery = state.documentProductQuery.trim().toLowerCase();
  const productMatches = state.products.filter((product) => !productQuery || `${product.name} ${product.description}`.toLowerCase().includes(productQuery)).slice(0, 5);
  const paymentOptions = state.paymentMethods.map((method) => `<option value="${escapeHtml(method.id)}" ${data.payment_method_id === method.id ? "selected" : ""}>${escapeHtml(method.name)}</option>`).join("");
  const issueDateLabel = document.document_type === "receipt" ? "Payment date" : "Issue date";
  const endDateField = document.document_type === "receipt" ? simpleInput("Payment reference", "documentReceiptReference", data.payment_reference || data.receipt_for || "", "text", { placeholder: "Bank or transaction reference" }) : simpleInput("Due or expiry date", "documentDueDate", data.due_date || data.expiry_date || "", "date");
  return `<div class="page document-editor">${pageHead(`Documents / ${documentTypeLabel(document.document_type)}`, `${escapeHtml(document.number)}`, "One authoring workflow for invoices, quotes, and receipts.", `${draft ? documentSaveStateMarkup() : ""}${documentActionMarkup(document)}`)}
    <div class="generic-editor-grid"><section class="section-card"><div class="section-head"><div class="section-title"><span class="section-number">1</span><div><h2>Document details</h2><p>Type is fixed after creation to preserve document history.</p></div></div><span class="status ${escapeHtml(document.status)}">${escapeHtml(document.status)}</span></div>
      <div class="field-grid">${simpleInput("Document type", "documentTypeDisplay", documentTypeLabel(document.document_type), "text", { disabled: true })}${simpleInput("Title", "documentTitle", data.document_title || documentTypeLabel(document.document_type), "text", { disabled: !draft })}${simpleInput("Number", "documentNumber", data.number || document.number, "text", { disabled: !draft })}${simpleInput("Currency", "documentCurrency", data.currency || "ZAR", "text", { disabled: !draft })}${simpleInput(issueDateLabel, "documentIssueDate", data.issue_date || "", "date", { disabled: !draft })}${endDateField}</div>${document.document_type === "receipt" ? "" : `<div class="field span-2"><label>Payment terms</label><div class="terms">${[0,7,14,30,60].map((days) => `<button type="button" class="term-chip ${Number(data.terms_days) === days ? "active" : ""}" data-document-terms="${days}" ${draft ? "" : "disabled"}>${days === 0 ? "Due now" : `Net ${days}`}</button>`).join("")}</div></div>`}
      <div class="generic-customer-fields"><div class="section-head"><div><h3>Client</h3><p>Choose a saved client or enter one-off billing details.</p></div>${draft ? `<button class="btn" data-new-customer>${icon("plus")}New client</button>` : ""}</div>${draft ? `<div class="document-quick-picker"><div class="input-wrap">${icon("search")}<input id="documentCustomerSearch" aria-label="Search saved clients" placeholder="Search saved clients by name or email" value="${escapeHtml(state.documentCustomerQuery)}"></div><div class="document-choice-list">${customerMatches.map((customer) => `<button type="button" class="document-choice ${data.customer_id === customer.id ? "active" : ""}" data-select-document-customer="${escapeHtml(customer.id)}"><span class="customer-avatar">${initials(customer.name)}</span><span><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.email || customer.address)}</small></span><em>${escapeHtml(customer.currency || "ZAR")}</em></button>`).join("") || `<span class="document-choice-empty">No saved client matches. Add a client or enter details below.</span>`}</div></div>` : ""}<div class="field-grid">${simpleInput("Company name", "documentCustomerName", data.customer?.name || "", "text")}${simpleInput("Contact name", "documentCustomerContact", data.customer?.contact_name || "", "text", { placeholder: "Accounts payable contact" })}${simpleInput("Email", "documentCustomerEmail", data.customer?.email || "", "email", { placeholder: "accounts@example.com" })}${simpleInput("Phone", "documentCustomerPhone", data.customer?.phone || "", "tel", { placeholder: "+27 21 000 0000" })}${simpleInput("VAT number", "documentCustomerVat", data.customer?.vat_number || "", "text")}${simpleInput("Registration number", "documentCustomerRegistration", data.customer?.registration_number || "", "text")}${simpleInput("Address", "documentCustomerAddress", data.customer?.address || "", "text", { span: "span-2", placeholder: "Street, city, postal code" })}</div></div>
      <div class="presentation-card"><div class="section-head"><div><h3>Template and branding</h3><p>Choose a paper style, page size, and the details that appear on every copy.</p></div><span class="template-selected">${escapeHtml(template.name)}</span></div><div class="template-gallery" role="listbox" aria-label="Document templates">${state.templates.map((item) => `<button type="button" class="template-card ${item.id === template.id ? "active" : ""}" data-select-document-template="${escapeHtml(item.id)}" role="option" aria-selected="${item.id === template.id}"><span class="template-swatch" style="background:${escapeHtml(item.accent)}"></span><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.density || "comfortable")}</small></button>`).join("")}</div><div class="field-grid presentation-controls"><div class="field"><label for="documentTemplate">Template</label><div class="input-wrap"><select id="documentTemplate"><option value="">Default template</option>${templateOptions}</select></div></div>${simpleInput("Accent HEX", "documentAccent", data.accent || template.accent || "#7f56d9", "text", { placeholder: "#7f56d9" })}${simpleInput("Footer", "documentFooter", data.footer || "", "text", { span: "span-2", placeholder: "Thank you for your business." })}${simpleInput("Signature", "documentSignature", data.signature || "", "text", { span: "span-2", placeholder: "Optional authorised signature" })}<div class="field"><label for="documentPageSize">Page size</label><div class="input-wrap"><select id="documentPageSize"><option value="A4" ${(data.page_size || "A4") === "A4" ? "selected" : ""}>A4</option><option value="LETTER" ${data.page_size === "LETTER" ? "selected" : ""}>Letter</option></select></div></div></div></div>
      <div class="generic-lines"><div class="section-head"><div><h3>Items</h3><p>Start from a saved product or enter an item directly.</p></div>${draft ? `<button class="btn" data-add-document-line>${icon("plus")}Add line</button>` : ""}</div>${draft ? `<div class="document-product-picker"><div class="input-wrap">${icon("search")}<input id="documentProductSearch" aria-label="Search saved products" placeholder="Add saved product or service" value="${escapeHtml(state.documentProductQuery)}"></div>${productQuery ? `<div class="document-product-results">${productMatches.map((product) => `<button type="button" data-add-document-product="${escapeHtml(product.id)}"><span><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.description || "Saved product")}</small></span><b>${money(product.unit_price_minor, product.currency)}</b></button>`).join("") || `<span>No saved product matches.</span>`}</div>` : ""}</div>` : ""}<div class="document-line-head" aria-hidden="true"><span>Description</span><span>Qty</span><span>Unit price</span><span>Tax</span><span>Discount</span><span>Total</span><span></span></div>${items.map((item, index) => `<div class="document-line" data-document-row="${index}"><input aria-label="Description for line ${index + 1}" data-document-line="description" data-document-index="${index}" value="${escapeHtml(item.description || "")}" placeholder="Description" ${draft ? "" : "disabled"}><input aria-label="Quantity for line ${index + 1}" data-document-line="quantity" data-document-index="${index}" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity ?? 1)}" ${draft ? "" : "disabled"}><input aria-label="Unit price for line ${index + 1}" data-document-line="unit_price" data-document-index="${index}" type="number" min="0" step="0.01" value="${escapeHtml(((item.unit_price_minor || 0) / 100).toFixed(2))}" ${draft ? "" : "disabled"}><input aria-label="Tax percent for line ${index + 1}" data-document-line="tax_bps" data-document-index="${index}" type="number" min="0" max="100" step="0.01" value="${escapeHtml(((item.tax_bps || 0) / 100).toFixed(2))}" ${draft ? "" : "disabled"}><input aria-label="Discount percent for line ${index + 1}" data-document-line="discount_bps" data-document-index="${index}" type="number" min="0" max="100" step="0.01" value="${escapeHtml(((item.discount_bps || 0) / 100).toFixed(2))}" ${draft ? "" : "disabled"}><div class="document-line-total">${money(genericTotals({ items: [item] }).total, data.currency)}</div>${draft ? `<div class="document-line-actions"><button class="icon-btn" data-move-document-line="${index}:up" aria-label="Move line ${index + 1} up">${icon("chevron")}</button><button class="icon-btn" data-move-document-line="${index}:down" aria-label="Move line ${index + 1} down">${icon("chevron")}</button><button class="icon-btn" data-remove-document-line="${index}" aria-label="Remove line ${index + 1}">${icon("trash")}</button></div>` : ""}</div>`).join("") || `<p class="panel-sub">No line items yet.</p>`}</div>
      <details class="options document-options" ${data.notes || data.payment_details || data.document_discount_bps || data.attachments?.length ? "open" : ""}><summary>Payment, terms and notes <span>Optional document details</span></summary><div class="options-body"><div class="field-grid"><div class="field"><label for="documentPaymentMethod">Payment method</label><div class="input-wrap"><select id="documentPaymentMethod" ${draft ? "" : "disabled"}><option value="">Manual instructions</option>${paymentOptions}</select></div></div>${simpleInput("Payment instructions", "documentPaymentDetails", data.payment_details || "", "text", { placeholder: "Reference and bank/payment instructions" })}${simpleInput("Document discount", "documentDiscount", ((data.document_discount_bps || 0) / 100).toFixed(2), "number", { min: 0, step: 0.01, suffix: "%" })}${simpleInput("Shipping or additional charge", "documentShipping", ((data.shipping_minor || 0) / 100).toFixed(2), "number", { min: 0, step: 0.01 })}${simpleInput("Purchase order / reference", "documentPoNumber", data.po_number || "", "text", { placeholder: "Optional client reference", span: "span-2" })}<div class="field span-2"><label for="documentNotes">Notes and terms</label><div class="input-wrap textarea-wrap"><textarea id="documentNotes" rows="4" placeholder="Payment terms, scope notes, or a thank-you message" ${draft ? "" : "disabled"}>${escapeHtml(data.notes || "")}</textarea></div></div>${documentAttachmentsMarkup(document, draft)}</div></div></details>
      ${draft ? `<div class="modal-actions"><button class="btn primary" data-save-document>${icon("check")}Save document</button></div>` : ""}</section>
      <aside class="document-side"><section class="generic-preview-panel"><div class="preview-panel-head"><div><span>Live preview</span><strong>${escapeHtml(template.name)}</strong></div><button class="icon-btn" data-open-document-preview aria-label="Open document preview">${icon("file")}</button></div><div class="generic-paper-wrap" id="genericDocumentPaper">${genericPaperMarkup(document)}</div></section><section class="panel document-totals-card"><h2>Totals</h2><div class="document-total"><span>Subtotal</span><strong>${money(totals.subtotal, data.currency)}</strong></div><div class="document-total"><span>Line discounts</span><strong>-${money(totals.lineDiscount, data.currency)}</strong></div>${totals.documentDiscount ? `<div class="document-total"><span>Document discount</span><strong>-${money(totals.documentDiscount, data.currency)}</strong></div>` : ""}${totals.taxBreakdown.filter((tax) => tax.tax_bps || tax.tax).map((tax) => `<div class="document-total"><span>Tax ${tax.tax_bps / 100}%</span><strong>${money(tax.tax, data.currency)}</strong></div>`).join("")}${totals.shipping ? `<div class="document-total"><span>Shipping</span><strong>${money(totals.shipping, data.currency)}</strong></div>` : ""}<div class="document-total grand"><span>Grand total</span><strong data-generic-total>${money(totals.total, data.currency)}</strong></div>${document.document_type === "invoice" ? `<div class="document-total"><span>Paid</span><strong>${money(document.amount_paid_minor || 0, data.currency)}</strong></div><div class="document-total balance"><span>Balance due</span><strong>${money(document.balance_due_minor ?? documentTotal(document), data.currency)}</strong></div>` : ""}</section><section class="panel"><h2>Delivery</h2><p class="panel-sub">Generated PDFs are attached to sends. Provider acceptance and failures are retained in document history.</p>${emailHistoryMarkup()}<button class="btn" style="width:100%;margin-top:12px" data-document-pdf>${icon("download")}Download PDF</button></section></aside>
    </div></div>`;
}

function renderQuickCreate() {
  const parsed = state.quickParsed;
  const parsedType = parsed?.document_type || parsed?.data?.document_type || "invoice";
  return `<div class="page quick-create-page">${pageHead("Workspace", "Quick create", "Describe the document in plain language, review the parsed result, then create it.")}
    <div class="split-grid"><section class="panel"><h2>Describe the document</h2><p class="panel-sub">Include the document type, customer, dates, line items and amounts.</p><textarea id="quickText" class="quick-text" placeholder="Quote for Acme: 3 design sessions at R1,250 each, valid for 14 days.">${escapeHtml(state.quickText)}</textarea><div class="modal-actions"><button class="btn primary" data-parse-quick>${icon("search")}Parse details</button></div></section>
    <section class="panel quick-review"><h2>Review before creating</h2>${parsed ? `<div class="quick-result"><span class="status draft">${documentTypeLabel(parsedType)}</span><dl><div><dt>Title</dt><dd>${escapeHtml(parsed.document_title || parsed.data?.document_title || documentTypeLabel(parsedType))}</dd></div><div><dt>Customer</dt><dd>${escapeHtml(parsed.customer?.name || parsed.data?.customer?.name || "Not detected")}</dd></div><div><dt>Items</dt><dd>${(parsed.items || parsed.data?.items || []).length}</dd></div></dl><div class="field"><label for="quickType">Document type</label><div class="input-wrap"><select id="quickType">${["invoice", "quote", "receipt"].map((type) => `<option value="${type}" ${parsedType === type ? "selected" : ""}>${documentTypeLabel(type)}</option>`).join("")}</select></div></div><div class="field"><label for="quickTemplate">Template</label><div class="input-wrap"><select id="quickTemplate"><option value="">Default template</option>${state.templates.map((template) => `<option value="${escapeHtml(template.id || template.key || "")}">${escapeHtml(template.name || template.title || template.id || "Template")}</option>`).join("")}</select></div></div><div class="modal-actions"><button class="btn primary" data-create-quick>${icon("plus")}Create ${documentTypeLabel(parsedType).toLowerCase()}</button></div></div>` : `<p class="panel-sub">Parsed details will appear here for a final review.</p>`}</section></div></div>`;
}

function renderSettings() {
  const profile = state.profile || {};
  const selectedPurpose = state.settingsEmailPurpose || state.emailTemplates[0]?.purpose || "";
  const selectedTemplate = state.emailTemplates.find((template) => template.purpose === selectedPurpose) || {};
  const templateOptions = state.templates.map((template) => `<option value="${escapeHtml(template.id || "")}">${escapeHtml(template.name || template.id || "Template")}</option>`).join("");
  return `<div class="page settings-page">${pageHead("System", "Business settings", "Set the identity and payment details used by new documents.")}
    <div class="settings-grid"><section class="panel settings-panel"><div class="settings-panel-head"><div><h2>Business profile</h2><p class="panel-sub">Applied to every newly created document.</p></div><span class="settings-kicker">Identity</span></div><div class="field-grid">${simpleInput("Business name", "profileName", profile.name || profile.business_name || "", "text")}${simpleInput("Email", "profileEmail", profile.email || "", "email")}${simpleInput("VAT number", "profileVat", profile.vat_number || "", "text")}${simpleInput("Default currency", "profileCurrency", profile.default_currency || "ZAR", "text")}${simpleInput("Logo URL", "profileLogoUrl", profile.logo_url || "", "url", { span: "span-2", placeholder: "https://example.com/logo.png" })}${simpleInput("Address", "profileAddress", profile.address || "", "text", { span: "span-2" })}</div><div class="logo-upload"><div><label for="profileLogoFile">Logo file</label><small>PNG, JPG, WebP, or safe SVG. Maximum 2 MB.</small><input id="profileLogoFile" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"></div><button class="btn" data-upload-logo>${icon("plus")}Upload logo</button>${profile.logo_url ? `<img src="${escapeHtml(profile.logo_url)}" alt="Current business logo" class="profile-logo-preview"><button class="icon-btn" data-remove-logo aria-label="Remove business logo">${icon("trash")}</button>` : ""}</div><div class="modal-actions"><button class="btn primary" data-save-profile>${icon("check")}Save profile</button></div></section>
    <section class="panel"><h2>Payment methods</h2><p class="panel-sub">Visible payment instructions are attached to new documents.</p><div class="payment-method-list">${state.paymentMethods.length ? state.paymentMethods.map((method) => `<div class="payment-method"><span><strong>${escapeHtml(method.name || method.label || method.type || "Payment method")}${method.is_default ? ` <em>Default</em>` : ""}</strong><small>${escapeHtml(method.details?.instructions || method.account_name || method.masked_details || "")}</small></span>${method.is_default ? "" : `<button class="link-btn" data-set-default-payment="${escapeHtml(method.id)}">Set default</button>`}</div>`).join("") : `<p class="panel-sub">No payment methods configured.</p>`}</div><div class="field-grid payment-form">${simpleInput("Method name", "paymentMethodName", "", "text", { placeholder: "Bank transfer" })}${simpleInput("Method type", "paymentMethodType", "bank_transfer", "text")}${simpleInput("Payment details", "paymentMethodDetails", "", "text", { span: "span-2", placeholder: "Account name and reference instructions" })}<label class="checkbox-field span-2"><input id="paymentMethodDefault" type="checkbox" ${state.paymentMethods.length ? "" : "checked"}>Make this the default for new documents</label></div><div class="modal-actions"><button class="btn" data-add-payment-method>${icon("plus")}Add payment method</button></div></section>
    <section class="panel settings-panel"><div class="settings-panel-head"><div><h2>Brand presets</h2><p class="panel-sub">Save a reusable template, accent, and footer combination.</p></div><span class="settings-kicker">Presentation</span></div><div class="preset-list">${state.brandingPresets.map((preset) => `<div><strong>${escapeHtml(preset.name)}</strong><small><i style="background:${escapeHtml(preset.accent || "#7f56d9")}"></i>${escapeHtml(preset.template_id || "classic")}</small></div>`).join("") || `<p class="panel-sub">No saved presets yet.</p>`}</div><div class="field-grid">${simpleInput("Preset name", "brandingPresetName", "", "text", { placeholder: "Client-facing" })}<div class="field"><label for="brandingPresetTemplate">Paper template</label><div class="input-wrap"><select id="brandingPresetTemplate">${templateOptions}</select></div></div>${simpleInput("Accent HEX", "brandingPresetAccent", "#7f56d9", "text")}${simpleInput("Footer", "brandingPresetFooter", "", "text", { placeholder: "Thank you for your business." })}</div><div class="modal-actions"><button class="btn" data-save-branding>${icon("plus")}Save brand preset</button></div></section>
    <section class="panel settings-panel"><div class="settings-panel-head"><div><h2>Document numbering</h2><p class="panel-sub">Prefixes are independent for invoices, quotes, and receipts.</p></div><span class="settings-kicker">Controls</span></div><div class="field-grid prefix-grid">${simpleInput("Invoice prefix", "prefixInvoice", state.numberPrefixes.invoice || "INV", "text")}${simpleInput("Quote prefix", "prefixQuote", state.numberPrefixes.quote || "QUO", "text")}${simpleInput("Receipt prefix", "prefixReceipt", state.numberPrefixes.receipt || "REC", "text")}</div><div class="modal-actions"><button class="btn" data-save-prefixes>${icon("check")}Save numbering</button></div></section>
    <section class="panel settings-email settings-panel"><div class="settings-panel-head"><div><h2>Email templates</h2><p class="panel-sub">Templates produce the default subject and message for mock delivery.</p></div><span class="settings-kicker">Delivery</span></div>${state.emailTemplates.length ? `<div class="field"><label for="emailTemplatePurpose">Message type</label><div class="input-wrap"><select id="emailTemplatePurpose">${state.emailTemplates.map((template) => `<option value="${escapeHtml(template.purpose)}" ${template.purpose === selectedPurpose ? "selected" : ""}>${escapeHtml(template.purpose.replaceAll("_", " "))}</option>`).join("")}</select></div></div>${simpleInput("Subject", "emailTemplateSubject", selectedTemplate.subject || "", "text")}<div class="field"><label for="emailTemplateText">Plain text body</label><div class="input-wrap textarea-wrap"><textarea id="emailTemplateText" rows="6">${escapeHtml(selectedTemplate.text || selectedTemplate.body || "")}</textarea></div></div><div class="modal-actions"><button class="btn" data-save-email-template>${icon("check")}Save email template</button></div>` : `<p class="panel-sub">No templates returned yet.</p>`}</section></div></div>`;
}
function renderGeneric(title) { return `<div class="page">${pageHead("Forma",title,"This workspace uses the same durable local ledger as the invoice workflow.")}<section class="panel"><h2>${title} workspace</h2><p class="panel-sub">Configuration is stored locally. Invoice generation, customers, products, lifecycle actions and PDFs are fully active.</p></section></div>`; }

function render() {
  renderNav();
  const views = { invoices: renderInvoices, documents: renderDocuments, recurring: renderRecurring, reminders: renderReminders, "document-editor": renderDocumentEditor, "quick-create": renderQuickCreate, dashboard: renderDashboard, customers: () => renderDirectory("customers"), products: () => renderDirectory("products"), reports: renderReports, settings: renderSettings };
  $("#content").innerHTML = (views[state.route] || renderDashboard)();
  bindPage();
}

function setPath(target, path, value) {
  const parts = path.split("."); let object = target;
  parts.slice(0, -1).forEach((part) => { object[part] ||= {}; object = object[part]; });
  object[parts.at(-1)] = value;
}
function updatePreview() {
  if (!state.current || state.route !== "invoice") return;
  const totals = localTotals();
  const paper = $("#paper"); if (paper) paper.innerHTML = paperMarkup(state.current.data, totals);
  $("#mobileTotal") && ($("#mobileTotal").textContent = money(totals.total_minor));
  const editorValues = { subtotal: totals.subtotal_minor, discount: totals.discount_minor, tax: totals.tax_minor, shipping: totals.shipping_minor, balance: totals.total_minor };
  $$('[data-editor-total]').forEach((node) => { const key = node.dataset.editorTotal; node.textContent = `${key === "discount" ? "-" : ""}${money(editorValues[key])}`; });
  const checks = clientReadyChecks(); const box = $(".readiness"); if (box) box.innerHTML = readinessMarkup(checks, checks.filter((item) => item.complete).length);
  $$('[data-line-total]').forEach((node) => { const item = state.current.data.items[Number(node.dataset.lineTotal)]; if (item) node.textContent = money(lineMath(item).total); });
}
function scheduleSave(immediate = false) {
  if (!state.current || state.current.status !== "draft") return;
  state.editRevision += 1;
  clearTimeout(state.saveTimer); state.saving = true; state.saveError = false; patchSaveState();
  state.saveTimer = setTimeout(saveDraft, immediate ? 0 : 650);
}
async function saveDraft() {
  if (!state.current || state.current.status !== "draft") return state.current;
  clearTimeout(state.saveTimer);
  if (state.savePromise) return state.savePromise;
  state.savePromise = (async () => {
    try {
      do {
        const invoiceId = state.current.id;
        const revision = state.editRevision;
        const data = structuredClone(state.current.data);
        state.saving = true; state.saveError = false; patchSaveState();
        const saved = await api(`/api/invoices/${invoiceId}`, { method: "PUT", body: JSON.stringify(data) });
        if (state.current?.id !== invoiceId) break;
        state.savedRevision = revision;
        state.current = state.editRevision === revision ? saved : { ...saved, data: state.current.data };
      } while (state.savedRevision < state.editRevision);
      state.saving = false; state.saveError = false; patchSaveState(); await refreshLists();
      return state.current;
    } catch (error) {
      state.saving = false; state.saveError = true; patchSaveState(); toast(`Draft not saved: ${error.message}`, "error"); return null;
    } finally { state.savePromise = null; }
  })();
  return state.savePromise;
}
function patchSaveState() { const current = $(".save-state"); if (current) current.outerHTML = saveStateMarkup(); }

async function refreshDocuments() { state.documents = await api("/api/documents"); }
async function refreshRecurringSchedules() { state.recurringSchedules = await api("/api/recurring-schedules"); }
async function refreshReminders() { const [rules, due] = await Promise.all([api("/api/reminders/rules"), api("/api/reminders/due")]); state.reminderRules = rules || []; state.dueReminders = due || []; }
async function loadDocumentEmailHistory(id = state.document?.id) { state.documentEmailHistory = id ? await api(`/api/documents/${id}/email-history`) : []; }
async function loadDocumentSupport() {
  const [templates, profile, paymentMethods, emailTemplates, brandingPresets, numberPrefixes] = await Promise.all([api("/api/templates"), api("/api/business-profile"), api("/api/payment-methods"), api("/api/email-templates"), api("/api/branding-presets"), api("/api/number-prefixes")]);
  state.templates = templates || []; state.profile = profile || {}; state.paymentMethods = paymentMethods || []; state.emailTemplates = emailTemplates || []; state.brandingPresets = brandingPresets || []; state.numberPrefixes = numberPrefixes || {};
}
async function openDocument(id) {
  try { if (state.document?.status === "draft") await saveDocument({ quiet: true }); state.document = await api(`/api/documents/${id}`); state.documentEditRevision = 0; state.documentSavedRevision = 0; state.documentSaveError = false; await Promise.all([loadDocumentSupport(), loadDocumentEmailHistory(id)]); setRoute("document-editor"); }
  catch (error) { toast(error.message, "error"); }
}
function defaultDocumentData(type) {
  const today = new Date().toISOString().slice(0, 10);
  const termsDays = Number(state.profile.default_terms_days || 30);
  const due = new Date(`${today}T12:00:00`); due.setDate(due.getDate() + termsDays);
  const defaultPayment = state.paymentMethods.find((method) => method.is_default) || state.paymentMethods[0];
  return { document_type: type, document_title: type === "quote" ? "Quote" : type === "receipt" ? "Receipt" : "Tax Invoice", currency: state.profile.default_currency || "ZAR", issue_date: today, due_date: type === "receipt" ? today : due.toISOString().slice(0, 10), terms_days: type === "receipt" ? 0 : termsDays, supplier: { name: state.profile.name || state.profile.business_name || "", address: state.profile.address || "", vat_number: state.profile.vat_number || "", logo_url: state.profile.logo_url || "" }, customer: {}, payment_method_id: defaultPayment?.id || null, payment_method: defaultPayment?.name || "Bank transfer", payment_details: defaultPayment?.details?.instructions || "", items: [{ description: "", quantity: 1, unit_price_minor: 0, tax_bps: type === "receipt" ? 0 : 1500, discount_bps: 0 }] };
}
function openNewDocumentModal() {
  $("#modalContent").innerHTML = `<h2>New document</h2><p class="lead">Choose the document type before assigning a number and lifecycle.</p><div class="field"><label for="newDocumentType">Document type</label><div class="input-wrap"><select id="newDocumentType"><option value="invoice">Invoice</option><option value="quote">Quote</option><option value="receipt">Receipt</option></select></div></div><div class="field"><label for="newDocumentTemplate">Template</label><div class="input-wrap"><select id="newDocumentTemplate"><option value="">Default template</option>${state.templates.map((template) => `<option value="${escapeHtml(template.id || template.key || "")}">${escapeHtml(template.name || template.title || template.id || "Template")}</option>`).join("")}</select></div></div><div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" type="button" id="confirmNewDocument">Create document</button></div>`;
  $("#modal").showModal(); $("#confirmNewDocument").onclick = () => createDocument($("#newDocumentType").value, $("#newDocumentTemplate").value);
}
async function createDocument(type, templateId = "") {
  try {
    if (state.document?.status === "draft") await saveDocument({ quiet: true });
    const data = defaultDocumentData(type); if (templateId) data.template_id = templateId;
    state.document = await api("/api/documents", { method: "POST", body: JSON.stringify(data) });
    state.documentEditRevision = 0; state.documentSavedRevision = 0; state.documentSaveError = false;
    $("#modal").open && $("#modal").close(); await refreshDocuments(); setRoute("document-editor"); toast(`${documentTypeLabel(type)} created`);
    return state.document;
  } catch (error) { toast(error.message, "error"); }
}
async function duplicateDocument(id) {
  try {
    state.document = await api(`/api/invoices/${id}/duplicate`, { method: "POST", body: "{}" });
    state.documentEditRevision = 0; state.documentSavedRevision = 0; state.documentSaveError = false;
    await Promise.all([refreshDocuments(), refreshLists(), loadDocumentEmailHistory(state.document.id)]);
    setRoute("document-editor"); toast("Invoice duplicated as a new draft");
  } catch (error) { toast(`Invoice not duplicated: ${error.message}`, "error"); }
}
function readDocumentForm() {
  if (!state.document) return;
  const data = state.document.data ||= {};
  data.document_title = $("#documentTitle")?.value.trim() || data.document_title;
  data.number = $("#documentNumber")?.value.trim() || data.number;
  data.currency = $("#documentCurrency")?.value.trim().toUpperCase() || data.currency;
  data.issue_date = $("#documentIssueDate")?.value || data.issue_date;
  data.due_date = $("#documentDueDate")?.value || data.due_date;
  if (state.document?.document_type === "receipt") { data.payment_reference = $("#documentReceiptReference")?.value.trim() || ""; data.receipt_for = data.payment_reference; }
  data.template_id = $("#documentTemplate")?.value || undefined;
  data.accent = $("#documentAccent")?.value.trim() || data.accent;
  data.footer = $("#documentFooter")?.value.trim() || "";
  data.signature = $("#documentSignature")?.value.trim() || "";
  data.page_size = $("#documentPageSize")?.value || "A4";
  data.payment_method_id = $("#documentPaymentMethod")?.value || null;
  const selectedPayment = state.paymentMethods.find((method) => method.id === data.payment_method_id);
  data.payment_method = selectedPayment?.name || data.payment_method || "Bank transfer";
  data.payment_details = $("#documentPaymentDetails")?.value.trim() || "";
  if (selectedPayment && !data.payment_details) data.payment_details = selectedPayment.details?.instructions || "";
  data.document_discount_bps = Math.round((Number($("#documentDiscount")?.value) || 0) * 100);
  data.shipping_minor = Math.round((Number($("#documentShipping")?.value) || 0) * 100);
  data.po_number = $("#documentPoNumber")?.value.trim() || "";
  data.notes = $("#documentNotes")?.value.trim() || "";
  data.customer ||= {};
  data.customer.name = $("#documentCustomerName")?.value.trim() || "";
  data.customer.contact_name = $("#documentCustomerContact")?.value.trim() || "";
  data.customer.email = $("#documentCustomerEmail")?.value.trim() || "";
  data.customer.phone = $("#documentCustomerPhone")?.value.trim() || "";
  data.customer.vat_number = $("#documentCustomerVat")?.value.trim() || "";
  data.customer.registration_number = $("#documentCustomerRegistration")?.value.trim() || "";
  data.customer.address = $("#documentCustomerAddress")?.value.trim() || "";
}
function updateDocumentPreview() {
  if (!state.document || state.route !== "document-editor") return;
  readDocumentForm();
  const paper = $("#genericDocumentPaper");
  if (paper) paper.innerHTML = genericPaperMarkup(state.document);
  const total = $("[data-generic-total]");
  if (total) total.textContent = money(genericTotals(state.document.data).total, state.document.data.currency);
}
function documentSaveStateMarkup() {
  if (state.documentSaveError) return `<span class="save-state error" data-document-save-state>Could not save</span>`;
  if (state.documentSaving) return `<span class="save-state saving" data-document-save-state><i></i>Saving...</span>`;
  return `<span class="save-state" data-document-save-state><i></i>Saved ${state.document ? new Date(state.document.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""}</span>`;
}
function patchDocumentSaveState() { const current = $("[data-document-save-state]"); if (current) current.outerHTML = documentSaveStateMarkup(); }
function scheduleDocumentSave(immediate = false) {
  if (!state.document || state.document.status !== "draft") return;
  state.documentEditRevision += 1; state.documentSaving = true; state.documentSaveError = false;
  clearTimeout(state.documentSaveTimer); patchDocumentSaveState();
  state.documentSaveTimer = setTimeout(() => saveDocument({ quiet: true }), immediate ? 0 : 650);
}
async function saveDocument({ quiet = false } = {}) {
  if (!state.document || state.document.status !== "draft") return state.document;
  clearTimeout(state.documentSaveTimer);
  if (state.documentSavePromise) return state.documentSavePromise;
  state.documentSavePromise = (async () => {
    try {
      do {
        readDocumentForm();
        const documentId = state.document.id; const revision = state.documentEditRevision; const data = structuredClone(state.document.data);
        state.documentSaving = true; state.documentSaveError = false; patchDocumentSaveState();
        const saved = await api(`/api/documents/${documentId}`, { method: "PUT", body: JSON.stringify(data) });
        if (state.document?.id !== documentId) break;
        state.documentSavedRevision = revision;
        state.document = state.documentEditRevision === revision ? saved : { ...saved, data: state.document.data };
      } while (state.documentSavedRevision < state.documentEditRevision);
      state.documentSaving = false; state.documentSaveError = false; patchDocumentSaveState(); await Promise.all([refreshDocuments(), refreshLists()]);
      if (!quiet) { render(); toast("Document saved"); }
      return state.document;
    } catch (error) {
      state.documentSaving = false; state.documentSaveError = true; patchDocumentSaveState(); toast(`Document not saved: ${error.message}`, "error"); return null;
    } finally { state.documentSavePromise = null; }
  })();
  return state.documentSavePromise;
}
async function uploadDocumentAttachment() {
  const file = $("#documentAttachmentFile")?.files?.[0];
  if (!file || !state.document) return toast("Choose an attachment first", "error");
  try {
    if (state.document.status === "draft") await saveDocument({ quiet: true });
    const response = await fetch(`/api/documents/${state.document.id}/attachments`, { method: "POST", headers: { "Content-Type": file.type, "X-File-Name": file.name }, body: file });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `Attachment upload failed (${response.status})`);
    state.document = payload.data.document; render(); toast("Attachment uploaded");
  } catch (error) { toast(error.message, "error"); }
}
async function removeDocumentAttachment(assetId) {
  if (!state.document) return;
  try { state.document = await api(`/api/documents/${state.document.id}/attachments/${assetId}`, { method: "DELETE" }); render(); toast("Attachment removed"); }
  catch (error) { toast(`Attachment was not removed: ${error.message}`, "error"); }
}
async function uploadInvoiceAttachment() {
  const file = $("#invoiceAttachmentFile")?.files?.[0];
  if (!file || !state.current) return toast("Choose an attachment first", "error");
  try {
    const response = await fetch(`/api/documents/${state.current.id}/attachments`, { method: "POST", headers: { "Content-Type": file.type, "X-File-Name": file.name }, body: file });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `Attachment upload failed (${response.status})`);
    state.current = payload.data.document; await refreshLists(); render(); toast("Attachment uploaded");
  } catch (error) { toast(error.message, "error"); }
}
async function removeInvoiceAttachment(assetId) {
  if (!state.current) return;
  try { state.current = await api(`/api/documents/${state.current.id}/attachments/${assetId}`, { method: "DELETE" }); await refreshLists(); render(); toast("Attachment removed"); }
  catch (error) { toast(`Attachment was not removed: ${error.message}`, "error"); }
}
function addDocumentLine() { state.document?.data?.items?.push({ description: "", quantity: 1, unit_price_minor: 0, tax_bps: state.document?.document_type === "receipt" ? 0 : 1500, discount_bps: 0 }); render(); scheduleDocumentSave(); setTimeout(() => $$('[data-document-line="description"]').at(-1)?.focus(), 0); }
function selectDocumentCustomer(id) { const customer = state.customers.find((item) => item.id === id); if (!customer || !state.document) return; const termsDays = Number(customer.terms_days || 30); const issue = new Date(`${state.document.data.issue_date || new Date().toISOString().slice(0, 10)}T12:00:00`); issue.setDate(issue.getDate() + termsDays); state.document.data.customer_id = customer.id; state.document.data.customer = { ...customer }; state.document.data.currency = customer.currency || state.document.data.currency; state.document.data.terms_days = termsDays; state.document.data.due_date = issue.toISOString().slice(0, 10); state.documentCustomerQuery = ""; render(); scheduleDocumentSave(); toast(`${customer.name} selected`); }
function addDocumentProduct(id) { const product = state.products.find((item) => item.id === id); if (!product || !state.document) return; const line = { product_id: product.id, description: product.name, detail: product.description, quantity: 1, unit_price_minor: product.unit_price_minor, tax_bps: product.tax_bps, discount_bps: 0 }; const items = state.document.data.items ||= []; const first = items[0]; if (items.length === 1 && first && !first.product_id && !String(first.description || "").trim() && Number(first.quantity) === 1 && !Number(first.unit_price_minor)) items[0] = line; else items.push(line); state.documentProductQuery = ""; render(); scheduleDocumentSave(); toast("Saved product added"); }
function updateDocumentLine(input) { const item = state.document?.data?.items?.[Number(input.dataset.documentIndex)]; if (!item) return; const key = input.dataset.documentLine; if (key === "unit_price") item.unit_price_minor = Math.round((Number(input.value) || 0) * 100); else if (key === "quantity") item.quantity = Number(input.value) || 1; else if (key === "tax_bps" || key === "discount_bps") item[key] = Math.round((Number(input.value) || 0) * 100); else item[key] = input.value; updateDocumentPreview(); scheduleDocumentSave(); }
async function parseQuickCreate() {
  const text = $("#quickText")?.value.trim(); if (!text) return toast("Describe the document first", "error");
  try { state.quickText = text; state.quickParsed = await api("/api/quick-create/parse", { method: "POST", body: JSON.stringify({ text }) }); render(); }
  catch (error) { toast(`Could not parse details: ${error.message}`, "error"); }
}
async function createQuickDocument() {
  if (!state.quickParsed) return;
  try {
    const parsed = structuredClone(state.quickParsed.data || state.quickParsed);
    const type = $("#quickType")?.value || parsed.document_type || "invoice";
    const templateId = $("#quickTemplate")?.value;
    const issueDate = new Date().toISOString().slice(0, 10);
    if (parsed.tax_bps && Array.isArray(parsed.items)) parsed.items = parsed.items.map((item) => ({ ...item, tax_bps: item.tax_bps ?? parsed.tax_bps, discount_bps: item.discount_bps ?? parsed.discount_bps ?? 0 }));
    if (parsed.due_in_days && !parsed.due_date) { const due = new Date(`${issueDate}T12:00:00`); due.setDate(due.getDate() + Number(parsed.due_in_days)); parsed.due_date = due.toISOString().slice(0, 10); }
    if (!parsed.issue_date) parsed.issue_date = issueDate;
    delete parsed.document_type; delete parsed.confidence; delete parsed.warnings; delete parsed.unparsed_segments; delete parsed.currency_defaulted; delete parsed.due_in_days; delete parsed.tax_bps; delete parsed.discount_bps;
    parsed.document_type = type; if (templateId) parsed.template_id = templateId;
    state.document = await api("/api/documents", { method: "POST", body: JSON.stringify(parsed) });
    state.quickParsed = null; state.quickText = ""; await refreshDocuments(); setRoute("document-editor"); toast(`${documentTypeLabel(type)} created from quick create`);
  } catch (error) { toast(`Could not create document: ${error.message}`, "error"); }
}
function emailTemplateFor(purpose) { return state.emailTemplates.find((template) => template.purpose === purpose) || state.emailTemplates[0] || {}; }
async function openEmailCompose() {
  const document = state.document; if (!document) return;
  try {
    const draft = await api(`/api/documents/${document.id}/email-drafts`, { method: "POST", body: JSON.stringify({ purpose: `${document.document_type}_send` }) });
    $("#modalContent").innerHTML = `<h2>Compose document email</h2><p class="lead">The selected template is rendered as a PDF attachment. The document is marked sent only after the configured provider accepts it.</p><div class="field-grid">${simpleInput("To", "emailTo", document.data?.customer?.email || "", "email")}${simpleInput("CC", "emailCc", "", "email")}${simpleInput("BCC", "emailBcc", "", "email")}${simpleInput("Subject", "emailSubject", draft.subject || `${documentTypeLabel(document.document_type)} ${document.number}`, "text")}</div><div class="field"><label for="emailBody">Message</label><div class="input-wrap textarea-wrap"><textarea id="emailBody">${escapeHtml(draft.text || `Please find ${documentTypeLabel(document.document_type).toLowerCase()} ${document.number} attached.`)}</textarea></div></div><div class="email-compose-note">PDF attachment: generated from the selected ${escapeHtml(documentTemplate(document).name)} template.</div><div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" type="button" id="sendDocumentEmail">${icon("send")}Send document</button></div>`;
    $("#modal").showModal(); $("#sendDocumentEmail").onclick = sendDocumentEmail;
  } catch (error) { toast(`Email draft could not be prepared: ${error.message}`, "error"); }
}
async function sendDocumentEmail() {
  try {
    const to = $("#emailTo").value.trim(); const cc = $("#emailCc").value.trim(); const bcc = $("#emailBcc").value.trim();
    const payload = { to, cc, bcc, subject: $("#emailSubject").value.trim(), body: $("#emailBody").value.trim(), request_key: crypto.randomUUID() };
    const draft = await api(`/api/documents/${state.document.id}/email-drafts`, { method: "POST", body: JSON.stringify(payload) });
    const attempt = await api(`/api/documents/${state.document.id}/send`, { method: "POST", body: JSON.stringify({ ...payload, email_draft_id: draft?.id }) });
    state.document = await api(`/api/documents/${state.document.id}`); $("#modal").close(); await Promise.all([refreshDocuments(), refreshReminders(), loadDocumentEmailHistory(state.document.id)]); render(); toast(attempt.provider_status.startsWith("accepted") ? "Delivery accepted and recorded" : `Delivery failed: ${attempt.provider_error || attempt.provider_status}`, attempt.provider_status.startsWith("accepted") ? "" : "error");
  } catch (error) { toast(`Email not sent: ${error.message}`, "error"); }
}
function openPaymentDialog() {
  const balance = state.document?.balance_due_minor ?? documentTotal(state.document);
  $("#modalContent").innerHTML = `<h2>Record payment</h2><p class="lead">A receipt is created automatically with this payment.</p><div class="field-grid">${simpleInput("Amount", "paymentAmount", (balance / 100).toFixed(2), "number", { min: 0.01, step: 0.01 })}${simpleInput("Method", "paymentMethod", state.paymentMethods[0]?.name || state.paymentMethods[0]?.label || "Bank transfer", "text")}${simpleInput("Reference", "paymentReference", "", "text")}${simpleInput("Received date", "paymentReceivedDate", new Date().toISOString().slice(0, 10), "date")}</div><div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" type="button" id="confirmPayment">Record payment</button></div>`;
  $("#modal").showModal(); $("#confirmPayment").onclick = recordPayment;
}
async function recordPayment() {
  try {
    const result = await api(`/api/documents/${state.document.id}/record-payment`, { method: "POST", body: JSON.stringify({ amount_minor: Math.round((Number($("#paymentAmount").value) || 0) * 100), method: $("#paymentMethod").value.trim(), reference: $("#paymentReference").value.trim(), received_date: $("#paymentReceivedDate").value, create_receipt: true }) });
    state.document = result.invoice || await api(`/api/documents/${state.document.id}`); $("#modal").close(); await Promise.all([refreshDocuments(), refreshReminders()]); render(); toast(result.receipt ? "Payment and receipt recorded" : "Payment recorded");
  } catch (error) { toast(`Payment not recorded: ${error.message}`, "error"); }
}
async function runDocumentAction(action) {
  if (!state.document) return;
  if (state.document.status === "draft") {
    await saveDocument({ quiet: true });
    if (state.documentSaveError) return;
  }
  if (action === "email") return openEmailCompose();
  if (action === "payment") return openPaymentDialog();
  if (action === "recurring") return openRecurringScheduleModal(state.document.id);
  try {
    const response = await api(`/api/documents/${state.document.id}/${action === "convert" ? "convert-to-invoice" : action}`, { method: "POST", body: "{}" });
    state.document = action === "convert" ? response : await api(`/api/documents/${state.document.id}`);
    await Promise.all([refreshDocuments(), refreshReminders()]);
    if (action === "convert") { setRoute("document-editor"); toast("Quote converted to invoice"); return; }
    render(); toast(`${documentTypeLabel(state.document.document_type)} ${action}ed`);
  } catch (error) { toast(`${documentTypeLabel(state.document.document_type)} could not be ${action}ed: ${error.message}`, "error"); }
}
function openRecurringScheduleModal(sourceDocumentId = "", scheduleId = "") {
  const schedule = scheduleId ? state.recurringSchedules.find((item) => item.id === scheduleId) : null;
  const invoices = state.documents.filter((document) => document.document_type === "invoice");
  if (!invoices.length) return toast("Create an invoice before setting up a recurring schedule.", "error");
  const selectedSource = sourceDocumentId || schedule?.source_document_id || invoices[0].id;
  const today = new Date().toISOString().slice(0, 10);
  const sourceOptions = invoices.map((document) => '<option value="' + escapeHtml(document.id) + '"' + (document.id === selectedSource ? " selected" : "") + '>' + escapeHtml(document.number) + " - " + escapeHtml(documentCustomer(document)) + "</option>").join("");
  const frequencyOptions = ["weekly", "monthly", "quarterly", "yearly"].map((frequency) => '<option value="' + frequency + '"' + ((schedule?.frequency || "monthly") === frequency ? " selected" : "") + ">" + frequency[0].toUpperCase() + frequency.slice(1) + "</option>").join("");
  $("#modalContent").innerHTML = "<h2>" + (schedule ? "Edit recurring schedule" : "Create recurring schedule") + "</h2><p class=\"lead\">Every run creates a separately numbered invoice draft for review. It never sends or finalizes an invoice automatically.</p><input id=\"recurringScheduleId\" type=\"hidden\" value=\"" + escapeHtml(schedule?.id || "") + '\"><div class=\"field-grid\">' + modalInput("Schedule name", "recurringName", true, "text", "span-2", schedule?.name || "") + '<div class=\"field span-2\"><label for=\"recurringSource\">Invoice structure</label><div class=\"input-wrap\"><select id=\"recurringSource\">' + sourceOptions + "</select></div></div><div class=\"field\"><label for=\"recurringFrequency\">Frequency</label><div class=\"input-wrap\"><select id=\"recurringFrequency\">" + frequencyOptions + "</select></div></div>" + modalInput("First run", "recurringNextRun", true, "date", "", schedule?.next_run_on || today) + modalInput("End after", "recurringEndsOn", false, "date", "", schedule?.ends_on || "") + '</div><label class=\"checkbox-field\"><input id=\"recurringActive\" type=\"checkbox\"' + (schedule?.active === false ? "" : " checked") + "> Schedule is active</label><div class=\"modal-actions\"><button class=\"btn\" value=\"cancel\">Cancel</button><button class=\"btn primary\" type=\"button\" id=\"saveRecurringSchedule\">" + (schedule ? "Save changes" : "Create schedule") + "</button></div>";
  $("#modal").showModal(); $("#saveRecurringSchedule").onclick = saveRecurringSchedule;
}
async function saveRecurringSchedule() {
  const id = $("#recurringScheduleId")?.value;
  const payload = { name: $("#recurringName")?.value.trim(), source_document_id: $("#recurringSource")?.value, frequency: $("#recurringFrequency")?.value, next_run_on: $("#recurringNextRun")?.value, ends_on: $("#recurringEndsOn")?.value || null, active: Boolean($("#recurringActive")?.checked) };
  if (!payload.name || !payload.source_document_id || !payload.next_run_on) return toast("Enter a schedule name, source invoice, and first run date.", "error");
  try {
    const saved = await api(id ? "/api/recurring-schedules/" + id : "/api/recurring-schedules", { method: id ? "PUT" : "POST", body: JSON.stringify(payload) });
    state.recurringSchedules = id ? state.recurringSchedules.map((schedule) => schedule.id === saved.id ? saved : schedule) : [saved, ...state.recurringSchedules];
    $("#modal").close(); render(); toast(id ? "Recurring schedule updated" : "Recurring schedule created");
  } catch (error) { toast("Recurring schedule not saved: " + error.message, "error"); }
}
async function runRecurringSchedules(scheduleId = "") {
  const path = scheduleId ? "/api/recurring-schedules/" + scheduleId + "/run-due" : "/api/recurring-schedules/run-due";
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify({ as_of: new Date().toISOString().slice(0, 10) }) });
    await Promise.all([refreshDocuments(), refreshRecurringSchedules()]);
    render(); toast(result.documents?.length ? result.documents.length + " recurring invoice draft" + (result.documents.length === 1 ? "" : "s") + " created" : "No invoices are due for generation");
  } catch (error) { toast("Recurring generation failed: " + error.message, "error"); }
}
async function toggleRecurringSchedule(id) {
  const schedule = state.recurringSchedules.find((item) => item.id === id); if (!schedule) return;
  try {
    const saved = await api("/api/recurring-schedules/" + id + "/" + (schedule.active ? "pause" : "resume"), { method: "POST", body: "{}" });
    state.recurringSchedules = state.recurringSchedules.map((item) => item.id === id ? saved : item); render(); toast(schedule.active ? "Recurring schedule paused" : "Recurring schedule resumed");
  } catch (error) { toast("Recurring schedule not updated: " + error.message, "error"); }
}
async function saveProfile() {
  try { state.profile = await api("/api/business-profile", { method: "PUT", body: JSON.stringify({ ...state.profile, name: $("#profileName").value.trim(), business_name: $("#profileName").value.trim(), email: $("#profileEmail").value.trim(), vat_number: $("#profileVat").value.trim(), default_currency: $("#profileCurrency").value.trim().toUpperCase() || "ZAR", logo_url: $("#profileLogoUrl").value.trim(), address: $("#profileAddress").value.trim() }) }); render(); toast("Business profile saved"); }
  catch (error) { toast(`Profile not saved: ${error.message}`, "error"); }
}
async function uploadProfileLogo() {
  const file = $("#profileLogoFile")?.files?.[0];
  if (!file) return toast("Choose a logo file first", "error");
  try {
    const response = await fetch("/api/business-logo", { method: "POST", headers: { "Content-Type": file.type, "X-File-Name": file.name }, body: file });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error?.message || `Logo upload failed (${response.status})`);
    state.profile = payload.data.profile; render(); toast("Business logo uploaded");
  } catch (error) { toast(error.message, "error"); }
}
async function removeProfileLogo() {
  try { state.profile = await api("/api/business-profile", { method: "PUT", body: JSON.stringify({ ...state.profile, logo_url: "" }) }); render(); toast("Business logo removed from the profile"); }
  catch (error) { toast(`Logo was not removed: ${error.message}`, "error"); }
}
async function addPaymentMethod() {
  try { const name = $("#paymentMethodName").value.trim(); const method = await api("/api/payment-methods", { method: "POST", body: JSON.stringify({ name, method_type: $("#paymentMethodType").value.trim(), is_default: $("#paymentMethodDefault").checked, details: { instructions: $("#paymentMethodDetails").value.trim() } }) }); state.paymentMethods = [method, ...state.paymentMethods.filter((item) => item.id !== method.id).map((item) => method.is_default ? { ...item, is_default: false } : item)]; render(); toast("Payment method added"); }
  catch (error) { toast(`Payment method not saved: ${error.message}`, "error"); }
}
async function setDefaultPaymentMethod(id) {
  try { const method = await api(`/api/payment-methods/${id}/default`, { method: "POST", body: "{}" }); state.paymentMethods = state.paymentMethods.map((item) => ({ ...item, is_default: item.id === method.id })); render(); toast("Default payment method updated"); }
  catch (error) { toast(`Default payment method was not updated: ${error.message}`, "error"); }
}
async function saveBrandingPreset() {
  try {
    const name = $("#brandingPresetName").value.trim();
    if (!name) return toast("Give the brand preset a name", "error");
    const preset = await api("/api/branding-presets", { method: "POST", body: JSON.stringify({ name, template_id: $("#brandingPresetTemplate").value, accent: $("#brandingPresetAccent").value.trim() || "#7f56d9", footer: $("#brandingPresetFooter").value.trim(), logo_url: state.profile.logo_url || "" }) });
    state.brandingPresets.push(preset); render(); toast("Brand preset saved");
  } catch (error) { toast(`Brand preset not saved: ${error.message}`, "error"); }
}
async function saveNumberPrefixes() {
  try {
    state.numberPrefixes = await api("/api/number-prefixes", { method: "PUT", body: JSON.stringify({ invoice: $("#prefixInvoice").value.trim().toUpperCase(), quote: $("#prefixQuote").value.trim().toUpperCase(), receipt: $("#prefixReceipt").value.trim().toUpperCase() }) });
    render(); toast("Document numbering saved");
  } catch (error) { toast(`Numbering not saved: ${error.message}`, "error"); }
}
async function saveEmailTemplate() {
  try {
    const purpose = $("#emailTemplatePurpose").value;
    const current = state.emailTemplates.find((template) => template.purpose === purpose) || {};
    const saved = await api(`/api/email-templates/${encodeURIComponent(purpose)}`, { method: "PUT", body: JSON.stringify({ ...current, subject: $("#emailTemplateSubject").value.trim(), text: $("#emailTemplateText").value }) });
    state.emailTemplates = state.emailTemplates.map((template) => template.purpose === purpose ? saved : template); render(); toast("Email template saved");
  } catch (error) { toast(`Email template not saved: ${error.message}`, "error"); }
}
async function restoreEmailTemplate() {
  const purpose = $("#emailTemplatePurpose")?.value; if (!purpose) return;
  try {
    const restored = await api("/api/email-templates/" + encodeURIComponent(purpose) + "/restore-default", { method: "POST", body: "{}" });
    state.emailTemplates = state.emailTemplates.map((template) => template.purpose === purpose ? restored : template); render(); toast("System email template restored");
  } catch (error) { toast("Email template was not restored: " + error.message, "error"); }
}
async function runDueReminders() {
  try {
    const result = await api("/api/reminders/run-due", { method: "POST", body: "{}" });
    await Promise.all([refreshDocuments(), refreshReminders()]);
    const accepted = (result.reminders || []).filter((item) => String(item.attempt?.provider_status || item.delivery?.status || "").startsWith("accepted")).length;
    render(); toast(accepted ? `${accepted} reminder${accepted === 1 ? "" : "s"} accepted` : "Reminder run recorded");
  } catch (error) { toast(`Reminder run failed: ${error.message}`, "error"); }
}
async function toggleReminderRule(id) {
  const rule = state.reminderRules.find((item) => item.id === id); if (!rule) return;
  try {
    await api(`/api/reminders/rules/${encodeURIComponent(id)}/${rule.active ? "pause" : "resume"}`, { method: "POST", body: "{}" });
    await refreshReminders(); render(); toast(rule.active ? "Reminder rule paused" : "Reminder rule resumed");
  } catch (error) { toast(`Reminder rule not updated: ${error.message}`, "error"); }
}

function bindPage() {
  $$('[data-route]').forEach((el) => el.onclick = async () => { if (state.document?.status === "draft") await saveDocument({ quiet: true }); setRoute(el.dataset.route); });
  $$('[data-new-invoice]').forEach((el) => el.onclick = () => createDocument("invoice"));
  $$('[data-quick-route]').forEach((el) => el.onclick = () => setRoute("quick-create"));
  $$('[data-new-document]').forEach((el) => el.onclick = openNewDocumentModal);
  $$('[data-new-recurring]').forEach((el) => el.onclick = () => openRecurringScheduleModal());
  $$('[data-edit-recurring]').forEach((el) => el.onclick = () => openRecurringScheduleModal("", el.dataset.editRecurring));
  $$('[data-run-recurring]').forEach((el) => el.onclick = () => runRecurringSchedules(el.dataset.runRecurring));
  $$('[data-run-all-recurring]').forEach((el) => el.onclick = () => runRecurringSchedules());
  $$('[data-toggle-recurring]').forEach((el) => el.onclick = () => toggleRecurringSchedule(el.dataset.toggleRecurring));
  $$('[data-run-reminders]').forEach((el) => el.onclick = runDueReminders);
  $$('[data-refresh-reminders]').forEach((el) => el.onclick = async () => { await refreshReminders(); render(); toast("Reminder queue refreshed"); });
  $$('[data-toggle-reminder-rule]').forEach((el) => el.onclick = () => toggleReminderRule(el.dataset.toggleReminderRule));
  $$('[data-export-receivables]').forEach((el) => el.onclick = () => { window.location.assign("/api/exports/receivables.csv"); });
  $$('[data-open-document]').forEach((el) => el.onclick = () => openDocument(el.dataset.openDocument));
  $$('[data-document-action]').forEach((el) => el.onclick = () => runDocumentAction(el.dataset.documentAction));
  $$('[data-retry-document-email]').forEach((el) => el.onclick = openEmailCompose);
  $$('[data-document-pdf]').forEach((el) => el.onclick = () => window.open(`/api/documents/${state.document.id}/pdf`, "_blank"));
  $$('[data-save-document]').forEach((el) => el.onclick = () => saveDocument({ quiet: false }));
  $$('[data-add-document-line]').forEach((el) => el.onclick = addDocumentLine);
  $$('[data-select-document-customer]').forEach((el) => el.onclick = () => selectDocumentCustomer(el.dataset.selectDocumentCustomer));
  $$('[data-add-document-product]').forEach((el) => el.onclick = () => addDocumentProduct(el.dataset.addDocumentProduct));
  $$('[data-upload-document-attachment]').forEach((el) => el.onclick = uploadDocumentAttachment);
  $$('[data-remove-document-attachment]').forEach((el) => el.onclick = () => removeDocumentAttachment(el.dataset.removeDocumentAttachment));
  $$('[data-upload-invoice-attachment]').forEach((el) => el.onclick = uploadInvoiceAttachment);
  $$('[data-remove-invoice-attachment]').forEach((el) => el.onclick = () => removeInvoiceAttachment(el.dataset.removeInvoiceAttachment));
  $$('[data-remove-document-line]').forEach((el) => el.onclick = () => { const index = Number(el.dataset.removeDocumentLine); const removed = state.document.data.items.splice(index, 1)[0]; render(); scheduleDocumentSave(); const undo = document.createElement("button"); undo.className = "toast"; undo.type = "button"; undo.textContent = "Line removed. Undo"; undo.onclick = () => { state.document.data.items.splice(index, 0, removed); undo.remove(); render(); scheduleDocumentSave(); }; $("#toasts").append(undo); setTimeout(() => undo.remove(), 5000); });
  $$('[data-document-line]').forEach((el) => { el.oninput = () => updateDocumentLine(el); el.onkeydown = (event) => { if (event.key === "Enter" && el.dataset.documentLine === "description" && Number(el.dataset.documentIndex) === state.document.data.items.length - 1) { event.preventDefault(); addDocumentLine(); } }; });
  $$('[data-move-document-line]').forEach((el) => el.onclick = () => { const [raw, direction] = el.dataset.moveDocumentLine.split(":"); const index = Number(raw); const target = direction === "up" ? index - 1 : index + 1; if (target < 0 || target >= state.document.data.items.length) return; [state.document.data.items[index], state.document.data.items[target]] = [state.document.data.items[target], state.document.data.items[index]]; render(); scheduleDocumentSave(); });
  $$('[data-select-document-template]').forEach((el) => el.onclick = () => { if (state.document.status !== "draft") return; const next = state.templates.find((item) => item.id === el.dataset.selectDocumentTemplate); state.document.data.template_id = el.dataset.selectDocumentTemplate; if (next?.accent) state.document.data.accent = next.accent; render(); scheduleDocumentSave(); });
  $$('[data-document-terms]').forEach((el) => el.onclick = () => { const days = Number(el.dataset.documentTerms); const issue = new Date(`${state.document.data.issue_date || new Date().toISOString().slice(0, 10)}T12:00:00`); issue.setDate(issue.getDate() + days); state.document.data.terms_days = days; state.document.data.due_date = issue.toISOString().slice(0, 10); render(); scheduleDocumentSave(); });
  $$('[data-open-document-preview]').forEach((el) => el.onclick = () => { $("#sheetTitle").textContent = `${documentTypeLabel(state.document.document_type)} preview`; $("#sheetBody").innerHTML = `<div class="generic-paper-wrap sheet-generic-paper">${genericPaperMarkup(state.document)}</div>`; $("#sheet").classList.add("open"); $("#sheet").setAttribute("aria-hidden", "false"); });
  $$('[data-parse-quick]').forEach((el) => el.onclick = parseQuickCreate);
  $$('[data-create-quick]').forEach((el) => el.onclick = createQuickDocument);
  $$('[data-save-profile]').forEach((el) => el.onclick = saveProfile);
  $$('[data-upload-logo]').forEach((el) => el.onclick = uploadProfileLogo);
  $$('[data-remove-logo]').forEach((el) => el.onclick = removeProfileLogo);
  $$('[data-add-payment-method]').forEach((el) => el.onclick = addPaymentMethod);
  $$('[data-set-default-payment]').forEach((el) => el.onclick = () => setDefaultPaymentMethod(el.dataset.setDefaultPayment));
  $$('[data-save-branding]').forEach((el) => el.onclick = saveBrandingPreset);
  $$('[data-save-prefixes]').forEach((el) => el.onclick = saveNumberPrefixes);
  $$('[data-save-email-template]').forEach((el) => el.onclick = saveEmailTemplate);
  $$('[data-open-invoice]').forEach((el) => el.onclick = () => openDocument(el.dataset.openInvoice));
  $$('[data-download]').forEach((el) => el.onclick = () => window.open(`/api/invoices/${state.current.id}/pdf`, "_blank"));
  $$('[data-fullscreen-preview]').forEach((el) => el.onclick = () => window.open(`/api/invoices/${state.current.id}/pdf`, "_blank"));
  $$('[data-save]').forEach((el) => el.onclick = async () => { await saveDraft(); toast("Draft saved"); });
  $$('[data-review]').forEach((el) => el.onclick = openReview);
  $$('[data-preview]').forEach((el) => el.onclick = openPreview);
  $$('[data-duplicate]').forEach((el) => el.onclick = () => duplicateInvoice(state.current.id));
  $$('[data-mark-paid]').forEach((el) => el.onclick = markPaid);
  $$('[data-void]').forEach((el) => el.onclick = openVoidDialog);
  $$('[data-duplicate-latest]').forEach((el) => el.onclick = () => state.invoices[0] && duplicateDocument(state.invoices[0].id));
  $$('[data-page]').forEach((el) => el.onclick = () => {
    const page = el.dataset.page;
    document.querySelectorAll('.form-page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.flow-step').forEach(s => s.classList.remove('active'));
    document.getElementById(`page-${page}`)?.classList.add('active');
    el.classList.add('active');
  });
  $$('[data-next-page]').forEach((el) => el.onclick = () => {
    const page = el.dataset.nextPage;
    document.querySelectorAll('.form-page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.flow-step').forEach(s => s.classList.remove('active'));
    document.getElementById(`page-${page}`)?.classList.add('active');
    document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  });
  $$('[data-prev-page]').forEach((el) => el.onclick = () => {
    const page = el.dataset.prevPage;
    document.querySelectorAll('.form-page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.flow-step').forEach(s => s.classList.remove('active'));
    document.getElementById(`page-${page}`)?.classList.add('active');
    document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  });
  $$('[data-customer]').forEach((el) => el.onclick = () => selectCustomer(el.dataset.customer));
  $('[data-change-customer]') && ($('[data-change-customer]').onclick = () => { state.current.data.customer_id = null; state.current.data.customer = {}; render(); scheduleSave(); });
  $('[data-new-customer]') && ($('[data-new-customer]').onclick = openCustomerModal);
  $('[data-new-product]') && ($('[data-new-product]').onclick = openProductModal);
  $$('[data-invoice-customer]').forEach((el) => el.onclick = async () => { if (await createDocument("invoice")) selectDocumentCustomer(el.dataset.invoiceCustomer); });
  $$('[data-use-product]').forEach((el) => el.onclick = async () => { if (await createDocument("invoice")) addDocumentProduct(el.dataset.useProduct); });
  $$('[data-product]').forEach((el) => el.onclick = () => addProduct(el.dataset.product));
  $$('[data-custom-item]').forEach((el) => el.onclick = addCustomItem);
  $$('[data-copy-line]').forEach((el) => el.onclick = () => { const index = Number(el.dataset.copyLine); state.current.data.items.splice(index + 1, 0, { ...state.current.data.items[index] }); render(); scheduleSave(); setTimeout(() => $(`#line-${index + 1}-description`)?.focus(), 0); toast("Line duplicated"); });
  $$('[data-delete-line]').forEach((el) => el.onclick = () => { const index = Number(el.dataset.deleteLine); state.current.data.items.splice(index, 1); state.expandedLines = new Set([...state.expandedLines].filter((item) => item !== index).map((item) => item > index ? item - 1 : item)); render(); scheduleSave(); setTimeout(() => $(`#line-${Math.max(0, index - 1)}-description`)?.focus(), 0); toast("Line removed"); });
  $$('[data-toggle-line]').forEach((el) => el.onclick = () => { const index = Number(el.dataset.toggleLine); state.expandedLines.has(index) ? state.expandedLines.delete(index) : state.expandedLines.add(index); render(); });
  $$('[data-terms]').forEach((el) => el.onclick = () => { const days = Number(el.dataset.terms); state.current.data.terms_days = days; const issue = new Date(`${state.current.data.issue_date}T12:00:00`); issue.setDate(issue.getDate() + days); state.current.data.due_date = issue.toISOString().slice(0, 10); render(); scheduleSave(); });
  $$('[data-path]').forEach((input) => {
    input.oninput = () => { let value = input.value; if (input.dataset.path === "shipping_display") { state.current.data.shipping_minor = Math.round((Number(value) || 0) * 100); } else setPath(state.current.data, input.dataset.path, value); updatePreview(); scheduleSave(); };
    input.onblur = () => { state.touched.add(input.dataset.path); if (!input.value.trim() && input.closest(".field")?.querySelector(".field-error")) input.closest(".field").classList.add("touched"); };
  });
  $$('[data-select-path]').forEach((select) => select.onchange = () => { setPath(state.current.data, select.dataset.selectPath, select.value); render(); scheduleSave(); });
  $$('[data-line-key]').forEach((input) => {
    input.oninput = () => { const item = state.current.data.items[Number(input.dataset.lineIndex)]; const key = input.dataset.lineKey; if (key === "unit_price_display") item.unit_price_minor = Math.round((Number(input.value) || 0) * 100); else if (key === "tax_percent") item.tax_bps = Math.round((Number(input.value) || 0) * 100); else if (key === "discount_percent") item.discount_bps = Math.round((Number(input.value) || 0) * 100); else item[key] = key === "description" ? input.value : Number(input.value) || 0; updatePreview(); scheduleSave(); };
    input.onkeydown = (event) => { if (event.key === "Enter" && input.dataset.lineKey === "description" && Number(input.dataset.lineIndex) === state.current.data.items.length - 1) { event.preventDefault(); addCustomItem(); setTimeout(() => $$('[data-line-key="description"]').at(-1)?.focus(), 0); } };
  });
  const customerSearch = $("#customerSearch"); if (customerSearch) customerSearch.oninput = () => { state.customerQuery = customerSearch.value; const focus = customerSearch.selectionStart; render(); const next = $("#customerSearch"); next?.focus(); next?.setSelectionRange(focus, focus); };
  const productSearch = $("#productSearch"); if (productSearch) productSearch.oninput = () => { state.productQuery = productSearch.value; const focus = productSearch.selectionStart; render(); const next = $("#productSearch"); next?.focus(); next?.setSelectionRange(focus, focus); };
  const invoiceSearch = $("#invoiceSearch"); if (invoiceSearch) invoiceSearch.oninput = () => { state.invoiceQuery = invoiceSearch.value; const focus = invoiceSearch.selectionStart; render(); const next = $("#invoiceSearch"); next?.focus(); next?.setSelectionRange(focus, focus); };
  const invoiceStatus = $("#invoiceStatus"); if (invoiceStatus) invoiceStatus.onchange = () => { state.invoiceStatus = invoiceStatus.value; render(); };
  const documentSearch = $("#documentSearch"); if (documentSearch) documentSearch.oninput = () => { state.documentQuery = documentSearch.value; render(); $("#documentSearch")?.focus(); };
  const documentType = $("#documentType"); if (documentType) documentType.onchange = () => { state.documentType = documentType.value; render(); };
  const documentCustomerSearch = $("#documentCustomerSearch"); if (documentCustomerSearch) documentCustomerSearch.oninput = () => { state.documentCustomerQuery = documentCustomerSearch.value; const position = documentCustomerSearch.selectionStart; render(); $("#documentCustomerSearch")?.focus(); $("#documentCustomerSearch")?.setSelectionRange(position, position); };
  const documentProductSearch = $("#documentProductSearch"); if (documentProductSearch) documentProductSearch.oninput = () => { state.documentProductQuery = documentProductSearch.value; const position = documentProductSearch.selectionStart; render(); $("#documentProductSearch")?.focus(); $("#documentProductSearch")?.setSelectionRange(position, position); };
  const emailTemplatePurpose = $("#emailTemplatePurpose"); if (emailTemplatePurpose) {
    emailTemplatePurpose.onchange = () => { state.settingsEmailPurpose = emailTemplatePurpose.value; render(); };
    const saveTemplate = $('[data-save-email-template]');
    if (saveTemplate && !$("#restoreEmailTemplate")) { const restore = document.createElement("button"); restore.id = "restoreEmailTemplate"; restore.type = "button"; restore.className = "btn"; restore.textContent = "Restore default"; restore.onclick = restoreEmailTemplate; saveTemplate.before(restore); }
  }
  ["#documentTitle", "#documentNumber", "#documentCurrency", "#documentIssueDate", "#documentDueDate", "#documentReceiptReference", "#documentAccent", "#documentFooter", "#documentSignature", "#documentCustomerName", "#documentCustomerContact", "#documentCustomerEmail", "#documentCustomerPhone", "#documentCustomerVat", "#documentCustomerRegistration", "#documentCustomerAddress", "#documentPaymentDetails", "#documentDiscount", "#documentShipping", "#documentPoNumber", "#documentNotes"].forEach((selector) => { const input = $(selector); if (input) input.oninput = () => { updateDocumentPreview(); scheduleDocumentSave(); }; });
  ["#documentTemplate", "#documentPageSize", "#documentPaymentMethod"].forEach((selector) => { const input = $(selector); if (input) input.onchange = () => { updateDocumentPreview(); scheduleDocumentSave(); }; });
}

async function refreshLists() { [state.invoices, state.customers, state.products] = await Promise.all([api("/api/invoices"), api("/api/customers"), api("/api/products")]); }
function resetSaveRevision() { state.editRevision = 0; state.savedRevision = 0; state.saveError = false; state.saving = false; }
async function loadAudit(id = state.current?.id) { state.audit = id ? await api(`/api/invoices/${id}/audit`) : []; }
async function createInvoice() { try { state.current = await api("/api/invoices", { method: "POST", body: "{}" }); resetSaveRevision(); state.customerQuery = ""; state.productQuery = ""; await Promise.all([refreshLists(), loadAudit(state.current.id)]); setRoute("invoice"); } catch (error) { toast(error.message, "error"); } }
async function duplicateInvoice(id) { try { state.current = await api(`/api/invoices/${id}/duplicate`, { method: "POST", body: "{}" }); resetSaveRevision(); await Promise.all([refreshLists(), loadAudit(state.current.id)]); setRoute("invoice"); toast("Invoice duplicated as a new draft"); } catch (error) { toast(error.message, "error"); } }
function selectCustomer(id) { const customer = state.customers.find((item) => item.id === id); if (!customer) return; state.current.data.customer_id = customer.id; state.current.data.customer = { ...customer }; state.current.data.currency = customer.currency; state.current.data.terms_days = customer.terms_days; const issue = new Date(`${state.current.data.issue_date}T12:00:00`); issue.setDate(issue.getDate() + customer.terms_days); state.current.data.due_date = issue.toISOString().slice(0, 10); render(); scheduleSave(); toast(`${customer.name} selected`); }
function addProduct(id) { const product = state.products.find((item) => item.id === id); if (!product) return; state.current.data.items.push({ product_id: product.id, description: product.name, quantity: 1, unit_price_minor: product.unit_price_minor, tax_bps: product.tax_bps, discount_bps: 0 }); state.productQuery = ""; render(); scheduleSave(); toast("Saved product added"); }
function addCustomItem() { state.current.data.items.push({ description: state.productQuery || "", quantity: 1, unit_price_minor: 0, tax_bps: 1500, discount_bps: 0 }); state.productQuery = ""; render(); scheduleSave(); setTimeout(() => $$('[data-line-key="description"]').at(-1)?.focus(), 0); }

function openPreview() { $("#sheetTitle").textContent = "Invoice preview"; $("#sheetBody").innerHTML = `<div class="paper-wrap"><div class="paper">${paperMarkup(state.current.data, localTotals())}</div></div>`; $("#sheet").classList.add("open"); $("#sheet").setAttribute("aria-hidden", "false"); }
function closeSheet() { $("#sheet").classList.remove("open"); $("#sheet").setAttribute("aria-hidden", "true"); }
function openReview() {
  state.touched = new Set(["document_title","number","issue_date","supplier.name","supplier.address"]);
  const checks = clientReadyChecks(); const totals = localTotals(); const ready = checks.every((item) => item.complete);
  $("#sheetTitle").textContent = "Review invoice";
  $("#sheetBody").innerHTML = `<div class="review-list">${checks.map((check) => `<div class="review-check ${check.complete ? "" : "missing"}"><i>${check.complete ? icon("check") : icon("x")}</i><span>${escapeHtml(check.label)}</span></div>`).join("")}</div><div class="review-summary"><div><span>Customer</span><strong>${escapeHtml(state.current.data.customer?.name || "Not selected")}</strong></div><div><span>Due</span><strong>${dateLabel(state.current.data.due_date)}</strong></div><div class="grand"><span>Balance due</span><strong>${money(totals.total_minor)}</strong></div></div><div class="completion-paths"><button class="completion-path" id="confirmFinalize" ${ready ? "" : "disabled"}><span class="path-icon">${icon("check")}</span><span><strong>Finalize only</strong><small>Lock the invoice and make its PDF ready. No send event is recorded.</small></span></button><button class="completion-path primary" id="confirmSend" ${ready ? "" : "disabled"}><span class="path-icon">${icon("send")}</span><span><strong>Finalize & record send</strong><small>Lock the invoice and add a send event. No email is delivered.</small></span></button></div><div class="review-note">External email delivery is not configured. Recording a send keeps the local receivables history accountable without claiming delivery.</div><div class="modal-actions"><button class="btn" data-close-sheet>Back to edit</button></div>`;
  $("#sheet").classList.add("open"); $("#sheet").setAttribute("aria-hidden", "false");
  $("#confirmFinalize") && ($("#confirmFinalize").onclick = () => finalizeInvoice(false));
  $("#confirmSend") && ($("#confirmSend").onclick = () => finalizeInvoice(true));
}
async function finalizeInvoice(recordSend) {
  try {
    await saveDraft();
    if (state.saveError) return;
    const endpoint = recordSend ? "send" : "finalize";
    state.current = await api(`/api/invoices/${state.current.id}/${endpoint}`, { method: "POST", body: "{}" });
    await Promise.all([refreshLists(), loadAudit(state.current.id)]);
    closeSheet(); render(); toast(recordSend ? "Invoice finalized and send event recorded" : "Invoice finalized without recording a send");
  } catch (error) { toast(error.message, "error"); if (error.details) openReview(); }
}

async function markPaid() {
  try { state.current = await api(`/api/invoices/${state.current.id}/paid`, { method: "POST", body: "{}" }); await Promise.all([refreshLists(), loadAudit(state.current.id)]); render(); toast("Invoice marked paid"); }
  catch (error) { toast(error.message, "error"); }
}

function openVoidDialog() {
  $("#modalContent").innerHTML = `<h2>Void ${escapeHtml(state.current.number)}?</h2><p class="lead">This closes the invoice and records the action in its audit history. It cannot be marked paid afterward.</p><div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn danger" type="button" id="confirmVoid">${icon("trash")}Void invoice</button></div>`;
  $("#modal").showModal();
  $("#confirmVoid").onclick = voidInvoice;
}

async function voidInvoice() {
  try { state.current = await api(`/api/invoices/${state.current.id}/void`, { method: "POST", body: "{}" }); await Promise.all([refreshLists(), loadAudit(state.current.id)]); $("#modal").close(); render(); toast("Invoice voided"); }
  catch (error) { toast(error.message, "error"); }
}

function openCustomerModal() {
  $("#modalContent").innerHTML = `<h2>New customer</h2><p class="lead">Set sensible billing defaults once, then reuse them on every document.</p><div class="field-grid">${modalInput("Company name","customerName",true)}${modalInput("Contact name","customerContact")}${modalInput("Billing email","customerEmail",true,"email")}${modalInput("Phone","customerPhone",false,"tel")}${modalInput("Billing address","customerAddress",true,"text","span-2")}${modalInput("VAT number","customerVat")}${modalInput("Registration number","customerRegistration")}${modalInput("Currency","customerCurrency",false,"text","","ZAR")}${modalInput("Payment terms (days)","customerTerms",false,"number","","30")}${modalInput("Customer notes","customerNotes",false,"text","span-2")}</div><div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" type="button" id="createCustomer">Create & select</button></div>`;
  $("#modal").showModal(); $("#createCustomer").onclick = createCustomer;
}
function openProductModal() {
  $("#modalContent").innerHTML = `<h2>New product</h2><p class="lead">Save a reusable product or service to speed up future invoices.</p><div class="field-grid">${modalInput("Name","productName",true)}${modalInput("Unit price","productPrice",true,"number")}${modalInput("Description","productDescription",false,"text","span-2")}${modalInput("VAT rate (%)","productTax",false,"number","","15")}</div><div class="modal-actions"><button class="btn" value="cancel">Cancel</button><button class="btn primary" type="button" id="createProduct">Save product</button></div>`;
  $("#modal").showModal(); $("#createProduct").onclick = createProduct;
}
function modalInput(label,id,required=false,type="text",span="",value="") { return `<div class="field ${span}"><label for="${id}">${label}${required ? " *" : ""}</label><div class="input-wrap"><input id="${id}" type="${type}" value="${value}" ${required ? "required" : ""}></div></div>`; }
async function createCustomer() { const payload = { name: $("#customerName").value.trim(), contact_name: $("#customerContact").value.trim(), email: $("#customerEmail").value.trim(), phone: $("#customerPhone").value.trim(), address: $("#customerAddress").value.trim(), country: "South Africa", vat_number: $("#customerVat").value.trim(), registration_number: $("#customerRegistration").value.trim(), notes: $("#customerNotes").value.trim(), vat_registered: Boolean($("#customerVat").value.trim()), currency: $("#customerCurrency").value.trim().toUpperCase() || "ZAR", terms_days: Number($("#customerTerms").value) || 30 }; if (!payload.name || !payload.email || !payload.address) return toast("Enter the client name, email address, and billing address.", "error"); try { const customer = await api("/api/customers", { method: "POST", body: JSON.stringify(payload) }); state.customers.unshift(customer); $("#modal").close(); if (state.route === "document-editor") selectDocumentCustomer(customer.id); else render(); } catch (error) { toast(error.message, "error"); } }
async function createProduct() { const payload = { name: $("#productName").value.trim(), description: $("#productDescription").value.trim(), unit_price_minor: Math.round((Number($("#productPrice").value) || 0) * 100), tax_bps: Math.round((Number($("#productTax").value) || 0) * 100), currency: state.document?.data.currency || "ZAR" }; if (!payload.name) return toast("Enter a product or service name.", "error"); try { const product = await api("/api/products", { method: "POST", body: JSON.stringify(payload) }); state.products.unshift(product); $("#modal").close(); if (state.route === "document-editor") addDocumentProduct(product.id); else render(); } catch (error) { toast(error.message, "error"); } }

async function bootstrap() {
  try {
    await Promise.all([refreshLists(), refreshDocuments(), refreshRecurringSchedules(), refreshReminders(), loadDocumentSupport()]);
    const hash = location.hash.slice(1); let [initialRoute, initialDocumentId] = hash.split("/");
    if (initialRoute === "invoice") { initialRoute = "documents"; state.route = "documents"; history.replaceState(null, "", "#documents"); }
    if (initialRoute === "document-editor" && initialDocumentId) { state.route = "document-editor"; state.documentRouteId = initialDocumentId; state.document = await api(`/api/documents/${initialDocumentId}`); await loadDocumentEmailHistory(initialDocumentId); }
    render();
  } catch (error) { $("#content").innerHTML = `<div class="error-state"><div><h2>Could not open VirtuKey Forma</h2><p>${escapeHtml(error.message)}</p><button class="btn primary" onclick="location.reload()">Try again</button></div></div>`; }
}

$("#menuBtn").onclick = () => { $("#sidebar").classList.add("open"); $("#scrim").classList.add("show"); };
$("#scrim").onclick = () => { $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); };
document.addEventListener("click", (event) => { if (event.target.closest("[data-close-sheet]")) closeSheet(); });
window.addEventListener("hashchange", async () => { const [next, documentId] = location.hash.slice(1).split("/"); if (!next) return; if (next === "invoice") return setRoute("documents"); if (next === "document-editor" && documentId) { try { state.route = next; state.documentRouteId = documentId; state.document = await api(`/api/documents/${documentId}`); await Promise.all([loadDocumentSupport(), loadDocumentEmailHistory(documentId)]); render(); } catch (error) { toast(error.message, "error"); setRoute("documents"); } return; } if (next !== state.route) { state.route = next; state.documentRouteId = null; state.documentEmailHistory = []; render(); } });
window.addEventListener("keydown", (event) => {
  const command = event.metaKey || event.ctrlKey;
  if (command && event.key.toLowerCase() === "s" && state.route === "document-editor" && state.document?.status === "draft") { event.preventDefault(); saveDocument({ quiet: false }); }
  if (event.key === "Escape") { closeSheet(); if ($("#modal").open) $("#modal").close(); }
});
bootstrap();
