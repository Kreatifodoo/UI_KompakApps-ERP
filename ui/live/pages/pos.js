// POS Station (pos.config) dan Metode Pembayaran (pos.payment.method). Satu stasiun punya metode pembayaran, kontrol kas,
// dan daftar harga; sesi dibuka dari sini (dengan kas awal bila kontrol kas aktif) lalu kasir dipakai di #/kasir.
import {
  INPUT, app, badge, button, call, cell, changedValues, closeModal, ctx, dateText, esc, fieldBlock, fieldValue, filterSelect, guarded, money, openModal,
  pageHeader, readOne, readonlyValue, referenceJournals, referencePricelists, rowLink, searchBox, searchRead, selectOptions, statTiles, table, toast,
} from "../common.js";

const SESSION = { opening_control: ["Kontrol Pembukaan", "warning"], opened: ["Berjalan", "success"], closing_control: ["Kontrol Penutupan", "warning"], closed: ["Ditutup", "muted"] };
const KINDS = { cash: "Tunai (jurnal kas)", bank: "Bank atau kartu (jurnal bank)", pay_later: "Piutang pelanggan (tanpa jurnal)" };
const FILTERS = [["active", "Aktif"], ["archived", "Diarsipkan"]];

let form = null; // { id, values, initial }
let methods = null; // daftar metode pembayaran (baris yang bisa diubah)
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
  methods = null;
};
const reload = () => render(last.sub, last.query);

