// RFQ dan Purchase Order (purchase.order). Struktur form mengikuti view Odoo 19: judul "Request for
// Quotation" atau "Purchase Order", tombol header menurut status, bilah status draft/sent/purchase,
// tombol statistik Receipt dan Vendor Bills, field yang dapat diedit selama RFQ, tabel barang
// (diterima, ditagih, harga, pajak, jumlah) dan total.
import {
  INPUT, actionBar, app, badge, call, cell, chatterHtml, closeLookup, ctx, dateText, esc, fieldBlock, filterSelect, fromInputDateTime,
  guarded, loadMessages, money, pageHeader, readOne, readonlyValue, referenceUsers, registerLookup, rowLink, runLookup, searchRead,
  selectOptions, statTiles, statusbar, table, toInputDateTime, toast, dateTimeText,
} from "../common.js";
import { printButton } from "../print.js";

const STATES = {
  draft: ["RFQ", "muted"],
  sent: ["RFQ Terkirim", "info"],
  "to approve": ["Menunggu Persetujuan", "warning"],
  purchase: ["Purchase Order", "success"],
  done: ["Terkunci", "success"],
  cancel: ["Dibatalkan", "danger"],
};
const FLOW = ["draft", "sent", "purchase"]; // statusbar_visible Odoo
const INVOICE_STATUS = {
  no: ["Tidak Ada Tagihan", "muted"],
  "to invoice": ["Perlu Ditagih", "warning"],
  invoiced: ["Sudah Ditagih", "success"],
};
const RECEIPT_STATUS = {
  pending: ["Belum Diterima", "muted"],
  partial: ["Diterima Sebagian", "warning"],
  full: ["Diterima Penuh", "success"],
};

/* Tombol header Odoo (purchase_order_form). Method null = ditangani khusus. */
const BUTTONS = [
  { action: "confirm", label: "Konfirmasi Order", method: "button_confirm", kind: "primary", show: (o) => ["draft", "sent"].includes(o.state) },
  { action: "approve", label: "Setujui Order", method: "button_approve", kind: "primary", show: (o) => o.state === "to approve" && ctx.flags.purchaseManager },
  { action: "receive", label: "Terima Barang", method: null, kind: "primary", show: (o) => o.state === "purchase" && !o.is_shipped && o.incoming_picking_count > 0 },
  { action: "bill", label: "Buat Tagihan", method: "action_create_invoice", kind: "primary", show: (o) => ["purchase", "done"].includes(o.state) && o.invoice_status === "to invoice" },
  { action: "draft", label: "Kembalikan ke Draft", method: "button_draft", show: (o) => o.state === "cancel" },
  { action: "lock", label: "Kunci", method: "button_lock", show: (o) => !o.locked && o.state === "purchase" && o.lock_confirmed_po === "lock" },
  { action: "unlock", label: "Buka Kunci", method: "button_unlock", show: (o) => o.locked && ctx.flags.purchaseManager },
  { action: "cancel", label: "Batalkan", method: "button_cancel", kind: "danger", show: (o) => ["draft", "to approve", "sent", "purchase"].includes(o.state) && !o.locked },
];
const DONE_MESSAGE = {
  confirm: "Purchase Order dikonfirmasi.",
  approve: "Purchase Order disetujui.",
  draft: "Dikembalikan ke draft.",
  lock: "Purchase Order dikunci.",
  unlock: "Kunci dibuka.",
  cancel: "Purchase Order dibatalkan.",
};

let form = null;
let terms = null;
let last = { sub: "", query: new URLSearchParams() };

export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

/* ---------- Kotak saran ---------- */

