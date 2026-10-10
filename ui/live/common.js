// Bagian bersama UI Nusara: pembantu tampilan, sesi, kotak saran, dialog, dan chatter.
import { OdooError, auth, call, readOne, searchRead } from "./odoo.js";

export const app = document.querySelector("#app");
const sessionBox = document.querySelector("#session");
const toastBox = document.querySelector("#toast");

export const ctx = { user: null, company: null, flags: {}, multiCompany: false, users: null };

let reroute = () => {};
export const setReroute = (fn) => {
  reroute = fn;
};

/* ---------- Format dan tampilan ---------- */

/* Warna lencana mengikuti dekorasi tampilan Odoo: success, muted, warning, danger, info. */
export const TONE = {
  success: "bg-emerald-100 text-emerald-800",
  muted: "bg-slate-100 text-slate-600",
  warning: "bg-amber-100 text-amber-800",
  danger: "bg-rose-100 text-rose-800",
  info: "bg-sky-100 text-sky-800",
};
export const INPUT = "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";
const BUTTON = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700",
  plain: "bg-white text-gray-700 border border-gray-300 hover:bg-gray-50",
  danger: "bg-white text-rose-600 border border-rose-300 hover:bg-rose-50",
  success: "bg-emerald-600 text-white hover:bg-emerald-700",
};

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const money = (n, currency = ctx.company?.currency_id?.[1] ?? "IDR") =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency, maximumFractionDigits: 0 }).format(n ?? 0);

const pad = (n) => String(n).padStart(2, "0");

/** Tanggal Odoo: "YYYY-MM-DD" (tanggal lokal) atau "YYYY-MM-DD HH:MM:SS" (UTC). */
export function parseOdooDate(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length === 10) {
    const [y, m, d] = text.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  return new Date(/[zZ]$/.test(text) ? text : `${text.replace(" ", "T")}Z`);
}
export const dateText = (v) => {
  const d = parseOdooDate(v);
  return d ? d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) : "-";
};
export const dateTimeText = (v) => {
  const d = parseOdooDate(v);
  return d ? d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "-";
};
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
/** Nilai Odoo (UTC) ke <input type="datetime-local"> (waktu setempat), dan sebaliknya. */
export function toInputDateTime(value) {
  const d = parseOdooDate(value);
  return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
}
export function fromInputDateTime(value) {
  if (!value) return false;
  const d = new Date(value);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
}
export const plain = (html) => new DOMParser().parseFromString(html || "", "text/html").body.textContent.trim();

export const badge = (map, key) => {
  const [label, tone] = map[key] ?? [key, "muted"];
  return `<span class="px-2 py-1 rounded-full text-xs font-medium ${TONE[tone]}">${esc(label)}</span>`;
};
export const fieldBlock = (label, content) =>
  `<div><div class="text-xs font-medium text-gray-500 uppercase tracking-wide">${esc(label)}</div>${content}</div>`;
export const readonlyValue = (v) =>
  `<div class="py-2 text-sm font-medium text-gray-900">${v ? esc(v) : '<span class="text-gray-400">-</span>'}</div>`;

/** Tombol dengan atribut data-*; kind: primary | plain | danger | success. */
export function button(action, label, kind = "plain", data = {}) {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(v)}"`).join(" ");
  return `<button data-action="${action}" ${attrs} class="px-4 py-2 rounded-lg text-sm font-medium ${BUTTON[kind]}">${esc(label)}</button>`;
}

/** Bilah tombol header: defs = [{ action, label, kind, show(rec) }]. */
export function actionBar(defs, record) {
  return defs
    .filter((d) => d.show(record))
    .map((d) => button(d.action, d.label, d.kind ?? "plain", { id: record.id }))
    .join("");
}

