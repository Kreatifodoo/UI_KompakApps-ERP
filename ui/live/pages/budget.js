// Budget (mis.budget.by.account dan mis.budget.by.account.item, OCA mis_builder_budget): isi angka anggaran per akun, analitik, dan
// periode di dalam sebuah rencana anggaran (Budget Plan Master), lalu konfirmasi. Baris debit dipakai untuk biaya dan baris kredit
// untuk pendapatan; UI menentukannya dari jenis akun, jadi pengguna cukup mengisi jumlah positif. Perbandingan dengan realisasi
// ada di Budget Report (D31).
import {
  ACCOUNT_TYPE_LABELS, INPUT, app, badge, button, call, cell, chatterHtml, closeLookup, closeModal, ctx, dateText, esc, fieldBlock, filterSelect, guarded, hasGroup,
  loadMessages, money, openModal, pageHeader, readOne, registerLookup, rowLink, runLookup, searchAccounts, searchBox, searchRead, selectOptions, statusbar, table, toast,
} from "../common.js";
import { STATES } from "./budgetplan.js";

const PLAN = "mis.budget.by.account";
const ITEM = "mis.budget.by.account.item";
const INCOME = ["income", "income_other"];
const PNL = [...INCOME, "expense", "expense_direct_cost", "expense_depreciation", "expense_other"];
const ITEM_LIMIT = 400;
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

let last = { sub: "", query: new URLSearchParams() };
let plan = null; // { record, canEdit, analytics: Map(id -> nama) }
let dialog = null; // isian dialog baris anggaran
export const leave = () => {
  plan = null;
  dialog = null;
};
const reload = () => render(last.sub, last.query);

/* ---------- Pembantu ---------- */

/** Pecah rentang tanggal menjadi potongan per bulan kalender; potongan pertama dan terakhir bisa parsial. */
export function monthlySegments(from, to) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  const segments = [];
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    segments.push([y === fy && m === fm ? from : iso(y, m, 1), y === ty && m === tm ? to : iso(y, m, lastDay)]);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return segments;
}

/** Bagi total sama banyak ke n bagian (dalam sen); sisa pembulatan masuk ke bagian terakhir agar jumlahnya persis. */
export function splitAmount(total, n) {
  const cents = Math.round(total * 100);
  const base = Math.floor(cents / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? cents - base * (n - 1) : base) / 100);
}

const accountTypes = async (ids) =>
  new Map((ids.length ? await searchRead("account.account", [["id", "in", ids]], ["account_type"], { context: { active_test: false } }) : []).map((a) => [a.id, a.account_type]));

/** Total anggaran per rencana: pendapatan (kredit), biaya (debit), dan akun di luar laba rugi. */
async function planTotals(ids) {
  const out = new Map(ids.map((id) => [id, { income: 0, cost: 0, other: 0, accounts: [] }]));
  if (!ids.length) return out;
  const groups = await call(ITEM, "formatted_read_group", { domain: [["budget_id", "in", ids]], groupby: ["budget_id", "account_id"], aggregates: ["balance:sum", "__count"] });
  const types = await accountTypes([...new Set(groups.map((g) => g.account_id[0]))]);
  for (const g of groups) {
    const total = out.get(g.budget_id[0]);
    const balance = g["balance:sum"] ?? 0;
    const type = types.get(g.account_id[0]);
    if (INCOME.includes(type)) total.income -= balance;
    else if (PNL.includes(type)) total.cost += balance;
    else total.other += balance;
    total.accounts.push({ id: g.account_id[0], name: g.account_id[1], count: g.__count });
  }
  return out;
}

const card = (label, value, hint = "", tone = "") =>
  `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${esc(label)}</div><div class="text-xl font-semibold mt-1 ${tone}">${esc(value)}</div>${hint ? `<div class="text-xs text-gray-500 mt-1">${esc(hint)}</div>` : ""}</div>`;

