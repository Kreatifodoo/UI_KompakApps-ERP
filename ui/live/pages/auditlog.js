// Audit Log (OCA auditlog): jejak siapa mengubah apa dan kapan, dengan nilai lama dan baru. Tab "Log Perubahan" menampilkan log beserta
// rincian perubahan per field; tab "Aturan Audit" memilih model mana yang diaudit (aturan diaktifkan dengan set_to_confirmed dan
// dinonaktifkan dengan set_to_draft, bukan subscribe) dan mengatur penghapusan log lama lewat cron auto-vacuum.
import {
  INPUT, app, badge, call, cell, dateTimeText, esc, fieldBlock, fromInputDateTime, guarded, openModal, pageHeader, referenceUsers,
  registerLookup, runLookup, searchRead, selectOptions, table, toast,
} from "../common.js";

const METHODS = { create: ["Dibuat", "success"], write: ["Diubah", "info"], unlink: ["Dihapus", "danger"], read: ["Dibaca", "muted"], export_data: ["Diekspor", "muted"] };
const PAGE = 50;

/** model, judul, log create, write, unlink. Dokumen berjumlah besar tidak mencatat create agar log tidak membengkak. */
const PRESETS = [
  ["res.partner", "Pelanggan dan Pemasok", true, true, true],
  ["product.template", "Produk", true, true, true],
  ["product.pricelist", "Daftar Harga", true, true, true],
  ["account.account", "Chart of Account", true, true, true],
  ["account.tax", "Pajak", true, true, true],
  ["account.journal", "Jurnal Master", true, true, true],
  ["purchase.order", "RFQ dan Purchase Order", false, true, true],
  ["sale.order", "Quotation dan Sales Order", false, true, true],
  ["stock.picking", "Transfer Stok", false, true, true],
  ["purchase.request", "Purchase Request", false, true, true],
  ["res.users", "Pengguna", true, true, true],
  ["res.company", "Perusahaan", false, true, false],
];

/** Mengaudit model akuntansi ini mengganggu rekonsiliasi (diuji: "already reconciled" saat pelunasan mutasi bank), jadi ditolak. */
const BLOCKED = new Set(["account.move", "account.move.line", "account.payment", "account.bank.statement.line"]);

let st = null; // { tab, filters, rows, more, offset, rules, vacuum, custom }

export const leave = () => {
  st = null;
};

const fresh = () => ({ tab: "log", filters: { model: "", method: "", user: "", from: "", to: "", q: "" }, rows: [], more: false, offset: 0, rules: [], vacuum: null, custom: { model: null } });

registerLookup("audit-model", {
  search: (q) =>
    searchRead("ir.model", [["transient", "=", false], ...(q ? ["|", ["name", "ilike", q], ["model", "ilike", q]] : [])], ["display_name", "model"], { limit: 12, order: "name" }),
  sub: (r) => r.model,
  isChosen: (input) => st?.custom.model?.display_name === input.value,
  choose: (input, item) => {
    st.custom.model = item;
    input.value = item.display_name;
  },
});

export async function render(sub) {
  st = st || fresh();
  st.tab = sub === "rules" ? "rules" : "log";
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  if (st.tab === "rules") await loadRules();
  else await loadLogs(true);
  draw();
}

/* ---------- Data ---------- */

async function loadRules() {
  const [rules, vacuum] = await Promise.all([
    searchRead("auditlog.rule", [], ["name", "model_id", "model_model", "log_create", "log_write", "log_unlink", "state"], { order: "name", limit: 200 }),
    call("ir.cron", "search_read", { domain: [["model_id.model", "=", "auditlog.autovacuum"]], fields: ["active", "code"], context: { active_test: false }, limit: 1 }).catch(() => []),
  ]);
  st.rules = rules;
  st.vacuum = vacuum[0] ?? null;
}