/** Bilah status: flow berisi urutan, status di luar urutan ditambahkan di akhir. */
export function statusbar(flow, labels, state) {
  const steps = flow.includes(state) ? flow : [...flow, state];
  const at = flow.indexOf(state);
  return `<div class="inline-flex">${steps
    .map((s, i) => {
      const current = s === state;
      const tone = labels[s]?.[1];
      const cls = current
        ? tone === "danger" ? "bg-rose-600 text-white" : "bg-indigo-600 text-white"
        : at > i ? "bg-indigo-100 text-indigo-800" : "bg-gray-100 text-gray-500";
      return `<span class="px-3 py-1.5 text-xs font-semibold ${cls} ${i === 0 ? "rounded-l-lg" : ""} ${i === steps.length - 1 ? "rounded-r-lg" : ""}">${esc(labels[s]?.[0] ?? s)}</span>`;
    })
    .join("")}</div>`;
}

/** Tombol statistik ala Odoo; tampil hanya bila jumlahnya lebih dari nol. */
export function statTiles(tiles) {
  return tiles
    .filter((t) => t.count > 0)
    .map((t) => {
      const inner = `<i class="fas ${t.icon} text-gray-400"></i><div><div class="text-base font-semibold leading-none">${esc(t.count)}</div><div class="text-xs text-gray-500">${esc(t.label)}</div></div>`;
      const cls = "flex items-center gap-3 border border-gray-200 bg-white rounded-lg px-4 py-2";
      if (t.href) return `<a href="${esc(t.href)}" class="${cls} hover:bg-gray-50">${inner}</a>`;
      if (t.target) return `<a href="#" data-action="scroll" data-target="${esc(t.target)}" class="${cls} hover:bg-gray-50">${inner}</a>`;
      return `<div class="${cls}">${inner}</div>`;
    })
    .join("");
}

/** Tabel sederhana; headers = [{ label, right }]. */
export function table(headers, rowsHtml, emptyText) {
  const head = headers
    .map((h) => `<th class="py-3 px-4 text-xs font-semibold text-gray-600 uppercase tracking-wider ${h.right ? "text-right" : ""}">${esc(h.label)}</th>`)
    .join("");
  const body = rowsHtml || `<tr><td colspan="${headers.length}" class="py-10 text-center text-sm text-gray-500">${esc(emptyText)}</td></tr>`;
  return `<div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
    <table class="w-full text-left"><thead class="bg-gray-50 border-b border-gray-200"><tr>${head}</tr></thead>
    <tbody class="divide-y divide-gray-200">${body}</tbody></table></div>`;
}

export const rowLink = (href, cells) =>
  `<tr class="hover:bg-gray-50 cursor-pointer" data-action="goto" data-href="${esc(href)}">${cells.join("")}</tr>`;
export const cell = (content, { right = false, strong = false, raw = false } = {}) =>
  `<td class="py-3 px-4 text-sm ${right ? "text-right" : ""} ${strong ? "font-medium text-indigo-700" : "text-gray-700"}">${raw ? content : esc(content)}</td>`;

export const searchBox = (value, placeholder = "Cari...") =>
  `<input data-change="search" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}"
    class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white w-48 focus:outline-none focus:ring-2 focus:ring-indigo-500">`;
export const checkboxField = (key, label, checked, extra = "") =>
  `<label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-value="${esc(key)}" ${checked ? "checked" : ""} ${extra} class="rounded border-gray-300 text-indigo-600"> ${esc(label)}</label>`;
/** Nilai field form menurut jenisnya: data-kind = id | bool | number, atau checkbox, atau teks. */
export function fieldValue(el) {
  if (el.type === "checkbox") return el.checked;
  if (el.dataset.kind === "id") return el.value ? Number(el.value) : null;
  if (el.dataset.kind === "bool") return el.value === "true";
  if (el.dataset.kind === "number") return el.value === "" ? "" : Number(el.value);
  return el.value;
}
export const idList = (text) => String(text ?? "").split(",").map(Number).filter(Boolean);

