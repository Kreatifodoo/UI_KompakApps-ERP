// Quotation dan Sales Order (sale.order). Struktur form mengikuti view Odoo 19: judul "Quotation" atau
// "Sales Order", tombol header menurut status, bilah status draft/sent/sale, tombol statistik Delivery dan
// Invoices, field yang dapat diedit selama quotation, tabel barang (dikirim, ditagih, harga, diskon, pajak,
// jumlah), dialog Buat Faktur (wizard sale.advance.payment.inv), dan total.
import {
  INPUT, actionBar, app, badge, call, cell, chatterHtml, closeLookup, closeModal, ctx, dateText, esc, fieldBlock, filterSelect, fromInputDateTime,
  guarded, loadMessages, money, openModal, pageHeader, readOne, readonlyValue, referencePricelists, referenceTerms, referenceUsers, referenceWarehouses, registerLookup,
  rowLink, runLookup, searchBox, searchRead, selectOptions, statTiles, statusbar, table, toInputDateTime, toast, dateTimeText,
} from "../common.js";
import { loadTaxNames, productDefaultTaxes, registerTaxes, taxCell, taxChange, taxList } from "../taxpick.js";
import { analyticCell, distributionChange, preloadAnalytic, readDistribution, registerAnalytic } from "../analyticpick.js";
import { printButton } from "../print.js";
import { defaultWarehouse, stockHint, stockText, storableStock } from "../stockqty.js";

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
  { action: "coupon", label: "Kode Kupon", method: null, show: (o) => !o.locked && o.state !== "cancel" },
  { action: "reward", label: "Hadiah", method: null, show: (o) => !o.locked && o.state !== "cancel" },
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
let whs = []; // gudang aktif, untuk info stok per baris (Q40)
let last = { sub: "", query: new URLSearchParams() };
let invoiceDialog = null; // { orderId }
let rewardDialog = null; // { orderId, rewards, selected, product }