const kindOf = (m) => (m.journal_id ? (m.type === "cash" ? "cash" : "bank") : "pay_later");

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") || "active";
  const text = query.get("q") ?? "";
  const domain = filter === "archived" ? [["active", "=", false]] : [];
  if (text) domain.push(["name", "ilike", text]);
  const [configs, paymentMethods, cashJournals, bankJournals] = await Promise.all([
    searchRead("pos.config", domain, ["name", "payment_method_ids", "current_session_id", "current_session_state", "last_session_closing_date", "last_session_closing_cash", "cash_control", "active"], {
      order: "name", limit: 100, context: { active_test: filter === "active" },
    }),
    searchRead("pos.payment.method", [], ["name", "type", "journal_id", "active"], { order: "sequence, id", context: { active_test: false } }),
    referenceJournals("cash"),
    referenceJournals("bank"),
  ]);
  methods = paymentMethods.map((m) => ({ id: m.id, name: m.name, kind: kindOf(m), journal: m.journal_id?.[0] ?? null, active: m.active, initial: { name: m.name, kind: kindOf(m), journal: m.journal_id?.[0] ?? null, active: m.active } }));
  const names = new Map(paymentMethods.map((m) => [m.id, m.name]));
  const body = configs
    .map((c) =>
      rowLink(`#/posconfig/${c.id}`, [
        cell(c.name, { strong: true }),
        cell(c.payment_method_ids.map((id) => names.get(id)).filter(Boolean).join(", ") || "-"),
        cell(c.cash_control ? "Ya" : "Tidak"),
        cell(c.current_session_id ? badge(SESSION, c.current_session_state) : "-", { raw: true }),
        cell(c.last_session_closing_date ? `${dateText(c.last_session_closing_date)} · ${money(c.last_session_closing_cash)}` : "-"),
        cell(
          c.active
            ? c.current_session_id && ["opened", "opening_control"].includes(c.current_session_state)
              ? `<button type="button" data-action="goto" data-href="#/kasir?config=${c.id}" class="px-3 py-1 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">Lanjutkan Kasir</button>`
              : `<button type="button" data-action="open-session" data-id="${c.id}" data-cash="${c.cash_control ? 1 : 0}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buka Sesi</button>`
            : "",
          { raw: true },
        ),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "POS Station",
      `${searchBox(text, "Cari stasiun")}${filterSelect(FILTERS, filter)}
       <a href="#/posconfig/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Stasiun Baru</a>`,
    ) +
    table([{ label: "Stasiun" }, { label: "Metode Pembayaran" }, { label: "Kontrol Kas" }, { label: "Sesi Saat Ini" }, { label: "Penutupan Terakhir" }, { label: "" }], body, "Belum ada stasiun POS. Buat dengan tombol Stasiun Baru, setelah menambahkan metode pembayaran di bawah.") +
    methodsSection(cashJournals, bankJournals);
}

function methodRow(m, i, cashJournals, bankJournals) {
  const journals = m.kind === "cash" ? cashJournals : m.kind === "bank" ? bankJournals : [];
  return `<tr class="${m.active ? "" : "opacity-60"}">
    <td class="py-2 px-3"><input data-method="${i}" data-col="name" value="${esc(m.name)}" class="${INPUT}" aria-label="Nama metode"></td>
    <td class="py-2 px-3 w-72"><select data-method="${i}" data-col="kind" class="${INPUT}" ${m.id ? "disabled" : ""} aria-label="Jenis">${Object.entries(KINDS).map(([k, l]) => `<option value="${k}" ${k === m.kind ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></td>
    <td class="py-2 px-3 w-56"><select data-method="${i}" data-col="journal" class="${INPUT}" ${m.kind === "pay_later" ? "disabled" : ""} aria-label="Jurnal">${selectOptions(journals, m.journal, "-")}</select></td>
    <td class="py-2 px-3 w-28 text-center"><label class="text-sm"><input type="checkbox" data-method="${i}" data-col="active" ${m.active ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> aktif</label></td></tr>`;
}

let journalLists = { cash: [], bank: [] };
function methodsSection(cashJournals, bankJournals) {
  journalLists = { cash: cashJournals, bank: bankJournals };
  return `<section id="methods" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-6 overflow-x-auto">
    <div class="px-4 py-3 border-b border-gray-200"><div class="text-sm font-semibold">Metode Pembayaran</div>
      <div class="text-xs text-gray-500 mt-0.5">Tunai memakai jurnal kas dan dihitung saat sesi ditutup; bank atau kartu memakai jurnal bank. Jenis tidak bisa diubah setelah dibuat. Satu metode tunai hanya untuk satu stasiun, dan satu jurnal kas hanya untuk satu metode tunai: untuk stasiun baru, buat jurnal kas baru di <a href="#/journal" class="underline">Journal Master</a> lalu metode tunainya di sini.</div></div>
    <table class="w-full text-left"><thead class="bg-gray-50"><tr>${["Nama", "Jenis", "Jurnal", ""].map((h) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${methods.map((m, i) => methodRow(m, i, cashJournals, bankJournals)).join("")}</tbody></table>
    <div class="px-4 py-3 border-t border-gray-100 flex gap-2">
      <button type="button" data-action="method-add" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-plus mr-1"></i>Tambah metode</button>
      <button type="button" data-action="method-save" class="px-3 py-1 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">Simpan Metode Pembayaran</button></div></section>`;
}

async function saveMethods() {
  for (const m of methods) {
    if (!m.name.trim()) throw new Error("Nama metode pembayaran tidak boleh kosong.");
    if (m.kind !== "pay_later" && !m.journal) throw new Error(`Pilih jurnal untuk metode ${m.name}.`);
  }
  for (const m of methods) {
    const vals = { name: m.name.trim(), journal_id: m.kind === "pay_later" ? false : m.journal, active: m.active };
    if (!m.id) await call("pos.payment.method", "create", { vals_list: [vals] });
    else {
      const before = m.initial;
      const changed = {};
      if (m.name.trim() !== before.name) changed.name = vals.name;
      if (m.journal !== before.journal && m.kind !== "pay_later") changed.journal_id = vals.journal_id;
      if (m.active !== before.active) changed.active = m.active;
      if (Object.keys(changed).length) await call("pos.payment.method", "write", { ids: [m.id], vals: changed });
    }
  }
  return true;
}

/* ---------- Form stasiun ---------- */

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [allMethods, pricelists] = await Promise.all([searchRead("pos.payment.method", [], ["name", "type", "config_ids"], { order: "sequence, id" }), referencePricelists()]);
  let cfg = null;
  if (id) {
    cfg = await readOne("pos.config", id, ["name", "payment_method_ids", "cash_control", "pricelist_id", "active", "current_session_id", "current_session_state", "journal_id", "picking_type_id", "session_ids", "last_session_closing_cash", "last_session_closing_date"]);
    if (!cfg) {
      app.innerHTML = '<p class="text-sm text-rose-600">Stasiun POS tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (cfg?.id ?? null)) {
    const values = cfg
      ? { name: cfg.name, payment_method_ids: [...cfg.payment_method_ids].sort((a, b) => a - b), cash_control: Boolean(cfg.cash_control), pricelist_id: cfg.pricelist_id?.[0] ?? null }
      : { name: "", payment_method_ids: allMethods.filter((m) => !(m.type === "cash" && m.config_ids.length)).map((m) => m.id).sort((a, b) => a - b), cash_control: false, pricelist_id: null };
    form = { id: cfg?.id ?? null, values, initial: cfg ? { ...values } : null };
  }
  const v = form.values;
  const methodChecks = allMethods.length
    ? `<div class="mt-1 border border-gray-200 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1">${allMethods
        .map((m) => {
          const taken = m.type === "cash" && m.config_ids.some((c) => c !== cfg?.id);
          return `<label class="flex items-center gap-2 text-sm ${taken ? "text-gray-400" : "text-gray-700"}"><input type="checkbox" data-pm value="${m.id}" ${v.payment_method_ids.includes(m.id) && !taken ? "checked" : ""} ${taken ? "disabled" : ""} class="rounded border-gray-300 text-indigo-600"> ${esc(m.name)} <span class="text-xs text-gray-400">${esc(m.type === "cash" ? "tunai" : m.type === "bank" ? "bank" : "piutang")}${taken ? ", dipakai stasiun lain" : ""}</span></label>`;
        })
        .join("")}</div>`
    : '<div class="py-2 text-sm text-amber-700">Belum ada metode pembayaran. Tambahkan di halaman POS Station.</div>';
  const running = cfg?.current_session_id && ["opened", "opening_control"].includes(cfg.current_session_state);
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/posconfig" class="hover:text-indigo-600">POS Station</a> / ${esc(cfg?.name ?? "Baru")}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      ${cfg && cfg.active ? (running ? `<a href="#/kasir?config=${cfg.id}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Lanjutkan Kasir</a>` : button("open-session", "Buka Sesi", "primary", { id: cfg.id, cash: cfg.cash_control ? 1 : 0 })) : ""}
      ${cfg ? button("toggle-active", cfg.active ? "Arsipkan" : "Aktifkan Kembali", cfg.active ? "danger" : "primary", { id: cfg.id }) : ""}
    </div>
    ${cfg ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: cfg.session_ids.length, label: "Sesi", icon: "fa-clock-rotate-left", href: `#/possession?config=${cfg.id}` },
      { count: cfg.current_session_id ? 1 : 0, label: `Sesi berjalan ${cfg.current_session_id?.[1] ?? ""}`, icon: "fa-play", href: `#/possession/${cfg.current_session_id?.[0]}` },
    ])}</div>` : ""}
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(cfg?.name ?? "Stasiun Baru")}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama Stasiun", `<input data-cfg="name" value="${esc(v.name)}" class="${INPUT}">`)}
      ${fieldBlock("Daftar Harga", `<select data-cfg="pricelist_id" data-kind="id" class="${INPUT}">${selectOptions(pricelists, v.pricelist_id, "Harga jual produk")}</select>`)}
      ${fieldBlock("Metode Pembayaran", methodChecks)}
      <div class="flex items-start pt-5"><label class="flex items-start gap-3 text-sm"><input type="checkbox" data-cfg="cash_control" ${v.cash_control ? "checked" : ""} class="mt-1 rounded border-gray-300 text-indigo-600">
        <span><span class="font-medium text-gray-900">Kontrol kas</span><span class="block text-gray-500">Kas awal dicatat saat membuka sesi dan kas dihitung saat menutup; selisih dijurnal sebagai selisih kas.</span></span></label></div>
      ${cfg ? fieldBlock("Jurnal Penjualan POS", readonlyValue(cfg.journal_id?.[1] ?? "-")) : ""}
      ${cfg ? fieldBlock("Tipe Operasi Stok", readonlyValue(cfg.picking_type_id?.[1] ?? "-")) : ""}
    </section>
    <div class="flex gap-2 mt-4">
      <button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/posconfig" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
    </div>
    <p class="mt-3 text-xs text-gray-500">Perubahan metode pembayaran dan kontrol kas berlaku untuk sesi berikutnya. Produk yang dijual di kasir ditandai pada Product Master (Dijual di POS).</p>`;
}

async function persist() {
  const v = form.values;
  if (!v.name.trim()) throw new Error("Nama stasiun wajib diisi.");
  if (!v.payment_method_ids.length) throw new Error("Pilih minimal satu metode pembayaran.");
  const toOdoo = { name: (x) => x.trim(), pricelist_id: (x) => x || false, cash_control: (x) => Boolean(x), payment_method_ids: (x) => [[6, 0, x]] };
  if (!form.id) {
    const [id] = await call("pos.config", "create", { vals_list: [Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toOdoo[k](x)]))] });
    return id;
  }
  const changed = changedValues(v, form.initial, Object.keys(v));
  const vals = Object.fromEntries(Object.keys(changed).map((k) => [k, toOdoo[k](v[k])]));
  if (Object.keys(vals).length) await call("pos.config", "write", { ids: [form.id], vals });
  return form.id;
}