function logDomain() {
  const f = st.filters;
  const domain = [];
  if (f.model) domain.push(["model_id", "=", Number(f.model)]);
  if (f.method) domain.push(["method", "=", f.method]);
  if (f.user) domain.push(["user_id", "=", Number(f.user)]);
  if (f.from) domain.push(["create_date", ">=", fromInputDateTime(`${f.from}T00:00`)]);
  if (f.to) domain.push(["create_date", "<=", fromInputDateTime(`${f.to}T23:59`)]);
  if (f.q) domain.push(["name", "ilike", f.q]);
  return domain;
}

async function loadLogs(reset) {
  if (reset) Object.assign(st, { rows: [], offset: 0 });
  const [rows, ruleModels, users] = await Promise.all([
    searchRead("auditlog.log", logDomain(), ["create_date", "user_id", "model_id", "name", "res_id", "method", "http_request_id"], { order: "id desc", limit: PAGE + 1, offset: st.offset }),
    st.models ? Promise.resolve(st.models) : searchRead("auditlog.rule", [["state", "=", "confirmed"]], ["model_id"], { limit: 200 }),
    referenceUsers(),
  ]);
  st.models ??= ruleModels;
  st.users = users;
  st.more = rows.length > PAGE;
  st.rows = st.rows.concat(rows.slice(0, PAGE));
  st.offset = st.rows.length;
}

const EMPTY = new Set(["", "[]", "0", "0.0", "False", "None", "false"]);
/** Nilai dari log tampil sebagai teks Python, mis. "(12, 'Nama')" untuk relasi: ambil namanya saja. */
function pretty(value) {
  if (value === false || value === null || value === undefined) return "";
  return String(value)
    .replace(/\((\d+), '((?:[^'\\]|\\.)*)'\)/g, "$2")
    .replace(/\((\d+), "((?:[^"\\]|\\.)*)"\)/g, "$2")
    .slice(0, 400);
}

/* ---------- Tampilan ---------- */

const tabs = () =>
  `<div class="flex gap-1 border-b border-gray-200 mb-4">${[["log", "Log Perubahan", "#/auditlog"], ["rules", "Aturan Audit", "#/auditlog/rules"]]
    .map(([key, label, href]) => `<a href="${href}" class="px-4 py-2 text-sm font-medium border-b-2 -mb-px ${st.tab === key ? "border-indigo-600 text-indigo-700" : "border-transparent text-gray-600 hover:text-gray-900"}">${label}</a>`)
    .join("")}</div>`;

function logTab() {
  const f = st.filters;
  const models = (st.models ?? []).map((r) => ({ id: r.model_id[0], display_name: r.model_id[1] })).sort((a, b) => a.display_name.localeCompare(b.display_name));
  const field = (label, control) => `<label class="block"><span class="text-xs font-medium text-gray-500 uppercase tracking-wide">${esc(label)}</span>${control}</label>`;
  const select = (key, options) => `<select data-al-filter="${key}" class="${INPUT}">${options}</select>`;
  const methodOptions = `<option value="">Semua aksi</option>${["create", "write", "unlink"].map((m) => `<option value="${m}" ${f.method === m ? "selected" : ""}>${METHODS[m][0]}</option>`).join("")}`;
  const filters = `<div class="grid sm:grid-cols-2 lg:grid-cols-6 gap-3 mb-4">
    ${field("Model", select("model", selectOptions(models, Number(f.model) || null, "Semua model")))}
    ${field("Aksi", select("method", methodOptions))}
    ${field("Pengguna", select("user", selectOptions(st.users ?? [], Number(f.user) || null, "Semua pengguna")))}
    ${field("Dari tanggal", `<input type="date" data-al-filter="from" value="${esc(f.from)}" class="${INPUT}">`)}
    ${field("Sampai tanggal", `<input type="date" data-al-filter="to" value="${esc(f.to)}" class="${INPUT}">`)}
    ${field("Nama dokumen", `<input data-al-filter="q" value="${esc(f.q)}" placeholder="Cari nama..." class="${INPUT}">`)}
  </div>`;
  const rows = st.rows
    .map(
      (r) => `<tr class="hover:bg-gray-50 cursor-pointer" data-action="al-detail" data-id="${r.id}">
        ${cell(dateTimeText(r.create_date))}${cell(r.user_id?.[1] ?? "-")}${cell(r.model_id?.[1] ?? "-")}
        ${cell(r.name || `#${r.res_id}`, { strong: true })}${cell(badge(METHODS, r.method), { raw: true })}</tr>`,
    )
    .join("");
  const empty = st.models?.length ? "Belum ada log yang cocok." : "Belum ada aturan audit yang aktif. Buka tab Aturan Audit lalu aktifkan audit standar.";
  return `${filters}${table([{ label: "Waktu" }, { label: "Pengguna" }, { label: "Model" }, { label: "Dokumen" }, { label: "Aksi" }], rows, empty)}
    ${st.more ? `<div class="mt-3 text-center"><button data-action="al-more" class="px-4 py-2 border border-gray-300 bg-white rounded-lg text-sm hover:bg-gray-50">Muat lebih banyak</button></div>` : ""}`;
}