export const leave = () => {
  form = null;
  invoiceDialog = null;
  rewardDialog = null;
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
/** Gudang yang menyuplai dokumen: pilihan pengguna, atau gudang bawaan bila "Otomatis". */
const docWarehouse = () => whs.find((w) => w.id === Number(form?.warehouse_id)) ?? defaultWarehouse(whs);
const docStockLocation = () => docWarehouse()?.lot_stock_id?.[0] ?? null;

/** Info stok di bawah produk pada baris; merah bila jumlah melebihi stok tersedia di gudang dokumen. Kosong untuk jasa dan barang tanpa pelacakan stok. */
const stockLine = (l) => (l.product_id && l.stock ? stockHint(l.stock, l.uom_label, docWarehouse()?.display_name, l.product_uom_qty, true) : "");
function paintStock(i) {
  const box = document.querySelector(`#sale-stock-${i}`);
  if (box && form?.lines[i]) box.innerHTML = stockLine(form.lines[i]);
}
/** Ambil ulang stok semua baris untuk gudang yang sedang berlaku (saat form dibuka dan saat gudang diganti). */
async function refreshStock() {
  const current = form;
  if (!current) return;
  const stock = await storableStock(current.lines.map((l) => l.product_id), docStockLocation());
  if (form !== current) return;
  current.lines.forEach((l, i) => {
    l.stock = l.product_id ? stock.get(l.product_id) ?? null : null;
    paintStock(i);
  });
}

registerLookup("sale-product", {
  search: async (q) => {
    const items = await searchRead(
      "product.product",
      [["sale_ok", "=", true], ...(q ? ["|", ["name", "ilike", q], ["default_code", "ilike", q]] : [])],
      ["display_name", "uom_id", "description_sale", "list_price"],
      { limit: 10, order: "name" },
    );
    const stock = await storableStock(items.map((i) => i.id), docStockLocation());
    return items.map((i) => ({ ...i, stock: stock.get(i.id) ?? null }));
  },
  sub: (r) => `${money(r.list_price)} / ${r.uom_id?.[1] ?? ""}${r.stock ? ` · ${stockText(r.stock)}` : ""}`,
  isChosen: (input) => {
    const line = form?.lines[Number(input.dataset.line)];
    return Boolean(line?.product_id) && line.productText === input.value;
  },
  choose: (input, item) => {
    const i = Number(input.dataset.line);
    const line = form.lines[i];
    Object.assign(line, {
      text: item.display_name, productText: item.display_name, product_id: item.id,
      product_uom_id: item.uom_id[0], uom_label: item.uom_id[1], stock: item.stock ?? null,
    });
    if (!line.name || line.name === line.lastAutoName) line.name = item.description_sale || item.display_name;
    line.lastAutoName = line.name;
    document.querySelector("#lines-box").innerHTML = linesTable();
    document.querySelector(`[data-line="${i}"][data-field="product_uom_qty"]`)?.focus();
    applyProductTaxes(line, item.id).catch((error) => toast(error.message, "error"));
  },
});

registerAnalytic("sale", {
  get: (i) => form?.lines[Number(i)]?.analytic ?? {},
  set: (i, dist) => {
    form.lines[Number(i)].analytic = dist;
    document.querySelector("#lines-box").innerHTML = linesTable();
  },
  label: (i) => form?.lines[Number(i)]?.text ?? "",
});

registerTaxes("sale", {
  use: "sale",
  get: (i) => form?.lines[Number(i)]?.taxes ?? [],
  set: (i, taxes) => {
    const line = form.lines[Number(i)];
    line.taxes = taxes;
    line.taxTouched = true;
    document.querySelector("#lines-box").innerHTML = linesTable();
  },
});

/** Mengganti produk menerapkan pajak bawaan produk baru; pilihan manual sebelumnya ditimpa dan penggunanya diberi tahu. */
async function applyProductTaxes(line, productId) {
  const defaults = await productDefaultTaxes(productId, "sale");
  if (line.product_id !== productId) return;
  const before = line.taxes.map((t) => t.id).sort().join();
  if (line.taxTouched && before !== defaults.map((t) => t.id).sort().join()) toast("Pajak baris diganti dengan pajak bawaan produk baru.");
  line.taxes = defaults;
  line.taxTouched = false;
  document.querySelector("#lines-box").innerHTML = linesTable();
}

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
  price_unit: "", price_unit0: "", discount: "", discount0: "", taxes: [], taxTouched: false, subtotal: null, analytic: undefined, // undefined = tidak disentuh
});

function linesTable() {
  const rows = form.lines
    .map(
      (l, i) => `<tr class="align-top">
        <td class="py-2 pr-2 min-w-48"><input data-lookup="sale-product" autocomplete="off" role="combobox" aria-autocomplete="list" data-line="${i}" data-field="text" value="${esc(l.text)}" placeholder="Cari atau pilih produk..." class="${INPUT}"><div id="sale-stock-${i}">${stockLine(l)}</div></td>
        <td class="py-2 px-2 min-w-40"><input data-line="${i}" data-field="name" value="${esc(l.name)}" class="${INPUT}"></td>
        <td class="py-2 px-2 w-24"><input type="number" min="0" step="any" data-line="${i}" data-field="product_uom_qty" value="${esc(l.product_uom_qty)}" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 w-20 text-sm text-gray-600">${esc(l.uom_label || "-")}</td>
        <td class="py-2 px-2 w-36"><input type="number" min="0" step="any" data-line="${i}" data-field="price_unit" value="${esc(l.price_unit)}" placeholder="otomatis" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 w-24"><input type="number" min="0" max="100" step="any" data-line="${i}" data-field="discount" value="${esc(l.discount)}" placeholder="0" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 min-w-48">${taxCell("sale", i, l.taxes)}</td>
        <td class="py-2 px-2 w-48">${analyticCell("sale", i, l.analytic)}</td>
        <td class="py-2 px-2 w-32 text-sm text-right text-gray-700">${l.subtotal === null ? "-" : money(l.subtotal)}</td>
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="remove-line" data-line="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris"><i class="fas fa-trash-alt"></i></button></td>
      </tr>`,
    )
    .join("");
  return `<table class="w-full text-left">
      <thead><tr>${["Produk", "Deskripsi", "Jumlah", "Satuan", "Harga Satuan", "Diskon %", "Pajak", "Analitik", "Jumlah Harga", ""]
        .map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${[2, 4, 5, 8].includes(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="text-xs text-gray-500 mt-2">Kosongkan harga satuan untuk memakai harga dari daftar harga.</p>
    <button type="button" data-action="add-line" class="mt-1 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>`;
}

