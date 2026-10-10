// Laporan keuangan (MIS Builder): Laba Rugi, Neraca, Arus Kas, Neraca Saldo, dan Ringkasan Eksekutif.
// Template ada di Odoo (nusara_base, models/mis_templates.py). Halaman ini membuat instance sementara,
// menjalankan compute(), menampilkan hasilnya, lalu menghapus instance. Angka bisa diklik untuk melihat
// item jurnal pembentuknya (drilldown MIS).
import {
  INPUT, app, call, closeModal, ctx, dateText, esc, guarded, openModal, pageHeader, readOne, searchRead, toast,
} from "../common.js";

const REPORTS = {
  "laba-rugi": { name: "mis_laba_rugi", title: "Laba Rugi", mode: "range", about: "Pendapatan, harga pokok, beban, dan laba bersih per periode." },
  neraca: { name: "mis_neraca", title: "Neraca", mode: "asof", about: "Aset, liabilitas, dan ekuitas pada satu tanggal." },
  "arus-kas": { name: "mis_arus_kas", title: "Arus Kas", mode: "range", about: "Arus kas metode tidak langsung, diuji terhadap saldo kas dan bank." },
  "neraca-saldo": { name: "mis_neraca_saldo", title: "Neraca Saldo", mode: "range", compare: false, about: "Saldo awal, debit, kredit, dan saldo akhir per akun." },
  ringkasan: { name: "mis_ringkasan", title: "Ringkasan Eksekutif", mode: "range", about: "Kinerja dan posisi keuangan dalam satu halaman." },
};

let current = null; // { instanceId, result }
let last = { sub: "", query: new URLSearchParams() };
let fiscal = null;

export const leave = () => {
  dropInstance();
};
const reload = () => render(last.sub, last.query);

/* ---------- Tanggal ---------- */

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (text) => {
  const [y, m, d] = text.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const shiftYear = (d, years) => {
  const copy = new Date(d.getFullYear() + years, d.getMonth(), d.getDate());
  if (copy.getMonth() !== d.getMonth()) copy.setDate(0); // 29 Feb pada tahun non-kabisat
  return copy;
};
const addDays = (d, days) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

/** Awal tahun fiskal yang memuat tanggal d, menurut pengaturan perusahaan (bawaan 1 Januari). */
function fiscalStart(d) {
  const month = Number(fiscal?.month ?? 12);
  const day = Number(fiscal?.day ?? 31);
  const end = new Date(d.getFullYear(), month - 1, day);
  const fyEnd = end >= d ? end : new Date(d.getFullYear() + 1, month - 1, day);
  return addDays(shiftYear(fyEnd, -1), 1);
}

/* ---------- Angka ---------- */

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 0 });
const num = (v) => (Math.round(v) === 0 ? "0" : v < 0 ? `(${nf.format(Math.abs(v))})` : nf.format(v));
const isPct = (cell) => /%\s*$/.test(cell.val_r ?? "");
const show = (cell) => {
  if (cell.val === null || cell.val === undefined) return "";
  if (isPct(cell)) return `${(cell.val * 100).toFixed(1).replace(".", ",")} %`;
  return num(cell.val);
};
const csvNumber = (cell) => (cell.val === null || cell.val === undefined ? "" : isPct(cell) ? (cell.val * 100).toFixed(2) : String(cell.val));

/** Sel hasil rumus akun (balp[...], bale[...]) bisa diurai ke item jurnal; sel turunan (nama KPI) tidak. */
const drillable = (cell) => {
  const expr = cell.drilldown_arg?.expr ?? "";
  if (!cell.val || !/\b(bal[pei]|deb[pei]|crd[pei])\[/.test(expr)) return false;
  return !/[a-z_]{2,}/i.test(expr.replace(/\w+\[[^\]]*\]/g, ""));
};

/* ---------- Render ---------- */

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

export async function render(sub, query) {
  last = { sub, query };
  await dropInstance();
  const def = REPORTS[sub];
  if (!def) return renderIndex();
  return renderReport(sub, def, query);
}

