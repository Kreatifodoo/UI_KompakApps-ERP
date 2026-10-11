// Budget Report: anggaran dibandingkan dengan realisasi, lengkap dengan selisih dan persentase pencapaian (D31). Halaman ini membuat
// instance laporan MIS sementara dengan dua kolom: Anggaran (sumber mis_budget_by_account dari mis_builder_budget, dibagi per hari
// terhadap periode laporan) dan Realisasi (jurnal terposting). Tampilan "Per Akun" memakai template Nusara mis_anggaran; tampilan
// "Laba Rugi" memakai template laba rugi yang sama dengan Accounting > Reporting. Angka bisa diklik sampai baris anggaran atau item jurnal.
import {
  INPUT, app, call, closeModal, dateText, esc, guarded, money, openModal, pageHeader, readOne, searchRead, selectOptions, today, toast,
} from "../common.js";
import { STATES } from "./budgetplan.js";

const VIEWS = {
  akun: { key: "mis_anggaran", label: "Per Akun" },
  labarugi: { key: "mis_laba_rugi", label: "Laba Rugi" },
};
// Baris yang makin kecil realisasinya makin baik (biaya) menurut label template; sisanya dianggap pendapatan atau laba.
const COST_SECTIONS = new Set(["Harga Pokok", "Beban"]);
const COST_LABELS = new Set([
  "Harga Pokok Penjualan", "Pembelian Bahan Baku", "Perubahan Persediaan", "Total Harga Pokok", "Gaji dan Tunjangan", "Beban Umum dan Kantor", "Jasa, Sewa, dan Pemeliharaan",
  "Kendaraan", "Penyusutan", "Beban Operasional Lain", "Total Beban Operasional", "Beban Lain", "Beban Pajak Penghasilan",
]);
const INCOME_LABELS = new Set(["Pendapatan", "Penjualan", "Pendapatan Bersih", "LABA KOTOR", "LABA USAHA", "Pendapatan Lain", "LABA SEBELUM PAJAK", "LABA BERSIH", "LABA (RUGI) BERSIH"]);

let current = null; // { instanceId, result, rows, view, planId }
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  dropInstance();
};
const reload = () => render(last.sub, last.query);

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
const num = (v) => (Math.round(v) === 0 ? "0" : v < 0 ? `(${nf.format(Math.abs(v))})` : nf.format(v));
const pct = (v) => `${(v * 100).toFixed(1).replace(".", ",")} %`;
const pad = (n) => String(n).padStart(2, "0");
const isPct = (c) => /%\s*$/.test(c?.val_r ?? "");
const hasValue = (c) => c && c.val !== null && c.val !== undefined;

async function dropInstance() {
  const id = current?.instanceId;
  current = null;
  if (!id) return;
  try {
    await call("mis.report.instance", "unlink", { ids: [id] });
  } catch {
    /* instance sementara dibersihkan Odoo (cron vacuum) bila gagal dihapus */
  }
}

/** Sel hasil rumus akun bisa diurai ke baris sumbernya; sel turunan (nama KPI) tidak. */
const drillable = (cell) => {
  const expr = cell?.drilldown_arg?.expr ?? "";
  if (!cell?.val || !/\b(bal[pei]|deb[pei]|crd[pei])\[/.test(expr)) return false;
  return !/[a-z_]{2,}/i.test(expr.replace(/\w+\[[^\]]*\]/g, ""));
};

/** Nilai selisih dan pencapaian sebuah baris, serta sifatnya (baik, buruk, netral) menurut jenis baris. */
function compare(budget, actual, kind) {
  if (!hasValue(budget) && !hasValue(actual)) return null;
  const b = budget?.val ?? 0;
  const a = actual?.val ?? 0;
  const diff = a - b;
  const ratio = b ? a / b : null;
  let tone = "";
  if (Math.abs(diff) >= 0.5 && kind) tone = (kind === "cost" ? diff > 0 : diff < 0) ? "text-rose-700" : "text-emerald-700";
  return { b, a, diff, ratio, tone };
}

