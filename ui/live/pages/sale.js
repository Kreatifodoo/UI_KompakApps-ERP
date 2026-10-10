// Quotation dan Sales Order (sale.order). Struktur form mengikuti view Odoo 19: judul "Quotation" atau
// "Sales Order", tombol header menurut status, bilah status draft/sent/sale, tombol statistik Delivery dan
// Invoices, field yang dapat diedit selama quotation, tabel barang (dikirim, ditagih, harga, diskon, pajak,
// jumlah), dialog Buat Faktur (wizard sale.advance.payment.inv), dan total.
import {
  INPUT, actionBar, app, badge, call, cell, chatterHtml, closeLookup, closeModal, ctx, dateText, esc, fieldBlock, filterSelect, fromInputDateTime,
  guarded, loadMessages, money, openModal, pageHeader, readOne, readonlyValue, referencePricelists, referenceTerms, referenceUsers, registerLookup,
  rowLink, runLookup, searchBox, searchRead, selectOptions, statTiles, statusbar, table, toInputDateTime, toast, dateTimeText,
} from "../common.js";

const STATES = {
  draft: ["Quotation", "muted"],
  sent: ["Quotation Terkirim", "info"],
  sale: ["Sales Order", "success"],
  cancel: ["Dibatalkan", "danger"],
};
const FLOW = ["draft", "sent", "sale"];
const INVOICE_STATUS = {
  no: ["Tidak Ada Faktur", "muted"],
  "to invoice": ["Perlu Difakturkan", "warning"],
  invoiced: ["Sudah Difakturkan", "success"],
  upselling: ["Peluang Upselling", "info"],
};
const DELIVERY_STATUS = {
  pending: ["Belum Dikirim", "muted"],
  started: ["Mulai Dikirim", "info"],
  partial: ["Dikirim Sebagian", "warning"],
  full: ["Terkirim Penuh", "success"],
};

/* Tombol header Odoo (sale_order_form). Method null = ditangani khusus. */
const BUTTONS = [
  { action: "confirm", label: "Konfirmasi", method: "action_confirm", kind: "primary", show: (o) => ["draft", "sent"].includes(o.state) },
  { action: "ship", label: "Kirim Barang", method: null, kind: "primary", show: (o) => o.state === "sale" && o.delivery_count > 0 && o.delivery_status !== "full" },
  { action: "invoice", label: "Buat Faktur", method: null, kind: "primary", show: (o) => o.state === "sale" && o.invoice_status === "to invoice" },
  { action: "draft", label: "Kembalikan ke Quotation", method: "action_draft", show: (o) => o.state === "cancel" },
  { action: "cancel", label: "Batalkan", method: "action_cancel", kind: "danger", show: (o) => ["draft", "sent", "sale"].includes(o.state) && !o.locked },
];
const DONE_MESSAGE = {
  confirm: "Quotation dikonfirmasi menjadi Sales Order.",
  draft: "Dikembalikan ke quotation.",
  cancel: "Dokumen dibatalkan.",
};
const INVOICE_METHODS = [
  ["delivered", "Faktur reguler (sesuai barang terkirim)"],
  ["percentage", "Uang muka (persen)"],
  ["fixed", "Uang muka (nominal)"],
];

let form = null;
let last = { sub: "", query: new URLSearchParams() };
let invoiceDialog = null; // { orderId }

export const leave = () => {
  form = null;
  invoiceDialog = null;
};
const reload = () => render(last.sub, last.query);

/* ---------- Kotak saran ---------- */

registerLookup("sale-customer", {
  search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: "customer_rank desc, name" }),
  isChosen: (input) => form?.partner?.display_name === input.value,
  choose: (input, item) => {
    form.partner = item;
    input.value = item.display_name;
  },
});
registerLookup("sale-product", {
  search: (q) =>
    searchRead(
      "product.product",
      [["sale_ok", "=", true], ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])],
      ["display_name", "uom_id", "description_sale", "list_price"],
      { limit: 10, order: "name" },
    ),
  sub: (r) => `${money(r.list_price)} / ${r.uom_id?.[1] ?? ""}`,
  isChosen: (input) => {
    const line = form?.lines[Number(input.dataset.line)];
    return Boolean(line?.product_id) && line.productText === input.value;
  },
  choose: (input, item) => {
    const i = Number(input.dataset.line);
    const line = form.lines[i];
    Object.assign(line, {
      text: item.display_name, productText: item.display_name, product_id: item.id,
      product_uom_id: item.uom_id[0], uom_label: item.uom_id[1],
    });
    if (!line.name || line.name === line.lastAutoName) line.name = item.description_sale || item.display_name;
    line.lastAutoName = line.name;
    document.querySelector("#lines-box").innerHTML = linesTable();
    document.querySelector(`[data-line="${i}"][data-field="product_uom_qty"]`)?.focus();
  },
});