const flag = (on) => (on ? '<span class="text-emerald-700">Ya</span>' : '<span class="text-gray-400">-</span>');
const RULE_STATE = { confirmed: ["Aktif", "success"], draft: ["Nonaktif", "muted"] };

function rulesTab() {
  const rows = st.rules
    .map(
      (r) => `<tr>${cell(r.name, { strong: true })}${cell(`${r.model_id?.[1] ?? ""} (${r.model_model ?? ""})`)}
        ${cell(flag(r.log_create), { raw: true })}${cell(flag(r.log_write), { raw: true })}${cell(flag(r.log_unlink), { raw: true })}
        ${cell(badge(RULE_STATE, r.state), { raw: true })}
        <td class="py-3 px-4 text-sm text-right whitespace-nowrap">${
          r.state === "confirmed"
            ? `<button data-action="al-off" data-id="${r.id}" class="text-gray-600 hover:underline">Nonaktifkan</button>`
            : `<button data-action="al-on" data-id="${r.id}" class="text-indigo-600 hover:underline">Aktifkan</button> <button data-action="al-del" data-id="${r.id}" class="ml-3 text-rose-600 hover:underline">Hapus</button>`
        }</td></tr>`,
    )
    .join("");
  const vacuum = st.vacuum
    ? `<label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-al-vacuum ${st.vacuum.active ? "checked" : ""} class="rounded border-gray-300 text-indigo-600">
        Hapus log yang lebih lama dari 180 hari secara otomatis (harian)</label>`
    : '<p class="text-sm text-gray-500">Penghapusan log otomatis belum tersedia (hanya untuk administrator).</p>';
  return `<div class="flex flex-wrap gap-2 mb-4">
      <button data-action="al-standard" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Aktifkan audit standar</button>
      <span class="text-sm text-gray-500 self-center">Master data dan pengaturan dicatat penuh (buat, ubah, hapus); dokumen transaksi hanya ubah dan hapus. Jurnal, faktur, dan pembayaran tidak ikut (lihat D35).</span></div>
    ${table([{ label: "Aturan" }, { label: "Model" }, { label: "Buat" }, { label: "Ubah" }, { label: "Hapus" }, { label: "Status" }, { label: "" }], rows, "Belum ada aturan audit.")}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mt-4"><h2 class="text-base font-semibold text-gray-900 mb-3">Tambah aturan untuk model lain</h2>
      <div class="grid md:grid-cols-[2fr_auto_auto_auto_auto] gap-4 items-end">
        ${fieldBlock("Model", `<input data-lookup="audit-model" autocomplete="off" role="combobox" aria-autocomplete="list" placeholder="Cari model, mis. Bill of Materials..." class="${INPUT}">`)}
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" data-al-new="log_create" checked class="rounded border-gray-300 text-indigo-600"> Buat</label>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" data-al-new="log_write" checked class="rounded border-gray-300 text-indigo-600"> Ubah</label>
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" data-al-new="log_unlink" checked class="rounded border-gray-300 text-indigo-600"> Hapus</label>
        <button data-action="al-add" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">Tambah dan aktifkan</button></div></section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mt-4"><h2 class="text-base font-semibold text-gray-900 mb-3">Retensi log</h2>${vacuum}
      <p class="text-xs text-gray-500 mt-2">Log menambah ukuran database; di sistem produksi aktifkan penghapusan otomatis dan pantau ukurannya.</p></section>`;
}