function readonlyLinesTable(lines, currency, showFlow) {
  const heads = ["Produk", "Deskripsi", "Jumlah", ...(showFlow ? ["Dikirim", "Difakturkan"] : []), "Satuan", "Harga Satuan", "Diskon", "Pajak", "Analitik", "Jumlah Harga"];
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
        <td class="py-2 px-4 text-sm">${taxCell("sale", l.id, l.taxes, false)}</td>
        <td class="py-2 px-4 text-sm">${analyticCell("sale", l.id, l.analytic_distribution, false)}</td>
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
  const [users, terms, pricelists, warehouses] = await Promise.all([referenceUsers(), referenceTerms(), referencePricelists(), referenceWarehouses(), preloadAnalytic()]);
  whs = warehouses;
  let so = null;
  let lines = [];
  let rewardLines = [];
  if (id) {
    so = await readOne("sale.order", id, [
      "name", "state", "locked", "partner_id", "client_order_ref", "date_order", "validity_date", "user_id", "origin", "payment_term_id", "pricelist_id",
      "currency_id", "delivery_count", "picking_ids", "invoice_count", "invoice_ids", "invoice_status", "delivery_status", "amount_untaxed", "amount_tax",
      "amount_total", "loyalty_data", "warehouse_id",
    ]);
    if (!so) {
      app.innerHTML = '<p class="text-sm text-rose-600">Dokumen tidak ditemukan.</p>';
      return;
    }
    lines = await searchRead(
      "sale.order.line",
      [["order_id", "=", id], ["display_type", "=", false]],
      ["product_id", "name", "product_uom_qty", "qty_delivered", "qty_invoiced", "product_uom_id", "price_unit", "discount", "tax_ids", "price_subtotal", "reward_id", "coupon_id", "points_cost", "analytic_distribution"],
      { order: "sequence, id" },
    );
    const taxName = await loadTaxNames(lines.flatMap((l) => l.tax_ids));
    lines.forEach((l) => {
      l.taxes = taxList(l.tax_ids, taxName);
    });
    // Baris hadiah promosi (sale_loyalty) dikelola Odoo; ditampilkan di bagian Promosi, bukan sebagai baris yang bisa diedit.
    rewardLines = lines.filter((l) => l.reward_id);
    lines = lines.filter((l) => !l.reward_id);
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
          user_id: so.user_id?.[0] ?? null, origin: so.origin || "", payment_term_id: so.payment_term_id?.[0] ?? null, pricelist_id: so.pricelist_id?.[0] ?? null, warehouse_id: so.warehouse_id?.[0] ?? null,
          initial: {
            warehouse_id: so.warehouse_id?.[0] ?? null, partner_id: so.partner_id?.[0] ?? null, client_order_ref: so.client_order_ref || "", date_order: toInputDateTime(so.date_order),
            validity_date: so.validity_date || "", user_id: so.user_id?.[0] ?? null, origin: so.origin || "",
            payment_term_id: so.payment_term_id?.[0] ?? null, pricelist_id: so.pricelist_id?.[0] ?? null,
          },
          lines: lines.map((l) => ({
            id: l.id, text: l.product_id?.[1] ?? "", productText: l.product_id?.[1] ?? "", product_id: l.product_id?.[0] ?? null,
            name: l.name || "", product_uom_qty: l.product_uom_qty, product_uom_id: l.product_uom_id?.[0] ?? null,
            uom_label: l.product_uom_id?.[1] ?? "", price_unit: l.price_unit, price_unit0: l.price_unit, discount: l.discount || "", discount0: l.discount || "",
            initial: { product_id: l.product_id?.[0] ?? null, name: l.name || "", product_uom_qty: l.product_uom_qty },
            taxes: l.taxes, taxes0: l.tax_ids, taxTouched: false, subtotal: l.price_subtotal,
            analytic: readDistribution(l.analytic_distribution), analytic0: readDistribution(l.analytic_distribution),
          })),
          removed: [],
        }
      : {
          id: null, partner: null, client_order_ref: "", date_order: "", validity_date: "", user_id: ctx.user.id, origin: "", payment_term_id: null,
          pricelist_id: null, warehouse_id: null, lines: [emptyLine()], removed: [],
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
       ${warehouses.length > 1 ? fieldBlock("Gudang Pengiriman", `<select data-value="warehouse_id" class="${INPUT}">${selectOptions(warehouses, f.warehouse_id, "Otomatis (gudang utama)")}</select>`) : ""}
       ${fieldBlock("Mata Uang", readonlyValue(currency))}`
    : `${fieldBlock("Pelanggan", readonlyValue(so.partner_id?.[1]))}
       ${fieldBlock("Referensi Pelanggan", readonlyValue(so.client_order_ref))}
       ${fieldBlock("Tanggal Order", readonlyValue(so.date_order ? dateTimeText(so.date_order) : ""))}
       ${fieldBlock("Berlaku Sampai", readonlyValue(so.validity_date ? dateText(so.validity_date) : ""))}
       ${fieldBlock("Salesperson", readonlyValue(so.user_id?.[1]))}
       ${fieldBlock("Daftar Harga", readonlyValue(so.pricelist_id?.[1]))}
       ${fieldBlock("Syarat Pembayaran", readonlyValue(so.payment_term_id?.[1]))}
       ${fieldBlock("Dokumen Sumber", readonlyValue(so.origin))}
       ${warehouses.length > 1 ? fieldBlock("Gudang Pengiriman", readonlyValue(so.warehouse_id?.[1])) : ""}
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
      <div class="flex flex-wrap gap-2">${so ? actionBar(BUTTONS, so) + printButton("sale.order", so.id) : ""}</div>
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
    ${so ? promotionSection(so, rewardLines, currency, editable) : ""}
    ${so ? chatterHtml("sale.order", so.id) : ""}`;
  if (so) loadMessages("sale.order", so.id);
  if (editable) refreshStock();
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
  const vals = { product_id: l.product_id, name: l.name, product_uom_qty: qty, product_uom_id: l.product_uom_id };
  const analytic = distributionChange(l.analytic, l.analytic0);
  if (analytic !== undefined) vals.analytic_distribution = analytic;
  const tax = taxChange(l.taxes, l.taxes0, l.taxTouched);
  if (tax !== undefined) vals.tax_ids = tax;
  return vals;
}

/* Harga dan diskon manual: baris yang dibuat dengan harga eksplisit dikembalikan ke harga daftar saat jumlahnya
 * diubah (technical_price_unit sama dengan price_unit dianggap "bukan manual"). Karena itu keduanya tidak ikut
 * saat membuat baris; ditulis sebagai langkah kedua sehingga tetap dianggap manual (lihat D10). */
const filled = (value) => String(value).trim() !== "";
const manualPrice = (l) => filled(l.price_unit) && (l.id ? Number(l.price_unit) !== Number(l.price_unit0) : true);
const manualDiscount = (l) => (l.id ? Number(l.discount || 0) !== Number(l.discount0 || 0) : filled(l.discount) && Number(l.discount) !== 0);

async function applyManualValues(orderId, resolved, knownLineIds) {
  if (!resolved.some((l) => manualPrice(l) || manualDiscount(l))) return;
  const rows = await searchRead("sale.order.line", [["order_id", "=", orderId], ["display_type", "=", false], ["reward_id", "=", false]], ["price_unit", "discount"], { order: "sequence, id" });
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
    user_id: Number(f.user_id) || null, origin: f.origin, payment_term_id: Number(f.payment_term_id) || null, pricelist_id: Number(f.pricelist_id) || null, warehouse_id: Number(f.warehouse_id) || null,
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
  if (f.id ? differs("warehouse_id") : current.warehouse_id) header.warehouse_id = current.warehouse_id || false;
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
    if ("analytic_distribution" in vals) changed.analytic_distribution = vals.analytic_distribution;
    if ("tax_ids" in vals) changed.tax_ids = vals.tax_ids;
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

/* ---------- Promosi dan hadiah (sale_loyalty) ----------
 * Metode privat seperti _try_apply_code tidak bisa dipanggil lewat JSON-2, jadi UI memakai jalur publik yang sama dengan klien web:
 * wizard sale.loyalty.coupon.wizard (tombol Kode Kupon), tombol action_open_reward_wizard (tombol Hadiah, juga memperbarui promosi otomatis),
 * dan wizard sale.loyalty.reward.wizard (memilih hadiah). Lihat D30. */

const PROMO_ERRORS = [
  [/This code is invalid \((.*)\)/, (m) => `Kode "${m[1]}" tidak valid atau programnya tidak berlaku saat ini.`],
  [/This coupon has already been used/, () => "Kupon ini sudah terpakai."],
  [/This coupon is expired/, () => "Kupon ini sudah kedaluwarsa."],
  [/This code is expired \((.*)\)/, (m) => `Kode "${m[1]}" sudah mencapai batas pemakaian.`],
  [/This promo code is already applied/, () => "Kode promo ini sudah diterapkan pada pesanan."],
  [/The program is not available for this order/, () => "Program tidak berlaku untuk pesanan ini."],
  [/This program is already applied to this order/, () => "Program ini sudah diterapkan pada pesanan."],
  [/There is nothing to discount/, () => "Tidak ada yang bisa didiskon pada pesanan ini."],
  [/This discount \((.*)\) is not compatible with "(.*)"\. Please remove it/, (m) => `Diskon "${m[1]}" tidak bisa digabung dengan diskon "${m[2]}" yang sudah terpasang. Hapus diskon itu lebih dulu.`],
  [/A better global discount is already applied/, () => "Sudah ada diskon seluruh pesanan yang lebih besar."],
  [/The coupon does not have enough points/, () => "Poin kupon tidak cukup untuk hadiah ini."],
  [/The coupon can only be claimed on future orders/, () => "Kupon ini hanya bisa dipakai pada pesanan berikutnya."],
  [/One or more rewards on the sale order is invalid/, () => "Satu atau lebih hadiah pada pesanan tidak valid. Periksa baris promosi."],
  [/This program cannot be applied with code/, () => "Kartu loyalti dan e-wallet dimuat otomatis dari pelanggan; tidak dipakai dengan kode."],
  [/This program requires a code to be applied/, () => "Program ini hanya berlaku dengan kode."],
  [/your order must include at least (.*) (\w+) of the eligible products/, (m) => `Pesanan harus memuat produk yang memenuhi syarat senilai minimal ${m[1]} ${m[2]}.`],
  [/You don't have the required product quantities/, () => "Jumlah produk pada pesanan belum memenuhi syarat program."],
  [/Once a sales order is confirmed, you can't remove one of its lines/, () => "Pesanan sudah dikonfirmasi: baris hadiah tidak bisa dihapus."],
];
/** Pesan galat Odoo untuk promosi diterjemahkan; pesan lain ditampilkan apa adanya. */
function promoError(error) {
  for (const [pattern, text] of PROMO_ERRORS) {
    const match = String(error.message).match(pattern);
    if (match) return new Error(text(match));
  }
  return error;
}
const promoContext = (orderId) => ({ active_model: "sale.order", active_ids: [orderId], active_id: orderId });
const codeOf = (coupon) => String(coupon?.[1] ?? "").split(": ").slice(1).join(": ");
const programOf = (reward) => String(reward?.[1] ?? "").split(" - ")[0];

function promotionSection(so, rewardLines, currency, editable) {
  const points = so.loyalty_data && so.loyalty_data.point_name
    ? `<p class="text-sm text-gray-600 mt-3">Poin ${esc(so.loyalty_data.point_name)}: diperoleh <b>${esc(so.loyalty_data.issued)}</b>, dipakai <b>${esc(so.loyalty_data.cost)}</b>.</p>`
    : "";
  if (!rewardLines.length && !points) return "";
  const rows = rewardLines
    .map(
      (l) => `<tr>
        <td class="py-2 px-4 text-sm">${esc(l.name)}</td>
        <td class="py-2 px-4 text-sm">${esc(programOf(l.reward_id))}</td>
        <td class="py-2 px-4 text-sm font-mono">${esc(codeOf(l.coupon_id)) || "-"}</td>
        <td class="py-2 px-4 text-sm text-right">${l.points_cost ? esc(l.points_cost) : "-"}</td>
        <td class="py-2 px-4 text-sm text-right">${l.discount === 100 ? `Gratis × ${esc(l.product_uom_qty)}` : money(l.price_subtotal, currency)}</td>
        <td class="py-2 px-4 text-right w-10">${editable ? `<button type="button" data-action="reward-line-remove" data-id="${l.id}" class="text-gray-400 hover:text-rose-600" aria-label="Hapus hadiah"><i class="fas fa-trash-alt"></i></button>` : ""}</td>
      </tr>`,
    )
    .join("");
  const head = ["Promosi dan Hadiah", "Program", "Kode", "Poin Dipakai", "Nilai", ""]
    .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i === 3 || i === 4 ? "text-right" : ""}">${h}</th>`)
    .join("");
  return `<section id="section-promo" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
    <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Promosi dan Hadiah</div>
    ${rewardLines.length ? `<table class="w-full text-left"><thead class="bg-gray-50"><tr>${head}</tr></thead><tbody class="divide-y divide-gray-100">${rows}</tbody></table>` : ""}
    <div class="px-4 pb-4">${points}
      <p class="text-xs text-gray-500 mt-2">Setelah mengubah barang atau jumlah, klik <b>Hadiah</b> untuk memperbarui promosi otomatis. ${so.state === "sale" ? "Pesanan sudah dikonfirmasi: baris hadiah tidak bisa dihapus." : ""}</p></div>
  </section>`;
}