/** Teks distribusi analitik sebuah baris: nama akun analitik (dengan persen bila tidak penuh). */
function analyticText(distribution, names) {
  if (!distribution) return "";
  return Object.entries(distribution)
    .map(([key, percent]) => `${key.split(",").map((id) => names.get(Number(id)) ?? `#${id}`).join(" + ")}${Number(percent) === 100 ? "" : ` ${percent}%`}`)
    .join("; ");
}

/* ---------- Daftar ---------- */

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const state = query.get("state") || "all";
  const text = query.get("q") ?? "";
  const domain = [];
  if (state !== "all") domain.push(["state", "=", state]);
  if (text) domain.push("|", ["name", "ilike", text], ["description", "ilike", text]);
  const plans = await searchRead(PLAN, domain, ["name", "description", "date_from", "date_to", "state", "item_ids"], { order: "date_from desc, id desc", limit: 100 });
  const totals = await planTotals(plans.map((p) => p.id));
  const body = plans
    .map((p) => {
      const t = totals.get(p.id);
      const result = t.income - t.cost;
      return rowLink(`#/budget/${p.id}`, [
        cell(p.name, { strong: true }),
        cell(`${dateText(p.date_from)} s.d. ${dateText(p.date_to)}`),
        cell(badge(STATES, p.state), { raw: true }),
        cell(String(p.item_ids.length), { right: true }),
        cell(money(t.income), { right: true }),
        cell(money(t.cost), { right: true }),
        cell(money(result), { right: true }),
      ]);
    })
    .join("");
  const options = [["all", "Semua status"], ...Object.entries(STATES).map(([k, v]) => [k, v[0]])];
  app.innerHTML =
    pageHeader(
      "Budget",
      `${searchBox(text, "Cari rencana...")}${filterSelect(options, state)}
       <a href="#/budgetplan/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Rencana Anggaran Baru</a>`,
    ) +
    table(
      [{ label: "Rencana" }, { label: "Periode" }, { label: "Status" }, { label: "Baris", right: true }, { label: "Pendapatan", right: true }, { label: "Biaya", right: true }, { label: "Laba (Rugi)", right: true }],
      body,
      "Belum ada rencana anggaran. Buat dulu di Budget Plan Master, lalu isi angkanya di sini.",
    ) +
    '<p class="text-xs text-gray-500 mt-3">Pendapatan dan biaya adalah jumlah seluruh baris anggaran pada rencana itu. Buka sebuah rencana untuk mengisi atau mengubah barisnya, lalu konfirmasi.</p>';
}

/* ---------- Form rencana dan baris anggaran ---------- */

