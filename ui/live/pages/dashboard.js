// Dashboard per modul (menu Dashboard di tiap modul): angka kunci yang bisa diklik menuju daftar terkait, grafik 6 bulan atau
// 7 hari, dan tabel ringkas. Semua angka dibaca langsung dari Odoo saat halaman dibuka.
import { app, call, dateText, esc, money, pageHeader, searchRead } from "../common.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const utc = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
const now = () => new Date();
const startOfDay = () => new Date(now().getFullYear(), now().getMonth(), now().getDate());
const startOfMonth = (offset = 0) => new Date(now().getFullYear(), now().getMonth() + offset, 1);

/* ---------- Pembantu data ---------- */

const count = (model, domain, context = {}) => call(model, "search_count", { domain, context });
const group = (model, domain, groupby, aggregates, context = {}) => call(model, "formatted_read_group", { domain, groupby, aggregates, context });
const total = async (model, domain, field, context = {}) => (await group(model, domain, [], [`${field}:sum`], context))[0]?.[`${field}:sum`] ?? 0;

/** Deret per bulan untuk n bulan terakhir (termasuk bulan ini); bulan tanpa data bernilai 0. */
async function monthly(model, domain, dateField, measure, n = 6, context = {}, isDatetime = true) {
  const from = startOfMonth(-(n - 1));
  const fromText = isDatetime ? utc(new Date(Date.UTC(from.getFullYear(), from.getMonth(), 1))) : ymd(from);
  const rows = await group(model, [...domain, [dateField, ">=", fromText]], [`${dateField}:month`], [measure === "__count" ? "__count" : `${measure}:sum`], context);
  const values = new Map(rows.map((r) => [String(r[`${dateField}:month`]?.[0] ?? "").slice(0, 7), r[measure === "__count" ? "__count" : `${measure}:sum`] ?? 0]));
  return Array.from({ length: n }, (_, i) => {
    const d = startOfMonth(-(n - 1 - i));
    const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    return { label: MONTHS[d.getMonth()], value: values.get(key) ?? 0 };
  });
}

/* ---------- Pembantu tampilan ---------- */

const tile = (label, value, { href, hint = "", tone = "" } = {}) => {
  const inner = `<div class="text-xs font-medium text-gray-500 uppercase">${esc(label)}</div><div class="text-xl font-semibold mt-1 ${tone}">${esc(value)}</div>${hint ? `<div class="text-xs text-gray-500 mt-1">${esc(hint)}</div>` : ""}`;
  const cls = "block bg-white rounded-xl border border-gray-200 shadow-sm p-4";
  return href ? `<a href="${esc(href)}" class="${cls} hover:border-indigo-300 hover:shadow">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
};

function bars(title, series, { format = (v) => nf.format(v), colors = ["bg-indigo-500"] } = {}) {
  const max = Math.max(1, ...series.flatMap((s) => s.values ?? [s.value]).map(Math.abs));
  const columns = series
    .map((s) => {
      const values = s.values ?? [s.value];
      return `<div class="flex-1 flex flex-col items-center gap-1 min-w-10">
        <div class="h-32 w-full flex items-end justify-center gap-1">${values
          .map((v, i) => `<div class="w-full max-w-8 ${v < 0 ? "bg-rose-400" : colors[i % colors.length]} rounded-t" style="height:${Math.max(2, Math.round((Math.abs(v) / max) * 100))}%" title="${esc(`${s.label}: ${format(v)}`)}"></div>`)
          .join("")}</div>
        <div class="text-xs text-gray-500">${esc(s.label)}</div>${values.map((v, i) => `<div class="text-xs font-medium ${values.length > 1 ? (i === 0 ? "text-emerald-700" : "text-rose-600") : "text-gray-700"}">${esc(format(v))}</div>`).join("")}</div>`;
    })
    .join("");
  return `<section class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-sm font-semibold mb-3">${esc(title)}</div><div class="flex gap-2">${columns}</div></section>`;
}