export function pageHeader(title, controlsHtml = "") {
  return `<div class="flex flex-col md:flex-row md:items-center justify-between mb-4 gap-3">
    <h1 class="text-2xl font-bold text-gray-900">${esc(title)}</h1><div class="flex flex-wrap gap-2">${controlsHtml}</div></div>`;
}
export function filterSelect(options, selected) {
  return `<select data-change="filter" class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white">${options
    .map(([k, label]) => `<option value="${esc(k)}" ${k === selected ? "selected" : ""}>${esc(label)}</option>`)
    .join("")}</select>`;
}
export function selectOptions(rows, selected, blank) {
  return (blank ? [`<option value="">${esc(blank)}</option>`] : [])
    .concat(rows.map((r) => `<option value="${r.id}" ${r.id === selected ? "selected" : ""}>${esc(r.display_name)}</option>`))
    .join("");
}

/* ---------- Pemberitahuan dan penanganan galat ---------- */

export function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `${kind === "error" ? "bg-rose-600" : "bg-emerald-600"} text-white text-sm rounded-lg shadow-lg px-4 py-3`;
  el.textContent = message;
  toastBox.append(el);
  setTimeout(() => el.remove(), kind === "error" ? 8000 : 3500);
}

/** Hanya field yang berubah yang dikirim ke Odoo: menulis ulang nilai yang sama dapat memicu hitung ulang (lihat D10). */
export function changedValues(current, initial, keys) {
  const changed = {};
  for (const key of keys) {
    if (JSON.stringify(current[key] ?? null) !== JSON.stringify(initial?.[key] ?? null)) changed[key] = current[key];
  }
  return changed;
}

/** Menjalankan tugas dengan tombol dinonaktifkan; galat ditampilkan, hasil undefined bila gagal. */
export async function guarded(button, task) {
  if (button) button.disabled = true;
  try {
    return await task();
  } catch (error) {
    if (error instanceof OdooError && error.status === 401) {
      auth.clear();
      ctx.user = null;
      toast(error.message, "error");
      reroute();
      return undefined;
    }
    toast(error.message || "Terjadi kesalahan.", "error");
    return undefined;
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}

/* ---------- Sesi dan navigasi ---------- */

export async function loadSession() {
  const { uid } = await call("res.users", "context_get");
  const user = await readOne("res.users", uid, ["name", "company_id"]);
  const company = await readOne("res.company", user.company_id[0], ["name", "currency_id"]);
  const has = (group) => call("res.users", "has_group", { ids: [uid], group_ext_id: group }).then(Boolean);
  const [prManager, purchaseManager, stockUser, companyCount] = await Promise.all([
    has("purchase_request.group_purchase_request_manager"),
    has("purchase.group_purchase_manager"),
    has("stock.group_stock_user"),
    call("res.company", "search_count", { domain: [] }),
  ]);
  Object.assign(ctx, { user, company, flags: { prManager, purchaseManager, stockUser }, multiCompany: companyCount > 1, users: null });
}

export async function referenceUsers() {
  ctx.users ??= await searchRead("res.users", [["share", "=", false]], ["display_name"], { order: "name", limit: 100 });
  return ctx.users;
}

/** Data referensi yang jarang berubah dimuat sekali per sesi. */
const refCache = {};
const reference = (key, loader) =>
  (refCache[key] ??= loader().catch((error) => {
    delete refCache[key]; // jangan simpan kegagalan: muat ulang pada pemanggilan berikutnya
    throw error;
  }));
export const resetReferences = () => {
  for (const key of Object.keys(refCache)) delete refCache[key];
};
export const referenceTerms = () => reference("terms", () => searchRead("account.payment.term", [], ["display_name"], { limit: 50 }));
export const referenceCurrencies = () => reference("currencies", () => searchRead("res.currency", [["active", "=", true]], ["display_name"], { order: "name" }));
export const referenceCountries = () => reference("countries", () => searchRead("res.country", [], ["display_name", "code"], { order: "name" }));
export const referenceCategories = () => reference("categories", () => searchRead("product.category", [], ["display_name"], { order: "complete_name" }));
export const referenceUoms = () => reference("uoms", () => searchRead("uom.uom", [], ["display_name"], { order: "name", limit: 100 }));
/** Profil aset (OCA account_asset_management); null bila modul tidak terpasang. */
export const referenceAssetProfiles = () =>
  reference("asset-profiles", () => searchRead("account.asset.profile", [], ["display_name"], { order: "name" }).catch(() => null));
export const referencePayableAccounts = () =>
  reference("payable-accounts", () => searchRead("account.account", [["account_type", "=", "liability_payable"]], ["display_name"], { order: "code" }));
export const referenceFiscalPositions = () => reference("fiscal-positions", () => searchRead("account.fiscal.position", [], ["display_name"], { order: "sequence, name" }));
export const referenceJournals = (type) => reference(`journals-${type}`, () => searchRead("account.journal", [["type", "=", type]], ["display_name"], { order: "sequence, code" }));
/** Id kategori bawaan Odoo (Goods dan Services) menurut xml id, bukan nama, karena nama bisa diterjemahkan. */
export const referenceDefaultCategories = () =>
  reference("default-categories", async () => {
    const rows = await searchRead("ir.model.data", [["module", "=", "product"], ["name", "in", ["product_category_goods", "product_category_services"]]], ["name", "res_id"]);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.res_id]));
    return { goods: byName.product_category_goods ?? null, services: byName.product_category_services ?? null };
  });
