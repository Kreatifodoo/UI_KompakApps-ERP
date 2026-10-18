// Bank Transaction (account.bank.statement dan account.bank.statement.line) dengan rekonsiliasi bank dari
// OCA account_reconcile_oca. Mutasi bank dimasukkan manual atau dari CSV; setiap mutasi dicocokkan dengan
// pembayaran tertunda, faktur, atau tagihan yang masih terbuka, atau sisanya dicatat ke sebuah akun (mis. biaya
// bank). Setelah dicocokkan, saldo berpindah dari akun Pembayaran Tertunda ke akun Bank.
import {
  ACCOUNT_TYPE_LABELS, INPUT, app, badge, call, cell, closeLookup, dateText, esc, fieldBlock, filterSelect, guarded, journalHtml, loadJournalItems,
  money, pageHeader, readOne, registerLookup, rowLink, runLookup, searchAccounts, searchBox, searchRead, selectOptions, statTiles, table, toast,
} from "../common.js";

const STATUS = {
  todo: ["Belum direkonsiliasi", "warning"],
  done: ["Sudah direkonsiliasi", "success"],
};
const FILTERS = [["", "Semua"], ["todo", "Belum direkonsiliasi"], ["done", "Sudah direkonsiliasi"]];
const KIND_LABEL = { liquidity: "Mutasi bank", other: "Pasangan", suspense: "Sisa belum dialokasikan" };
const TABS = [
  ["all", "Semua"], ["payment", "Pembayaran tertunda"], ["out_invoice", "Faktur pelanggan"], ["in_invoice", "Tagihan vendor"], ["refund", "Nota kredit/debit"],
  ["entry", "Jurnal entry"],
];
const DOC_LABEL = { payment: "Pembayaran", out_invoice: "Faktur", in_invoice: "Tagihan", out_refund: "Nota Kredit", in_refund: "Nota Debit", entry: "Jurnal" };
const WRITE_OFF_TYPES = { expense: ["expense", "expense_other", "expense_direct_cost"], income: ["income", "income_other"] };
const EMPTY_FILTERS = () => ({ partner: "", min: "", max: "", from: "", to: "" });
const ONCHANGE_SPEC = { reconcile_data_info: {}, can_reconcile: {}, add_account_move_line_id: {} };

let form = null; // transaksi baru: { journal, name, lines: [{ date, label, partner, amount }] }
let rec = null; // rekonsiliasi: { id, line, info, search, onlyPartner, candidates, account, accountText, label }
let journals = null;
let last = { sub: "", query: new URLSearchParams() };

export const leave = () => {
  form = null;
  rec = null;
};
const reload = () => render(last.sub, last.query);

const todayText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

registerLookup("bank-account", {
  search: (q) => searchAccounts(q, rec?.accountTypes ?? null),
  sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
  isChosen: (input) => rec?.account?.display_name === input.value,
  choose: (input, item) => {
    rec.account = item;
    input.value = item.display_name;
  },
});

async function bankJournals() {
  journals ??= await searchRead("account.journal", [["type", "in", ["bank", "cash"]]], ["display_name", "type"], { order: "sequence, code" });
  return journals;
}

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  if (sub === "new") return renderNew();
  return renderLine(Number(sub));
}

/* ---------- Daftar mutasi ---------- */

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const journal = Number(query.get("journal")) || null;
  const statement = Number(query.get("statement")) || null;
  const domain = [];
  if (filter === "todo") domain.push(["is_reconciled", "=", false]);
  else if (filter === "done") domain.push(["is_reconciled", "=", true]);
  if (journal) domain.push(["journal_id", "=", journal]);
  if (statement) domain.push(["statement_id", "=", statement]);
  if (text) domain.push("|", "|", ["payment_ref", "ilike", text], ["partner_name", "ilike", text], ["partner_id.name", "ilike", text]);
  const [rows, js] = await Promise.all([
    searchRead("account.bank.statement.line", domain, ["date", "journal_id", "payment_ref", "partner_id", "partner_name", "amount", "currency_id", "is_reconciled"], {
      order: "date desc, id desc", limit: 100,
    }),
    bankJournals(),
  ]);
  const body = rows
    .map((r) =>
      rowLink(`#/bank/${r.id}`, [
        cell(dateText(r.date)),
        cell(r.journal_id?.[1] ?? ""),
        cell(r.payment_ref || "-", { strong: true }),
        cell(r.partner_id?.[1] || r.partner_name || ""),
        `<td class="py-3 px-4 text-sm text-right tabular-nums ${r.amount < 0 ? "text-rose-700" : "text-emerald-700"}">${esc(money(r.amount, r.currency_id?.[1]))}</td>`,
        cell(badge(STATUS, r.is_reconciled ? "done" : "todo"), { raw: true }),
      ]),
    )
    .join("");
  const journalSelect = `<select data-change="journal-filter" class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"><option value="">Semua jurnal</option>${js
    .map((j) => `<option value="${j.id}" ${j.id === journal ? "selected" : ""}>${esc(j.display_name)}</option>`)
    .join("")}</select>`;
  app.innerHTML =
    pageHeader(
      "Bank Transaction",
      `${searchBox(text, "Cari referensi atau mitra")}${journalSelect}${filterSelect(FILTERS, filter)}
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
       <a href="#/bank/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Mutasi Baru</a>`,
    ) +
    table(
      [{ label: "Tanggal" }, { label: "Jurnal" }, { label: "Referensi" }, { label: "Mitra" }, { label: "Jumlah", right: true }, { label: "Status" }],
      body,
      "Belum ada mutasi bank. Tambahkan dengan Mutasi Baru atau impor CSV, lalu cocokkan dengan pembayaran.",
    );
}