/* ---------- Render ---------- */

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const ids = (query.get("ids") ?? "").split(",").map(Number).filter(Boolean);
  const partner = Number(query.get("partner")) || null;
  const domain = [];
  if (filter === "quotation") domain.push(["state", "in", ["draft", "sent"]]);
  else if (filter) domain.push(["state", "=", filter]);
  if (ids.length) domain.push(["id", "in", ids]);
  if (partner) domain.push(["partner_id", "=", partner]);
  if (text) domain.push("|", "|", ["name", "ilike", text], ["client_order_ref", "ilike", text], ["partner_id.name", "ilike", text]);
  const rows = await searchRead(
    "sale.order",
    domain,
    ["name", "partner_id", "user_id", "date_order", "amount_total", "currency_id", "state", "invoice_status", "delivery_status"],
    { order: "id desc", limit: 80 },
  );
  const options = [["", "Semua status"], ["quotation", "Quotation (draft, terkirim)"], ["sale", "Sales Order"], ["cancel", "Dibatalkan"]];
  const body = rows
    .map((r) =>
      rowLink(`#/sale/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(r.partner_id?.[1] ?? ""),
        cell(r.user_id?.[1] ?? ""),
        cell(dateText(r.date_order)),
        cell(money(r.amount_total, r.currency_id?.[1]), { right: true }),
        cell(badge(STATES, r.state), { raw: true }),
        cell(r.state === "sale" ? badge(DELIVERY_STATUS, r.delivery_status) : "", { raw: true }),
        cell(r.state === "sale" ? badge(INVOICE_STATUS, r.invoice_status) : "", { raw: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Quotation & Sales Order",
      `${searchBox(text, "Cari nomor, referensi, pelanggan")}${filterSelect(options, filter)}
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
       <a href="#/sale/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Quotation Baru</a>`,
    ) +
    (partner
      ? '<p class="text-sm text-gray-500 mb-3">Difilter per pelanggan. <a href="#/sale" class="text-indigo-600 hover:underline">Tampilkan semua</a></p>'
      : "") +
    table(
      [{ label: "Nomor" }, { label: "Pelanggan" }, { label: "Salesperson" }, { label: "Tanggal" }, { label: "Total", right: true }, { label: "Status" }, { label: "Pengiriman" }, { label: "Faktur" }],
      body,
      "Belum ada quotation atau Sales Order.",
    );
}

const emptyLine = () => ({
  id: null, text: "", product_id: null, productText: "", name: "", product_uom_qty: 1, product_uom_id: null, uom_label: "",
  price_unit: "", price_unit0: "", discount: "", discount0: "", taxLabel: "", subtotal: null,
});

function linesTable() {
  const rows = form.lines
    .map(
      (l, i) => `<tr class="align-top">
        <td class="py-2 pr-2 min-w-48"><input data-lookup="sale-product" autocomplete="off" role="combobox" aria-autocomplete="list" data-line="${i}" data-field="text" value="${esc(l.text)}" placeholder="Cari atau pilih produk..." class="${INPUT}"></td>
        <td class="py-2 px-2 min-w-40"><input data-line="${i}" data-field="name" value="${esc(l.name)}" class="${INPUT}"></td>
        <td class="py-2 px-2 w-24"><input type="number" min="0" step="any" data-line="${i}" data-field="product_uom_qty" value="${esc(l.product_uom_qty)}" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 w-20 text-sm text-gray-600">${esc(l.uom_label || "-")}</td>
        <td class="py-2 px-2 w-36"><input type="number" min="0" step="any" data-line="${i}" data-field="price_unit" value="${esc(l.price_unit)}" placeholder="otomatis" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 w-24"><input type="number" min="0" max="100" step="any" data-line="${i}" data-field="discount" value="${esc(l.discount)}" placeholder="0" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 w-32 text-sm text-gray-600">${esc(l.taxLabel || "-")}</td>
        <td class="py-2 px-2 w-32 text-sm text-right text-gray-700">${l.subtotal === null ? "-" : money(l.subtotal)}</td>
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="remove-line" data-line="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris"><i class="fas fa-trash-alt"></i></button></td>
      </tr>`,
    )
    .join("");
  return `<table class="w-full text-left">
      <thead><tr>${["Produk", "Deskripsi", "Jumlah", "Satuan", "Harga Satuan", "Diskon %", "Pajak", "Jumlah Harga", ""]
        .map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${[2, 4, 5, 7].includes(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="text-xs text-gray-500 mt-2">Kosongkan harga satuan untuk memakai harga dari daftar harga.</p>
    <button type="button" data-action="add-line" class="mt-1 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>`;
}