function openCouponDialog(orderId) {
  openModal(
    "Kode Kupon",
    `<form data-form="coupon" class="space-y-3">${fieldBlock("Kode kupon atau kode promo", `<input data-promo="code" autocomplete="off" placeholder="mis. HEMAT10" class="${INPUT}" aria-label="Kode kupon">`)}
       <p class="text-xs text-gray-500">Kupon dan kode promo dibuat di Sales &gt; Master &gt; Promotion &amp; Loyalty. Kartu loyalti dan e-wallet pelanggan dimuat otomatis lewat tombol Hadiah.</p></form>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="coupon-apply" data-id="${orderId}" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Terapkan</button>`,
  );
  document.querySelector('[data-promo="code"]')?.focus();
}

/** Menyimpan perubahan quotation yang belum tersimpan sebelum promosi dihitung ulang (tombol Odoo juga menyimpan dulu). */
const saveBefore = async (orderId) => {
  if (form?.id === orderId) await persist();
};

async function applyCode(button) {
  const orderId = Number(button.dataset.id);
  const code = document.querySelector('[data-promo="code"]')?.value.trim() ?? "";
  if (!code) {
    toast("Isi kode kupon atau kode promo.", "error");
    return;
  }
  const action = await guarded(button, async () => {
    await saveBefore(orderId);
    const context = promoContext(orderId);
    const [wizard] = await call("sale.loyalty.coupon.wizard", "create", { vals_list: [{ order_id: orderId, coupon_code: code }], context });
    try {
      return await call("sale.loyalty.coupon.wizard", "action_apply", { ids: [wizard], context });
    } catch (error) {
      throw promoError(error);
    }
  });
  if (!action) return;
  const rewardIds = action.context?.default_reward_ids ?? [];
  closeModal();
  if (!rewardIds.length) {
    toast("Kode diterima, tetapi belum ada hadiah yang bisa diklaim. Klik Hadiah setelah syarat pesanan terpenuhi.");
    form = null;
    reload();
    return;
  }
  await openRewardChooser(orderId, rewardIds);
}