/* ---------- Mutasi baru (manual atau CSV) ---------- */

const emptyRow = () => ({ date: todayText(), label: "", partner: "", amount: "" });

async function renderNew() {
  const js = await bankJournals();
  if (!js.length) {
    app.innerHTML = '<p class="text-sm text-rose-600">Belum ada jurnal bank atau kas.</p>';
    return;
  }
  form ??= { journal: js[0].id, name: "", lines: [emptyRow()] };
  const rows = form.lines
    .map(
      (l, i) => `<tr class="align-top">
        <td class="py-2 pr-2 w-40"><input type="date" data-bank-line="${i}" data-field="date" value="${esc(l.date)}" class="${INPUT}"></td>
        <td class="py-2 px-2 min-w-56"><input data-bank-line="${i}" data-field="label" value="${esc(l.label)}" placeholder="Keterangan di rekening koran" class="${INPUT}"></td>
        <td class="py-2 px-2 min-w-48"><input data-bank-line="${i}" data-field="partner" value="${esc(l.partner)}" placeholder="Nama mitra (opsional)" class="${INPUT}"></td>
        <td class="py-2 px-2 w-44"><input type="number" step="any" data-bank-line="${i}" data-field="amount" value="${esc(l.amount)}" placeholder="+ masuk / - keluar" class="${INPUT} text-right"></td>
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="remove-bank-line" data-line="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris"><i class="fas fa-trash-alt"></i></button></td></tr>`,
    )
    .join("");
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/bank" class="hover:text-indigo-600">Bank Transaction</a> / Mutasi Baru</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">Mutasi Baru</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Jurnal", `<select data-bank="journal" class="${INPUT}">${selectOptions(js, form.journal)}</select>`)}
      ${fieldBlock("Referensi Mutasi", `<input data-bank="name" value="${esc(form.name)}" placeholder="mis. Rekening koran Oktober 2026" class="${INPUT}">`)}
    </section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3"><div class="text-sm font-semibold">Baris mutasi</div>
        <label class="text-sm text-indigo-600 font-medium cursor-pointer hover:text-indigo-800"><i class="fas fa-file-csv mr-1"></i>Impor CSV<input type="file" accept=".csv,text/csv" data-bank-csv class="hidden"></label></div>
      <table class="w-full text-left"><thead><tr>${["Tanggal", "Keterangan", "Mitra", "Jumlah", ""]
        .map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${i === 3 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
      <p class="text-xs text-gray-500 mt-2">Jumlah positif = uang masuk, negatif = uang keluar. CSV: kolom tanggal, keterangan, jumlah (atau masuk dan keluar), dan opsional mitra; pemisah koma atau titik koma.</p>
      <button type="button" data-action="add-bank-line" class="mt-1 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>
    </section>
    <div class="flex gap-2 mt-4">
      <button data-action="save-statement" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan Mutasi</button>
      <a href="#/bank" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
    </div>`;
}

/* Pembacaan CSV rekening koran: pemisah dideteksi, tanggal ISO atau dd/mm/yyyy, angka gaya Indonesia atau Inggris. */
function splitCsvLine(line, delimiter) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
    } else current += ch;
  }
  cells.push(current.trim());
  return cells;
}
function parseAmount(text) {
  let value = String(text ?? "").replace(/[^\d,.\-()]/g, "");
  if (!value) return null;
  const negative = /^\(.*\)$/.test(value) || value.startsWith("-");
  value = value.replace(/[()-]/g, "");
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) value = comma > dot ? value.replaceAll(".", "").replace(",", ".") : value.replaceAll(",", "");
  else if (comma >= 0) value = /,\d{1,2}$/.test(value) ? value.replace(",", ".") : value.replaceAll(",", "");
  else if ((value.match(/\./g) ?? []).length > 1 || /\.\d{3}$/.test(value)) value = value.replaceAll(".", "");
  const number = Number(value);
  return Number.isFinite(number) ? (negative ? -number : number) : null;
}
function parseDate(text) {
  const t = String(text ?? "").trim();
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}
export function parseStatementCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) throw new Error("CSV kosong atau tanpa baris data.");
  const delimiter = (lines[0].match(/;/g) ?? []).length > (lines[0].match(/,/g) ?? []).length ? ";" : ",";
  const header = splitCsvLine(lines[0], delimiter).map((h) => h.toLowerCase());
  const find = (...names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const col = {
    date: find("tanggal", "date", "tgl"), label: find("keterangan", "deskripsi", "description", "uraian", "label", "ref"),
    amount: find("jumlah", "amount", "nominal"), in: find("masuk", "kredit", "credit"), out: find("keluar", "debit"), partner: find("mitra", "partner", "nama"),
  };
  if (col.date < 0 || (col.amount < 0 && col.in < 0 && col.out < 0)) {
    throw new Error("Kolom wajib tidak ditemukan: butuh tanggal dan jumlah (atau masuk dan keluar) pada baris judul.");
  }
  const rows = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = splitCsvLine(line, delimiter);
    const date = parseDate(cells[col.date]);
    let amount = col.amount >= 0 ? parseAmount(cells[col.amount]) : null;
    if (amount === null) amount = (parseAmount(cells[col.in]) ?? 0) - Math.abs(parseAmount(cells[col.out]) ?? 0);
    if (!date || amount === null || amount === 0) throw new Error(`Baris ${index + 2} tidak terbaca (tanggal atau jumlah tidak valid).`);
    rows.push({ date, label: col.label >= 0 ? cells[col.label] : "", partner: col.partner >= 0 ? cells[col.partner] : "", amount });
  }
  return rows;
}

async function saveStatement() {
  const rows = form.lines.filter((l) => String(l.amount).trim() !== "" || l.label.trim());
  if (!rows.length) throw new Error("Isi minimal satu baris mutasi.");
  const lines = rows.map((l, i) => {
    const amount = Number(l.amount);
    if (!l.date) throw new Error(`Baris ${i + 1}: isi tanggal.`);
    if (!(amount !== 0) || !Number.isFinite(amount)) throw new Error(`Baris ${i + 1}: jumlah tidak boleh kosong atau nol.`);
    return [0, 0, { journal_id: form.journal, date: l.date, payment_ref: l.label.trim() || "Mutasi bank", amount, ...(l.partner.trim() ? { partner_name: l.partner.trim() } : {}) }];
  });
  const name = form.name.trim() || `Mutasi ${rows[0].date}`;
  const [id] = await call("account.bank.statement", "create", { vals_list: [{ name, journal_id: form.journal, line_ids: lines }] });
  return id;
}

/* ---------- Rekonsiliasi satu mutasi ---------- */

const hasBank = (info) => (info?.data ?? []).some((d) => d.kind === "liquidity");

async function onchange(values, fieldNames) {
  const line = rec.line;
  const result = await call("account.bank.statement.line", "onchange", {
    ids: [rec.id],
    values: {
      journal_id: line.journal_id[0], partner_id: line.partner_id?.[0] ?? false, amount: line.amount, manual_reference: false, ...values,
    },
    field_names: fieldNames,
    fields_spec: ONCHANGE_SPEC,
  });
  return result.value.reconcile_data_info ?? rec.info;
}

const norm = (text) => String(text ?? "").toLowerCase();

async function loadCandidates() {
  const { line, info } = rec;
  const taken = info?.counterparts ?? [];
  const f = rec.filters;
  const domain = [["parent_state", "=", "posted"], ["reconciled", "=", false], ["account_id.reconcile", "=", true], ["move_id", "!=", line.move_id[0]]];
  if (!rec.opposite) domain.push(["amount_residual", line.amount > 0 ? ">" : "<", 0]);
  else domain.push(["amount_residual", "!=", 0]);
  if (taken.length) domain.push(["id", "not in", taken]);
  if (rec.onlyPartner && line.partner_id) domain.push(["partner_id", "=", line.partner_id[0]]);
  if (rec.search) domain.push("|", "|", ["move_id.name", "ilike", rec.search], ["name", "ilike", rec.search], ["partner_id.name", "ilike", rec.search]);
  if (f.partner) domain.push(["partner_id.name", "ilike", f.partner]);
  if (f.from) domain.push(["date", ">=", f.from]);
  if (f.to) domain.push(["date", "<=", f.to]);
  if (rec.tab === "payment") domain.push(["payment_id", "!=", false]);
  else if (rec.tab === "refund") domain.push(["move_type", "in", ["out_refund", "in_refund"]]);
  else if (rec.tab === "entry") domain.push(["move_type", "=", "entry"], ["payment_id", "=", false]);
  else if (rec.tab !== "all") domain.push(["move_type", "=", rec.tab]);
  const rows = await searchRead(
    "account.move.line", domain,
    ["date", "date_maturity", "move_id", "account_id", "partner_id", "name", "ref", "amount_residual", "move_type", "payment_id"],
    { order: "date desc, id desc", limit: 200 },
  );
  const target = Math.abs(line.amount);
  const min = f.min === "" ? null : Number(f.min);
  const max = f.max === "" ? null : Number(f.max);
  const text = norm(line.payment_ref);
  rec.candidates = rows
    .filter((r) => (min === null || Math.abs(r.amount_residual) >= min) && (max === null || Math.abs(r.amount_residual) <= max))
    .map((r) => {
      const exact = Math.abs(Math.abs(r.amount_residual) - target) < 0.005;
      const partnerMatch = Boolean(line.partner_id && r.partner_id && r.partner_id[0] === line.partner_id[0]);
      const names = [r.move_id[1], r.ref].filter((n) => n && String(n).length >= 4).map(norm);
      const refMatch = names.some((n) => text.includes(n));
      const sameSign = r.amount_residual > 0 === line.amount > 0;
      const score = (exact ? 4 : 0) + (partnerMatch ? 2 : 0) + (refMatch ? 3 : 0);
      return { ...r, exact, partnerMatch, refMatch, sameSign, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 60);
  rec.selected = new Set([...rec.selected].filter((id) => rec.candidates.some((c) => c.id === id)));
}

function proposalTable() {
  const rows = rec.info.data
    .map((d) => {
      const removable = d.kind === "other";
      const manual = removable && !(d.counterpart_line_ids?.length);
      const doc = removable && d.counterpart_line_ids?.length && d.id;
      const amount = d.amount;
      const full = Math.abs(d.original_amount_unsigned ?? 0);
      const amountCell = doc
        ? `<input type="number" step="any" min="0" data-pair-amount="${esc(d.reference)}" value="${Math.abs(amount)}" aria-label="Jumlah dialokasikan" class="${INPUT} w-36 text-right inline-block">
           ${full && Math.abs(amount) < full - 0.005 ? `<button type="button" data-action="pair-full" data-ref="${esc(d.reference)}" class="ml-1 text-xs text-indigo-600 hover:text-indigo-800" title="Alokasikan seluruh sisa dokumen (${esc(money(full))}); selisih jadi sisa mutasi">Penuh</button>` : ""}`
        : esc(money(amount));
      return `<tr>
        <td class="py-2 px-4 text-sm"><span class="text-xs font-medium ${d.kind === "suspense" ? "text-amber-700" : "text-gray-500"}">${esc(KIND_LABEL[d.kind] ?? d.kind)}</span></td>
        <td class="py-2 px-4 text-sm">${esc(d.account_id?.[1] ?? "")}</td>
        <td class="py-2 px-4 text-sm">${esc(d.name || "")}${d.move ? ` <span class="text-gray-400">(${esc(d.move)})</span>` : ""}</td>
        <td class="py-2 px-4 text-sm">${esc(d.partner_id?.[1] || "")}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums whitespace-nowrap">${amountCell}</td>
        <td class="py-2 px-4 text-sm text-right">${removable ? `<button type="button" data-action="remove-pair" data-ref="${esc(d.reference)}" data-line-id="${d.counterpart_line_ids?.[0] ?? ""}" data-manual="${manual ? 1 : 0}" class="text-gray-400 hover:text-rose-600" aria-label="Lepas"><i class="fas fa-times"></i></button>` : ""}</td></tr>`;
    })
    .join("");
  return `<div class="overflow-x-auto"><table class="w-full text-left"><thead class="bg-gray-50"><tr>${["", "Akun", "Label", "Mitra", "Jumlah", ""]
    .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i === 4 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody class="divide-y divide-gray-100">${rows}</tbody></table></div>`;
}

function pickedTotal() {
  return rec.candidates.filter((c) => rec.selected.has(c.id)).reduce((sum, c) => sum + Math.abs(c.amount_residual), 0);
}

function candidatesTable() {
  if (!rec.candidates.length) return '<p class="py-6 text-center text-sm text-gray-500">Tidak ada item terbuka yang cocok. Ganti jenis dokumen, longgarkan filter, atau catat ke sebuah akun.</p>';
  const rows = rec.candidates
    .map((r) => {
      const tags = [
        r.exact ? '<span class="ml-1 text-xs font-medium text-emerald-700">jumlah cocok</span>' : "",
        r.refMatch ? '<span class="ml-1 text-xs font-medium text-emerald-700">nomor cocok</span>' : "",
        r.partnerMatch && !r.exact ? '<span class="ml-1 text-xs font-medium text-indigo-700">mitra sama</span>' : "",
        r.sameSign ? "" : '<span class="ml-1 text-xs font-medium text-amber-700">arah berlawanan</span>',
      ].join("");
      return `<tr class="${r.score >= 4 ? "bg-emerald-50" : ""}">
        <td class="py-2 pl-4 pr-1"><input type="checkbox" data-pick="${r.id}" ${rec.selected.has(r.id) ? "checked" : ""} aria-label="Pilih ${esc(r.move_id[1])}" class="rounded border-gray-300 text-indigo-600"></td>
        <td class="py-2 px-3 text-sm whitespace-nowrap">${esc(dateText(r.date))}</td>
        <td class="py-2 px-3 text-sm"><span class="text-xs text-gray-500">${esc(DOC_LABEL[r.payment_id ? "payment" : r.move_type] ?? "")}</span> ${esc(r.move_id[1])}${tags}</td>
        <td class="py-2 px-3 text-sm">${esc(r.account_id[1])}</td><td class="py-2 px-3 text-sm">${esc(r.partner_id?.[1] || "")}</td>
        <td class="py-2 px-3 text-sm text-right tabular-nums">${esc(money(r.amount_residual))}</td>
        <td class="py-2 px-3 text-sm text-right"><button type="button" data-action="add-pair" data-line-id="${r.id}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Tambah</button></td></tr>`;
    })
    .join("");
  return `<div class="overflow-x-auto"><table class="w-full text-left"><thead class="bg-gray-50"><tr><th class="py-2 pl-4 pr-1"></th>${["Tanggal", "Dokumen", "Akun", "Mitra", "Sisa", ""]
    .map((h, i) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase ${i === 4 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody class="divide-y divide-gray-100">${rows}</tbody></table></div>`;
}

async function renderLine(id) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const line = await readOne("account.bank.statement.line", id, [
    "date", "journal_id", "payment_ref", "partner_id", "partner_name", "amount", "currency_id", "is_reconciled", "move_id", "statement_id", "reconcile_data_info", "can_reconcile",
  ]);
  if (!line) {
    app.innerHTML = '<p class="text-sm text-rose-600">Mutasi tidak ditemukan.</p>';
    return;
  }
  const currency = line.currency_id?.[1];
  const items = await loadJournalItems(line.move_id?.[0]);
  const header = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/bank" class="hover:text-indigo-600">Bank Transaction</a> / ${esc(line.payment_ref || `#${id}`)}</div>
    <div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: line.move_id ? 1 : 0, label: `Jurnal ${line.move_id?.[1] ?? ""}`, icon: "fa-book", href: `#/journal/${line.move_id?.[0]}` },
      { count: line.statement_id ? 1 : 0, label: `Mutasi ${line.statement_id?.[1] ?? ""}`, icon: "fa-list", href: `#/bank?statement=${line.statement_id?.[0]}` },
    ])}</div>
    <div class="mb-3"><h1 class="text-2xl font-bold text-gray-900">${esc(line.payment_ref || `Mutasi #${id}`)}</h1>
      <div class="mt-2">${badge(STATUS, line.is_reconciled ? "done" : "todo")}</div></div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Tanggal", `<div class="py-2 text-sm font-medium text-gray-900">${esc(dateText(line.date))}</div>`)}
      ${fieldBlock("Jurnal", `<div class="py-2 text-sm font-medium text-gray-900">${esc(line.journal_id?.[1])}</div>`)}
      ${fieldBlock("Mitra", `<div class="py-2 text-sm font-medium text-gray-900">${esc(line.partner_id?.[1] || line.partner_name || "-")}</div>`)}
      ${fieldBlock("Jumlah", `<div class="py-2 text-sm font-semibold ${line.amount < 0 ? "text-rose-700" : "text-emerald-700"}">${esc(money(line.amount, currency))} <span class="font-normal text-gray-500">${line.amount < 0 ? "(keluar)" : "(masuk)"}</span></div>`)}
    </section>`;

  if (line.is_reconciled) {
    rec = null;
    app.innerHTML = `${header}
      <div class="flex gap-2 mt-4"><button data-action="unreconcile" data-id="${id}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Batalkan Rekonsiliasi</button></div>
      ${journalHtml(items, currency, { journal: line.journal_id?.[1], title: "Item Jurnal Mutasi" })}`;
    return;
  }
  if (!rec || rec.id !== id) {
    // Mulai dari usulan bersih: data rekonsiliasi tersimpan dari sesi lama bisa memuat pasangan ganda.
    await call("account.bank.statement.line", "clean_reconcile", { ids: [id] });
    const fresh = await readOne("account.bank.statement.line", id, ["reconcile_data_info"]);
    rec = {
      id, line, info: fresh.reconcile_data_info, search: "", onlyPartner: Boolean(line.partner_id), candidates: [], account: null, accountTypes: null, label: "",
      tab: "all", filters: EMPTY_FILTERS(), opposite: false, selected: new Set(),
    };
  }
  rec.header = header;
  await loadCandidates();
  paintReconcile();
}

function paintReconcile() {
  const { info, line, header } = rec;
  const hasSuspense = info.data.some((d) => d.kind === "suspense");
  const suspense = info.data.find((d) => d.kind === "suspense");
  const partnerNote = hasSuspense && line.partner_id
    ? `Selisih ${money(Math.abs(suspense.amount))} akan dicatat ke akun ${esc(suspense.account_id?.[1] ?? "mitra")} atas nama ${esc(line.partner_id[1])} (pembayaran di muka atau lebih bayar), atau catat ke akun lain di bawah.`
    : hasSuspense
      ? "Selisih belum bisa dicatat: pilih mitra pada mutasi, cocokkan dengan dokumen lain, atau catat ke sebuah akun di bawah."
      : "Jumlah sudah seimbang.";
  const f = rec.filters;
  const chip = (action, label, extra = "") => `<button type="button" data-action="${action}" ${extra} class="px-2 py-1 bg-white border border-gray-300 rounded-full text-xs hover:bg-gray-50">${label}</button>`;
  const html = `${header}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4" id="proposal">
      <div class="text-sm font-semibold mb-3">Rekonsiliasi</div>
      ${proposalTable()}
      <p class="mt-3 text-sm ${hasSuspense && !info.can_reconcile ? "text-amber-800" : "text-gray-600"}">${partnerNote}</p>
      ${hasSuspense
        ? `<div class="mt-3 border-t border-gray-100 pt-3">
             <div class="text-xs font-medium text-gray-500 uppercase mb-2">Catat selisih ke akun (${esc(money(Math.abs(suspense.amount)))})</div>
             <div class="flex flex-wrap gap-2 mb-2">${chip("wo-types", "Beban", 'data-kind="expense"')}${chip("wo-types", "Pendapatan", 'data-kind="income"')}${chip("wo-fx", "Selisih kurs")}
               ${rec.accountTypes ? chip("wo-types", "Semua akun", 'data-kind=""') : ""}</div>
             <div class="flex flex-wrap items-end gap-3">
               <label class="text-xs font-medium text-gray-500 uppercase">Akun<input data-lookup="bank-account" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(rec.account?.display_name ?? "")}" placeholder="mis. Biaya administrasi bank" class="${INPUT} mt-1 w-72"></label>
               <label class="text-xs font-medium text-gray-500 uppercase">Label<input data-wo-label value="${esc(rec.label)}" placeholder="mis. Biaya transfer" class="${INPUT} mt-1 w-56"></label>
               <button type="button" data-action="apply-account" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Terapkan</button></div></div>`
        : ""}
      <div class="flex gap-2 mt-4">
        <button data-action="reconcile" class="px-4 py-2 rounded-lg text-sm font-medium ${info.can_reconcile ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-gray-200 text-gray-500 cursor-not-allowed"}" ${info.can_reconcile ? "" : "disabled"}>Konfirmasi</button>
        <button data-action="reset-reconcile" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Atur Ulang</button>
      </div>
    </section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
      <div class="text-sm font-semibold mb-3">Cocokkan dengan faktur, tagihan, pembayaran, atau jurnal entry</div>
      <div class="flex flex-wrap gap-2 mb-3" role="tablist">${TABS.map(
        ([key, label]) => `<button type="button" role="tab" aria-selected="${rec.tab === key}" data-action="cand-tab" data-tab="${key}" class="px-3 py-1.5 rounded-lg text-sm ${rec.tab === key ? "bg-indigo-600 text-white" : "bg-white border border-gray-300 hover:bg-gray-50"}">${label}</button>`,
      ).join("")}</div>
      <form data-form="candidates" class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <label class="text-xs font-medium text-gray-500 uppercase">Cari<input data-search value="${esc(rec.search)}" placeholder="Dokumen, label, mitra" class="${INPUT} mt-1"></label>
        <label class="text-xs font-medium text-gray-500 uppercase">Mitra<input data-f="partner" value="${esc(f.partner)}" placeholder="Nama mitra" class="${INPUT} mt-1"></label>
        <label class="text-xs font-medium text-gray-500 uppercase">Jumlah dari<input type="number" step="any" data-f="min" value="${esc(f.min)}" class="${INPUT} mt-1 text-right"></label>
        <label class="text-xs font-medium text-gray-500 uppercase">Jumlah sampai<input type="number" step="any" data-f="max" value="${esc(f.max)}" class="${INPUT} mt-1 text-right"></label>
        <label class="text-xs font-medium text-gray-500 uppercase">Tanggal dari<input type="date" data-f="from" value="${esc(f.from)}" class="${INPUT} mt-1"></label>
        <label class="text-xs font-medium text-gray-500 uppercase">Tanggal sampai<input type="date" data-f="to" value="${esc(f.to)}" class="${INPUT} mt-1"></label>
        <div class="flex flex-col justify-end gap-1 text-sm text-gray-700">
          ${line.partner_id ? `<label class="flex items-center gap-2"><input type="checkbox" data-only-partner ${rec.onlyPartner ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> Hanya ${esc(line.partner_id[1])}</label>` : ""}
          <label class="flex items-center gap-2"><input type="checkbox" data-opposite ${rec.opposite ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> Sertakan arah berlawanan (nota kredit)</label></div>
        <div class="flex items-end"><button type="submit" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cari</button></div></form>
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2 text-sm">
        <span class="text-gray-600" id="pick-total">${pickText()}</span>
        <button type="button" data-action="add-picked" id="add-picked" class="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700" ${rec.selected.size ? "" : "disabled"}>Tambah yang dipilih</button></div>
      <div id="candidates">${candidatesTable()}</div>
      <p class="mt-2 text-xs text-gray-500">Baris hijau = saran (jumlah, nomor, atau mitra cocok). Satu mutasi bisa untuk banyak dokumen; satu dokumen bisa dibayar beberapa mutasi (sisanya muncul lagi di mutasi berikutnya).</p>
    </section>`;
  app.innerHTML = html;
}

function pickText() {
  if (!rec.selected.size) return "Centang beberapa dokumen untuk dicocokkan sekaligus.";
  return `${rec.selected.size} dokumen dipilih, total sisa ${money(pickedTotal())}; mutasi ${money(Math.abs(rec.line.amount))}.`;
}

/* ---------- Aksi ---------- */

async function refreshProposal() {
  await loadCandidates();
  paintReconcile(); // gambar ulang bagian rekonsiliasi tanpa memuat ulang halaman penuh
}

async function addPair(button, lineId) {
  const info = await guarded(button, () => onchange({ reconcile_data_info: rec.info, add_account_move_line_id: lineId }, ["add_account_move_line_id"]));
  if (!info) return;
  rec.info = info;
  await refreshProposal();
}

async function removePair(button, el) {
  const manual = el.dataset.manual === "1";
  const info = await guarded(button, () =>
    manual
      ? onchange({ reconcile_data_info: rec.info, manual_reference: el.dataset.ref, manual_delete: true }, ["manual_delete"])
      : onchange({ reconcile_data_info: rec.info, add_account_move_line_id: Number(el.dataset.lineId) }, ["add_account_move_line_id"]),
  );
  if (!info) return;
  rec.info = info;
  await refreshProposal();
}

async function applyAccount(button) {
  if (!rec.account) {
    toast("Pilih akun dari kotak saran.", "error");
    return;
  }
  const suspense = rec.info.data.find((d) => d.kind === "suspense");
  if (!suspense) return;
  const info = await guarded(button, () =>
    onchange(
      {
        reconcile_data_info: rec.info, manual_reference: suspense.reference, manual_account_id: rec.account.id, manual_name: rec.label.trim() || suspense.name,
        manual_amount: suspense.amount, manual_partner_id: suspense.partner_id?.[0] ?? false, manual_currency_id: suspense.currency_id,
        manual_in_currency_id: suspense.line_currency_id, manual_in_currency: false, manual_amount_in_currency: suspense.currency_amount,
        previous_manual_amount_in_currency: suspense.currency_amount, manual_kind: "suspense", manual_original_amount: 0.0,
        manual_exchange_counterpart: false, manual_delete: false, analytic_distribution: {},
      },
      ["manual_account_id"],
    ),
  );
  if (!info) return;
  rec.info = info;
  rec.account = null;
  rec.label = "";
  await refreshProposal();
}

async function addPicked(button) {
  const ids = [...rec.selected];
  if (!ids.length) return;
  const info = await guarded(button, async () => {
    let current = rec.info;
    for (const id of ids) current = await onchange({ reconcile_data_info: current, add_account_move_line_id: id }, ["add_account_move_line_id"]);
    return current;
  });
  if (!info) return;
  rec.info = info;
  rec.selected = new Set();
  await refreshProposal();
}

// Ubah jumlah yang dialokasikan ke satu dokumen (sebagian, atau penuh agar selisihnya menjadi sisa mutasi).
async function setPairAmount(el, value) {
  const pair = rec.info.data.find((d) => d.reference === el.dataset.pairAmount);
  if (!pair) return;
  const target = Number(value);
  if (!(target >= 0) || !Number.isFinite(target)) {
    toast("Jumlah tidak valid.", "error");
    return;
  }
  const signed = (pair.amount < 0 ? -1 : 1) * target;
  const info = await guarded(el, () =>
    onchange(
      {
        reconcile_data_info: rec.info, manual_reference: pair.reference, manual_account_id: pair.account_id[0], manual_name: pair.name,
        manual_amount: signed, manual_partner_id: pair.partner_id?.[0] ?? false, manual_currency_id: pair.currency_id, manual_in_currency_id: pair.line_currency_id,
        manual_in_currency: false, manual_amount_in_currency: signed, previous_manual_amount_in_currency: pair.currency_amount, manual_kind: pair.kind,
        manual_original_amount: pair.original_amount ?? 0.0, manual_exchange_counterpart: false, manual_delete: false, analytic_distribution: pair.analytic_distribution ?? {},
      },
      ["manual_amount"],
    ),
  );
  if (info) rec.info = info;
  await refreshProposal();
}

async function writeOffFx(button) {
  const suspense = rec.info.data.find((d) => d.kind === "suspense");
  if (!suspense) return;
  const [company] = await searchRead("res.company", [], ["expense_currency_exchange_account_id", "income_currency_exchange_account_id"], { limit: 1 });
  const account = suspense.amount > 0 ? company?.expense_currency_exchange_account_id : company?.income_currency_exchange_account_id;
  if (!account) {
    toast("Akun selisih kurs perusahaan belum diatur.", "error");
    return;
  }
  rec.account = { id: account[0], display_name: account[1] };
  rec.label ||= "Selisih kurs";
  await applyAccount(button);
}

async function reconcile(button) {
  const done = await guarded(button, async () => {
    if (!rec.info.can_reconcile) throw new Error("Mutasi belum bisa direkonsiliasi: alokasikan seluruh jumlahnya.");
    await call("account.bank.statement.line", "write", { ids: [rec.id], vals: { reconcile_data_info: rec.info } });
    await call("account.bank.statement.line", "reconcile_bank_line", { ids: [rec.id] });
    return true;
  });
  if (!done) return;
  rec = null;
  toast("Mutasi direkonsiliasi. Saldo berpindah ke akun bank.");
  reload();
}

async function resetReconcile(button) {
  const ok = await guarded(button, () => call("account.bank.statement.line", "clean_reconcile", { ids: [rec.id] }));
  if (ok === undefined) return;
  rec = null;
  reload();
}

async function unreconcile(button, id) {
  if (!window.confirm("Batalkan rekonsiliasi mutasi ini? Pembayaran dikembalikan ke status belum dicocokkan.")) return;
  const ok = await guarded(button, () => call("account.bank.statement.line", "unreconcile_bank_line", { ids: [id] }));
  if (ok === undefined) return;
  rec = null;
  toast("Rekonsiliasi dibatalkan.");
  reload();
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "refresh") reload();
  else if (action === "discard") form = null;
  else if (action === "add-bank-line") {
    form.lines.push(emptyRow());
    await renderNew();
  } else if (action === "remove-bank-line") {
    form.lines.splice(Number(el.dataset.line), 1);
    if (!form.lines.length) form.lines.push(emptyRow());
    await renderNew();
  } else if (action === "save-statement") {
    const id = await guarded(el, saveStatement);
    if (id) {
      form = null;
      toast("Mutasi disimpan.");
      location.hash = `#/bank?statement=${id}`;
    }
  } else if (action === "add-pair") await addPair(el, Number(el.dataset.lineId));
  else if (action === "remove-pair") await removePair(el, el);
  else if (action === "apply-account") await applyAccount(el);
  else if (action === "add-picked") await addPicked(el);
  else if (action === "cand-tab") {
    rec.tab = el.dataset.tab;
    rec.selected = new Set();
    await refreshProposal();
  } else if (action === "wo-types") {
    rec.accountTypes = WRITE_OFF_TYPES[el.dataset.kind] ?? null;
    paintReconcile();
    document.querySelector('[data-lookup="bank-account"]')?.focus();
  } else if (action === "wo-fx") await writeOffFx(el);
  else if (action === "pair-full") {
    const pair = rec.info.data.find((d) => d.reference === el.dataset.ref);
    if (pair) await setPairAmount({ dataset: { pairAmount: pair.reference } }, Math.abs(pair.original_amount_unsigned));
  }
  else if (action === "reconcile") await reconcile(el);
  else if (action === "reset-reconcile") await resetReconcile(el);
  else if (action === "unreconcile") await unreconcile(el, Number(el.dataset.id));
}