registerLookup("po-vendor", {
  search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: "name" }),
  isChosen: (input) => form?.partner?.display_name === input.value,
  choose: (input, item) => {
    form.partner = item;
    input.value = item.display_name;
  },
});
registerLookup("po-product", {
  search: (q) =>
    searchRead(
      "product.product",
      [["purchase_ok", "=", true], ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])],
      ["display_name", "uom_id", "description_purchase"],
      { limit: 10, order: "name" },
    ),
  sub: (r) => r.uom_id?.[1] ?? "",
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
    if (!line.name || line.name === line.lastAutoName) line.name = item.description_purchase || item.display_name;
    line.lastAutoName = line.name;
    document.querySelector("#lines-box").innerHTML = linesTable();
    document.querySelector(`[data-line="${i}"][data-field="product_qty"]`)?.focus();
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
  const ids = (query.get("ids") ?? "").split(",").map(Number).filter(Boolean);
  const domain = [];
  if (filter === "rfq") domain.push(["state", "in", ["draft", "sent", "to approve"]]);
  else if (filter) domain.push(["state", "=", filter]);
  if (ids.length) domain.push(["id", "in", ids]);
  const partner = Number(query.get("partner")) || null;
  if (partner) domain.push(["partner_id", "=", partner]);
  const rows = await searchRead(
    "purchase.order",
    domain,
    ["name", "partner_id", "user_id", "date_order", "origin", "amount_total", "currency_id", "state", "invoice_status", "receipt_status"],
    { order: "id desc", limit: 80 },
  );
  const options = [["", "Semua status"], ["rfq", "RFQ (draft, terkirim, menunggu)"], ["purchase", "Purchase Order"], ["done", "Terkunci"], ["cancel", "Dibatalkan"]];
  const body = rows
    .map((r) =>
      rowLink(`#/po/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(r.partner_id?.[1] ?? ""),
        cell(r.user_id?.[1] ?? ""),
        cell(dateText(r.date_order)),
        cell(r.origin || "-"),
        cell(money(r.amount_total, r.currency_id?.[1]), { right: true }),
        cell(badge(STATES, r.state), { raw: true }),
        cell(r.state === "purchase" || r.state === "done" ? badge(INVOICE_STATUS, r.invoice_status) : "", { raw: true }),
        cell(r.state === "purchase" || r.state === "done" ? badge(RECEIPT_STATUS, r.receipt_status) : "", { raw: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "RFQ & Purchase Order",
      `${filterSelect(options, filter)}
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
       <a href="#/po/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>RFQ Baru</a>`,
    ) +
    (partner
      ? `<p class="text-sm text-gray-500 mb-3">Difilter per pemasok. <a href="#/po" class="text-indigo-600 hover:underline">Tampilkan semua</a></p>`
      : "") +
    table(
      [{ label: "Nomor" }, { label: "Pemasok" }, { label: "Pembeli" }, { label: "Tanggal" }, { label: "Dokumen Sumber" }, { label: "Total", right: true }, { label: "Status" }, { label: "Tagihan" }, { label: "Penerimaan" }],
      body,
      "Belum ada RFQ atau Purchase Order.",
    );
}

const emptyLine = () => ({
  id: null, text: "", product_id: null, productText: "", name: "", product_qty: 1, product_uom_id: null, uom_label: "",
  price_unit: "", taxLabel: "", subtotal: null,
});

function linesTable() {
  const rows = form.lines
    .map(
      (l, i) => `<tr class="align-top">
        <td class="py-2 pr-2 min-w-48"><input data-lookup="po-product" autocomplete="off" role="combobox" aria-autocomplete="list" data-line="${i}" data-field="text" value="${esc(l.text)}" placeholder="Cari atau pilih produk..." class="${INPUT}"></td>
        <td class="py-2 px-2 min-w-40"><input data-line="${i}" data-field="name" value="${esc(l.name)}" class="${INPUT}"></td>
        <td class="py-2 px-2 w-24"><input type="number" min="0" step="any" data-line="${i}" data-field="product_qty" value="${esc(l.product_qty)}" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 w-20 text-sm text-gray-600">${esc(l.uom_label || "-")}</td>
        <td class="py-2 px-2 w-36"><input type="number" min="0" step="any" data-line="${i}" data-field="price_unit" value="${esc(l.price_unit)}" placeholder="otomatis" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 w-32 text-sm text-gray-600">${esc(l.taxLabel || "-")}</td>
        <td class="py-2 px-2 w-32 text-sm text-right text-gray-700">${l.subtotal === null ? "-" : money(l.subtotal)}</td>
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="remove-line" data-line="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris"><i class="fas fa-trash-alt"></i></button></td>
      </tr>`,
    )
    .join("");
  return `<table class="w-full text-left">
      <thead><tr>${["Produk", "Deskripsi", "Jumlah", "Satuan", "Harga Satuan", "Pajak", "Jumlah Harga", ""]
        .map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${[2, 4, 6].includes(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="text-xs text-gray-500 mt-2">Kosongkan harga satuan untuk memakai harga dari daftar harga pemasok.</p>
    <button type="button" data-action="add-line" class="mt-1 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>`;
}

