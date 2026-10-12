// Pemilih distribusi analitik bersama (D39): kolom "Analitik" pada baris transaksi dan dialog pengeditannya.
// Nilainya adalah `analytic_distribution` Odoo, mis. {"2": 100} atau {"1,3": 60, "2": 40}: kunci = id akun analitik
// (beberapa akun dari rencana akar berbeda digabung dengan koma), nilai = persen. Modul ini mengurus sendiri klik dan
// input di dialognya (atribut data-an-*), jadi halaman cukup mendaftarkan penangannya lewat registerAnalytic.
import { INPUT, call, closeModal, esc, money, onResetReferences, openModal, searchRead, toast } from "./common.js";

/* ---------- Data referensi (rencana dan akun), dimuat sekali per sesi ---------- */

let cache = null; // Promise<{ plans, accounts, byId }>
let ready = null; // hasil preloadAnalytic yang sudah selesai (dibaca sinkron oleh ringkasan dan dialog)
onResetReferences(() => {
  cache = null;
  ready = null;
});

async function load() {
  const [plans, accounts] = await Promise.all([
    searchRead("account.analytic.plan", [["parent_id", "=", false]], ["name"], { order: "name" }),
    searchRead("account.analytic.account", [], ["name", "display_name", "root_plan_id", "active"], { order: "name", limit: 2000, context: { active_test: false } }),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const used = new Set(accounts.map((a) => a.root_plan_id?.[0]));
  return { plans: plans.filter((p) => used.has(p.id)), accounts, byId };
}

/** Memuat cache; halaman memanggilnya sebelum menggambar baris. Galat (mis. tanpa hak baca) tidak dilempar: kolom tetap tampil dengan nomor akun. */
export async function preloadAnalytic() {
  try {
    cache ??= load().catch((error) => {
      cache = null;
      throw error;
    });
    ready = await cache;
  } catch {
    ready = null;
  }
  return ready;
}
const refs = () => ready;

/* ---------- Nilai distribusi ---------- */

const ids = (key) => String(key).split(",").map(Number).filter(Boolean);
const canonKey = (list) => [...new Set(list)].sort((a, b) => a - b).join(",");
/** Bentuk baku untuk membandingkan dua distribusi (urutan kunci dan urutan id dalam kunci tidak berarti). */
export const canonicalDistribution = (dist) =>
  JSON.stringify(
    Object.entries(dist || {})
      .map(([k, v]) => [canonKey(ids(k)), Number(v)])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  );
export const sameDistribution = (a, b) => canonicalDistribution(a) === canonicalDistribution(b);
/** Salinan distribusi dari Odoo (false berarti kosong). */
export const readDistribution = (value) => (value && typeof value === "object" ? { ...value } : {});
/** Nilai untuk ditulis ke Odoo bila berubah: distribusi, false bila dikosongkan, undefined bila tidak ada perubahan.
 * current undefined = baris belum disentuh; initial undefined = baris baru (apa pun yang dipilih pengguna dikirim). */
export function distributionChange(current, initial) {
  if (current === undefined || current === null) return undefined;
  if (initial !== undefined && sameDistribution(current, initial)) return undefined;
  return Object.keys(current).length ? current : false;
}

const pctText = (v) => `${String(Math.round(Number(v) * 100) / 100).replace(".", ",")}%`;
const accountName = (id) => refs()?.byId.get(id)?.name ?? `#${id}`;

/** Ringkasan teks: nama akun saja bila satu baris 100%, selain itu "akun persen, akun persen". Kosong bila tidak ada. */
export function analyticSummary(dist) {
  const entries = Object.entries(dist || {});
  if (!entries.length) return "";
  const names = (key) => ids(key).map(accountName).join(" + ");
  if (entries.length === 1 && Number(entries[0][1]) === 100) return names(entries[0][0]);
  return entries.map(([key, pct]) => `${names(key)} ${pctText(pct)}`).join(", ");
}

/* ---------- Sel tabel ---------- */

const handlers = {};
/** Penangan per halaman: get(key) mengembalikan distribusi baris, set(key, dist) menyimpannya ke status halaman dan menggambar ulang. */
export const registerAnalytic = (scope, def) => {
  handlers[scope] = def;
};

/** Isi sel kolom Analitik. editable=false menampilkan teks saja (dokumen terkunci). */
export function analyticCell(scope, key, dist, editable = true) {
  const text = analyticSummary(dist);
  if (!editable) return `<span class="text-sm text-gray-700" title="${esc(text)}">${esc(text || "-")}</span>`;
  return `<button type="button" data-an-open="${esc(scope)}" data-an-key="${esc(key)}" title="${esc(text || "Pilih akun analitik")}"
    class="w-full min-w-40 max-w-64 text-left border border-gray-300 rounded-lg px-3 py-2 text-sm truncate hover:bg-gray-50 ${text ? "text-gray-800" : "text-gray-400"}">${esc(text || "Pilih analitik...")}</button>`;
}

/* ---------- Dialog ---------- */

let dlg = null; // { scope, key, label, rows: [{ sel: {planId: accountId}, extra: [id], pct }], seq }

function parseRows(dist) {
  const data = refs();
  return Object.entries(dist || {}).map(([key, pct]) => {
    const sel = {};
    const extra = [];
    for (const id of ids(key)) {
      const plan = data?.byId.get(id)?.root_plan_id?.[0];
      if (plan && sel[plan] === undefined) sel[plan] = id;
      else extra.push(id);
    }
    return { sel, extra, pct: String(pct) };
  });
}

const rowKey = (row) => canonKey([...Object.values(row.sel).map(Number), ...row.extra]);
const rowAccounts = (row) => ids(rowKey(row));

/** Menghitung hasil dialog: { error } atau { dist, total }. Baris yang sama digabung dengan menjumlahkan persennya. */
function collect() {
  const dist = {};
  let total = 0;
  for (const [i, row] of dlg.rows.entries()) {
    const key = rowKey(row);
    const pct = row.pct === "" ? NaN : Number(row.pct);
    if (!key && (row.pct === "" || pct === 0)) continue; // baris kosong diabaikan
    if (!key) return { error: `Baris ${i + 1}: pilih minimal satu akun analitik.` };
    if (!(pct > 0)) return { error: `Baris ${i + 1}: persentase harus lebih dari 0.` };
    dist[key] = (dist[key] ?? 0) + pct;
    total += pct;
  }
  total = Math.round(total * 1e6) / 1e6;
  if (total > 100.0001) return { error: `Total persentase ${pctText(total)} melebihi 100%.`, total };
  return { dist, total };
}

function totalHtml() {
  const result = collect();
  const sum = dlg.rows.reduce((s, r) => s + (Number(r.pct) || 0), 0);
  const shown = result.total ?? Math.round(sum * 1e6) / 1e6;
  if (result.error) return `<span class="text-rose-600">${esc(result.error)}</span>`;
  if (!dlg.rows.length) return '<span class="text-gray-500">Tanpa distribusi analitik.</span>';
  if (shown < 99.9999) return `<span class="text-amber-700">Total ${esc(pctText(shown))}: sisa ${esc(pctText(100 - shown))} tidak dibebankan ke akun analitik mana pun.</span>`;
  return `<span class="text-emerald-700">Total ${esc(pctText(shown))}.</span>`;
}

function bodyHtml() {
  const data = refs();
  if (!data) return '<p class="text-sm text-rose-600">Daftar akun analitik tidak dapat dimuat. Pastikan Anda punya hak Analytic Accounting.</p>';
  if (!data.plans.length) return '<p class="text-sm text-gray-600">Belum ada akun analitik. Buat dulu di <a href="#/analytic" class="text-indigo-600 underline">Analytic Account</a>.</p>';
  const head = `<tr>${data.plans.map((p) => `<th class="pb-2 pr-2 text-xs font-semibold text-gray-600 uppercase">${esc(p.name)}</th>`).join("")}
    <th class="pb-2 pr-2 text-xs font-semibold text-gray-600 uppercase text-right w-28">Persen</th><th class="w-8"></th></tr>`;
  const rows = dlg.rows
    .map((row, i) => {
      const cells = data.plans
        .map((p) => {
          const chosen = row.sel[p.id] ?? "";
          const options = data.accounts.filter((a) => a.root_plan_id?.[0] === p.id && (a.active || a.id === chosen));
          return `<td class="py-1 pr-2"><select data-an-plan="${p.id}" data-an-row="${i}" class="${INPUT} min-w-36" aria-label="${esc(p.name)} baris ${i + 1}">
            <option value="">-</option>${options.map((a) => `<option value="${a.id}" ${a.id === chosen ? "selected" : ""}>${esc(a.name)}${a.active ? "" : " (arsip)"}</option>`).join("")}</select></td>`;
        })
        .join("");
      const extra = row.extra.length ? `<div class="text-xs text-gray-500 mt-1">Akun lain dipertahankan: ${esc(row.extra.map(accountName).join(", "))}</div>` : "";
      return `<tr class="align-top">${cells}
        <td class="py-1 pr-2"><input type="number" min="0" max="100" step="any" data-an-pct data-an-row="${i}" value="${esc(row.pct)}" class="${INPUT} text-right" aria-label="Persen baris ${i + 1}">${extra}</td>
        <td class="py-1"><button type="button" data-an-act="del" data-an-row="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris ${i + 1}"><i class="fas fa-trash-alt"></i></button></td></tr>`;
    })
    .join("");
  return `${dlg.label ? `<p class="text-sm text-gray-500">${esc(dlg.label)}</p>` : ""}
    <div class="overflow-x-auto"><table class="w-full text-left"><thead>${head}</thead><tbody>${rows}</tbody></table></div>
    <button type="button" data-an-act="add" class="text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>
    <div id="an-total" class="text-sm">${totalHtml()}</div>
    <div id="an-budget" class="text-sm text-gray-600 space-y-1"></div>`;
}

const footHtml = (disabled) => `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
  <button data-an-act="save" ${disabled ? "disabled" : ""} class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">Terapkan</button>`;

function paint() {
  const data = refs();
  openModal("Distribusi Analitik", bodyHtml(), footHtml(!data?.plans.length), () => {
    dlg = null;
  }, { wide: (data?.plans.length ?? 0) > 1 });
  refreshBudget();
}

async function openDialog(scope, key) {
  const handler = handlers[scope];
  if (!handler) return;
  await preloadAnalytic();
  const dist = handler.get(key);
  dlg = { scope, key, label: handler.label?.(key) ?? "", rows: parseRows(dist), seq: 0 };
  paint();
}

/* ---------- Informasi anggaran ---------- */

/** Anggaran terkonfirmasi (mis_builder_budget) untuk akun terpilih, dengan realisasi dari baris analitik dan tautan ke Budget Report. */
async function budgetLines(accountIds) {
  const items = await searchRead(
    "mis.budget.by.account.item",
    [["analytic_distribution", "in", accountIds], ["budget_id.state", "=", "confirmed"]],
    ["budget_id", "account_id", "debit", "credit", "analytic_distribution"],
  );
  const lines = [];
  for (const accountId of accountIds) {
    const mine = items.filter((it) => Object.keys(it.analytic_distribution || {}).some((k) => ids(k).includes(accountId)));
    const plans = [...new Set(mine.map((it) => it.budget_id[0]))];
    for (const planId of plans) {
      const planItems = mine.filter((it) => it.budget_id[0] === planId);
      const [plan] = await call("mis.budget.by.account", "read", { ids: [planId], fields: ["name", "date_from", "date_to"] });
      const budget = planItems.reduce((s, it) => s + it.debit - it.credit, 0);
      const [sum] = await call("account.analytic.line", "formatted_read_group", {
        domain: [["account_id", "=", accountId], ["general_account_id", "in", [...new Set(planItems.map((it) => it.account_id[0]))]], ["date", ">=", plan.date_from], ["date", "<=", plan.date_to]],
        groupby: [],
        aggregates: ["amount:sum"],
      });
      const actual = -(sum?.["amount:sum"] ?? 0) || 0; // || 0 mengubah -0 menjadi 0
      lines.push({ accountId, planId, plan: plan.name, budget, actual });
    }
  }
  return lines;
}

async function refreshBudget() {
  const current = dlg;
  const box = document.querySelector("#an-budget");
  if (!current || !box) return;
  const mine = ++current.seq;
  const accountIds = [...new Set(current.rows.flatMap(rowAccounts))];
  if (!accountIds.length) {
    box.innerHTML = "";
    return;
  }
  let lines;
  try {
    lines = await budgetLines(accountIds);
  } catch {
    return; // modul anggaran tidak ada atau tanpa hak baca: informasi dilewati
  }
  if (dlg !== current || current.seq !== mine) return;
  const text = lines.length
    ? lines
        .map(
          (l) => `<div><span class="font-medium">${esc(accountName(l.accountId))}</span> · anggaran "${esc(l.plan)}" ${esc(money(l.budget))}, realisasi ${esc(money(l.actual))},
            <span class="${l.budget - l.actual < 0 ? "text-rose-600" : "text-emerald-700"}">sisa ${esc(money(l.budget - l.actual))}</span>
            <a href="#/budgetreport/${l.planId}?analytic=${l.accountId}" class="text-indigo-600 underline">Lihat Budget Report</a></div>`,
        )
        .join("") + '<div class="text-xs text-gray-400">Anggaran terkonfirmasi (biaya dikurangi pendapatan) dan realisasi dari baris analitik dalam periode rencana.</div>'
    : '<div class="text-xs text-gray-400">Akun terpilih belum dipakai pada anggaran yang dikonfirmasi.</div>';
  box.innerHTML = text;
}

/* ---------- Acara dialog ---------- */

const updateTotal = () => {
  const box = document.querySelector("#an-total");
  if (box) box.innerHTML = totalHtml();
};

document.addEventListener("click", async (event) => {
  const open = event.target.closest("[data-an-open]");
  if (open) {
    await openDialog(open.dataset.anOpen, open.dataset.anKey);
    return;
  }
  const el = event.target.closest("[data-an-act]");
  if (!el || !dlg) return;
  const act = el.dataset.anAct;
  if (act === "add") {
    const used = dlg.rows.reduce((s, r) => s + (Number(r.pct) || 0), 0);
    dlg.rows.push({ sel: {}, extra: [], pct: String(Math.max(0, Math.round((100 - used) * 1e6) / 1e6)) });
    paint();
  } else if (act === "del") {
    dlg.rows.splice(Number(el.dataset.anRow), 1);
    paint();
  } else if (act === "save") {
    const result = collect();
    if (result.error) {
      toast(result.error, "error");
      return;
    }
    const { scope, key } = dlg;
    closeModal();
    handlers[scope]?.set(key, result.dist);
  }
});

document.addEventListener("change", (event) => {
  const el = event.target;
  if (!dlg || el.dataset.anPlan === undefined) return;
  const row = dlg.rows[Number(el.dataset.anRow)];
  if (!row) return;
  if (el.value) row.sel[el.dataset.anPlan] = Number(el.value);
  else delete row.sel[el.dataset.anPlan];
  updateTotal();
  refreshBudget();
});

document.addEventListener("input", (event) => {
  const el = event.target;
  if (!dlg || el.dataset.anPct === undefined) return;
  const row = dlg.rows[Number(el.dataset.anRow)];
  if (row) row.pct = el.value;
  updateTotal();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && dlg && event.target.dataset?.anPct !== undefined) {
    event.preventDefault();
    document.querySelector("[data-an-act=save]")?.click();
  }
});