export async function render(sub, query) {
  last = { sub, query };
  await dropInstance();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const plans = await searchRead("mis.budget.by.account", [], ["name", "date_from", "date_to", "state"], { order: "date_from desc, id desc", limit: 100 });
  if (!plans.length) {
    app.innerHTML =
      pageHeader("Budget Report") +
      '<div class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 text-sm text-gray-600">Belum ada rencana anggaran. Buat di <a href="#/budgetplan/new" class="text-indigo-700 underline">Budget Plan Master</a>, isi angkanya di <a href="#/budget" class="text-indigo-700 underline">Budget</a>, lalu kembali ke sini.</div>';
    return;
  }
  const wanted = Number(sub) || Number(query.get("plan")) || null;
  const chosen = plans.find((p) => p.id === wanted) ?? plans.find((p) => p.state === "confirmed") ?? plans[0];
  const view = VIEWS[query.get("view")] ? query.get("view") : "akun";
  const from = query.get("from") || chosen.date_from;
  const to = query.get("to") || chosen.date_to;
  const moves = query.get("moves") === "all" ? "all" : "posted";
  const analyticId = Number(query.get("analytic")) || null;
  const analytics = await searchRead("account.analytic.account", [], ["display_name"], { order: "name", limit: 300, context: { active_test: false } });

  const controls = `<form data-form="period" class="flex flex-wrap items-end gap-3">
      <label class="text-xs font-medium text-gray-500 uppercase">Rencana<select data-bp="plan" class="${INPUT} mt-1 w-64">${plans
        .map((p) => `<option value="${p.id}" ${p.id === chosen.id ? "selected" : ""}>${esc(p.name)} (${esc(STATES[p.state]?.[0] ?? p.state)})</option>`)
        .join("")}</select></label>
      <label class="text-xs font-medium text-gray-500 uppercase">Tampilan<select data-bp="view" class="${INPUT} mt-1 w-40">${Object.entries(VIEWS)
        .map(([k, v]) => `<option value="${k}" ${k === view ? "selected" : ""}>${esc(v.label)}</option>`)
        .join("")}</select></label>
      <label class="text-xs font-medium text-gray-500 uppercase">Dari<input type="date" data-bp="from" value="${esc(from)}" class="${INPUT} mt-1 w-40"></label>
      <label class="text-xs font-medium text-gray-500 uppercase">Sampai<input type="date" data-bp="to" value="${esc(to)}" class="${INPUT} mt-1 w-40"></label>
      <label class="text-xs font-medium text-gray-500 uppercase">Analitik<select data-bp="analytic" class="${INPUT} mt-1 w-48">${selectOptions(analytics, analyticId, "Semua")}</select></label>
      <label class="text-xs font-medium text-gray-500 uppercase">Entri<select data-bp="moves" class="${INPUT} mt-1 w-44">
        <option value="posted" ${moves === "posted" ? "selected" : ""}>Hanya terposting</option><option value="all" ${moves === "all" ? "selected" : ""}>Termasuk draft</option></select></label>
      <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Tampilkan</button>
      <button type="button" data-action="range-all" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Seluruh periode</button>
      <button type="button" data-action="range-today" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Sampai hari ini</button>
      <button type="button" data-action="csv" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-download mr-2"></i>Unduh CSV</button>
    </form>`;
  const header = `<div class="text-sm text-gray-500 mb-2"><a href="#/budget/${chosen.id}" class="hover:text-indigo-600">Budget</a> / Budget Report</div>
    <h1 class="text-2xl font-bold text-gray-900">Budget Report</h1>
    <p class="text-sm text-gray-500 mb-4">${esc(chosen.name)} · ${esc(VIEWS[view].label)} · ${esc(dateText(from))} s.d. ${esc(dateText(to))}${analyticId ? ` · ${esc(analytics.find((a) => a.id === analyticId)?.display_name ?? "")}` : ""}${moves === "all" ? " · termasuk entri draft" : ""}</p>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4">${controls}</section>`;

  if (from > to) {
    app.innerHTML = `${header}<p class="text-sm text-rose-600">Tanggal dari tidak boleh sesudah tanggal sampai.</p>`;
    return;
  }
  const [template] = await searchRead("ir.model.data", [["module", "=", "nusara_base"], ["name", "=", VIEWS[view].key]], ["res_id"], { limit: 1 });
  if (!template) {
    app.innerHTML = `${header}<p class="text-sm text-rose-600">Template laporan belum dimuat. Perbarui modul nusara_base di Odoo.</p>`;
    return;
  }
  const [instanceId] = await call("mis.report.instance", "create", {
    vals_list: [{
      name: `Anggaran vs Realisasi (UI)`, report_id: template.res_id, temporary: true, target_move: moves,
      analytic_domain: analyticId ? JSON.stringify([["analytic_distribution", "in", [analyticId]]]) : "[]",
      period_ids: [
        [0, 0, { name: "Anggaran", sequence: 1, mode: "fix", manual_date_from: from, manual_date_to: to, source: "mis_budget_by_account", source_mis_budget_by_account_id: chosen.id }],
        [0, 0, { name: "Realisasi", sequence: 2, mode: "fix", manual_date_from: from, manual_date_to: to }],
      ],
    }],
  });
  current = { instanceId, view, planId: chosen.id };
  const result = await call("mis.report.instance", "compute", { ids: [instanceId] });
  current.result = result;

  // Jenis baris (pendapatan atau biaya) dan baris rincian per akun, untuk warna selisih dan indentasi.
  let section = "";
  const rows = result.body.map((row, r) => {
    const detail = row.cells.some((c) => c.drilldown_arg?.account_id);
    if (!detail) section = row.label;
    const kind = view === "akun"
      ? COST_SECTIONS.has(section) ? "cost" : INCOME_LABELS.has(section) ? "income" : ""
      : COST_LABELS.has(row.label) ? "cost" : INCOME_LABELS.has(row.label) ? "income" : "";
    const [budget, actual] = row.cells;
    return { r, label: row.label, style: row.style ?? "", detail, kind, budget, actual, cmp: isPct(budget) || isPct(actual) ? null : compare(budget, actual, kind) };
  });
  current.rows = rows;

  const byLabel = Object.fromEntries(rows.filter((x) => !x.detail).map((x) => [x.label, x]));
  const summary = (title, row, costLike) => {
    const c = row?.cmp;
    if (!c) return "";
    return `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${esc(title)}</div>
      <div class="text-xl font-semibold mt-1">${esc(money(c.a))}</div><div class="text-xs text-gray-500 mt-1">anggaran ${esc(money(c.b))}${c.ratio !== null ? ` · ${esc(pct(c.ratio))}` : ""}</div>
      <div class="text-xs mt-1 ${c.tone}">${costLike ? (c.diff > 0 ? "melebihi anggaran" : "di bawah anggaran") : c.diff < 0 ? "di bawah target" : "mencapai target"}${Math.abs(c.diff) >= 0.5 ? ` ${esc(money(Math.abs(c.diff)))}` : ""}</div></div>`;
  };
  const cost = byLabel["Harga Pokok"] && byLabel.Beban ? {
    cmp: compare({ val: (byLabel["Harga Pokok"].budget?.val ?? 0) + (byLabel.Beban.budget?.val ?? 0) }, { val: (byLabel["Harga Pokok"].actual?.val ?? 0) + (byLabel.Beban.actual?.val ?? 0) }, "cost"),
  } : null;
  const cards = view === "akun"
    ? `<div class="grid md:grid-cols-3 gap-4 mb-4">${summary("Pendapatan", byLabel.Pendapatan, false)}${summary("Harga pokok dan beban", cost, true)}${summary("Laba (rugi) bersih", byLabel["LABA (RUGI) BERSIH"], false)}</div>`
    : "";

  const body = rows
    .map((x) => {
      const cellHtml = (cell, col, other) => {
        if (!hasValue(cell)) return `<td class="py-2 px-4 text-sm text-right tabular-nums">${hasValue(other) && !isPct(other) ? "0" : ""}</td>`;
        const text = isPct(cell) ? pct(cell.val) : num(cell.val);
        const inner = !x.cmp && isPct(cell) ? esc(text) : drillable(cell)
          ? `<button type="button" data-action="drill" data-row="${x.r}" data-col="${col}" class="hover:underline hover:text-indigo-700">${esc(text)}</button>` : esc(text);
        return `<td class="py-2 px-4 text-sm text-right tabular-nums">${inner}</td>`;
      };
      const c = x.cmp;
      const diff = c ? `<td class="py-2 px-4 text-sm text-right tabular-nums ${c.tone}">${num(c.diff)}</td><td class="py-2 px-4 text-sm text-right tabular-nums ${c.tone}">${c.ratio === null ? "-" : pct(c.ratio)}</td>` : "<td></td><td></td>";
      const style = x.style ? ` style="${esc(x.style)}"` : "";
      return `<tr${style}><td class="py-2 px-4 text-sm ${x.detail ? "pl-10" : ""}"${style}>${esc(x.label)}</td>${cellHtml(x.budget, 0, x.actual)}${cellHtml(x.actual, 1, x.budget)}${diff}</tr>`;
    })
    .join("");
  const warn = chosen.state === "draft"
    ? '<p class="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">Rencana ini masih draft, jadi angka anggarannya bisa berubah sebelum dikonfirmasi.</p>'
    : chosen.state === "cancelled" ? '<p class="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">Rencana ini dibatalkan.</p>' : "";
  app.innerHTML = `${header}${warn}${cards}
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <table class="w-full text-left" id="budget-report-table"><thead class="bg-gray-50 border-b border-gray-200"><tr>
        <th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-left">Uraian</th>
        <th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">Anggaran</th>
        <th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">Realisasi</th>
        <th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">Selisih</th>
        <th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">% Realisasi</th></tr></thead>
        <tbody class="divide-y divide-gray-100">${body}</tbody></table></div>
    <p class="text-xs text-gray-500 mt-3">Selisih adalah realisasi dikurangi anggaran dan % Realisasi adalah realisasi per anggaran. Merah berarti biaya melebihi anggaran atau pendapatan di bawah anggaran; hijau sebaliknya. Anggaran sebuah baris dibagi menurut jumlah hari yang beririsan dengan periode laporan, jadi baris tahunan menyumbang sebagian pada periode yang lebih pendek. Angka bertanda kurung bernilai negatif. Klik angka untuk melihat baris anggaran atau item jurnal pembentuknya.</p>`;
}

