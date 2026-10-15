// Laporan akuntansi dari data jurnal dan analisis faktur: Tax Report (PPN keluaran dan masukan per pajak dengan dasar pengenaan
// pajak), Invoice Analysis (penjualan atau pembelian per bulan, mitra, produk, kategori, atau sales), dan Analytic Report
// (pendapatan dan biaya per akun analitik). Semuanya per rentang tanggal dan bisa diunduh sebagai CSV.
import { INPUT, app, call, ctx, dateText, esc, money, openModal, pageHeader, searchRead, selectOptions } from "../common.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const pad = (n) => String(n).padStart(2, "0");
const TITLES = { tax: "Tax Report", invoice: "Invoice Analysis", analytic: "Analytic Report" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const todayText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const yearStart = () => `${new Date().getFullYear()}-01-01`;
const monthLabel = (key) => (key ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` : "Tanpa tanggal");

let last = { sub: "tax", query: new URLSearchParams() };
let exportRows = [];
export const leave = () => {
  exportRows = [];
};

const card = (label, value, hint = "", tone = "") =>
  `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${esc(label)}</div><div class="text-xl font-semibold mt-1 ${tone}">${esc(value)}</div>${hint ? `<div class="text-xs text-gray-500 mt-1">${esc(hint)}</div>` : ""}</div>`;
const head = (labels, right = []) => `<thead class="bg-gray-50"><tr>${labels.map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${right.includes(i) ? "text-right" : ""}">${esc(h)}</th>`).join("")}</tr></thead>`;
const section = (title, inner) => `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">${esc(title)}</div>${inner}</section>`;
const dateControls = (from, to) =>
  `<label class="text-xs font-medium text-gray-500 uppercase">Dari<input type="date" data-acct="from" value="${esc(from)}" class="${INPUT} mt-1 w-40"></label>
   <label class="text-xs font-medium text-gray-500 uppercase">Sampai<input type="date" data-acct="to" value="${esc(to)}" class="${INPUT} mt-1 w-40"></label>`;
const csvButton = `<button type="button" data-action="csv" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-download mr-2"></i>Unduh CSV</button>`;

export async function render(sub, query) {
  const kind = TITLES[sub] ? sub : "tax";
  last = { sub: kind, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat laporan...</p>';
  const from = query.get("from") ?? yearStart();
  const to = query.get("to") ?? todayText();
  const body = await { tax, invoice, analytic }[kind](query, from, to);
  app.innerHTML = pageHeader(TITLES[kind], `${body.controls ?? ""}${dateControls(from, to)}${csvButton}`) + body.html;
}

/* ---------- Tax Report ---------- */

async function tax(query, from, to) {
  const domain = [["parent_state", "=", "posted"], ["tax_line_id", "!=", false], ["date", ">=", from], ["date", "<=", to]];
  const rows = await call("account.move.line", "formatted_read_group", { domain, groupby: ["tax_line_id"], aggregates: ["__count", "balance:sum", "tax_base_amount:sum"] });
  const taxIds = rows.map((r) => r.tax_line_id[0]);
  const taxes = taxIds.length ? await searchRead("account.tax", [["id", "in", taxIds]], ["name", "type_tax_use", "amount"], { context: { active_test: false } }) : [];
  const info = new Map(taxes.map((t) => [t.id, t]));
  // Penjualan: pajak keluaran (kredit, saldo negatif); pembelian: pajak masukan (debit, saldo positif).
  const build = (use, sign) =>
    rows
      .filter((r) => info.get(r.tax_line_id[0])?.type_tax_use === use)
      .map((r) => ({ id: r.tax_line_id[0], name: r.tax_line_id[1], rate: info.get(r.tax_line_id[0])?.amount ?? 0, count: r.__count, base: sign * r["tax_base_amount:sum"], tax: sign * r["balance:sum"] }));
  const output = build("sale", -1);
  const input = build("purchase", 1);
  const sum = (list, key) => list.reduce((s, r) => s + r[key], 0);
  const net = sum(output, "tax") - sum(input, "tax");
  const table = (title, list, sign) =>
    section(
      title,
      `<table class="w-full text-left">${head(["Pajak", "Tarif", "Baris", "Dasar Pengenaan Pajak", "Pajak"], [1, 2, 3, 4])}<tbody class="divide-y divide-gray-100">${
        list
          .map(
            (r) => `<tr class="hover:bg-gray-50 cursor-pointer" data-action="tax-detail" data-id="${r.id}" data-sign="${sign}" data-name="${esc(r.name)}"><td class="py-2 px-4 text-sm font-medium text-indigo-700">${esc(r.name)}</td>
              <td class="py-2 px-4 text-sm text-right tabular-nums">${nf.format(r.rate)}%</td><td class="py-2 px-4 text-sm text-right tabular-nums">${r.count}</td>
              <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(r.base))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(r.tax))}</td></tr>`,
          )
          .join("") || '<tr><td colspan="5" class="py-6 text-center text-sm text-gray-500">Tidak ada transaksi pada rentang ini.</td></tr>'
      }</tbody>${list.length ? `<tfoot class="bg-gray-50"><tr><td colspan="3" class="py-2 px-4 text-sm font-semibold">Total</td><td class="py-2 px-4 text-sm text-right tabular-nums font-semibold">${esc(money(sum(list, "base")))}</td><td class="py-2 px-4 text-sm text-right tabular-nums font-semibold">${esc(money(sum(list, "tax")))}</td></tr></tfoot>` : ""}</table>`,
    );
  exportRows = [["Jenis", "Pajak", "Tarif (%)", "Baris", "Dasar Pengenaan Pajak", "Pajak"], ...output.map((r) => ["Keluaran", r.name, r.rate, r.count, r.base, r.tax]), ...input.map((r) => ["Masukan", r.name, r.rate, r.count, r.base, r.tax])];
  return {
    html: `<div class="grid md:grid-cols-3 gap-4 mb-4">
        ${card("PPN Keluaran (penjualan)", money(sum(output, "tax")), `DPP ${money(sum(output, "base"))}`)}
        ${card("PPN Masukan (pembelian)", money(sum(input, "tax")), `DPP ${money(sum(input, "base"))}`)}
        ${card(net >= 0 ? "PPN Kurang Bayar" : "PPN Lebih Bayar", money(Math.abs(net)), "keluaran dikurangi masukan", net >= 0 ? "text-rose-700" : "text-emerald-700")}</div>` +
      table("Pajak Keluaran", output, -1) + table("Pajak Masukan", input, 1) +
      '<p class="text-xs text-gray-500">Dari jurnal terposting, termasuk nota kredit dan retur yang mengurangi pajak. Klik baris untuk melihat rincian per dokumen. Pelaporan SPT dan e-Faktur dilakukan terpisah.</p>',
  };
}

async function taxDetail(id, name, sign) {
  const lines = await searchRead("account.move.line", [["parent_state", "=", "posted"], ["tax_line_id", "=", id], ["date", ">=", last.query.get("from") ?? yearStart()], ["date", "<=", last.query.get("to") ?? todayText()]], ["date", "move_id", "partner_id", "tax_base_amount", "balance"], {
    order: "date desc, id desc", limit: 200,
  });
  openModal(
    `Rincian ${name}`,
    `<div class="overflow-x-auto"><table class="w-full text-left" data-list="on">${head(["Tanggal", "Dokumen", "Mitra", "DPP", "Pajak"], [3, 4])}<tbody class="divide-y divide-gray-100">${lines
      .map((l) => `<tr><td class="py-2 px-3 text-sm">${esc(dateText(l.date))}</td><td class="py-2 px-3 text-sm">${esc(l.move_id[1])}</td><td class="py-2 px-3 text-sm">${esc(l.partner_id?.[1] ?? "-")}</td><td class="py-2 px-3 text-sm text-right tabular-nums">${esc(money(sign * l.tax_base_amount))}</td><td class="py-2 px-3 text-sm text-right tabular-nums">${esc(money(sign * l.balance))}</td></tr>`)
      .join("")}</tbody></table></div>${lines.length >= 200 ? '<p class="text-xs text-gray-500 mt-2">Menampilkan 200 terbaru.</p>' : ""}`,
    '<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Tutup</button>',
    null,
    { wide: true },
  );
}

/* ---------- Invoice Analysis ---------- */

const DIMENSIONS = {
  month: { label: "Bulan", groupby: "invoice_date:month" },
  partner: { label: "Mitra", groupby: "commercial_partner_id" },
  product: { label: "Produk", groupby: "product_id" },
  category: { label: "Kategori Produk", groupby: "product_categ_id" },
  user: { label: "Sales", groupby: "invoice_user_id" },
};

async function invoice(query, from, to) {
  const side = query.get("side") === "purchase" ? "purchase" : "sale";
  const dim = DIMENSIONS[query.get("by")] ? query.get("by") : "month";
  const types = side === "sale" ? ["out_invoice", "out_refund"] : ["in_invoice", "in_refund"];
  const sign = side === "sale" ? 1 : -1; // laporan Odoo bertanda negatif untuk pembelian dan nota kredit
  const domain = [["state", "=", "posted"], ["move_type", "in", types], ["invoice_date", ">=", from], ["invoice_date", "<=", to]];
  const groupby = DIMENSIONS[dim].groupby;
  const [rows, totals] = await Promise.all([
    call("account.invoice.report", "formatted_read_group", { domain, groupby: [groupby], aggregates: ["__count", "price_subtotal:sum", "price_total:sum", "quantity:sum"] }),
    call("account.invoice.report", "formatted_read_group", { domain, groupby: ["move_type"], aggregates: ["__count", "price_subtotal:sum"] }),
  ]);
  const labelOf = (r) => {
    const v = r[groupby];
    if (dim === "month") return v ? monthLabel(v[0].slice(0, 7)) : "Tanpa tanggal";
    return v ? v[1] : "Tanpa data";
  };
  const list = rows.map((r) => ({ label: labelOf(r), key: dim === "month" ? (r[groupby]?.[0] ?? "") : "", count: r.__count, subtotal: sign * r["price_subtotal:sum"], total: sign * r["price_total:sum"], qty: sign * r["quantity:sum"] }));
  list.sort((a, b) => (dim === "month" ? (a.key < b.key ? -1 : 1) : b.subtotal - a.subtotal));
  const sumOf = (key) => list.reduce((s, r) => s + r[key], 0);
  const byType = Object.fromEntries(totals.map((t) => [t.move_type, sign * t["price_subtotal:sum"]]));
  const maxValue = Math.max(1, ...list.map((r) => Math.abs(r.subtotal)));
  exportRows = [[DIMENSIONS[dim].label, "Baris", "Jumlah", "Sebelum Pajak", "Termasuk Pajak"], ...list.map((r) => [r.label, r.count, r.qty, r.subtotal, r.total])];
  return {
    controls: `<select data-acct="side" class="${INPUT} w-40"><option value="sale" ${side === "sale" ? "selected" : ""}>Penjualan</option><option value="purchase" ${side === "purchase" ? "selected" : ""}>Pembelian</option></select>
      <select data-acct="by" class="${INPUT} w-44">${selectOptions(Object.entries(DIMENSIONS).map(([k, d]) => ({ id: k, display_name: d.label })), dim)}</select>`,
    html: `<div class="grid md:grid-cols-4 gap-4 mb-4">
        ${card(side === "sale" ? "Penjualan bersih" : "Pembelian bersih", money(sumOf("subtotal")), "sebelum pajak, setelah nota kredit")}
        ${card("Termasuk pajak", money(sumOf("total")))}
        ${card(side === "sale" ? "Faktur" : "Tagihan", money(byType[types[0]] ?? 0), `${totals.find((t) => t.move_type === types[0])?.__count ?? 0} baris`)}
        ${card(side === "sale" ? "Nota kredit" : "Nota debit", money(byType[types[1]] ?? 0), `${totals.find((t) => t.move_type === types[1])?.__count ?? 0} baris`)}</div>` +
      section(`Per ${DIMENSIONS[dim].label}`, `<table class="w-full text-left">${head([DIMENSIONS[dim].label, "Baris", "Jumlah", "", "Sebelum Pajak", "Termasuk Pajak"], [1, 2, 4, 5])}<tbody class="divide-y divide-gray-100">${
        list
          .map(
            (r) => `<tr><td class="py-2 px-4 text-sm">${esc(r.label)}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${r.count}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${nf.format(r.qty)}</td>
              <td class="py-2 px-4 text-sm w-1/4"><div class="h-3 bg-gray-100 rounded"><div class="h-3 ${r.subtotal < 0 ? "bg-rose-400" : "bg-indigo-500"} rounded" style="width:${Math.round((Math.abs(r.subtotal) / maxValue) * 100)}%"></div></div></td>
              <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(r.subtotal))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(r.total))}</td></tr>`,
          )
          .join("") || '<tr><td colspan="6" class="py-6 text-center text-sm text-gray-500">Tidak ada dokumen terposting pada rentang ini.</td></tr>'
      }</tbody></table>`) +
      '<p class="text-xs text-gray-500">Dokumen terposting menurut tanggal faktur. Nota kredit mengurangi penjualan; baris tanpa produk (mis. biaya) dikelompokkan sebagai "Tanpa data" pada analisis per produk.</p>',
  };
}