async function updateRewards(button, orderId) {
  const result = await guarded(button, async () => {
    await saveBefore(orderId);
    try {
      return await call("sale.order", "action_open_reward_wizard", { ids: [orderId] });
    } catch (error) {
      throw promoError(error);
    }
  });
  if (result === undefined) return;
  if (result === true || !result?.res_model) {
    toast("Promosi dan hadiah diperbarui.");
    form = null;
    reload();
    return;
  }
  await openRewardChooser(orderId, null);
}

/** Dialog pilih hadiah: hadiah yang bisa diklaim (dari wizard hadiah Odoo), dengan pilihan produk bila hadiahnya memberi beberapa pilihan produk. */
async function openRewardChooser(orderId, rewardIds) {
  const ready = await guarded(null, async () => {
    const context = promoContext(orderId);
    let ids = rewardIds;
    if (!ids) {
      const [wizard] = await call("sale.loyalty.reward.wizard", "create", { vals_list: [{ order_id: orderId }], context });
      [{ reward_ids: ids }] = await call("sale.loyalty.reward.wizard", "read", { ids: [wizard], fields: ["reward_ids"], context });
    }
    const rewards = ids.length ? await call("loyalty.reward", "read", { ids, fields: ["description", "program_id", "program_type", "reward_type", "multi_product", "reward_product_ids", "required_points", "point_name"] }) : [];
    const productIds = [...new Set(rewards.flatMap((r) => (r.multi_product ? r.reward_product_ids : [])))];
    const products = productIds.length ? await searchRead("product.product", [["id", "in", productIds]], ["display_name"]) : [];
    return { rewards, products };
  });
  if (!ready) {
    form = null;
    reload();
    return;
  }
  const { rewards, products } = ready;
  if (!rewards.length) {
    toast("Belum ada hadiah yang bisa diklaim untuk pesanan ini.");
    form = null;
    reload();
    return;
  }
  rewardDialog = { orderId, rewards, products, selected: rewards[0].id, product: null, applied: false };
  const selected = rewardDialog.rewards[0];
  rewardDialog.product = selected.multi_product ? selected.reward_product_ids[0] : null;
  openModal("Pilih Hadiah", "", "", () => {
    const wasApplied = rewardDialog?.applied;
    rewardDialog = null;
    form = null;
    if (!wasApplied) reload(); // pembaruan otomatis (mis. promosi baru terpasang) sudah mengubah pesanan
  });
  paintRewardChoice();
}