function renderIndex() {
  app.innerHTML =
    pageHeader("Laporan Keuangan") +
    `<div class="grid md:grid-cols-2 xl:grid-cols-3 gap-4">${Object.entries(REPORTS)
      .map(
        ([key, def]) => `<a href="#/report/${key}" class="block bg-white rounded-xl shadow-sm border border-gray-200 p-5 hover:border-indigo-300">
          <div class="font-semibold text-gray-900">${esc(def.title)}</div><p class="text-sm text-gray-600 mt-1">${esc(def.about)}</p></a>`,
      )
      .join("")}</div>`;
}

async function periods(def, query) {
  fiscal ??= await readOne("res.company", ctx.company.id, ["fiscalyear_last_day", "fiscalyear_last_month"]).then((c) => ({
    day: c?.fiscalyear_last_day ?? 31, month: c?.fiscalyear_last_month ?? 12,
  }));
  const today = new Date();
  const to = query.get("to") ? parse(query.get("to")) : today;
  const from = def.mode === "asof" ? fiscalStart(to) : query.get("from") ? parse(query.get("from")) : fiscalStart(to);
  const compare = def.compare === false ? "none" : query.get("cmp") || "none";
  const list = [{ label: def.mode === "asof" ? `Per ${dateText(iso(to))}` : `${dateText(iso(from))} s.d. ${dateText(iso(to))}`, from: iso(from), to: iso(to) }];
  if (compare === "year") {
    const toPrev = shiftYear(to, -1);
    const fromPrev = def.mode === "asof" ? fiscalStart(toPrev) : shiftYear(from, -1);
    list.push({ label: def.mode === "asof" ? `Per ${dateText(iso(toPrev))}` : `${dateText(iso(fromPrev))} s.d. ${dateText(iso(toPrev))}`, from: iso(fromPrev), to: iso(toPrev) });
  } else if (compare === "prev" && def.mode === "range") {
    const length = Math.round((to - from) / 86400000);
    const toPrev = addDays(from, -1);
    const fromPrev = addDays(toPrev, -length);
    list.push({ label: `${dateText(iso(fromPrev))} s.d. ${dateText(iso(toPrev))}`, from: iso(fromPrev), to: iso(toPrev) });
  }
  return { list, from: iso(from), to: iso(to), compare };
}