function readonlyLinesTable(lines, currency, showFlow) {
  const heads = ["Produk", "Deskripsi", "Jumlah", ...(showFlow ? ["Dikirim", "Difakturkan"] : []), "Satuan", "Harga Satuan", "Diskon", "Pajak", "Jumlah Harga"];
  const right = new Set(heads.map((h, i) => (["Jumlah", "Dikirim", "Difakturkan", "Harga Satuan", "Diskon", "Jumlah Harga"].includes(h) ? i : -1)).filter((i) => i >= 0));
  const rows = lines
    .map(
      (l) => `<tr>
        <td class="py-2 px-4 text-sm">${esc(l.product_id?.[1])}</td>
        <td class="py-2 px-4 text-sm">${esc(l.name)}</td>
        <td class="py-2 px-4 text-sm text-right">${esc(l.product_uom_qty)}</td>
        ${showFlow ? `<td class="py-2 px-4 text-sm text-right">${esc(l.qty_delivered)}</td><td class="py-2 px-4 text-sm text-right">${esc(l.qty_invoiced)}</td>` : ""}
        <td class="py-2 px-4 text-sm">${esc(l.product_uom_id?.[1])}</td>
        <td class="py-2 px-4 text-sm text-right">${money(l.price_unit, currency)}</td>
        <td class="py-2 px-4 text-sm text-right">${l.discount ? `${esc(l.discount)}%` : "-"}</td>
        <td class="py-2 px-4 text-sm">${esc(l.taxLabel || "-")}</td>
        <td class="py-2 px-4 text-sm text-right">${money(l.price_subtotal, currency)}</td>
      </tr>`,
    )
    .join("");
  return `<table class="w-full text-left">
      <thead class="bg-gray-50"><tr>${heads.map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${right.has(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${rows}</tbody></table>`;
}

