// POS Order (pos.order): daftar pesanan kasir dan detailnya (barang, pajak, pembayaran, pengiriman stok, faktur), cetak ulang struk,
// dan pembuatan faktur untuk pesanan yang punya pelanggan.
import {
  app, badge, button, call, cell, dateTimeText, esc, fieldBlock, filterSelect, guarded, money, pageHeader, readOne, readonlyValue, rowLink,
  searchBox, searchRead, statTiles, statusbar, table, toast, chatterHtml, loadMessages, dayBoundary,} from "../common.js";
import { printButton } from "../print.js";

const STATES = { draft: ["Baru", "muted"], paid: ["Dibayar", "info"], done: ["Selesai", "success"], invoiced: ["Difaktur", "success"], cancel: ["Dibatalkan", "danger"] };
const FLOW = ["draft", "paid", "done", "invoiced"];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });

let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {};
const reload = () => render(last.sub, last.query);

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const session = Number(query.get("session")) || null;
  const domain = [];
  if (filter) domain.push(["state", "=", filter]);
  if (session) domain.push(["session_id", "=", session]);
  // dari tombol POS di halaman produk: id template produk dan periode; hanya pesanan yang sudah dibayar (sama dengan hitungan tombolnya)
  const template = Number(query.get("product")) || null;
  if (template) {
    domain.push(["lines.product_id.product_tmpl_id", "=", template]);
    if (!filter) domain.push(["state", "in", ["paid", "done", "invoiced"]]);
    if (query.get("from")) domain.push(["date_order", ">=", dayBoundary(query.get("from"))]);
    if (query.get("to")) domain.push(["date_order", "<=", dayBoundary(query.get("to"), true)]);
  }
  if (query.get("ids")) domain.push(["id", "in", query.get("ids").split(",").map(Number).filter(Boolean)]);
  if (text) domain.push("|", "|", ["pos_reference", "ilike", text], ["name", "ilike", text], ["partner_id.name", "ilike", text]);
  const rows = await searchRead("pos.order", domain, ["name", "pos_reference", "session_id", "date_order", "partner_id", "amount_total", "state", "user_id"], { order: "id desc", limit: 100 });
  const body = rows
    .map((r) =>
      rowLink(`#/posorder/${r.id}`, [
        cell(r.pos_reference || r.name, { strong: true }),
        cell(r.session_id?.[1] ?? ""),
        cell(dateTimeText(r.date_order)),
        cell(r.partner_id?.[1] ?? "-"),
        cell(r.user_id?.[1] ?? ""),
        cell(money(r.amount_total), { right: true }),
        cell(badge(STATES, r.state), { raw: true }),
      ]),
    )
    .join("");
  const options = [["", "Semua status"], ...Object.entries(STATES).map(([k, v]) => [k, v[0]])];
  app.innerHTML =
    pageHeader("POS Order", `${searchBox(text, "Cari referensi atau pelanggan")}${filterSelect(options, filter)}`) +
    (template ? `<p class="text-sm text-gray-500 mb-3">Difilter per produk${query.get("from") ? `, ${esc(query.get("from"))} sampai ${esc(query.get("to") ?? "")}` : ""}. <a href="#/posorder" class="text-indigo-600 hover:underline">Tampilkan semua</a></p>` : "") +
    (session ? `<p class="text-sm text-gray-500 mb-3">Difilter per sesi. <a href="#/posorder" class="text-indigo-600 hover:underline">Tampilkan semua</a></p>` : "") +
    table(
      [{ label: "Referensi" }, { label: "Sesi" }, { label: "Waktu" }, { label: "Pelanggan" }, { label: "Kasir" }, { label: "Total", right: true }, { label: "Status" }],
      body,
      "Belum ada pesanan POS. Pesanan tercipta dari halaman Kasir.",
    );
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const order = await readOne("pos.order", id, [
    "name", "pos_reference", "session_id", "config_id", "date_order", "partner_id", "user_id", "amount_total", "amount_tax", "amount_paid", "amount_return", "state", "lines", "payment_ids",
    "picking_ids", "account_move", "is_invoiced", "to_invoice",
  ]);
  if (!order) {
    app.innerHTML = '<p class="text-sm text-rose-600">Pesanan tidak ditemukan.</p>';
    return;
  }
  const [lines, payments] = await Promise.all([
    searchRead("pos.order.line", [["id", "in", order.lines]], ["full_product_name", "qty", "price_unit", "discount", "tax_ids", "price_subtotal", "price_subtotal_incl"], { order: "id" }),
    searchRead("pos.payment", [["id", "in", order.payment_ids]], ["payment_method_id", "amount", "is_change", "payment_date"], { order: "id" }),
  ]);
  const taxIds = [...new Set(lines.flatMap((l) => l.tax_ids))];
  const taxNames = new Map(taxIds.length ? (await searchRead("account.tax", [["id", "in", taxIds]], ["name"])).map((t) => [t.id, t.name]) : []);
  const lineRows = lines
    .map(
      (l) => `<tr><td class="py-2 px-4 text-sm">${esc(l.full_product_name)}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(nf.format(l.qty))}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(l.price_unit))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${l.discount ? `${esc(nf.format(l.discount))}%` : "-"}</td>
        <td class="py-2 px-4 text-sm text-gray-600">${esc(l.tax_ids.map((t) => taxNames.get(t) ?? "").filter(Boolean).join(", ") || "-")}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(l.price_subtotal_incl))}</td></tr>`,
    )
    .join("");
  const paymentRows = payments
    .map((p) => `<tr><td class="py-2 px-4 text-sm">${esc(p.payment_method_id[1])}${p.is_change ? ' <span class="ml-1 px-2 py-0.5 rounded-full text-xs bg-amber-50 text-amber-700">kembalian</span>' : ""}</td><td class="py-2 px-4 text-sm">${esc(dateTimeText(p.payment_date))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(p.amount))}</td></tr>`)
    .join("");
  const head = (labels, right = []) => `<thead class="bg-gray-50"><tr>${labels.map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${right.includes(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>`;
  const canInvoice = order.partner_id && !order.account_move && ["paid", "done"].includes(order.state);
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/posorder" class="hover:text-indigo-600">POS Order</a> / ${esc(order.pos_reference || order.name)}</div>
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
      <div class="flex flex-wrap gap-2">${printButton("pos.order", order.id, "Cetak Struk")}${canInvoice ? button("invoice", "Buat Faktur", "primary", { id: order.id }) : ""}</div>
      ${statusbar(FLOW, STATES, order.state)}
    </div>
    <div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: order.picking_ids.length, label: "Pengiriman Stok", icon: "fa-truck", href: `#/delivery?ids=${order.picking_ids.join(",")}` },
      { count: order.account_move ? 1 : 0, label: `Faktur ${order.account_move?.[1] ?? ""}`, icon: "fa-file-invoice-dollar", href: `#/invoice/${order.account_move?.[0]}` },
    ])}</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(order.pos_reference || order.name)}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Sesi", `<div class="mt-1 py-2 text-sm"><a href="#/possession/${order.session_id[0]}" class="text-indigo-700 hover:underline">${esc(order.session_id[1])}</a></div>`)}
      ${fieldBlock("Waktu", readonlyValue(dateTimeText(order.date_order)))}
      ${fieldBlock("Pelanggan", readonlyValue(order.partner_id?.[1]))}
      ${fieldBlock("Kasir", readonlyValue(order.user_id?.[1]))}
    </section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Barang</div>
      <table class="w-full text-left">${head(["Produk", "Jumlah", "Harga", "Diskon", "Pajak", "Total"], [1, 2, 3, 5])}<tbody class="divide-y divide-gray-100">${lineRows}</tbody>
        <tfoot class="bg-gray-50"><tr><td colspan="5" class="py-2 px-4 text-sm text-right text-gray-600">Pajak</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(order.amount_tax))}</td></tr>
          <tr><td colspan="5" class="py-2 px-4 text-sm text-right font-semibold">Total</td><td class="py-2 px-4 text-sm text-right tabular-nums font-semibold">${esc(money(order.amount_total))}</td></tr></tfoot></table></section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Pembayaran</div>
      <table class="w-full text-left">${head(["Metode", "Waktu", "Jumlah"], [2])}<tbody class="divide-y divide-gray-100">${paymentRows || '<tr><td colspan="3" class="py-6 text-center text-sm text-gray-500">Belum ada pembayaran.</td></tr>'}</tbody></table></section>
    <p class="mt-3 text-xs text-gray-500">Jurnal penjualan POS tercipta saat sesi ditutup; lihat di halaman <a href="#/possession/${order.session_id[0]}" class="underline">sesi</a>. Pesanan dengan pelanggan bisa dibuatkan faktur.</p>
    ${chatterHtml("pos.order", order.id)}`;
  loadMessages("pos.order", order.id);
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  if (action === "invoice") {
    const ok = await guarded(el, () => call("pos.order", "action_pos_order_invoice", { ids: [id] }));
    if (ok !== undefined) {
      toast("Faktur dibuat.");
      reload();
    }
  }
}