function readonlyLinesTable(lines, currency, showReceived) {
  const heads = ["Produk", "Deskripsi", "Jumlah", ...(showReceived ? ["Diterima", "Ditagih"] : []), "Satuan", "Harga Satuan", "Pajak", "Jumlah Harga"];
  const right = new Set([2, ...(showReceived ? [3, 4, 6] : [4]), showReceived ? 8 : 6]);
  const rows = lines
    .map(
      (l) => `<tr>
        <td class="py-2 px-4 text-sm">${esc(l.product_id?.[1])}</td>
        <td class="py-2 px-4 text-sm">${esc(l.name)}</td>
        <td class="py-2 px-4 text-sm text-right">${esc(l.product_qty)}</td>
        ${showReceived ? `<td class="py-2 px-4 text-sm text-right">${esc(l.qty_received)}</td><td class="py-2 px-4 text-sm text-right">${esc(l.qty_invoiced)}</td>` : ""}
        <td class="py-2 px-4 text-sm">${esc(l.product_uom_id?.[1])}</td>
        <td class="py-2 px-4 text-sm text-right">${money(l.price_unit, currency)}</td>
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
  const users = await referenceUsers();
  terms ??= await searchRead("account.payment.term", [], ["display_name"], { limit: 50 });
  let po = null;
  let lines = [];
  if (id) {
    po = await readOne("purchase.order", id, [
      "name", "state", "partner_id", "partner_ref", "date_order", "date_approve", "date_planned", "user_id", "origin", "payment_term_id",
      "currency_id", "incoming_picking_count", "picking_ids", "invoice_count", "invoice_ids", "invoice_status", "receipt_status", "is_shipped",
      "locked", "lock_confirmed_po", "amount_untaxed", "amount_tax", "amount_total",
    ]);
    if (!po) {
      app.innerHTML = '<p class="text-sm text-rose-600">Dokumen tidak ditemukan.</p>';
      return;
    }
    lines = await searchRead(
      "purchase.order.line",
      [["order_id", "=", id], ["display_type", "=", false]],
      ["product_id", "name", "product_qty", "qty_received", "qty_invoiced", "product_uom_id", "price_unit", "tax_ids", "price_subtotal"],
      { order: "sequence, id" },
    );
    const taxIds = [...new Set(lines.flatMap((l) => l.tax_ids))];
    const taxes = taxIds.length ? await searchRead("account.tax", [["id", "in", taxIds]], ["display_name"]) : [];
    const taxName = new Map(taxes.map((t) => [t.id, t.display_name]));
    lines.forEach((l) => {
      l.taxLabel = l.tax_ids.map((t) => taxName.get(t) ?? "").filter(Boolean).join(", ");
    });
  }
  const editable = !po || ["draft", "sent"].includes(po.state);
  const currency = po?.currency_id?.[1] ?? ctx.company.currency_id?.[1] ?? "IDR";
  const isRfq = !po || ["draft", "sent"].includes(po.state);

  if (editable && (!form || form.id !== (po?.id ?? null))) {
    form = po
      ? {
          id: po.id,
          partner: po.partner_id ? { id: po.partner_id[0], display_name: po.partner_id[1] } : null,
          partner_ref: po.partner_ref || "", date_order: toInputDateTime(po.date_order),
          date_planned: toInputDateTime(po.date_planned), date_planned0: toInputDateTime(po.date_planned),
          user_id: po.user_id?.[0] ?? null, origin: po.origin || "", payment_term_id: po.payment_term_id?.[0] ?? null,
          initial: {
            partner_id: po.partner_id?.[0] ?? null, partner_ref: po.partner_ref || "", date_order: toInputDateTime(po.date_order),
            user_id: po.user_id?.[0] ?? null, origin: po.origin || "", payment_term_id: po.payment_term_id?.[0] ?? null,
          },
          lines: lines.map((l) => ({
            id: l.id, text: l.product_id?.[1] ?? "", productText: l.product_id?.[1] ?? "", product_id: l.product_id?.[0] ?? null,
            name: l.name || "", product_qty: l.product_qty, product_uom_id: l.product_uom_id?.[0] ?? null,
            uom_label: l.product_uom_id?.[1] ?? "", price_unit: l.price_unit, price_unit0: l.price_unit,
            initial: { product_id: l.product_id?.[0] ?? null, name: l.name || "", product_qty: l.product_qty },
            taxLabel: l.taxLabel, subtotal: l.price_subtotal,
          })),
          removed: [],
        }
      : {
          id: null, partner: null, partner_ref: "", date_order: "", date_planned: "", date_planned0: "", user_id: ctx.user.id,
          origin: "", payment_term_id: null, lines: [emptyLine()], removed: [],
        };
  }

  const title = po ? esc(po.name) : "Baru";
  const kind = isRfq ? "Request for Quotation" : "Purchase Order";
  const f = form;
  const fields = editable
    ? `${fieldBlock("Pemasok", `<input data-lookup="po-vendor" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(f.partner?.display_name ?? "")}" placeholder="Cari atau pilih pemasok..." class="${INPUT}">`)}
       ${fieldBlock("Referensi Pemasok", `<input data-value="partner_ref" value="${esc(f.partner_ref)}" class="${INPUT}">`)}
       ${fieldBlock("Batas Waktu Order", `<input type="datetime-local" data-value="date_order" value="${esc(f.date_order)}" class="${INPUT}">`)}
       ${fieldBlock("Perkiraan Tiba", `<input type="datetime-local" data-value="date_planned" value="${esc(f.date_planned)}" class="${INPUT}">`)}
       ${fieldBlock("Pembeli", `<select data-value="user_id" class="${INPUT}">${selectOptions(users, f.user_id, "-")}</select>`)}
       ${fieldBlock("Dokumen Sumber", `<input data-value="origin" value="${esc(f.origin)}" class="${INPUT}">`)}
       ${fieldBlock("Syarat Pembayaran", `<select data-value="payment_term_id" class="${INPUT}">${selectOptions(terms, f.payment_term_id, "-")}</select>`)}
       ${fieldBlock("Mata Uang", readonlyValue(currency))}`
    : `${fieldBlock("Pemasok", readonlyValue(po.partner_id?.[1]))}
       ${fieldBlock("Referensi Pemasok", readonlyValue(po.partner_ref))}
       ${fieldBlock("Tanggal Konfirmasi", readonlyValue(po.date_approve ? dateTimeText(po.date_approve) : ""))}
       ${fieldBlock("Perkiraan Tiba", readonlyValue(po.date_planned ? dateTimeText(po.date_planned) : ""))}
       ${fieldBlock("Pembeli", readonlyValue(po.user_id?.[1]))}
       ${fieldBlock("Dokumen Sumber", readonlyValue(po.origin))}
       ${fieldBlock("Syarat Pembayaran", readonlyValue(po.payment_term_id?.[1]))}
       ${fieldBlock("Mata Uang", readonlyValue(currency))}`;

  const totals = po
    ? `<div class="mt-4 ml-auto w-full max-w-xs text-sm space-y-1">
        <div class="flex justify-between"><span class="text-gray-500">Sebelum Pajak</span><span id="t-untaxed">${money(po.amount_untaxed, currency)}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Pajak</span><span id="t-tax">${money(po.amount_tax, currency)}</span></div>
        <div class="flex justify-between border-t border-gray-200 pt-1 font-semibold"><span>Total</span><span id="t-total">${money(po.amount_total, currency)}</span></div>
      </div>`
    : '<p class="text-xs text-gray-500 mt-3">Pajak dan total dihitung Odoo setelah disimpan.</p>';

  const saveBar = editable
    ? `<div class="flex gap-2 mt-4">
         <button data-action="save" data-id="${po?.id ?? ""}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
         <a href="#/po" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
       </div>` : "";
  const showTiles = po && (
    po.incoming_picking_count > 0 || (po.invoice_count > 0 && !["draft", "sent", "to approve"].includes(po.state))
  );

  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/po" class="hover:text-indigo-600">RFQ & Purchase Order</a> / ${title}</div>
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
      <div class="flex flex-wrap gap-2">${po ? actionBar(BUTTONS, po) + printButton("purchase.order", po.id) : ""}</div>
      ${statusbar(FLOW, STATES, po?.state ?? "draft")}
    </div>
    ${showTiles ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: po.incoming_picking_count, label: "Penerimaan", icon: "fa-truck", href: `#/receipt?ids=${po.picking_ids.join(",")}` },
      { count: ["draft", "sent", "to approve"].includes(po.state) ? 0 : po.invoice_count, label: "Tagihan Vendor", icon: "fa-file-invoice", href: `#/bill?ids=${po.invoice_ids.join(",")}` },
    ])}</div>` : ""}
    <div class="mb-3"><div class="text-sm text-gray-500">${kind}</div><h1 class="text-2xl font-bold text-gray-900">${title}</h1>
      ${po ? `<div class="mt-2 flex flex-wrap gap-2">${po.state === "purchase" || po.state === "done" ? `${badge(RECEIPT_STATUS, po.receipt_status)} ${badge(INVOICE_STATUS, po.invoice_status)}` : ""}</div>` : ""}</div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">${fields}</section>
    <section id="section-lines" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto">
      <div class="text-sm font-semibold mb-3">Produk</div>
      <div id="lines-box">${editable ? linesTable() : readonlyLinesTable(lines, currency, po.state === "purchase" || po.state === "done")}</div>
      ${totals}
      ${saveBar}
    </section>
    ${po ? chatterHtml("purchase.order", po.id) : ""}`;
  if (po) loadMessages("purchase.order", po.id);
}