async function renderForm(id) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [users, terms, pricelists] = await Promise.all([referenceUsers(), referenceTerms(), referencePricelists()]);
  let so = null;
  let lines = [];
  if (id) {
    so = await readOne("sale.order", id, [
      "name", "state", "locked", "partner_id", "client_order_ref", "date_order", "validity_date", "user_id", "origin", "payment_term_id", "pricelist_id",
      "currency_id", "delivery_count", "picking_ids", "invoice_count", "invoice_ids", "invoice_status", "delivery_status", "amount_untaxed", "amount_tax",
      "amount_total",
    ]);
    if (!so) {
      app.innerHTML = '<p class="text-sm text-rose-600">Dokumen tidak ditemukan.</p>';
      return;
    }
    lines = await searchRead(
      "sale.order.line",
      [["order_id", "=", id], ["display_type", "=", false]],
      ["product_id", "name", "product_uom_qty", "qty_delivered", "qty_invoiced", "product_uom_id", "price_unit", "discount", "tax_ids", "price_subtotal"],
      { order: "sequence, id" },
    );
    const taxIds = [...new Set(lines.flatMap((l) => l.tax_ids))];
    const taxes = taxIds.length ? await searchRead("account.tax", [["id", "in", taxIds]], ["display_name"]) : [];
    const taxName = new Map(taxes.map((t) => [t.id, t.display_name]));
    lines.forEach((l) => {
      l.taxLabel = l.tax_ids.map((t) => taxName.get(t) ?? "").filter(Boolean).join(", ");
    });
  }
  const editable = !so || ["draft", "sent"].includes(so.state);
  const currency = so?.currency_id?.[1] ?? ctx.company.currency_id?.[1] ?? "IDR";
  const isQuotation = !so || ["draft", "sent"].includes(so.state);

  if (editable && (!form || form.id !== (so?.id ?? null))) {
    form = so
      ? {
          id: so.id,
          partner: so.partner_id ? { id: so.partner_id[0], display_name: so.partner_id[1] } : null,
          client_order_ref: so.client_order_ref || "", date_order: toInputDateTime(so.date_order), validity_date: so.validity_date || "",
          user_id: so.user_id?.[0] ?? null, origin: so.origin || "", payment_term_id: so.payment_term_id?.[0] ?? null, pricelist_id: so.pricelist_id?.[0] ?? null,
          initial: {
            partner_id: so.partner_id?.[0] ?? null, client_order_ref: so.client_order_ref || "", date_order: toInputDateTime(so.date_order),
            validity_date: so.validity_date || "", user_id: so.user_id?.[0] ?? null, origin: so.origin || "",
            payment_term_id: so.payment_term_id?.[0] ?? null, pricelist_id: so.pricelist_id?.[0] ?? null,
          },
          lines: lines.map((l) => ({
            id: l.id, text: l.product_id?.[1] ?? "", productText: l.product_id?.[1] ?? "", product_id: l.product_id?.[0] ?? null,
            name: l.name || "", product_uom_qty: l.product_uom_qty, product_uom_id: l.product_uom_id?.[0] ?? null,
            uom_label: l.product_uom_id?.[1] ?? "", price_unit: l.price_unit, price_unit0: l.price_unit, discount: l.discount || "", discount0: l.discount || "",
            initial: { product_id: l.product_id?.[0] ?? null, name: l.name || "", product_uom_qty: l.product_uom_qty },
            taxLabel: l.taxLabel, subtotal: l.price_subtotal,
          })),
          removed: [],
        }
      : {
          id: null, partner: null, client_order_ref: "", date_order: "", validity_date: "", user_id: ctx.user.id, origin: "", payment_term_id: null,
          pricelist_id: null, lines: [emptyLine()], removed: [],
        };
  }

  const title = so ? esc(so.name) : "Baru";
  const kind = isQuotation ? "Quotation" : "Sales Order";
  const f = form;
  const fields = editable
    ? `${fieldBlock("Pelanggan", `<input data-lookup="sale-customer" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(f.partner?.display_name ?? "")}" placeholder="Cari atau pilih pelanggan..." class="${INPUT}">`)}
       ${fieldBlock("Referensi Pelanggan", `<input data-value="client_order_ref" value="${esc(f.client_order_ref)}" class="${INPUT}">`)}
       ${fieldBlock("Tanggal Order", `<input type="datetime-local" data-value="date_order" value="${esc(f.date_order)}" class="${INPUT}">`)}
       ${fieldBlock("Berlaku Sampai", `<input type="date" data-value="validity_date" value="${esc(f.validity_date)}" class="${INPUT}">`)}
       ${fieldBlock("Salesperson", `<select data-value="user_id" class="${INPUT}">${selectOptions(users, f.user_id, "-")}</select>`)}
       ${fieldBlock("Daftar Harga", `<select data-value="pricelist_id" class="${INPUT}">${selectOptions(pricelists, f.pricelist_id, "Otomatis dari pelanggan")}</select>`)}
       ${fieldBlock("Syarat Pembayaran", `<select data-value="payment_term_id" class="${INPUT}">${selectOptions(terms, f.payment_term_id, "Otomatis dari pelanggan")}</select>`)}
       ${fieldBlock("Dokumen Sumber", `<input data-value="origin" value="${esc(f.origin)}" class="${INPUT}">`)}
       ${fieldBlock("Mata Uang", readonlyValue(currency))}`
    : `${fieldBlock("Pelanggan", readonlyValue(so.partner_id?.[1]))}
       ${fieldBlock("Referensi Pelanggan", readonlyValue(so.client_order_ref))}
       ${fieldBlock("Tanggal Order", readonlyValue(so.date_order ? dateTimeText(so.date_order) : ""))}
       ${fieldBlock("Berlaku Sampai", readonlyValue(so.validity_date ? dateText(so.validity_date) : ""))}
       ${fieldBlock("Salesperson", readonlyValue(so.user_id?.[1]))}
       ${fieldBlock("Daftar Harga", readonlyValue(so.pricelist_id?.[1]))}
       ${fieldBlock("Syarat Pembayaran", readonlyValue(so.payment_term_id?.[1]))}
       ${fieldBlock("Dokumen Sumber", readonlyValue(so.origin))}
       ${fieldBlock("Mata Uang", readonlyValue(currency))}`;

  const totals = so
    ? `<div class="mt-4 ml-auto w-full max-w-xs text-sm space-y-1">
        <div class="flex justify-between"><span class="text-gray-500">Sebelum Pajak</span><span id="t-untaxed">${money(so.amount_untaxed, currency)}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Pajak</span><span id="t-tax">${money(so.amount_tax, currency)}</span></div>
        <div class="flex justify-between border-t border-gray-200 pt-1 font-semibold"><span>Total</span><span id="t-total">${money(so.amount_total, currency)}</span></div>
      </div>`
    : '<p class="text-xs text-gray-500 mt-3">Pajak dan total dihitung Odoo setelah disimpan.</p>';

  const saveBar = editable
    ? `<div class="flex gap-2 mt-4">
         <button data-action="save" data-id="${so?.id ?? ""}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
         <a href="#/sale" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
       </div>` : "";
  const showTiles = so && (so.delivery_count > 0 || so.invoice_count > 0);

  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/sale" class="hover:text-indigo-600">Quotation & Sales Order</a> / ${title}</div>
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
      <div class="flex flex-wrap gap-2">${so ? actionBar(BUTTONS, so) : ""}</div>
      ${statusbar(FLOW, STATES, so?.state ?? "draft")}
    </div>
    ${showTiles ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: so.delivery_count, label: "Pengiriman", icon: "fa-truck", href: `#/delivery?ids=${so.picking_ids.join(",")}` },
      { count: so.invoice_count, label: "Faktur Pelanggan", icon: "fa-file-invoice-dollar", href: `#/invoice?ids=${so.invoice_ids.join(",")}` },
    ])}</div>` : ""}
    <div class="mb-3"><div class="text-sm text-gray-500">${kind}</div><h1 class="text-2xl font-bold text-gray-900">${title}</h1>
      ${so ? `<div class="mt-2 flex flex-wrap gap-2">${so.state === "sale" ? `${badge(DELIVERY_STATUS, so.delivery_status)} ${badge(INVOICE_STATUS, so.invoice_status)}` : ""}</div>` : ""}</div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">${fields}</section>
    <section id="section-lines" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto">
      <div class="text-sm font-semibold mb-3">Produk</div>
      <div id="lines-box">${editable ? linesTable() : readonlyLinesTable(lines, currency, so.state === "sale")}</div>
      ${totals}
      ${saveBar}
    </section>
    ${so ? chatterHtml("sale.order", so.id) : ""}`;
  if (so) loadMessages("sale.order", so.id);
}