/* ---------- Drilldown ---------- */

async function drill(button, rowIndex, colIndex) {
  const cell = current?.result?.body[rowIndex]?.cells[colIndex];
  if (!cell || !current?.instanceId) return;
  const title = `${current.result.body[rowIndex].label} · ${colIndex === 0 ? "Anggaran" : "Realisasi"}`;
  const shown = await guarded(button, async () => {
    const action = await call("mis.report.instance", "drilldown", { ids: [current.instanceId], arg: cell.drilldown_arg });
    if (!action) return null;
    if (action.res_model === "mis.budget.by.account.item") {
      const items = await searchRead("mis.budget.by.account.item", action.domain, ["account_id", "name", "date_from", "date_to", "debit", "credit", "analytic_distribution"], { order: "account_id, date_from", limit: 300 });
      return { kind: "budget", items };
    }
    const lines = await searchRead("account.move.line", action.domain, ["date", "move_id", "account_id", "name", "partner_id", "debit", "credit"], { order: "date, id", limit: 300, context: { active_test: false } });
    return { kind: "journal", lines };
  });
  if (!shown) return;
  const th = (labels, rightFrom) => `<thead class="bg-gray-50"><tr>${labels.map((h, i) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase ${i >= rightFrom ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>`;
  let table;
  if (shown.kind === "budget") {
    const rows = shown.items
      .map((i) => `<tr><td class="py-2 px-3 text-sm">${esc(i.account_id[1])}</td><td class="py-2 px-3 text-sm whitespace-nowrap">${esc(dateText(i.date_from))} s.d. ${esc(dateText(i.date_to))}</td><td class="py-2 px-3 text-sm">${esc(i.name || "")}</td>
        <td class="py-2 px-3 text-sm text-right tabular-nums">${i.debit ? num(i.debit) : ""}</td><td class="py-2 px-3 text-sm text-right tabular-nums">${i.credit ? num(i.credit) : ""}</td></tr>`)
      .join("");
    table = `<table class="w-full text-left">${th(["Akun", "Periode baris", "Label", "Debit", "Kredit"], 3)}<tbody class="divide-y divide-gray-100">${rows || '<tr><td colspan="5" class="py-6 text-center text-sm text-gray-500">Tidak ada baris anggaran.</td></tr>'}</tbody></table>
      <p class="text-xs text-gray-500 mt-2">Angka pada laporan adalah bagian baris yang beririsan dengan periode laporan (dibagi per hari).</p>`;
  } else {
    const rows = shown.lines
      .map((l) => `<tr><td class="py-2 px-3 text-sm whitespace-nowrap">${esc(dateText(l.date))}</td><td class="py-2 px-3 text-sm"><a href="#/journal/${l.move_id[0]}" data-action="modal-close" class="text-indigo-700 hover:underline">${esc(l.move_id[1])}</a></td>
        <td class="py-2 px-3 text-sm">${esc(l.account_id[1])}</td><td class="py-2 px-3 text-sm">${esc(l.name || "")}</td><td class="py-2 px-3 text-sm">${esc(l.partner_id?.[1] ?? "")}</td>
        <td class="py-2 px-3 text-sm text-right tabular-nums">${l.debit ? num(l.debit) : ""}</td><td class="py-2 px-3 text-sm text-right tabular-nums">${l.credit ? num(l.credit) : ""}</td></tr>`)
      .join("");
    table = `<table class="w-full text-left">${th(["Tanggal", "Jurnal", "Akun", "Label", "Mitra", "Debit", "Kredit"], 5)}<tbody class="divide-y divide-gray-100">${rows || '<tr><td colspan="7" class="py-6 text-center text-sm text-gray-500">Tidak ada item jurnal.</td></tr>'}</tbody></table>`;
  }
  openModal(
    title,
    `<div class="overflow-x-auto max-h-[60vh] overflow-y-auto">${table}</div>`,
    '<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Tutup</button>',
    null,
    { wide: true },
  );
}