function paintRewardChoice() {
  const d = rewardDialog;
  if (!d) return;
  const body = document.querySelector("#modal-body");
  const foot = document.querySelector("#modal-foot");
  if (!body || !foot) return;
  const picked = d.rewards.find((r) => r.id === d.selected);
  body.innerHTML = `<div class="space-y-2">${d.rewards
    .map(
      (r) => `<label class="flex items-start gap-3 border ${r.id === d.selected ? "border-indigo-400 bg-indigo-50" : "border-gray-200"} rounded-lg p-3 cursor-pointer">
        <input type="radio" name="reward" data-promo="reward" value="${r.id}" ${r.id === d.selected ? "checked" : ""} class="mt-1 text-indigo-600">
        <span><span class="block text-sm font-medium text-gray-900">${r.reward_type === "discount" && !/^diskon/i.test(r.description) ? "Diskon " : ""}${esc(r.description)}</span>
          <span class="block text-xs text-gray-500">${esc(programOf(r.program_id) || r.program_id?.[1] || "")}${["loyalty", "buy_x_get_y"].includes(r.program_type) ? ` · ${esc(r.required_points)} ${esc(r.point_name ?? "poin")}` : ""}</span></span></label>`,
    )
    .join("")}</div>
    ${picked?.multi_product ? fieldBlock("Pilih Produk Hadiah", `<select data-promo="product" class="${INPUT}">${d.products.filter((p) => picked.reward_product_ids.includes(p.id)).map((p) => `<option value="${p.id}" ${p.id === d.product ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select>`) : ""}`;
  foot.innerHTML = `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Tutup</button>
    <button data-action="reward-apply" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Terapkan Hadiah</button>`;
  if (picked?.multi_product && !d.product) d.product = picked.reward_product_ids[0];
}

async function applyReward(button) {
  const d = rewardDialog;
  if (!d) return;
  const picked = d.rewards.find((r) => r.id === d.selected);
  const ok = await guarded(button, async () => {
    const context = promoContext(d.orderId);
    const [wizard] = await call("sale.loyalty.reward.wizard", "create", {
      vals_list: [{ order_id: d.orderId, selected_reward_id: d.selected, ...(picked.multi_product ? { selected_product_id: d.product } : {}) }],
      context,
    });
    try {
      await call("sale.loyalty.reward.wizard", "action_apply", { ids: [wizard], context });
    } catch (error) {
      throw promoError(error);
    }
    return true;
  });
  if (!ok) return;
  d.applied = true;
  closeModal();
  toast("Hadiah diterapkan.");
  form = null;
  reload();
}

async function removeRewardLine(button) {
  if (!window.confirm("Hapus baris hadiah ini? Promosi otomatis dipasang lagi bila Anda klik Hadiah dan syaratnya masih terpenuhi.")) return;
  const ok = await guarded(button, async () => {
    try {
      return await call("sale.order.line", "unlink", { ids: [Number(button.dataset.id)] });
    } catch (error) {
      throw promoError(error);
    }
  });
  if (ok !== undefined) {
    toast("Baris hadiah dihapus.");
    form = null;
    reload();
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
      toast(wasNew ? "Quotation dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/sale/${saved}`;
      else reload();
    }
  } else if (action === "coupon") openCouponDialog(id);
  else if (action === "coupon-apply") await applyCode(el);
  else if (action === "reward") await updateRewards(el, id);
  else if (action === "reward-apply") await applyReward(el);
  else if (action === "reward-line-remove") await removeRewardLine(el);
  else if (action === "ship") await openDelivery(id);
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
  if (el.dataset.value) {
    form[el.dataset.value] = el.value;
    if (el.dataset.value === "warehouse_id") refreshStock();
  } else if (el.dataset.line !== undefined) {
    form.lines[Number(el.dataset.line)][el.dataset.field] = el.value;
    if (el.dataset.field === "text") {
      const line = form.lines[Number(el.dataset.line)];
      if (line.stock && el.value !== line.productText) {
        line.stock = null; // teks produk diubah: info stok produk lama tidak berlaku lagi
        paintStock(Number(el.dataset.line));
      }
      runLookup(el, 250);
    } else if (el.dataset.field === "product_uom_qty") paintStock(Number(el.dataset.line));
  } else if (el.dataset.lookup === "sale-customer") {
    form.partner = null;
    runLookup(el, 250);
  }
}

export function onChange(event, el) {
  if (el.dataset.promo === "reward" && rewardDialog) {
    rewardDialog.selected = Number(el.value);
    paintRewardChoice();
  } else if (el.dataset.promo === "product" && rewardDialog) rewardDialog.product = Number(el.value);
  // Metode faktur uang muka membutuhkan jumlah; faktur reguler tidak.
  if (el.dataset.invoice === "method") {
    document.querySelector("#invoice-amount")?.classList.toggle("hidden", el.value === "delivered");
  }
}

export async function onSubmit(event, formEl, kind) {
  if (kind === "invoice") await createInvoice(null);
  else if (kind === "coupon") await applyCode(document.querySelector('[data-action="coupon-apply"]'));
}