/* ---------- Simpan dan aksi ---------- */

function resolveLine(l) {
  const text = l.text.trim();
  if (!text) return null;
  if (l.product_id && text === l.productText) return l;
  throw new Error(`Produk "${text}" belum dipilih dari daftar. Klik produk pada kotak saran.`);
}

function lineValues(l) {
  const qty = Number(l.product_qty);
  if (!(qty > 0)) throw new Error(`Jumlah untuk "${l.text}" harus lebih dari 0.`);
  return { product_id: l.product_id, name: l.name, product_qty: qty, product_uom_id: l.product_uom_id };
}

/* Harga manual: Odoo menghitung ulang harga baris yang dibuat dengan harga eksplisit setiap kali header
 * ditulis (technical_price_unit sama dengan price_unit dianggap "bukan manual"). Karena itu harga tidak
 * ikut saat membuat baris; ditulis sebagai langkah kedua sehingga tetap dianggap manual. */
const hasExplicitPrice = (l) => String(l.price_unit).trim() !== "" && (l.id ? Number(l.price_unit) !== Number(l.price_unit0) : true);

async function applyManualPrices(orderId, resolved, knownLineIds) {
  const wanted = resolved.filter(hasExplicitPrice);
  if (!wanted.length) return;
  const rows = await searchRead("purchase.order.line", [["order_id", "=", orderId], ["display_type", "=", false]], ["price_unit"], { order: "sequence, id" });
  const fresh = rows.filter((r) => !knownLineIds.has(r.id));
  let nextNew = 0;
  for (const l of resolved) {
    const row = l.id ? rows.find((r) => r.id === l.id) : fresh[nextNew++];
    if (!row || !hasExplicitPrice(l)) continue;
    if (Number(l.price_unit) !== row.price_unit) {
      await call("purchase.order.line", "write", { ids: [row.id], vals: { price_unit: Number(l.price_unit) } });
    }
  }
}