/* ---------- Ekspor dan acara ---------- */

function downloadCsv() {
  const rows = current?.rows;
  if (!rows) return;
  const lines = [
    ["Uraian", "Anggaran", "Realisasi", "Selisih (realisasi - anggaran)", "Realisasi per anggaran (%)"],
    ...rows.map((x) => [x.label, hasValue(x.budget) ? x.budget.val : "", hasValue(x.actual) ? x.actual.val : "", x.cmp ? x.cmp.diff : "", x.cmp && x.cmp.ratio !== null ? Math.round(x.cmp.ratio * 10000) / 100 : ""]),
  ];
  const text = lines.map((cells) => cells.map((v) => (typeof v === "number" ? String(v) : `"${String(v).replaceAll('"', '""')}"`)).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
  link.download = `anggaran-vs-realisasi-${current.view}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("CSV diunduh.");
}

function applyPeriod(overrides = {}) {
  const params = new URLSearchParams();
  for (const el of document.querySelectorAll("[data-bp]")) if (el.value) params.set(el.dataset.bp, el.value);
  // Mengganti rencana mengembalikan periode ke periode rencana itu.
  if (overrides.resetDates) {
    params.delete("from");
    params.delete("to");
  }
  for (const [k, v] of Object.entries(overrides)) if (k !== "resetDates") params.set(k, v);
  const target = `#/budgetreport${params.toString() ? `?${params}` : ""}`;
  if (location.hash === target) reload();
  else location.hash = target;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "drill") await drill(el, Number(el.dataset.row), Number(el.dataset.col));
  else if (action === "csv") downloadCsv();
  else if (action === "range-all") applyPeriod({ resetDates: true });
  else if (action === "range-today") {
    const plan = await readOne("mis.budget.by.account", Number(document.querySelector('[data-bp="plan"]').value), ["date_from", "date_to"]);
    const now = today();
    const end = now > plan.date_to ? plan.date_to : now < plan.date_from ? plan.date_from : now;
    applyPeriod({ from: plan.date_from, to: end });
  } else if (action === "modal-close") closeModal();
}

export function onChange(event, el) {
  if (el.dataset.bp && el.tagName === "SELECT") applyPeriod(el.dataset.bp === "plan" ? { resetDates: true } : {});
}

export function onSubmit(event, form, kind) {
  if (kind === "period") applyPeriod();
}