/* ---------- Simpan dan aksi ---------- */

function resolveLine(l) {
  const text = l.text.trim();
  if (!text) return null;
  if (l.product_id && text === l.productText) return l;
  throw new Error(`Produk "${text}" belum dipilih dari daftar. Klik produk pada kotak saran.`);
}

function lineValues(l) {
  const qty = Number(l.product_uom_qty);
  if (!(qty > 0)) throw new Error(`Jumlah untuk "${l.text}" harus lebih dari 0.`);
  return { product_id: l.product_id, name: l.name, product_uom_qty: qty, product_uom_id: l.product_uom_id };
}

/* Harga dan diskon manual: baris yang dibuat dengan harga eksplisit dikembalikan ke harga daftar saat jumlahnya
 * diubah (technical_price_unit sama dengan price_unit dianggap "bukan manual"). Karena itu keduanya tidak ikut
 * saat membuat baris; ditulis sebagai langkah kedua sehingga tetap dianggap manual (lihat D10). */
const filled = (value) => String(value).trim() !== "";
const manualPrice = (l) => filled(l.price_unit) && (l.id ? Number(l.price_unit) !== Number(l.price_unit0) : true);
const manualDiscount = (l) => (l.id ? Number(l.discount || 0) !== Number(l.discount0 || 0) : filled(l.discount) && Number(l.discount) !== 0);