function listCard(title, headers, rows, empty, right = []) {
  const body = rows.map((cells) => `<tr>${cells.map((c, i) => `<td class="py-2 px-3 text-sm ${right.includes(i) ? "text-right tabular-nums" : ""}">${c}</td>`).join("")}</tr>`).join("");
  return `<section class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">${esc(title)}</div>
    <table class="w-full text-left"><thead class="bg-gray-50"><tr>${headers.map((h, i) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase ${right.includes(i) ? "text-right" : ""}">${esc(h)}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${body || `<tr><td colspan="${headers.length}" class="py-6 text-center text-sm text-gray-500">${esc(empty)}</td></tr>`}</tbody></table></section>`;
}

const link = (href, text) => `<a href="${esc(href)}" class="text-indigo-700 hover:underline">${esc(text)}</a>`;
const shortcuts = (items) =>
  `<div class="flex flex-wrap gap-2 mb-4">${items.map(([label, href, icon]) => `<a href="${esc(href)}" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas ${icon} mr-2 text-gray-400"></i>${esc(label)}</a>`).join("")}</div>`;

/* ---------- Dashboard per modul ---------- */

const BUILDERS = {
  async pr() {
    const [states, series, waiting] = await Promise.all([
      group("purchase.request", [], ["state"], ["__count"]),
      monthly("purchase.request", [], "date_start", "__count", 6, {}, false),
      searchRead("purchase.request", [["state", "=", "to_approve"]], ["name", "requested_by", "date_start", "estimated_cost"], { order: "date_start", limit: 5 }),
    ]);
    const n = (key) => states.find((s) => s.state === key)?.__count ?? 0;
    return {
      title: "Dashboard Purchase Request",
      html: shortcuts([["Purchase Request Baru", "#/pr/new", "fa-plus"], ["Menunggu Persetujuan", "#/pr?state=to_approve", "fa-hourglass-half"]]) +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Draft", n("draft"), { href: "#/pr?state=draft" })}${tile("Menunggu persetujuan", n("to_approve"), { href: "#/pr?state=to_approve", tone: n("to_approve") ? "text-amber-700" : "" })}${tile("Disetujui", n("approved"), { href: "#/pr?state=approved" })}${tile("Dalam proses", n("in_progress"), { href: "#/pr?state=in_progress" })}</div>` +
        `<div class="grid lg:grid-cols-2 gap-4">${bars("Purchase Request per Bulan", series)}${listCard("Menunggu Persetujuan Anda", ["Nomor", "Diminta oleh", "Tanggal", "Estimasi"], waiting.map((r) => [link(`#/pr/${r.id}`, r.name), esc(r.requested_by?.[1] ?? ""), esc(dateText(r.date_start)), money(r.estimated_cost)]), "Tidak ada PR yang menunggu persetujuan.", [3])}</div>`,
    };
  },

  async purchase() {
    const yearAgo = ymd(new Date(now().getFullYear() - 1, now().getMonth(), now().getDate()));
    const [rfq, open, toReceive, toBill, series, vendors] = await Promise.all([
      group("purchase.order", [["state", "in", ["draft", "sent", "to approve"]]], [], ["__count", "amount_total:sum"]),
      group("purchase.order", [["state", "=", "purchase"]], [], ["__count", "amount_total:sum"]),
      count("purchase.order", [["state", "=", "purchase"], ["receipt_status", "in", ["pending", "partial"]]]),
      count("purchase.order", [["invoice_status", "=", "to invoice"]]),
      monthly("purchase.order", [["state", "in", ["purchase", "done"]]], "date_order", "amount_untaxed"),
      group("purchase.order", [["state", "in", ["purchase", "done"]], ["date_order", ">=", `${yearAgo} 00:00:00`]], ["partner_id"], ["amount_untaxed:sum"]),
    ]);
    const top = vendors.sort((a, b) => b["amount_untaxed:sum"] - a["amount_untaxed:sum"]).slice(0, 5);
    return {
      title: "Dashboard Purchase",
      html: shortcuts([["RFQ Baru", "#/po/new", "fa-plus"], ["Penerimaan Barang", "#/receipt?state=assigned", "fa-truck-ramp-box"], ["Tagihan Vendor Draft", "#/bill?state=draft", "fa-file-invoice"]]) +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("RFQ", rfq[0]?.__count ?? 0, { href: "#/po?state=rfq", hint: money(rfq[0]?.["amount_total:sum"] ?? 0) })}${tile("Purchase Order berjalan", open[0]?.__count ?? 0, { href: "#/po?state=purchase", hint: money(open[0]?.["amount_total:sum"] ?? 0) })}${tile("Belum diterima", toReceive, { href: "#/po?state=purchase", hint: "PO menunggu barang" })}${tile("Belum ditagih", toBill, { href: "#/po?state=purchase", hint: "PO yang perlu tagihan" })}</div>` +
        `<div class="grid lg:grid-cols-2 gap-4">${bars("Pembelian per Bulan (sebelum pajak)", series, { format: (v) => money(v) })}${listCard("Vendor Terbesar (12 bulan)", ["Vendor", "Pembelian"], top.map((r) => [esc(r.partner_id?.[1] ?? "-"), money(r["amount_untaxed:sum"])]), "Belum ada pembelian.", [1])}</div>`,
    };
  },

  async inventory() {
    const nowText = utc(now());
    const [ready, outgoing, waiting, late, negative, expired, series] = await Promise.all([
      count("stock.picking", [["picking_type_code", "=", "incoming"], ["state", "=", "assigned"]]),
      count("stock.picking", [["picking_type_code", "=", "outgoing"], ["state", "=", "assigned"]]),
      count("stock.picking", [["state", "in", ["confirmed", "waiting"]]]),
      count("stock.picking", [["state", "in", ["assigned", "confirmed", "waiting"]], ["scheduled_date", "<", nowText]]),
      count("stock.quant", [["location_id.usage", "=", "internal"], ["quantity", "<", 0]]),
      count("stock.lot", [["expiration_date", "<", nowText], ["product_qty", ">", 0]]).catch(() => 0),
      Promise.all([
        monthly("stock.move.line", [["state", "=", "done"], ["location_id.usage", "!=", "internal"], ["location_dest_id.usage", "=", "internal"], ["location_id.usage", "!=", "inventory"]], "date", "quantity"),
        monthly("stock.move.line", [["state", "=", "done"], ["location_id.usage", "=", "internal"], ["location_dest_id.usage", "!=", "internal"], ["location_dest_id.usage", "!=", "inventory"]], "date", "quantity"),
      ]),
    ]);
    const [inbound, outbound] = series;
    const value = await total("stock.quant", [["location_id.usage", "=", "internal"]], "value").catch(() => 0);
    const reorder = await searchRead("stock.warehouse.orderpoint", [["trigger", "=", "manual"]], ["qty_to_order"], { limit: 200 }).catch(() => []);
    const lowCount = reorder.filter((o) => o.qty_to_order > 0).length;
    return {
      title: "Dashboard Inventory",
      html: shortcuts([["Penerimaan Siap", "#/receipt?state=assigned", "fa-truck-ramp-box"], ["Pengiriman Siap", "#/delivery?state=assigned", "fa-truck"], ["Physical Inventory", "#/count", "fa-clipboard-check"], ["Replenishment", "#/replenish", "fa-rotate"]]) +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Penerimaan siap", ready, { href: "#/receipt?state=assigned" })}${tile("Pengiriman siap", outgoing, { href: "#/delivery?state=assigned" })}${tile("Menunggu stok", waiting, { href: "#/delivery?state=confirmed", tone: waiting ? "text-amber-700" : "" })}${tile("Terlambat", late, { href: "#/delivery", tone: late ? "text-rose-700" : "" })}</div>` +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Nilai stok", money(value), { href: "#/stock/report" })}${tile("Perlu diisi ulang", lowCount, { href: "#/replenish", hint: "di bawah stok minimum", tone: lowCount ? "text-amber-700" : "" })}${tile("Stok minus", negative, { href: "#/stock/report?state=negative", tone: negative ? "text-rose-700" : "" })}${tile("Lot kedaluwarsa", expired, { href: "#/lot?state=expired", tone: expired ? "text-rose-700" : "" })}</div>` +
        `<div class="grid lg:grid-cols-2 gap-4">${bars("Barang Masuk per Bulan", inbound)}${bars("Barang Keluar per Bulan", outbound, { colors: ["bg-emerald-500"] })}</div>`,
    };
  },

  async manufacture() {
    const nowText = utc(now());
    const monthStart = utc(new Date(Date.UTC(now().getFullYear(), now().getMonth(), 1)));
    const [states, late, produced, series, upcoming] = await Promise.all([
      group("mrp.production", [], ["state"], ["__count"]),
      count("mrp.production", [["state", "in", ["draft", "confirmed"]], ["date_start", "<", nowText]]),
      total("mrp.production", [["state", "=", "done"], ["date_finished", ">=", monthStart]], "product_qty"),
      monthly("mrp.production", [["state", "=", "done"]], "date_finished", "product_qty"),
      searchRead("mrp.production", [["state", "in", ["confirmed", "progress", "to_close"]]], ["name", "product_id", "product_qty", "date_start", "state"], { order: "date_start", limit: 5 }),
    ]);
    const n = (key) => states.find((s) => s.state === key)?.__count ?? 0;
    return {
      title: "Dashboard Manufacture",
      html: shortcuts([["MO Baru", "#/mo/new", "fa-plus"], ["Schedule Production", "#/schedule", "fa-calendar-days"], ["Bill of Material", "#/bom", "fa-sitemap"]]) +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Dikonfirmasi", n("confirmed"), { href: "#/mo?state=confirmed" })}${tile("Sedang diproduksi", n("progress"), { href: "#/mo?state=progress" })}${tile("Siap ditutup", n("to_close"), { href: "#/mo?state=to_close", tone: n("to_close") ? "text-amber-700" : "" })}${tile("Terlambat dimulai", late, { href: "#/schedule?state=late", tone: late ? "text-rose-700" : "" })}</div>` +
        `<div class="grid md:grid-cols-2 gap-4 mb-4">${tile("Unit diproduksi bulan ini", nf.format(produced), { href: "#/production" })}${tile("MO selesai (semua waktu)", n("done"), { href: "#/mo?state=done" })}</div>` +
        `<div class="grid lg:grid-cols-2 gap-4">${bars("Unit Diproduksi per Bulan", series)}${listCard("Produksi Terdekat", ["MO", "Produk", "Jumlah", "Mulai"], upcoming.map((r) => [link(`#/mo/${r.id}`, r.name), esc(r.product_id[1]), nf.format(r.product_qty), esc(dateText(r.date_start))]), "Tidak ada MO terjadwal.", [2])}</div>`,
    };
  },

  async crm() {
    const today = ymd(now());
    const [open, leads, won, lost, overdue, stages, series] = await Promise.all([
      group("crm.lead", [["type", "=", "opportunity"], ["active", "=", true], ["won_status", "=", "pending"]], [], ["__count", "expected_revenue:sum", "prorated_revenue:sum"]),
      count("crm.lead", [["type", "=", "lead"], ["active", "=", true]]),
      count("crm.lead", [["type", "=", "opportunity"], ["won_status", "=", "won"]]),
      count("crm.lead", [["type", "=", "opportunity"], ["won_status", "=", "lost"]], { active_test: false }),
      count("mail.activity", [["res_model", "=", "crm.lead"], ["date_deadline", "<", today]]),
      group("crm.lead", [["type", "=", "opportunity"], ["active", "=", true], ["won_status", "=", "pending"]], ["stage_id"], ["__count", "expected_revenue:sum"]),
      monthly("crm.lead", [["type", "=", "opportunity"], ["won_status", "=", "won"]], "date_closed", "expected_revenue"),
    ]);
    const rate = won + lost ? (won / (won + lost)) * 100 : 0;
    return {
      title: "Dashboard CRM",
      html: shortcuts([["Opportunity Baru", "#/opportunity/new", "fa-plus"], ["Pipeline", "#/opportunity", "fa-table-columns"], ["Aktivitas", "#/crmreport/activities", "fa-clock"]]) +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Peluang berjalan", open[0]?.__count ?? 0, { href: "#/opportunity" })}${tile("Pendapatan diharapkan", money(open[0]?.["expected_revenue:sum"] ?? 0), { href: "#/crmreport/forecast", hint: `berbobot ${money(open[0]?.["prorated_revenue:sum"] ?? 0)}` })}${tile("Tingkat menang", `${nf.format(rate)}%`, { href: "#/crmreport/pipeline", hint: `${won} menang, ${lost} kalah` })}${tile("Aktivitas lewat tenggat", overdue, { href: "#/crmreport/activities?state=overdue", tone: overdue ? "text-rose-700" : "" })}</div>` +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Lead belum dikonversi", leads, { href: "#/lead" })}</div>` +
        `<div class="grid lg:grid-cols-2 gap-4">${bars("Pendapatan Menang per Bulan", series, { format: (v) => money(v), colors: ["bg-emerald-500"] })}${bars("Pendapatan Diharapkan per Tahap", stages.map((s) => ({ label: s.stage_id?.[1] ?? "-", value: s["expected_revenue:sum"] })), { format: (v) => money(v) })}</div>`,
    };
  },

  async hr() {
    const dayStart = utc(startOfDay());
    const [employees, present, todayAtt, ot] = await Promise.all([
      count("hr.employee", []),
      count("hr.attendance", [["check_out", "=", false]]),
      count("hr.attendance", [["check_in", ">=", dayStart]]),
      count("hr.attendance", [["overtime_hours", ">", 0], ["overtime_status", "=", "to_approve"]]),
    ]);
    const series = await monthly("hr.attendance", [], "check_in", "worked_hours");
    return {
      title: "Dashboard Human Resources",
      html: shortcuts([["Karyawan Baru", "#/employee/new", "fa-user-plus"], ["Kehadiran", "#/attendance", "fa-user-clock"], ["Departemen", "#/department", "fa-sitemap"]]) +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Karyawan aktif", employees, { href: "#/employee" })}${tile("Sedang hadir", present, { href: "#/attendance?period=open" })}${tile("Check in hari ini", todayAtt, { href: "#/attendance?period=today" })}${tile("Lembur menunggu persetujuan", ot, { href: "#/attendance?ot=to_approve", tone: ot ? "text-amber-700" : "" })}</div>` +
        `<div class="grid lg:grid-cols-2 gap-4">${bars("Jam Kerja per Bulan", series, { format: (v) => `${nf.format(v)} j` })}</div>`,
    };
  },

  async pos() {
    const todayStart = utc(startOfDay());
    const paid = [["state", "in", ["paid", "done", "invoiced"]]];
    const weekAgo = new Date(startOfDay().getTime() - 6 * 86400000);
    const [sessions, today, byMethod, daily] = await Promise.all([
      searchRead("pos.session", [["state", "in", ["opened", "opening_control"]]], ["name", "config_id", "user_id", "order_count"], { limit: 10 }),
      group("pos.order", [...paid, ["date_order", ">=", todayStart]], [], ["__count", "amount_total:sum"]),
      group("pos.payment", [["payment_date", ">=", todayStart]], ["payment_method_id"], ["amount:sum"]),
      group("pos.order", [...paid, ["date_order", ">=", utc(weekAgo)]], ["date_order:day"], ["amount_total:sum"]),
    ]);
    const days = new Map(daily.map((r) => [String(r["date_order:day"]?.[0] ?? "").slice(0, 10), r["amount_total:sum"]]));
    const series = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(weekAgo.getTime() + i * 86400000);
      return { label: `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`, value: days.get(ymd(d)) ?? 0 };
    });
    const orders = today[0]?.__count ?? 0;
    const amount = today[0]?.["amount_total:sum"] ?? 0;
    return {
      title: "Dashboard POS",
      html: shortcuts([["Buka Kasir", "#/kasir", "fa-cash-register"], ["POS Station", "#/posconfig", "fa-store"], ["POS Order", "#/posorder", "fa-receipt"]]) +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Sesi berjalan", sessions.length, { href: "#/possession?state=opened" })}${tile("Penjualan hari ini", money(amount), { href: "#/posorder" })}${tile("Pesanan hari ini", orders)}${tile("Rata-rata per pesanan", money(orders ? amount / orders : 0))}</div>` +
        `<div class="grid lg:grid-cols-2 gap-4">${bars("Penjualan 7 Hari Terakhir", series, { format: (v) => money(v) })}${listCard("Pembayaran Hari Ini per Metode", ["Metode", "Jumlah"], byMethod.map((r) => [esc(r.payment_method_id[1]), money(r["amount:sum"])]), "Belum ada pembayaran hari ini.", [1])}</div>` +
        `<div class="mt-4">${listCard("Sesi Berjalan", ["Sesi", "Stasiun", "Kasir", "Pesanan"], sessions.map((s) => [link(`#/possession/${s.id}`, s.name), esc(s.config_id[1]), esc(s.user_id?.[1] ?? ""), String(s.order_count)]), "Tidak ada sesi berjalan.", [3])}</div>`,
    };
  },

  async sales() {
    const yearAgo = ymd(new Date(now().getFullYear() - 1, now().getMonth(), now().getDate()));
    const [quotes, orders, toDeliver, toInvoice, series, customers] = await Promise.all([
      group("sale.order", [["state", "in", ["draft", "sent"]]], [], ["__count", "amount_total:sum"]),
      group("sale.order", [["state", "=", "sale"]], [], ["__count", "amount_total:sum"]),
      count("sale.order", [["state", "=", "sale"], ["delivery_status", "in", ["pending", "started", "partial"]]]),
      count("sale.order", [["invoice_status", "=", "to invoice"]]),
      monthly("sale.order", [["state", "in", ["sale", "done"]]], "date_order", "amount_untaxed"),
      group("sale.order", [["state", "in", ["sale", "done"]], ["date_order", ">=", `${yearAgo} 00:00:00`]], ["partner_id"], ["amount_untaxed:sum"]),
    ]);
    const top = customers.sort((a, b) => b["amount_untaxed:sum"] - a["amount_untaxed:sum"]).slice(0, 5);
    return {
      title: "Dashboard Sales",
      html: shortcuts([["Quotation Baru", "#/sale/new", "fa-plus"], ["Pengiriman Siap", "#/delivery?state=assigned", "fa-truck"], ["Faktur Draft", "#/invoice?state=draft", "fa-file-invoice-dollar"]]) +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Quotation", quotes[0]?.__count ?? 0, { href: "#/sale?state=draft", hint: money(quotes[0]?.["amount_total:sum"] ?? 0) })}${tile("Sales Order berjalan", orders[0]?.__count ?? 0, { href: "#/sale?state=sale", hint: money(orders[0]?.["amount_total:sum"] ?? 0) })}${tile("Perlu dikirim", toDeliver, { href: "#/sale?state=sale", tone: toDeliver ? "text-amber-700" : "" })}${tile("Perlu ditagih", toInvoice, { href: "#/sale?state=sale", tone: toInvoice ? "text-amber-700" : "" })}</div>` +
        `<div class="grid lg:grid-cols-2 gap-4">${bars("Penjualan per Bulan (sebelum pajak)", series, { format: (v) => money(v) })}${listCard("Pelanggan Terbesar (12 bulan)", ["Pelanggan", "Penjualan"], top.map((r) => [esc(r.partner_id?.[1] ?? "-"), money(r["amount_untaxed:sum"])]), "Belum ada penjualan.", [1])}</div>`,
    };
  },

  async accounting() {
    const today = ymd(now());
    const incomeTypes = ["income", "income_other"];
    const expenseTypes = ["expense", "expense_depreciation", "expense_direct_cost"];
    const posted = [["parent_state", "=", "posted"]];
    const [cash, receivable, payable, drafts, income, expense] = await Promise.all([
      group("account.move.line", [...posted, ["account_id.account_type", "=", "asset_cash"]], ["account_id"], ["balance:sum"]),
      total("account.move.line", [...posted, ["account_id.account_type", "=", "asset_receivable"], ["reconciled", "=", false], ["date_maturity", "<", today]], "amount_residual"),
      total("account.move.line", [...posted, ["account_id.account_type", "=", "liability_payable"], ["reconciled", "=", false], ["date_maturity", "<", today]], "amount_residual"),
      count("account.move", [["state", "=", "draft"], ["move_type", "in", ["out_invoice", "in_invoice", "out_refund", "in_refund"]]]),
      monthly("account.move.line", [...posted, ["account_id.account_type", "in", incomeTypes]], "date", "balance", 6, {}, false),
      monthly("account.move.line", [...posted, ["account_id.account_type", "in", expenseTypes]], "date", "balance", 6, {}, false),
    ]);
    const cashTotal = cash.reduce((s, r) => s + r["balance:sum"], 0);
    const revenue = income.map((m) => ({ label: m.label, value: m.value ? -m.value : 0 }));
    const costs = expense.map((m) => ({ label: m.label, value: m.value }));
    const series = revenue.map((m, i) => ({ label: m.label, values: [m.value, costs[i].value] }));
    const thisMonth = series[series.length - 1]?.values ?? [0, 0];
    return {
      title: "Dashboard Accounting",
      html: shortcuts([["Faktur Pelanggan", "#/invoice", "fa-file-invoice-dollar"], ["Tagihan Vendor", "#/bill", "fa-file-invoice"], ["Rekonsiliasi Bank", "#/bank", "fa-building-columns"], ["Laba Rugi", "#/report/laba-rugi", "fa-chart-pie"]]) +
        `<div class="grid md:grid-cols-4 gap-4 mb-4">${tile("Kas dan bank", money(cashTotal), { href: "#/report/neraca" })}${tile("Piutang jatuh tempo", money(receivable), { href: "#/aging/receivable", tone: receivable > 0 ? "text-amber-700" : "" })}${tile("Hutang jatuh tempo", money(-payable), { href: "#/aging/payable", tone: payable < 0 ? "text-amber-700" : "" })}${tile("Dokumen draft", drafts, { href: "#/invoice?state=draft", hint: "faktur, tagihan, dan nota" })}</div>` +
        `<div class="grid md:grid-cols-3 gap-4 mb-4">${tile("Pendapatan bulan ini", money(thisMonth[0]), { href: "#/report/laba-rugi" })}${tile("Biaya bulan ini", money(thisMonth[1]), { href: "#/report/laba-rugi" })}${tile("Laba bulan ini", money(thisMonth[0] - thisMonth[1]), { href: "#/report/ringkasan", tone: thisMonth[0] - thisMonth[1] < 0 ? "text-rose-700" : "text-emerald-700" })}</div>` +
        `<div class="grid lg:grid-cols-1 gap-4">${bars("Pendapatan (kiri) dan Biaya (kanan) per Bulan", series, { format: (v) => money(v), colors: ["bg-emerald-500", "bg-rose-400"] })}</div>` +
        '<p class="mt-3 text-xs text-gray-500">Pendapatan dan biaya dari jurnal terposting menurut jenis akun; laporan lengkap ada di Laba Rugi dan Neraca.</p>',
    };
  },
};

let last = "sales";
const KEYS = { pr: "pr", purchase: "purchase", inventory: "inventory", manufacture: "manufacture", crm: "crm", pos: "pos", sales: "sales", accounting: "accounting", hr: "hr" };

export async function render(sub) {
  const key = KEYS[sub] ?? "sales";
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat dashboard...</p>';
  const result = await BUILDERS[key]();
  app.innerHTML = pageHeader(result.title, `<button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>`) + result.html;
  last = sub;
}

export const leave = () => {};
export function onClick(event, el) {
  if (el.dataset.action === "refresh") render(last);
}