async function renderReport(sub, def, query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Menghitung laporan...</p>';
  const p = await periods(def, query);
  const moves = query.get("moves") === "all" ? "all" : "posted";
  const [template] = await searchRead("ir.model.data", [["module", "=", "nusara_base"], ["name", "=", def.name]], ["res_id"], { limit: 1 });
  if (!template) {
    app.innerHTML = '<p class="text-sm text-rose-600">Template laporan belum dimuat. Perbarui modul nusara_base di Odoo.</p>';
    return;
  }
  const [instanceId] = await call("mis.report.instance", "create", {
    vals_list: [{
      name: `${def.title} (UI)`, report_id: template.res_id, temporary: true, target_move: moves,
      period_ids: p.list.map((period, i) => [0, 0, { name: period.label, sequence: i + 1, mode: "fix", manual_date_from: period.from, manual_date_to: period.to }]),
    }],
  });
  current = { instanceId };
  const result = await call("mis.report.instance", "compute", { ids: [instanceId] });
  current.result = result;

  const cols = result.header[0].cols;
  const sub2 = result.header[1].cols;
  const hasSub = sub2.some((c) => c.label);
  const comparing = cols.length === 2 && cols.every((c) => c.colspan === 1) && !hasSub;
  const head1 = `<th rowspan="${hasSub ? 2 : 1}" class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-left">Uraian</th>${cols
    .map((c) => `<th colspan="${c.colspan}" class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">${esc(c.label)}</th>`)
    .join("")}${comparing ? '<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">Selisih</th><th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right">%</th>' : ""}`;
  const head2 = hasSub ? `<tr>${sub2.map((c) => `<th class="py-1 px-4 text-xs font-semibold text-gray-500 text-right">${esc(c.label)}</th>`).join("")}</tr>` : "";
  const rows = result.body
    .map((row, r) => {
      const cells = row.cells
        .map((cell, c) => {
          const text = show(cell);
          if (text === "") return '<td class="py-2 px-4 text-sm text-right"></td>';
          const inner = drillable(cell)
            ? `<button type="button" data-action="drill" data-row="${r}" data-col="${c}" class="hover:underline hover:text-indigo-700">${esc(text)}</button>`
            : esc(text);
          return `<td class="py-2 px-4 text-sm text-right tabular-nums">${inner}</td>`;
        })
        .join("");
      let variance = "";
      if (comparing) {
        const [a, b] = row.cells;
        const ok = a?.val !== null && a?.val !== undefined && b?.val !== null && b?.val !== undefined && !isPct(a);
        variance = ok
          ? `<td class="py-2 px-4 text-sm text-right tabular-nums">${num(a.val - b.val)}</td><td class="py-2 px-4 text-sm text-right tabular-nums text-gray-500">${b.val ? `${(((a.val - b.val) / Math.abs(b.val)) * 100).toFixed(1).replace(".", ",")} %` : ""}</td>`
          : '<td></td><td></td>';
      }
      return `<tr style="${esc(row.style ?? "")}"><td class="py-2 px-4 text-sm" style="${esc(row.style ?? "")}">${esc(row.label)}</td>${cells}${variance}</tr>`;
    })
    .join("");

  const controls = `<form data-form="period" class="flex flex-wrap items-end gap-3">
      ${def.mode === "range" ? `<label class="text-xs font-medium text-gray-500 uppercase">Dari<input type="date" data-period="from" value="${p.from}" class="${INPUT} mt-1 w-44"></label>` : ""}
      <label class="text-xs font-medium text-gray-500 uppercase">${def.mode === "asof" ? "Per tanggal" : "Sampai"}<input type="date" data-period="to" value="${p.to}" class="${INPUT} mt-1 w-44"></label>
      ${def.compare === false ? "" : `<label class="text-xs font-medium text-gray-500 uppercase">Bandingkan<select data-period="cmp" class="${INPUT} mt-1 w-52">
        <option value="none" ${p.compare === "none" ? "selected" : ""}>Tanpa pembanding</option>
        <option value="year" ${p.compare === "year" ? "selected" : ""}>Tahun lalu</option>
        ${def.mode === "range" ? `<option value="prev" ${p.compare === "prev" ? "selected" : ""}>Periode sebelumnya</option>` : ""}</select></label>`}
      <label class="text-xs font-medium text-gray-500 uppercase">Entri<select data-period="moves" class="${INPUT} mt-1 w-48">
        <option value="posted" ${moves === "posted" ? "selected" : ""}>Hanya terposting</option><option value="all" ${moves === "all" ? "selected" : ""}>Termasuk draft</option></select></label>
      <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Tampilkan</button>
      <button type="button" data-action="csv" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Unduh CSV</button>
      <button type="button" data-action="print" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cetak</button>
    </form>`;

  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/report" class="hover:text-indigo-600">Laporan Keuangan</a> / ${esc(def.title)}</div>
    <h1 class="text-2xl font-bold text-gray-900">${esc(def.title)}</h1>
    <p class="text-sm text-gray-500 mb-4">${esc(ctx.company.name ?? "")}${moves === "all" ? " · termasuk entri draft" : ""}</p>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mb-4">${controls}</section>
    <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <table class="w-full text-left" id="report-table"><thead class="bg-gray-50 border-b border-gray-200"><tr>${head1}</tr>${head2}</thead>
        <tbody class="divide-y divide-gray-100">${rows}</tbody></table>
    </div>
    <p class="text-xs text-gray-500 mt-3">Angka bertanda kurung bernilai negatif. Klik angka untuk melihat item jurnalnya. Baris bertanda "harus 0" menyala bila ada akun di luar pemetaan template.</p>`;
}