async function applyManualValues(orderId, resolved, knownLineIds) {
  if (!resolved.some((l) => manualPrice(l) || manualDiscount(l))) return;
  const rows = await searchRead("sale.order.line", [["order_id", "=", orderId], ["display_type", "=", false]], ["price_unit", "discount"], { order: "sequence, id" });
  const fresh = rows.filter((r) => !knownLineIds.has(r.id));
  let nextNew = 0;
  for (const l of resolved) {
    const row = l.id ? rows.find((r) => r.id === l.id) : fresh[nextNew++];
    if (!row) continue;
    const vals = {};
    if (manualPrice(l) && Number(l.price_unit) !== row.price_unit) vals.price_unit = Number(l.price_unit);
    if (manualDiscount(l) && Number(l.discount || 0) !== row.discount) vals.discount = Number(l.discount || 0);
    if (Object.keys(vals).length) await call("sale.order.line", "write", { ids: [row.id], vals });
  }
}

function changedHeader() {
  const f = form;
  const current = {
    partner_id: f.partner?.id ?? null, client_order_ref: f.client_order_ref, date_order: f.date_order, validity_date: f.validity_date,
    user_id: Number(f.user_id) || null, origin: f.origin, payment_term_id: Number(f.payment_term_id) || null, pricelist_id: Number(f.pricelist_id) || null,
  };
  const initial = f.initial ?? {};
  const header = {};
  const differs = (key) => !f.id || current[key] !== initial[key];
  if (differs("partner_id")) header.partner_id = current.partner_id;
  if (differs("client_order_ref")) header.client_order_ref = current.client_order_ref || false;
  if (differs("origin")) header.origin = current.origin || false;
  if (differs("user_id")) header.user_id = current.user_id || false;
  // Syarat bayar dan daftar harga kosong pada quotation baru dihitung Odoo dari pelanggan.
  if (f.id ? differs("payment_term_id") : current.payment_term_id) header.payment_term_id = current.payment_term_id || false;
  if (f.id ? differs("pricelist_id") : current.pricelist_id) header.pricelist_id = current.pricelist_id || false;
  if (current.date_order && differs("date_order")) header.date_order = fromInputDateTime(current.date_order);
  if (f.id ? differs("validity_date") : current.validity_date) header.validity_date = current.validity_date || false;
  return header;
}

async function persist() {
  if (!form.partner) throw new Error("Pilih pelanggan dari kotak saran.");
  const resolved = form.lines.map(resolveLine).filter(Boolean);
  if (!resolved.length) throw new Error("Tambahkan minimal satu barang.");
  const header = changedHeader();
  if (!form.id) {
    const [id] = await call("sale.order", "create", {
      vals_list: [{ ...header, order_line: resolved.map((l) => [0, 0, lineValues(l)]) }],
    });
    await applyManualValues(id, resolved, new Set());
    return id;
  }
  const knownLineIds = new Set(form.lines.filter((l) => l.id).map((l) => l.id).concat(form.removed));
  const commands = [];
  for (const l of resolved) {
    if (!l.id) {
      commands.push([0, 0, lineValues(l)]);
      continue;
    }
    const vals = lineValues(l);
    const before = l.initial ?? {};
    const changed = Object.fromEntries(Object.entries({ product_id: vals.product_id, name: vals.name, product_uom_qty: vals.product_uom_qty })
      .filter(([k, v]) => v !== before[k]));
    if (Object.keys(changed).length) commands.push([1, l.id, changed]);
  }
  commands.push(...form.removed.map((lineId) => [2, lineId, 0]));
  const vals = { ...header, ...(commands.length ? { order_line: commands } : {}) };
  if (Object.keys(vals).length) await call("sale.order", "write", { ids: [form.id], vals });
  await applyManualValues(form.id, resolved, knownLineIds);
  return form.id;
}

async function openDelivery(id) {
  const open = await searchRead("stock.picking", [["sale_id", "=", id], ["state", "not in", ["done", "cancel"]]], ["id"], { order: "id" });
  if (open.length) location.hash = `#/delivery/${open[0].id}`;
  else location.hash = `#/delivery?so=${id}`;
}

/** Aksi Odoo yang dapat mengembalikan wizard (mis. batal quotation yang sudah dikirim lewat email). */
async function runAction(method, id) {
  const result = await call("sale.order", method, { ids: [id] });
  if (result === true || result === false || result == null) return true;
  if (result.res_model === "sale.order.cancel") {
    const context = result.context ?? {};
    const wizard = await call("sale.order.cancel", "create", { vals_list: [{}], context });
    await call("sale.order.cancel", "action_cancel", { ids: wizard, context });
    return true;
  }
  throw new Error(`Odoo meminta langkah tambahan ("${result.name ?? result.res_model}") yang belum didukung UI ini. Selesaikan di Odoo.`);
}