function draw() {
  app.innerHTML = pageHeader("Audit Log") + tabs() + (st.tab === "rules" ? rulesTab() : logTab());
}

/* ---------- Aksi ---------- */

async function detail(id) {
  const [log] = await call("auditlog.log", "read", { ids: [id], fields: ["create_date", "user_id", "model_id", "name", "res_id", "method", "http_request_id"] });
  const lines = await searchRead("auditlog.log.line", [["log_id", "=", id]], ["field_description", "old_value_text", "new_value_text"], { order: "field_description", limit: 500 });
  const create = log.method === "create";
  const shown = lines.filter((l) => (create ? !EMPTY.has(String(l.new_value_text)) && l.new_value_text !== false : true));
  const body = shown.length
    ? shown
        .map((l) => `<tr>${cell(l.field_description || "-", { strong: true })}${cell(pretty(l.old_value_text) || "(kosong)")}${cell(pretty(l.new_value_text) || "(kosong)")}</tr>`)
        .join("")
    : `<tr><td colspan="3" class="py-6 text-center text-sm text-gray-500">Tidak ada rincian field.</td></tr>`;
  const info = [["Waktu", dateTimeText(log.create_date)], ["Pengguna", log.user_id?.[1] ?? "-"], ["Model", log.model_id?.[1] ?? "-"], ["Dokumen", `${log.name || ""} (ID ${log.res_id})`], ["Aksi", METHODS[log.method]?.[0] ?? log.method], ["Permintaan", log.http_request_id?.[1] ?? "-"]];
  openModal(
    "Rincian perubahan",
    `<dl class="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">${info.map(([k, v]) => `<div><dt class="text-xs font-medium text-gray-500 uppercase tracking-wide">${esc(k)}</dt><dd class="text-gray-900">${esc(v)}</dd></div>`).join("")}</dl>
     <div class="border border-gray-200 rounded-lg overflow-auto max-h-96"><table class="w-full text-left"><thead class="bg-gray-50"><tr>
       <th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase">Field</th><th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase">Sebelum</th><th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase">Sesudah</th>
     </tr></thead><tbody class="divide-y divide-gray-100">${body}</tbody></table></div>
     ${create ? '<p class="text-xs text-gray-500">Untuk pembuatan, hanya field yang terisi yang ditampilkan.</p>' : ""}`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Tutup</button>`,
    null,
    { wide: true },
  );
}

async function enableStandard(btn) {
  const created = await guarded(btn, async () => {
    const models = await searchRead("ir.model", [["model", "in", PRESETS.map((p) => p[0])]], ["model"], { limit: 100 });
    const modelId = Object.fromEntries(models.map((m) => [m.model, m.id]));
    const existing = new Map((await searchRead("auditlog.rule", [], ["model_id", "state"], { limit: 500 })).map((r) => [r.model_id[0], r]));
    let count = 0;
    for (const [model, title, create, write, unlink] of PRESETS) {
      const id = modelId[model];
      if (!id) continue;
      const rule = existing.get(id);
      if (rule?.state === "confirmed") continue;
      let ruleId = rule?.id;
      if (!ruleId) [ruleId] = await call("auditlog.rule", "create", { vals_list: [{ name: `Audit ${title}`, model_id: id, log_create: create, log_write: write, log_unlink: unlink, log_type: "full" }] });
      await call("auditlog.rule", "set_to_confirmed", { ids: [ruleId] });
      count += 1;
    }
    return count;
  });
  if (created === undefined) return;
  toast(created ? `${created} aturan audit diaktifkan.` : "Semua aturan audit standar sudah aktif.");
  st.models = null;
  await render("rules");
}

async function ruleAction(btn, id, action) {
  if (action === "al-del" && !window.confirm("Hapus aturan audit ini? Log yang sudah tercatat tetap tersimpan.")) return;
  const ok = await guarded(btn, async () => {
    if (action === "al-on") await call("auditlog.rule", "set_to_confirmed", { ids: [id] });
    else if (action === "al-off") await call("auditlog.rule", "set_to_draft", { ids: [id] });
    else await call("auditlog.rule", "unlink", { ids: [id] });
    return true;
  });
  if (!ok) return;
  st.models = null;
  await render("rules");
}

async function addRule(btn) {
  const model = st.custom.model;
  if (!model) {
    toast("Pilih model dari daftar saran.", "error");
    return;
  }
  if (BLOCKED.has(model.model)) {
    toast("Jurnal, faktur, dan pembayaran tidak bisa diaudit di sini karena mengganggu rekonsiliasi. Dokumen terposting sudah tidak dapat diubah, dan perubahan lainnya tercatat di riwayat dokumen.", "error");
    return;
  }
  const flags = Object.fromEntries([...document.querySelectorAll("[data-al-new]")].map((el) => [el.dataset.alNew, el.checked]));
  if (!Object.values(flags).some(Boolean)) {
    toast("Pilih sedikitnya satu jenis aksi.", "error");
    return;
  }
  const ok = await guarded(btn, async () => {
    const [id] = await call("auditlog.rule", "create", { vals_list: [{ name: `Audit ${model.display_name}`, model_id: model.id, log_type: "full", ...flags }] });
    await call("auditlog.rule", "set_to_confirmed", { ids: [id] });
    return true;
  });
  if (!ok) return;
  st.custom.model = null;
  st.models = null;
  toast("Aturan audit ditambahkan.");
  await render("rules");
}

export async function onClick(event, el) {
  if (!st) return;
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  if (action === "al-detail") await guarded(null, () => detail(id));
  else if (action === "al-more") {
    await guarded(el, () => loadLogs(false));
    draw();
  } else if (action === "al-standard") await enableStandard(el);
  else if (["al-on", "al-off", "al-del"].includes(action)) await ruleAction(el, id, action);
  else if (action === "al-add") await addRule(el);
}

let timer;
export function onInput(event, el) {
  if (!st) return;
  if (el.dataset.lookup === "audit-model") {
    st.custom.model = null;
    runLookup(el, 250);
  } else if (el.dataset.alFilter === "q") {
    st.filters.q = el.value.trim();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await loadLogs(true);
      const box = document.querySelector('[data-al-filter="q"]');
      const caret = box?.selectionStart;
      draw();
      const again = document.querySelector('[data-al-filter="q"]');
      again?.focus();
      if (caret !== undefined) again?.setSelectionRange(caret, caret);
    }, 400);
  }
}

export async function onChange(event, el) {
  if (!st) return;
  if (el.dataset.alFilter && el.dataset.alFilter !== "q") {
    st.filters[el.dataset.alFilter] = el.value;
    await guarded(null, () => loadLogs(true));
    draw();
  } else if (el.dataset.alVacuum !== undefined && st.vacuum) {
    const ok = await guarded(el, () => call("ir.cron", "write", { ids: [st.vacuum.id], vals: { active: el.checked } }));
    if (ok !== undefined) {
      st.vacuum.active = el.checked;
      toast(el.checked ? "Penghapusan log otomatis diaktifkan." : "Penghapusan log otomatis dimatikan.");
    }
  }
}