/* ---------- Drilldown ---------- */

async function drill(button, rowIndex, colIndex) {
  const cell = current?.result?.body[rowIndex]?.cells[colIndex];
  if (!cell || !current?.instanceId) return;
  const title = `${current.result.body[rowIndex].label}`;
  const lines = await guarded(button, async () => {
    const action = await call("mis.report.instance", "drilldown", { ids: [current.instanceId], arg: cell.drilldown_arg });
    return searchRead(
      "account.move.line", action.domain,
      ["date", "move_id", "account_id", "name", "partner_id", "debit", "credit"],
      { order: "date, id", limit: 300, context: { active_test: false } },
    );
  });
  if (!lines) return;
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  const rows = lines
    .map(
      (l) => `<tr><td class="py-2 px-3 text-sm whitespace-nowrap">${esc(dateText(l.date))}</td>
        <td class="py-2 px-3 text-sm"><a href="#/journal/${l.move_id[0]}" data-action="modal-close" class="text-indigo-700 hover:underline">${esc(l.move_id[1])}</a></td>
        <td class="py-2 px-3 text-sm">${esc(l.account_id[1])}</td><td class="py-2 px-3 text-sm">${esc(l.name || "")}</td><td class="py-2 px-3 text-sm">${esc(l.partner_id?.[1] ?? "")}</td>
        <td class="py-2 px-3 text-sm text-right tabular-nums">${l.debit ? num(l.debit) : ""}</td><td class="py-2 px-3 text-sm text-right tabular-nums">${l.credit ? num(l.credit) : ""}</td></tr>`,
    )
    .join("");
  openModal(
    title,
    `<div class="overflow-x-auto max-h-[60vh] overflow-y-auto"><table class="w-full text-left"><thead class="bg-gray-50"><tr>${["Tanggal", "Jurnal", "Akun", "Label", "Mitra", "Debit", "Kredit"]
      .map((h, i) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase ${i > 4 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${rows || '<tr><td colspan="7" class="py-6 text-center text-sm text-gray-500">Tidak ada item jurnal.</td></tr>'}</tbody>
      <tfoot class="bg-gray-50 font-semibold"><tr><td colspan="5" class="py-2 px-3 text-sm">Total${lines.length >= 300 ? " (300 baris pertama)" : ""}</td><td class="py-2 px-3 text-sm text-right">${num(debit)}</td><td class="py-2 px-3 text-sm text-right">${num(credit)}</td></tr></tfoot></table></div>`,
    '<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Tutup</button>',
    null,
    { wide: true },
  );
}

/* ---------- Ekspor ---------- */

function downloadCsv() {
  const result = current?.result;
  if (!result) return;
  const header = ["Uraian", ...result.header[0].cols.flatMap((c, i) => {
    const subs = result.header[1].cols.filter((s) => s.label);
    return c.colspan > 1 && subs.length ? subs.map((s) => `${c.label} - ${s.label}`) : [c.label || `Kolom ${i + 1}`];
  })];
  const lines = [header, ...result.body.map((row) => [row.label, ...row.cells.map(csvNumber)])];
  const text = lines.map((cells) => cells.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
  link.download = `${REPORTS[last.sub]?.name ?? "laporan"}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("CSV diunduh.");
}

/* ---------- Acara ---------- */

function applyPeriod() {
  const params = new URLSearchParams();
  for (const el of document.querySelectorAll("[data-period]")) if (el.value) params.set(el.dataset.period, el.value);
  const qs = params.toString();
  const target = `#/report/${last.sub}${qs ? `?${qs}` : ""}`;
  if (location.hash === target) reload();
  else location.hash = target;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "drill") await drill(el, Number(el.dataset.row), Number(el.dataset.col));
  else if (action === "csv") downloadCsv();
  else if (action === "print") window.print();
  else if (action === "modal-close") closeModal();
}

export function onSubmit(event, form, kind) {
  if (kind === "period") applyPeriod();
}