export function onInput(event, el) {
  if (el.dataset.bankLine !== undefined && form) form.lines[Number(el.dataset.bankLine)][el.dataset.field] = el.value;
  else if (el.dataset.bank && form) form[el.dataset.bank] = el.dataset.bank === "journal" ? Number(el.value) : el.value;
  else if (el.dataset.woLabel !== undefined && rec) rec.label = el.value;
  else if (el.dataset.lookup === "bank-account" && rec) {
    rec.account = null;
    runLookup(el, 250);
  }
}

export async function onChange(event, el) {
  if (el.dataset.change === "journal-filter") {
    const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
    if (el.value) params.set("journal", el.value);
    else params.delete("journal");
    location.hash = `#/bank${params.toString() ? `?${params}` : ""}`;
    return;
  }
  if (el.dataset.pick !== undefined && rec) {
    const id = Number(el.dataset.pick);
    if (el.checked) rec.selected.add(id);
    else rec.selected.delete(id);
    const total = document.getElementById("pick-total");
    if (total) total.textContent = pickText();
    const add = document.getElementById("add-picked");
    if (add) add.disabled = !rec.selected.size;
    return;
  }
  if (el.dataset.pairAmount !== undefined && rec) {
    await setPairAmount(el, el.value);
    return;
  }
  if (el.dataset.bankCsv !== undefined && el.files?.[0]) {
    const text = await el.files[0].text();
    try {
      const rows = parseStatementCsv(text);
      form.lines = rows;
      toast(`${rows.length} baris dibaca dari CSV.`);
      await renderNew();
    } catch (error) {
      toast(error.message, "error");
    }
  }
}

export async function onSubmit(event, formEl, kind) {
  if (kind !== "candidates" || !rec) return;
  rec.search = document.querySelector("[data-search]").value.trim();
  rec.onlyPartner = document.querySelector("[data-only-partner]")?.checked ?? false;
  rec.opposite = document.querySelector("[data-opposite]")?.checked ?? false;
  for (const input of document.querySelectorAll("[data-f]")) rec.filters[input.dataset.f] = input.value.trim();
  await refreshProposal();
}