export const referencePricelists = () => reference("pricelists", () => searchRead("product.pricelist", [], ["display_name"], { order: "name" }));
export const referenceTaxes = (type) => reference(`taxes-${type}`, () => searchRead("account.tax", [["type_tax_use", "=", type]], ["display_name"], { order: "sequence, id" }));
export const referenceSelection = (model, field) =>
  reference(`sel-${model}-${field}`, async () => {
    const info = await call(model, "fields_get", { allfields: [field], attributes: ["selection"] });
    return info[field]?.selection ?? [];
  });

export function renderSession() {
  if (!ctx.user) {
    sessionBox.innerHTML = '<span class="text-sm text-gray-400">Belum terhubung</span>';
    return;
  }
  const initials = ctx.user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  sessionBox.innerHTML = `<span class="h-8 w-8 rounded-full bg-indigo-600 text-white text-xs font-semibold flex items-center justify-center border border-gray-200" aria-hidden="true">${esc(initials)}</span>
    <div class="ml-3 hidden md:block"><p class="text-sm font-medium text-gray-700">${esc(ctx.user.name)}</p><p class="text-xs text-gray-500">${esc(ctx.company.name)}</p></div>
    <button data-action="disconnect" class="ml-4 text-xs text-gray-400 hover:text-gray-700 underline">Putus</button>`;
}

export function renderConnect() {
  app.innerHTML = `
    <section class="bg-white border border-gray-200 rounded-xl shadow-sm p-6 max-w-xl mx-auto mt-8">
      <h1 class="text-xl font-bold text-gray-900">Hubungkan ke Odoo</h1>
      <p class="text-sm text-gray-600 mt-2">Halaman ini bertransaksi langsung ke Odoo memakai API key milik Anda sendiri.</p>
      <ol class="text-sm text-gray-600 mt-4 list-decimal ml-5 space-y-1">
        <li>Di Odoo, klik nama Anda di pojok kanan atas, lalu <b>Preferences</b>.</li>
        <li>Buka tab <b>Account Security</b>, klik <b>New API Key</b>, beri nama bebas.</li>
        <li>Salin key yang tampil (hanya muncul sekali), lalu tempel di bawah.</li>
      </ol>
      <form data-form="connect" class="mt-5 space-y-3">
        <label class="block text-sm font-medium text-gray-700" for="apikey">API key</label>
        <input id="apikey" type="password" autocomplete="off" required class="${INPUT}">
        <button class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Hubungkan</button>
        <p class="text-xs text-gray-500">Key disimpan hanya selama tab ini terbuka dan hilang saat tab ditutup.</p>
      </form>
    </section>`;
}