function changedHeader() {
  const f = form;
  const current = {
    partner_id: f.partner?.id ?? null, partner_ref: f.partner_ref, date_order: f.date_order, user_id: Number(f.user_id) || null,
    origin: f.origin, payment_term_id: Number(f.payment_term_id) || null,
  };
  const initial = f.initial ?? {};
  const header = {};
  if (!f.id || current.partner_id !== initial.partner_id) header.partner_id = current.partner_id;
  if (!f.id || current.partner_ref !== initial.partner_ref) header.partner_ref = current.partner_ref || false;
  if (!f.id || current.origin !== initial.origin) header.origin = current.origin || false;
  if (!f.id || current.user_id !== initial.user_id) header.user_id = current.user_id || false;
  if (!f.id || current.payment_term_id !== initial.payment_term_id) header.payment_term_id = current.payment_term_id || false;
  if (current.date_order && (!f.id || current.date_order !== initial.date_order)) header.date_order = fromInputDateTime(current.date_order);
  if (f.date_planned && f.date_planned !== f.date_planned0) header.date_planned = fromInputDateTime(f.date_planned);
  return header;
}

async function persist() {
  if (!form.partner) throw new Error("Pilih pemasok dari kotak saran.");
  const resolved = form.lines.map(resolveLine).filter(Boolean);
  if (!resolved.length) throw new Error("Tambahkan minimal satu barang.");
  const header = changedHeader();
  if (!form.id) {
    const [id] = await call("purchase.order", "create", {
      vals_list: [{ ...header, order_line: resolved.map((l) => [0, 0, lineValues(l)]) }],
    });
    await applyManualPrices(id, resolved, new Set());
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
    const changed = Object.fromEntries(Object.entries({ product_id: vals.product_id, name: vals.name, product_qty: vals.product_qty })
      .filter(([k, v]) => v !== before[k]));
    if (Object.keys(changed).length) commands.push([1, l.id, changed]);
  }
  commands.push(...form.removed.map((lineId) => [2, lineId, 0]));
  const vals = { ...header, ...(commands.length ? { order_line: commands } : {}) };
  if (Object.keys(vals).length) await call("purchase.order", "write", { ids: [form.id], vals });
  await applyManualPrices(form.id, resolved, knownLineIds);
  return form.id;
}