/* ---------- Buka sesi ---------- */

function openDialog(configId, cashControl) {
  openModal(
    "Buka Sesi",
    `<form data-form="open" data-id="${configId}" class="space-y-3">
       ${cashControl ? fieldBlock("Kas awal (uang di laci)", `<input type="number" min="0" step="any" data-open="cash" value="0" class="${INPUT} text-right">`) : '<p class="text-sm text-gray-700">Sesi baru dibuka dan kasir siap dipakai.</p>'}
       ${fieldBlock("Catatan pembukaan", `<input data-open="notes" class="${INPUT}" placeholder="opsional">`)}</form>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="open-confirm" data-id="${configId}" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Buka Sesi</button>`,
  );
}

async function openSession(button, configId) {
  const session = await guarded(button, async () => {
    const cash = Number(document.querySelector('[data-open="cash"]')?.value || 0);
    if (!(cash >= 0)) throw new Error("Kas awal tidak boleh negatif.");
    const notes = document.querySelector('[data-open="notes"]').value.trim();
    const [sessionId] = await call("pos.session", "create", { vals_list: [{ config_id: configId, user_id: ctx.user.id }] });
    await call("pos.session", "set_opening_control", { ids: [sessionId], cashbox_value: cash, notes });
    return sessionId;
  });
  if (session) {
    closeModal();
    toast("Sesi dibuka.");
    location.hash = `#/kasir?config=${configId}`;
  }
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "open-session") openDialog(Number(el.dataset.id), el.dataset.cash === "1");
  else if (action === "open-confirm") await openSession(el, Number(el.dataset.id));
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "Stasiun dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/posconfig/${saved}`;
      else reload();
    }
  } else if (action === "toggle-active") {
    const archiving = el.textContent.trim() === "Arsipkan";
    if (archiving && !window.confirm("Arsipkan stasiun ini? Sesi dan pesanan lamanya tetap tersimpan.")) return;
    const ok = await guarded(el, () => call("pos.config", archiving ? "action_archive" : "action_unarchive", { ids: [Number(el.dataset.id)] }));
    if (ok !== undefined) {
      form = null;
      toast(archiving ? "Stasiun diarsipkan." : "Stasiun diaktifkan kembali.");
      location.hash = "#/posconfig";
    }
  } else if (action === "method-add") {
    methods.push({ id: null, name: "", kind: "cash", journal: journalLists.cash[0]?.id ?? null, active: true, initial: null });
    document.querySelector("#methods").outerHTML = methodsSection(journalLists.cash, journalLists.bank);
  } else if (action === "method-save") {
    const ok = await guarded(el, saveMethods);
    if (ok) {
      toast("Metode pembayaran disimpan.");
      methods = null;
      reload();
    }
  }
}

export function onInput(event, el) {
  if (el.dataset.cfg && form) form.values[el.dataset.cfg] = fieldValue(el);
  else if (el.dataset.method !== undefined && methods) {
    const m = methods[Number(el.dataset.method)];
    const col = el.dataset.col;
    if (col === "name") m.name = el.value;
    else if (col === "active") m.active = el.checked;
    else if (col === "journal") m.journal = el.value ? Number(el.value) : null;
    else if (col === "kind") {
      m.kind = el.value;
      m.journal = (el.value === "cash" ? journalLists.cash : el.value === "bank" ? journalLists.bank : [])[0]?.id ?? null;
      document.querySelector("#methods").outerHTML = methodsSection(journalLists.cash, journalLists.bank);
    }
  }
}

export function onChange(event, el) {
  if (el.dataset.pm !== undefined && form) {
    form.values.payment_method_ids = [...document.querySelectorAll("[data-pm]:checked")].map((b) => Number(b.value)).sort((a, b) => a - b);
  }
}