/* ---------- Dialog ---------- */

const modalRoot = document.createElement("div");
modalRoot.id = "modal";
modalRoot.className = "hidden fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-auto";
document.body.append(modalRoot);

let modalOnClose = null;
export function openModal(title, bodyHtml, footerHtml, onClose = null, { wide = false } = {}) {
  modalOnClose = onClose;
  modalRoot.innerHTML = `<div class="bg-white rounded-xl shadow-xl w-full ${wide ? "max-w-5xl" : "max-w-lg"} mt-16" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="px-5 py-4 border-b border-gray-200 font-semibold text-gray-900">${esc(title)}</div>
    <div class="p-5 space-y-4" id="modal-body">${bodyHtml}</div>
    <div class="px-5 py-3 border-t border-gray-200 flex flex-wrap justify-end gap-2" id="modal-foot">${footerHtml}</div></div>`;
  modalRoot.classList.remove("hidden");
}
/** Menutup dialog; onClose (bila ada) dipanggil agar proses yang menunggu dialog tidak menggantung. */
export function closeModal() {
  const callback = modalOnClose;
  modalOnClose = null;
  modalRoot.classList.add("hidden");
  modalRoot.innerHTML = "";
  callback?.();
}
export const modalOpen = () => !modalRoot.classList.contains("hidden");

/* ---------- Kotak saran (autocomplete) ----------
 * Pengganti <datalist>, yang popup-nya tidak tampil di semua browser (mis. browser tertanam).
 * Satu menu berposisi fixed agar tidak terpotong tabel yang dapat digulir. Terbuka saat field
 * difokuskan, difilter saat mengetik, dan dapat dipilih dengan klik atau keyboard.
 * Setiap halaman mendaftarkan jenisnya: { search(q), sub?(item), isChosen(input), choose(input, item) }.
 */
const menu = document.createElement("div");
menu.id = "lookup-menu";
menu.setAttribute("role", "listbox");
menu.className = "hidden fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg max-h-64 overflow-auto text-sm";
document.body.append(menu);

const lookupKinds = {};
export const registerLookup = (kind, def) => {
  lookupKinds[kind] = def;
};
let lookup = null; // { input, def, items, active, seq, loading }
let lookupTimer;

export function closeLookup() {
  lookup = null;
  menu.classList.add("hidden");
}

function paintMenu() {
  if (!lookup) return;
  menu.innerHTML = lookup.items.length
    ? lookup.items
        .map(
          (it, i) => `<div role="option" data-lookup-item="${i}" class="px-3 py-2 cursor-pointer flex justify-between gap-4 hover:bg-indigo-50 ${i === lookup.active ? "bg-indigo-50" : ""}">
            <span>${esc(it.display_name)}</span><span class="text-gray-400 text-xs">${esc(lookup.def.sub?.(it) ?? "")}</span></div>`,
        )
        .join("")
    : `<div class="px-3 py-2 text-gray-500">${lookup.loading ? "Mencari..." : "Tidak ada hasil"}</div>`;
  const box = lookup.input.getBoundingClientRect();
  Object.assign(menu.style, { left: `${box.left}px`, top: `${box.bottom + 4}px`, minWidth: `${Math.max(box.width, 280)}px` });
  menu.classList.remove("hidden");
}

export function runLookup(input, delay = 0) {
  const def = lookupKinds[input.dataset.lookup];
  if (!def) return;
  if (!lookup || lookup.input !== input) lookup = { input, def, items: [], active: -1, seq: 0, loading: true };
  const current = lookup;
  const mine = ++current.seq;
  current.loading = true;
  paintMenu();
  clearTimeout(lookupTimer);
  lookupTimer = setTimeout(async () => {
    try {
      const items = await def.search(def.isChosen(input) ? "" : input.value.trim(), input);
      if (lookup !== current || current.seq !== mine) return; // jawaban usang
      current.items = items;
      current.active = items.length ? 0 : -1;
    } catch (error) {
      if (lookup !== current) return;
      current.items = [];
      toast(error.message, "error");
    }
    current.loading = false;
    paintMenu();
  }, delay);
}