async function openReceipt(id) {
  const open = await searchRead("stock.picking", [["purchase_id", "=", id], ["state", "not in", ["done", "cancel"]]], ["id"], { order: "id" });
  if (open.length) location.hash = `#/receipt/${open[0].id}`;
  else location.hash = `#/receipt?po=${id}`;
}

async function createBill(button, id) {
  const bills = await guarded(button, async () => {
    await call("purchase.order", "action_create_invoice", { ids: [id] });
    const [{ invoice_ids: invoiceIds }] = await call("purchase.order", "read", { ids: [id], fields: ["invoice_ids"] });
    return invoiceIds;
  });
  if (bills?.length) {
    toast("Tagihan vendor dibuat (draft).");
    location.hash = `#/bill/${bills[bills.length - 1]}`;
  }
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
      toast(wasNew ? "RFQ dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/po/${saved}`;
      else reload();
    }
  } else if (action === "receive") await openReceipt(id);
  else if (action === "bill") await createBill(el, id);
  else if (action === "cancel" && !window.confirm("Batalkan dokumen ini?")) {
    /* dibatalkan pengguna */
  } else if (def?.method) {
    const ok = await guarded(el, async () => {
      if (form?.id === id) await persist(); // simpan perubahan RFQ sebelum mengubah status
      return call("purchase.order", def.method, { ids: [id] });
    });
    if (ok !== undefined) {
      form = null;
      toast(DONE_MESSAGE[action]);
      reload();
    }
  }
}

export function onInput(event, el) {
  if (el.dataset.value) form[el.dataset.value] = el.value;
  else if (el.dataset.line !== undefined) {
    form.lines[Number(el.dataset.line)][el.dataset.field] = el.value;
    if (el.dataset.field === "text") runLookup(el, 250);
  } else if (el.dataset.lookup === "po-vendor") {
    form.partner = null;
    runLookup(el, 250);
  }
}