async function renderForm(id) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const record = await readOne(PLAN, id, ["name", "description", "date_from", "date_to", "state", "allow_items_overlap", "active", "item_ids", "company_id"]);
  if (!record) {
    app.innerHTML = '<p class="text-sm text-rose-600">Rencana anggaran tidak ditemukan.</p>';
    return;
  }
  const accountFilter = Number(last.query.get("account")) || null;
  const [items, totals, canEdit, analyticRows] = await Promise.all([
    searchRead(ITEM, [["budget_id", "=", id], ...(accountFilter ? [["account_id", "=", accountFilter]] : [])], ["account_id", "name", "date_from", "date_to", "debit", "credit", "analytic_distribution"], {
      order: "account_id, date_from, id", limit: ITEM_LIMIT,
    }),
    planTotals([id]),
    hasGroup("account.group_account_manager"),
    searchRead("account.analytic.account", [], ["display_name"], { order: "name", limit: 300, context: { active_test: false } }),
  ]);
  const total = totals.get(id);
  const analytics = new Map(analyticRows.map((a) => [a.id, a.display_name]));
  const types = await accountTypes([...new Set(items.map((i) => i.account_id[0]))]);
  plan = { record, canEdit, analytics, analyticRows, types };

  const editable = canEdit && record.state === "draft";
  const state = record.state;
  const buttons = canEdit
    ? [
        state === "draft" ? button("plan-confirm", "Konfirmasi", "primary") : "",
        state !== "draft" ? button("plan-draft", "Kembalikan ke Draft") : "",
        state !== "cancelled" ? button("plan-cancel", "Batalkan", "danger") : "",
        button("plan-copy", "Duplikasi"),
      ].join("")
    : "";
  const rows = items
    .map((i) => {
      const side = i.credit > 0 ? "Kredit" : "Debit";
      const type = types.get(i.account_id[0]);
      return `<tr class="hover:bg-gray-50">
        <td class="py-2 px-4 text-sm">${esc(i.account_id[1])}${type ? `<div class="text-xs text-gray-500">${esc(ACCOUNT_TYPE_LABELS[type] ?? type)}</div>` : ""}</td>
        <td class="py-2 px-4 text-sm">${esc(analyticText(i.analytic_distribution, analytics) || "-")}</td>
        <td class="py-2 px-4 text-sm whitespace-nowrap">${esc(dateText(i.date_from))} s.d. ${esc(dateText(i.date_to))}</td>
        <td class="py-2 px-4 text-sm">${side}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(i.debit || i.credit))}</td>
        <td class="py-2 px-4 text-sm text-gray-600">${esc(i.name || "")}</td>
        <td class="py-2 px-4 text-sm text-right whitespace-nowrap">${editable
          ? `<button type="button" data-action="item-edit" data-id="${i.id}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Ubah</button>
             <button type="button" data-action="item-delete" data-id="${i.id}" class="px-3 py-1 bg-white border border-rose-300 text-rose-600 rounded-lg text-sm hover:bg-rose-50">Hapus</button>`
          : ""}</td></tr>`;
    })
    .join("");
  const head = ["Akun", "Analitik", "Periode", "Sisi", "Jumlah", "Label", ""];
  const accountOptions = [{ id: 0, display_name: "Semua akun" }, ...total.accounts.map((a) => ({ id: a.id, display_name: `${a.name} (${a.count})` }))];
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/budget" class="hover:text-indigo-600">Budget</a> / ${esc(record.name)}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">${buttons}
      <a href="#/budgetplan/${id}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Ubah Rencana</a>
      <a href="#/budgetreport/${id}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-chart-column mr-2"></i>Anggaran vs Realisasi</a></div>
    <div class="mb-3">${statusbar(["draft", "confirmed"], STATES, state)}</div>
    <div class="mb-1 flex items-center gap-3"><h1 class="text-2xl font-bold text-gray-900">${esc(record.name)}</h1>${record.active ? "" : badge({ a: ["Diarsipkan", "muted"] }, "a")}</div>
    <p class="text-sm text-gray-500 mb-4">${esc(dateText(record.date_from))} s.d. ${esc(dateText(record.date_to))}${record.description ? ` · ${esc(record.description)}` : ""}${record.allow_items_overlap ? " · baris boleh tumpang tindih" : ""}</p>
    ${canEdit ? "" : '<p class="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">Anda hanya dapat melihat anggaran. Mengisi dan mengubah anggaran butuh hak Accounting Advisor.</p>'}
    <div class="grid md:grid-cols-4 gap-4 mb-4">
      ${card("Anggaran pendapatan", money(total.income))}
      ${card("Anggaran biaya", money(total.cost), "harga pokok dan beban")}
      ${card("Laba (rugi) anggaran", money(total.income - total.cost), "", total.income - total.cost < 0 ? "text-rose-700" : "text-emerald-700")}
      ${card("Baris anggaran", String(record.item_ids.length), total.other ? `termasuk akun di luar laba rugi: ${money(total.other)}` : "")}
    </div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <div class="px-4 py-3 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
        <span class="text-sm font-semibold">Baris Anggaran</span>
        <div class="flex flex-wrap items-center gap-2">
          <select data-bud="account" aria-label="Filter akun" class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">${selectOptions(accountOptions, accountFilter ?? 0)}</select>
          ${editable ? '<button type="button" data-action="item-add" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Tambah Baris</button>' : ""}
        </div>
      </div>
      <table class="w-full text-left"><thead class="bg-gray-50"><tr>${head.map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i === 4 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        <tbody class="divide-y divide-gray-100">${rows || `<tr><td colspan="7" class="py-8 text-center text-sm text-gray-500">${editable ? "Belum ada baris anggaran. Tambahkan dengan tombol Tambah Baris." : "Tidak ada baris anggaran."}</td></tr>`}</tbody></table>
    </section>
    ${items.length >= ITEM_LIMIT ? `<p class="text-xs text-gray-500 mt-3">Menampilkan ${ITEM_LIMIT} baris pertama; pilih akun untuk menyaring.</p>` : ""}
    <p class="text-xs text-gray-500 mt-3">${state === "draft" ? "Baris hanya bisa diubah saat rencana berstatus draft. Konfirmasi mengunci angkanya; kembalikan ke draft untuk mengubah." : state === "confirmed" ? "Rencana dikonfirmasi: baris dikunci. Kembalikan ke draft untuk mengubahnya." : "Rencana dibatalkan: baris dikunci. Kembalikan ke draft untuk mengubahnya."} Pendapatan dicatat sebagai kredit dan biaya sebagai debit. Laporan membagi angka sebuah baris menurut jumlah hari yang beririsan dengan periode laporan.</p>
    ${chatterHtml(PLAN, id)}`;
  loadMessages(PLAN, id);
}

/* ---------- Dialog baris anggaran ---------- */

registerLookup("budget-account", {
  search: (q) => searchAccounts(q, PNL),
  sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
  isChosen: (input) => dialog?.account?.display_name === input.value,
  choose: (input, item) => {
    dialog.account = item;
    input.value = item.display_name;
    paintSideHint();
  },
});

const autoSide = (account) => (account && INCOME.includes(account.account_type) ? "credit" : "debit");
const SIDE_LABEL = { debit: "Debit (biaya)", credit: "Kredit (pendapatan)" };

function paintSideHint() {
  const hint = document.querySelector("#bud-side-hint");
  if (!hint || !dialog) return;
  hint.textContent = dialog.side === "auto"
    ? dialog.account ? `Otomatis: ${SIDE_LABEL[autoSide(dialog.account)]}.` : "Otomatis menurut jenis akun: pendapatan sebagai kredit, biaya sebagai debit."
    : `Dicatat sebagai ${SIDE_LABEL[dialog.side]}.`;
}

function openItemDialog(item) {
  const r = plan.record;
  if (item) {
    const type = plan.types.get(item.account_id[0]);
    const key = item.analytic_distribution ? Object.keys(item.analytic_distribution) : [];
    dialog = {
      id: item.id, account: { id: item.account_id[0], display_name: item.account_id[1], account_type: type }, analytic: key.length === 1 ? Number(key[0]) : null,
      from: item.date_from, to: item.date_to, amount: item.debit || item.credit, side: item.credit > 0 ? "credit" : "debit", name: item.name || "", split: false,
      keepAnalytic: key.length > 1 ? item.analytic_distribution : null,
    };
  } else {
    dialog = { id: null, account: null, analytic: null, from: r.date_from, to: r.date_to, amount: "", side: "auto", name: "", split: true, keepAnalytic: null };
  }
  const analyticOptions = plan.analyticRows;
  openModal(
    dialog.id ? "Ubah Baris Anggaran" : "Tambah Baris Anggaran",
    `<div class="space-y-3">
      ${fieldBlock("Akun", `<input data-lookup="budget-account" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(dialog.account?.display_name ?? "")}" placeholder="Cari kode atau nama akun pendapatan atau biaya..." class="${INPUT}">`)}
      ${fieldBlock("Analitik (opsional)", dialog.keepAnalytic
        ? `<div class="py-2 text-sm text-gray-700">${esc(analyticText(dialog.keepAnalytic, plan.analytics))} <span class="text-gray-400">(beberapa analitik; ubah di Odoo)</span></div>`
        : `<select data-dlg="analytic" data-kind="id" class="${INPUT}">${selectOptions(analyticOptions, dialog.analytic, "Tanpa analitik")}</select>`)}
      <div class="grid grid-cols-2 gap-3">
        ${fieldBlock("Dari", `<input type="date" data-dlg="from" value="${esc(dialog.from)}" min="${esc(r.date_from)}" max="${esc(r.date_to)}" class="${INPUT}">`)}
        ${fieldBlock("Sampai", `<input type="date" data-dlg="to" value="${esc(dialog.to)}" min="${esc(r.date_from)}" max="${esc(r.date_to)}" class="${INPUT}">`)}
      </div>
      <div class="grid grid-cols-2 gap-3">
        ${fieldBlock("Jumlah", `<input type="number" min="0" step="any" data-dlg="amount" data-kind="number" value="${esc(dialog.amount)}" class="${INPUT} text-right">`)}
        ${fieldBlock("Sisi", `<select data-dlg="side" class="${INPUT}"><option value="auto" ${dialog.side === "auto" ? "selected" : ""}>Otomatis</option><option value="debit" ${dialog.side === "debit" ? "selected" : ""}>Debit</option><option value="credit" ${dialog.side === "credit" ? "selected" : ""}>Kredit</option></select>`)}
      </div>
      <p id="bud-side-hint" class="text-xs text-gray-500"></p>
      ${dialog.id ? "" : `<label class="flex items-start gap-2 text-sm text-gray-700"><input type="checkbox" data-dlg="split" checked class="mt-1 rounded border-gray-300 text-indigo-600"><span>Bagi rata per bulan. Jumlah di atas dibagi sama banyak ke setiap bulan pada rentang tanggal (satu baris per bulan). Matikan untuk satu baris dengan jumlah penuh.</span></label>`}
      ${fieldBlock("Label (opsional)", `<input data-dlg="name" value="${esc(dialog.name)}" class="${INPUT}">`)}
    </div>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="item-save" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Simpan</button>`,
    () => {
      dialog = null;
    },
  );
  paintSideHint();
}

async function saveDialog() {
  const d = dialog;
  const r = plan.record;
  if (!d.account) throw new Error("Pilih akun dari kotak saran.");
  if (!d.from || !d.to) throw new Error("Isi tanggal dari dan sampai.");
  if (d.to < d.from) throw new Error("Tanggal sampai tidak boleh sebelum tanggal dari.");
  if (d.from < r.date_from || d.to > r.date_to) throw new Error(`Periode baris harus berada dalam periode rencana (${dateText(r.date_from)} s.d. ${dateText(r.date_to)}).`);
  const amount = Number(d.amount);
  if (!(amount > 0)) throw new Error("Jumlah harus lebih dari 0.");
  if (!r.allow_items_overlap) {
    const clash = await searchRead(
      ITEM, [["budget_id", "=", r.id], ["account_id", "=", d.account.id], ["date_from", "<=", d.to], ["date_to", ">=", d.from], ...(d.id ? [["id", "!=", d.id]] : [])],
      ["date_from", "date_to"], { limit: 1 },
    );
    if (clash.length) {
      throw new Error(`Akun ${d.account.display_name} sudah punya anggaran pada ${dateText(clash[0].date_from)} s.d. ${dateText(clash[0].date_to)}. Ubah baris itu, atau nyalakan "Izinkan baris anggaran tumpang tindih" di Budget Plan Master bila akun yang sama dianggarkan untuk beberapa analitik.`);
    }
  }
  const side = d.side === "auto" ? autoSide(d.account) : d.side;
  const money_ = (value) => ({ debit: side === "debit" ? value : 0, credit: side === "credit" ? value : 0 });
  const common = {
    account_id: d.account.id, name: d.name.trim() || false,
    ...(d.keepAnalytic ? {} : { analytic_distribution: d.analytic ? { [d.analytic]: 100 } : false }),
  };
  if (d.id) {
    await call(ITEM, "write", { ids: [d.id], vals: { ...common, date_from: d.from, date_to: d.to, ...money_(amount) } });
    return "Baris anggaran diubah.";
  }
  const segments = d.split ? monthlySegments(d.from, d.to) : [[d.from, d.to]];
  const parts = splitAmount(amount, segments.length);
  const companyId = r.company_id?.[0] ?? ctx.company.id;
  await call(ITEM, "create", {
    vals_list: segments.map(([from, to], i) => ({ budget_id: r.id, company_id: companyId, ...common, date_from: from, date_to: to, ...money_(parts[i]) })),
  });
  return segments.length > 1 ? `${segments.length} baris anggaran (per bulan) dibuat.` : "Baris anggaran dibuat.";
}

/* ---------- Acara ---------- */

async function changeState(el, method, message, confirmText = "") {
  if (confirmText && !window.confirm(confirmText)) return;
  if (method === "action_confirm" && !plan.record.item_ids.length) {
    toast("Isi minimal satu baris anggaran sebelum mengonfirmasi.", "error");
    return;
  }
  const ok = await guarded(el, () => call(PLAN, method, { ids: [plan.record.id] }));
  if (ok !== undefined) {
    toast(message);
    reload();
  }
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  if (action === "plan-confirm") await changeState(el, "action_confirm", "Rencana dikonfirmasi. Baris anggaran dikunci.");
  else if (action === "plan-draft") await changeState(el, "action_draft", "Rencana dikembalikan ke draft.");
  else if (action === "plan-cancel") await changeState(el, "action_cancel", "Rencana dibatalkan.", "Batalkan rencana anggaran ini? Barisnya tetap tersimpan dan bisa dikembalikan ke draft.");
  else if (action === "plan-copy") {
    const copied = await guarded(el, () => call(PLAN, "copy", { ids: [plan.record.id] }));
    const newId = Array.isArray(copied) ? copied[0] : copied;
    if (newId) {
      toast("Rencana diduplikasi sebagai draft. Sesuaikan nama dan periodenya.");
      location.hash = `#/budgetplan/${newId}`;
    }
  } else if (action === "item-add") openItemDialog(null);
  else if (action === "item-edit") {
    const [item] = await searchRead(ITEM, [["id", "=", id]], ["account_id", "name", "date_from", "date_to", "debit", "credit", "analytic_distribution"], { limit: 1 });
    if (item) openItemDialog(item);
  } else if (action === "item-delete") {
    if (!window.confirm("Hapus baris anggaran ini?")) return;
    const ok = await guarded(el, () => call(ITEM, "unlink", { ids: [id] }));
    if (ok !== undefined) {
      toast("Baris anggaran dihapus.");
      reload();
    }
  } else if (action === "item-save") {
    const message = await guarded(el, saveDialog);
    if (message) {
      closeModal();
      toast(message);
      reload();
    }
  }
}

export function onInput(event, el) {
  if (el.dataset.lookup === "budget-account") {
    if (!dialog) return;
    dialog.account = null;
    paintSideHint();
    runLookup(el, 250);
  } else if (el.dataset.dlg && dialog) setDialogValue(el);
}

export function onChange(event, el) {
  if (el.dataset.bud === "account") {
    const params = new URLSearchParams(last.query);
    if (el.value && el.value !== "0") params.set("account", el.value);
    else params.delete("account");
    const qs = params.toString();
    location.hash = `#/budget/${plan.record.id}${qs ? `?${qs}` : ""}`;
  } else if (el.dataset.dlg && dialog) setDialogValue(el);
}

function setDialogValue(el) {
  const key = el.dataset.dlg;
  if (el.type === "checkbox") dialog[key] = el.checked;
  else if (el.dataset.kind === "id") dialog[key] = el.value ? Number(el.value) : null;
  else dialog[key] = el.value;
  if (key === "side") paintSideHint();
}