function chooseItem(index) {
  const item = lookup?.items[index];
  if (!item) return;
  const { input, def } = lookup;
  closeLookup();
  def.choose(input, item);
}

menu.addEventListener("mousedown", (event) => {
  event.preventDefault(); // jaga fokus tetap di field sampai pilihan diproses
  const item = event.target.closest("[data-lookup-item]");
  if (item) chooseItem(Number(item.dataset.lookupItem));
});
window.addEventListener("resize", closeLookup);
window.addEventListener(
  "scroll",
  (event) => {
    if (!menu.contains(event.target)) closeLookup();
  },
  true,
);
document.addEventListener("focusin", (event) => {
  if (event.target.dataset?.lookup) runLookup(event.target);
});
document.addEventListener("focusout", (event) => {
  if (!event.target.dataset?.lookup) return;
  setTimeout(() => {
    if (lookup && document.activeElement !== lookup.input) closeLookup();
  }, 120);
});
document.addEventListener("keydown", (event) => {
  const el = event.target;
  if (!el.dataset?.lookup) return;
  if (!lookup || lookup.input !== el) {
    if (event.key === "ArrowDown") runLookup(el);
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const count = lookup.items.length;
    if (count) {
      lookup.active = (lookup.active + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
      paintMenu();
      menu.children[lookup.active]?.scrollIntoView({ block: "nearest" });
    }
  } else if (event.key === "Enter") {
    event.preventDefault(); // jangan mengirim form; Enter memilih saran yang aktif
    chooseItem(lookup.active);
  } else if (event.key === "Escape") {
    closeLookup();
  }
});

/** Pencarian akun untuk kotak saran: kode atau nama, opsional dibatasi jenis akun. */
export const searchAccounts = (query, types = null) =>
  searchRead(
    "account.account",
    [...(types ? [["account_type", "in", types]] : []), ...(query ? ["|", ["code", "ilike", query], ["name", "ilike", query]] : [])],
    ["display_name", "account_type"],
    { limit: 10, order: "code" },
  );
export const ACCOUNT_TYPE_LABELS = {
  expense: "Beban", expense_direct_cost: "Beban Pokok", expense_other: "Beban Lain", expense_depreciation: "Penyusutan", asset_fixed: "Aset Tetap",
  asset_current: "Aset Lancar", asset_non_current: "Aset Tidak Lancar", asset_prepayments: "Biaya Dibayar Dimuka", liability_current: "Kewajiban Lancar",
  liability_payable: "Hutang", asset_receivable: "Piutang", asset_cash: "Kas dan Bank", income: "Pendapatan", income_other: "Pendapatan Lain",
};

/* ---------- Item jurnal ---------- */

/** Baris jurnal (account.move.line) sebuah entri: dipakai tagihan dan pembayaran untuk memperlihatkan jurnal yang tercipta. */
export const loadJournalItems = (moveId) =>
  moveId
    ? searchRead("account.move.line", [["move_id", "=", moveId]], ["account_id", "name", "partner_id", "debit", "credit", "matching_number"], { order: "id" })
    : Promise.resolve([]);

export function journalHtml(items, currency, { title = "Item Jurnal", journal = "", state = "" } = {}) {
  if (!items.length) return "";
  const debit = items.reduce((sum, l) => sum + l.debit, 0);
  const credit = items.reduce((sum, l) => sum + l.credit, 0);
  const balanced = Math.abs(debit - credit) < 0.005;
  const rows = items
    .map(
      (l) => `<tr>
        <td class="py-2 px-4 text-sm">${esc(l.account_id?.[1])}</td>
        <td class="py-2 px-4 text-sm">${esc(l.name || "")}</td>
        <td class="py-2 px-4 text-sm">${esc(l.partner_id?.[1] ?? "")}</td>
        <td class="py-2 px-4 text-sm text-right">${l.debit ? money(l.debit, currency) : ""}</td>
        <td class="py-2 px-4 text-sm text-right">${l.credit ? money(l.credit, currency) : ""}</td>
        <td class="py-2 px-4 text-sm text-gray-500">${esc(l.matching_number || "")}</td>
      </tr>`,
    )
    .join("");
  const meta = [journal, state === "draft" ? "belum diposting" : ""].filter(Boolean).join(" · ");
  return `<section id="journal-items" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
    <div class="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
      <span class="text-sm font-semibold">${esc(title)}${meta ? ` <span class="font-normal text-gray-500">(${esc(meta)})</span>` : ""}</span>
      <span class="text-xs font-medium ${balanced ? "text-emerald-600" : "text-rose-600"}">${balanced ? "Seimbang" : "Tidak seimbang"}</span>
    </div>
    <table class="w-full text-left"><thead class="bg-gray-50"><tr>${["Akun", "Label", "Mitra", "Debit", "Kredit", "Rekonsiliasi"]
      .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i === 3 || i === 4 ? "text-right" : ""}">${h}</th>`)
      .join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${rows}</tbody>
      <tfoot class="bg-gray-50 font-semibold"><tr><td colspan="3" class="py-2 px-4 text-sm">Total</td>
        <td class="py-2 px-4 text-sm text-right">${money(debit, currency)}</td><td class="py-2 px-4 text-sm text-right">${money(credit, currency)}</td><td></td></tr></tfoot></table>
  </section>`;
}

/* ---------- Chatter ---------- */

export function chatterHtml(model, id) {
  return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
    <div class="text-sm font-semibold mb-3">Catatan dan riwayat</div>
    <form data-form="note" data-model="${esc(model)}" data-id="${id}" class="flex gap-2 mb-4">
      <input name="note" placeholder="Tambah catatan internal..." class="${INPUT}" required>
      <button class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50 whitespace-nowrap">Catat</button>
    </form>
    <div id="messages" class="space-y-3 text-sm text-gray-500">Memuat...</div></section>`;
}