/* ---------- Dialog Buat Faktur (wizard sale.advance.payment.inv) ---------- */

function openInvoiceDialog(orderId) {
  invoiceDialog = { orderId };
  openModal(
    "Buat Faktur",
    `<form data-form="invoice" class="space-y-4">
       ${fieldBlock("Jenis Faktur", `<select data-invoice="method" class="${INPUT}">${INVOICE_METHODS.map(([k, label]) => `<option value="${k}">${esc(label)}</option>`).join("")}</select>`)}
       <div id="invoice-amount" class="hidden">${fieldBlock("Uang Muka", `<input type="number" min="0" step="any" data-invoice="amount" value="" class="${INPUT} text-right">`)}</div>
     </form>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="invoice-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Buat Faktur</button>`,
    () => {
      invoiceDialog = null;
    },
  );
}

async function createInvoice(button) {
  const { orderId } = invoiceDialog;
  const method = document.querySelector('[data-invoice="method"]').value;
  const amount = Number(document.querySelector('[data-invoice="amount"]').value);
  const invoiceId = await guarded(button, async () => {
    if (method !== "delivered" && !(amount > 0)) throw new Error("Isi jumlah uang muka.");
    const context = { active_model: "sale.order", active_ids: [orderId], active_id: orderId };
    const vals = { advance_payment_method: method, ...(method === "percentage" ? { amount } : {}), ...(method === "fixed" ? { fixed_amount: amount } : {}) };
    const [wizard] = await call("sale.advance.payment.inv", "create", { vals_list: [vals], context });
    const result = await call("sale.advance.payment.inv", "create_invoices", { ids: [wizard], context });
    if (result?.res_id) return result.res_id;
    const [{ invoice_ids: ids }] = await call("sale.order", "read", { ids: [orderId], fields: ["invoice_ids"] });
    return ids[ids.length - 1];
  });
  if (!invoiceId) return;
  closeModal();
  toast("Faktur pelanggan dibuat (draft).");
  location.hash = `#/invoice/${invoiceId}`;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  const def = BUTTONS.find((b) => b.action === action);

  if (action === "refresh") reload();
  else if (action === "discard") form = null;
  else if (action === "add-line") {
    form.lines.push(emptyLine());
    document.querySelector("#lines-box").innerHTML = linesTable();
  } else if (action === "remove-line") {
    const [removed] = form.lines.splice(Number(el.dataset.line), 1);
    if (removed?.id) form.removed.push(removed.id);
    if (!form.lines.length) form.lines.push(emptyLine());
    document.querySelector("#lines-box").innerHTML = linesTable();
  } else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "Quotation dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/sale/${saved}`;
      else reload();
    }
  } else if (action === "ship") await openDelivery(id);
  else if (action === "invoice") openInvoiceDialog(id);
  else if (action === "invoice-confirm") await createInvoice(el);
  else if (action === "cancel" && !window.confirm("Batalkan dokumen ini?")) {
    /* dibatalkan pengguna */
  } else if (def?.method) {
    const ok = await guarded(el, async () => {
      if (form?.id === id) await persist(); // simpan perubahan quotation sebelum mengubah status
      return runAction(def.method, id);
    });
    if (ok !== undefined) {
      form = null;
      toast(DONE_MESSAGE[action]);
      reload();
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.value) form[el.dataset.value] = el.value;
  else if (el.dataset.line !== undefined) {
    form.lines[Number(el.dataset.line)][el.dataset.field] = el.value;
    if (el.dataset.field === "text") runLookup(el, 250);
  } else if (el.dataset.lookup === "sale-customer") {
    form.partner = null;
    runLookup(el, 250);
  }
}

export function onChange(event, el) {
  // Metode faktur uang muka membutuhkan jumlah; faktur reguler tidak.
  if (el.dataset.invoice === "method") {
    document.querySelector("#invoice-amount")?.classList.toggle("hidden", el.value === "delivered");
  }
}

export async function onSubmit(event, formEl, kind) {
  if (kind === "invoice") await createInvoice(null);
}