/* ---------- Analytic Report ---------- */

async function analytic(query, from, to) {
  // hanya akun laba rugi (pendapatan dan biaya): pembelian persediaan masuk akun neraca dan bukan biaya sampai barangnya terjual
  const domain = [["date", ">=", from], ["date", "<=", to], ["general_account_id.account_type", "in", ["income", "income_other", "expense", "expense_direct_cost", "expense_depreciation", "expense_other"]]];
  // Tiap rencana analitik punya kolomnya sendiri di baris analitik: `account_id` untuk rencana bawaan (Project) dan `x_plan<id>_id` untuk
  // rencana lain, jadi setiap kolom dikelompokkan sendiri-sendiri (satu baris bisa tercatat pada beberapa rencana).
  const fieldMap = await call("account.analytic.line", "fields_get", { attributes: ["relation"] });
  const columns = Object.entries(fieldMap).filter(([key, f]) => (key === "account_id" || /^x_plan\d+_id$/.test(key)) && f.relation === "account.analytic.account").map(([key]) => key);
  const group = (column, sign) => call("account.analytic.line", "formatted_read_group", { domain: [...domain, ["amount", sign, 0]], groupby: [column], aggregates: ["__count", "amount:sum"] });
  const [accounts, enabled, totalIn, totalOut, ...grouped] = await Promise.all([
    searchRead("account.analytic.account", [], ["name", "code", "plan_id"], { order: "name", limit: 500, context: { active_test: false } }),
    call("res.users", "has_group", { ids: [ctx.user.id], group_ext_id: "analytic.group_analytic_accounting" }),
    call("account.analytic.line", "formatted_read_group", { domain: [...domain, ["amount", ">", 0]], groupby: [], aggregates: ["amount:sum"] }),
    call("account.analytic.line", "formatted_read_group", { domain: [...domain, ["amount", "<", 0]], groupby: [], aggregates: ["amount:sum"] }),
    ...columns.flatMap((column) => [group(column, ">"), group(column, "<")]),
  ]);
  const byAccount = new Map(accounts.map((a) => [a.id, { name: a.code ? `[${a.code}] ${a.name}` : a.name, plan: a.plan_id?.[1] ?? "", income: 0, expense: 0, lines: 0 }]));
  columns.forEach((column, k) => {
    for (const r of grouped[2 * k]) if (byAccount.has(r[column]?.[0])) Object.assign(byAccount.get(r[column][0]), { income: r["amount:sum"], lines: byAccount.get(r[column][0]).lines + r.__count });
    for (const r of grouped[2 * k + 1]) if (byAccount.has(r[column]?.[0])) Object.assign(byAccount.get(r[column][0]), { expense: -r["amount:sum"], lines: byAccount.get(r[column][0]).lines + r.__count });
  });
  const list = [...byAccount.values()].filter((a) => a.lines).sort((a, b) => a.plan.localeCompare(b.plan) || b.income - b.expense - (a.income - a.expense));
  const totalIncome = totalIn[0]?.["amount:sum"] || 0;
  const totalExpense = -(totalOut[0]?.["amount:sum"] || 0);
  exportRows = [["Akun Analitik", "Rencana", "Pendapatan", "Biaya", "Saldo"], ...list.map((a) => [a.name, a.plan, a.income, a.expense, a.income - a.expense])];
  return {
    html:
      (enabled ? "" : '<p class="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">Akuntansi analitik belum aktif untuk pengguna ini, jadi baris jurnal belum diberi akun analitik. Aktifkan fitur Analytic Accounting di pengaturan Odoo.</p>') +
      `<div class="grid md:grid-cols-3 gap-4 mb-4">${card("Pendapatan", money(totalIncome))}${card("Biaya", money(totalExpense))}${card("Saldo", money(totalIncome - totalExpense), `${list.length} akun analitik`, totalIncome - totalExpense < 0 ? "text-rose-700" : "text-emerald-700")}</div>` +
      section("Per Akun Analitik", `<table class="w-full text-left">${head(["Akun Analitik", "Rencana", "Baris", "Pendapatan", "Biaya", "Saldo"], [2, 3, 4, 5])}<tbody class="divide-y divide-gray-100">${
        list
          .map((a) => `<tr><td class="py-2 px-4 text-sm">${esc(a.name)}</td><td class="py-2 px-4 text-sm text-gray-600">${esc(a.plan)}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${a.lines}</td>
            <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(a.income))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(a.expense))}</td><td class="py-2 px-4 text-sm text-right tabular-nums font-medium ${a.income - a.expense < 0 ? "text-rose-700" : ""}">${esc(money(a.income - a.expense))}</td></tr>`)
          .join("") || '<tr><td colspan="6" class="py-8 text-center text-sm text-gray-500">Belum ada baris analitik pada rentang ini.</td></tr>'
      }</tbody></table>`) +
      '<p class="text-xs text-gray-500">Hanya baris pada akun laba rugi: pendapatan adalah baris analitik bernilai positif dan biaya yang bernilai negatif, dari faktur, tagihan, dan entri jurnal yang diberi distribusi analitik (pembelian persediaan masuk akun neraca dan belum dihitung sebagai biaya). Satu baris bisa tercatat pada akun dari beberapa rencana (mis. Departemen dan Lini Produk), jadi angka per akun tidak dijumlahkan lintas rencana; kartu di atas memakai total asli.</p>',
  };
}

/* ---------- Penanganan acara ---------- */

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "tax-detail") await taxDetail(Number(el.dataset.id), el.dataset.name, Number(el.dataset.sign));
  else if (action === "csv") {
    const text = exportRows.map((row) => row.map((v) => (typeof v === "number" ? String(v) : `"${String(v ?? "").replaceAll('"', '""')}"`)).join(",")).join("\r\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
    link.download = `${TITLES[last.sub].toLowerCase().replaceAll(" ", "-")}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }
}

export function onChange(event, el) {
  const key = el.dataset.acct;
  if (!key) return;
  const params = new URLSearchParams(last.query);
  if (el.value) params.set(key, el.value);
  else params.delete(key);
  const qs = params.toString();
  location.hash = `#/acctreport/${last.sub}${qs ? `?${qs}` : ""}`;
}