export async function loadMessages(model, id) {
  const box = document.querySelector("#messages");
  if (!box) return;
  try {
    const rows = await searchRead(
      "mail.message",
      [["model", "=", model], ["res_id", "=", id], ["message_type", "in", ["comment", "notification"]]],
      ["author_id", "date", "body", "message_type"],
      { order: "id desc", limit: 30 },
    );
    box.innerHTML = rows.length
      ? rows
          .map((m) => {
            const text = plain(m.body);
            return `<div class="border-l-2 ${m.message_type === "comment" ? "border-indigo-300" : "border-gray-200"} pl-3">
              <div class="text-xs text-gray-500">${esc(m.author_id?.[1] ?? "Sistem")} · ${esc(dateTimeText(m.date))}</div>
              <div class="text-gray-800">${text ? esc(text) : '<span class="text-gray-400">Perubahan data tercatat</span>'}</div></div>`;
          })
          .join("")
      : "Belum ada catatan.";
  } catch {
    box.textContent = "Riwayat tidak dapat dimuat.";
  }
}

export async function postNote(form, submitButton) {
  const { model } = form.dataset;
  const id = Number(form.dataset.id);
  const field = form.elements.note;
  const ok = await guarded(submitButton, () =>
    call(model, "message_post", { ids: [id], body: field.value, message_type: "comment", subtype_xmlid: "mail.mt_note" }),
  );
  if (ok !== undefined) {
    field.value = "";
    loadMessages(model, id);
  }
}

export { OdooError, auth, call, readOne, searchRead };
