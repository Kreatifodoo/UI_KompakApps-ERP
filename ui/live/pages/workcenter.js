// WorkCenter (mrp.workcenter): mesin atau stasiun kerja untuk operasi BoM dan work order. Halaman ini juga memuat
// sakelar fitur manufaktur (Work Orders dan By-Products) yang diaktifkan lewat pengaturan Odoo (res.config.settings).
import {
  INPUT, app, badge, call, cell, changedValues, esc, fieldBlock, fieldValue, filterSelect, guarded, hasGroup, pageHeader, plain, readOne,
  readonlyValue, resetReferences, rowLink, searchBox, searchRead, selectOptions, statTiles, table, toast, button, chatterHtml, loadMessages,
} from "../common.js";

const FEATURES = [
  { setting: "group_mrp_routings", group: "mrp.group_mrp_routings", label: "Work Orders", about: "Operasi per work center pada BoM, work order, dan pelacakan waktu." },
  { setting: "group_mrp_byproducts", group: "mrp.group_mrp_byproducts", label: "By-Products", about: "Produk sampingan pada BoM, dengan porsi biaya per produk." },
];
const WORKING = { normal: ["Tersedia", "success"], blocked: ["Terhenti", "danger"], done: ["Selesai", "info"] };
const FILTERS = [["active", "Aktif"], ["archived", "Diarsipkan"]];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

let form = null; // { id, values, initial }
let features = null;
let calendars = null;
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
  features = null;
};
const reload = () => render(last.sub, last.query);

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function loadFeatures() {
  const entries = await Promise.all(FEATURES.map(async (f) => [f.setting, await hasGroup(f.group)]));
  features = Object.fromEntries(entries);
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") || "active";
  const text = query.get("q") ?? "";
  const domain = filter === "archived" ? [["active", "=", false]] : [];
  if (text) domain.push("|", ["name", "ilike", text], ["code", "ilike", text]);
  const [rows] = await Promise.all([
    searchRead("mrp.workcenter", domain, ["name", "code", "costs_hour", "time_efficiency", "working_state", "workorder_count", "workorder_progress_count", "active"], {
      order: "sequence, name", limit: 100, context: { active_test: filter === "active" },
    }),
    features ? null : loadFeatures(),
  ]);
  const body = rows
    .map((r) =>
      rowLink(`#/workcenter/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(r.code || "-"),
        cell(`${nf.format(r.costs_hour)} / jam`, { right: true }),
        cell(`${nf.format(r.time_efficiency)}%`, { right: true }),
        cell(String(r.workorder_count), { right: true }),
        cell(badge(WORKING, r.working_state), { raw: true }),
      ]),
    )
    .join("");
  const toggles = FEATURES.map(
    (f) => `<label class="flex items-start gap-3 text-sm"><input type="checkbox" data-feature="${f.setting}" ${features[f.setting] ? "checked" : ""} class="mt-1 rounded border-gray-300 text-indigo-600">
      <span><span class="font-medium text-gray-900">${esc(f.label)}</span><span class="block text-gray-500">${esc(f.about)}</span></span></label>`,
  ).join("");
  app.innerHTML =
    pageHeader(
      "WorkCenter",
      `${searchBox(text, "Cari nama atau kode")}${filterSelect(FILTERS, filter)}
       <a href="#/workcenter/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>WorkCenter Baru</a>`,
    ) +
    `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-4"><div class="text-sm font-semibold mb-3">Fitur manufaktur</div>
       <div class="grid md:grid-cols-2 gap-4">${toggles}</div>
       <div class="mt-4"><button data-action="apply-features" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Terapkan Fitur</button></div></section>` +
    table(
      [{ label: "WorkCenter" }, { label: "Kode" }, { label: "Biaya", right: true }, { label: "Efisiensi", right: true }, { label: "Work Order", right: true }, { label: "Status" }],
      body,
      "Belum ada work center. Buat dengan tombol WorkCenter Baru; work center dipakai pada operasi BoM.",
    );
}

const FIELDS = ["name", "code", "costs_hour", "time_efficiency", "oee_target", "time_start", "time_stop", "resource_calendar_id", "note"];
const normalize = (r) => ({
  name: r.name || "", code: r.code || "", costs_hour: r.costs_hour ?? 0, time_efficiency: r.time_efficiency ?? 100, oee_target: r.oee_target ?? 90,
  time_start: r.time_start ?? 0, time_stop: r.time_stop ?? 0, calendar: r.resource_calendar_id?.[0] ?? null, note: plain(r.note),
});

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  calendars ??= await searchRead("resource.calendar", [], ["display_name"], { order: "name" });
  let wc = null;
  if (id) {
    wc = await readOne("mrp.workcenter", id, [...FIELDS, "active", "workorder_count", "workorder_progress_count", "workorder_ready_count", "workorder_late_count", "working_state"]);
    if (!wc) {
      app.innerHTML = '<p class="text-sm text-rose-600">WorkCenter tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (wc?.id ?? null)) {
    const values = wc ? normalize(wc) : { name: "", code: "", costs_hour: 0, time_efficiency: 100, oee_target: 90, time_start: 0, time_stop: 0, calendar: calendars[0]?.id ?? null, note: "" };
    form = { id: wc?.id ?? null, values, initial: wc ? { ...values } : null };
  }
  const v = form.values;
  const number = (key, extra = "") => `<input type="number" min="0" step="any" data-wc="${key}" data-kind="number" value="${esc(v[key])}" ${extra} class="${INPUT} text-right">`;
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/workcenter" class="hover:text-indigo-600">WorkCenter</a> / ${esc(wc?.name ?? "Baru")}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">${wc ? button("toggle-active", wc.active ? "Arsipkan" : "Aktifkan Kembali", wc.active ? "danger" : "primary", { id: wc.id }) : ""}</div>
    ${wc ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: wc.workorder_count, label: "Work Order", icon: "fa-list-check" },
      { count: wc.workorder_progress_count, label: "Sedang Berjalan", icon: "fa-play" },
      { count: wc.workorder_ready_count, label: "Siap", icon: "fa-circle-check" },
      { count: wc.workorder_late_count, label: "Terlambat", icon: "fa-clock" },
    ])}</div>` : ""}
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(wc?.name ?? "WorkCenter Baru")}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama", `<input data-wc="name" value="${esc(v.name)}" class="${INPUT}">`)}
      ${fieldBlock("Kode", `<input data-wc="code" value="${esc(v.code)}" class="${INPUT}">`)}
      ${fieldBlock("Biaya per Jam", number("costs_hour"))}
      ${fieldBlock("Efisiensi Waktu (%)", number("time_efficiency"))}
      ${fieldBlock("Target OEE (%)", number("oee_target"))}
      ${fieldBlock("Jam Kerja", `<select data-wc="calendar" data-kind="id" class="${INPUT}">${selectOptions(calendars, v.calendar, "-")}</select>`)}
      ${fieldBlock("Waktu Persiapan (menit)", number("time_start"))}
      ${fieldBlock("Waktu Pembersihan (menit)", number("time_stop"))}
      <div class="md:col-span-2">${fieldBlock("Catatan", `<textarea data-wc="note" rows="2" class="${INPUT}">${esc(v.note)}</textarea>`)}</div>
      ${wc ? fieldBlock("Status Saat Ini", readonlyValue(WORKING[wc.working_state]?.[0] ?? wc.working_state)) : ""}
    </section>
    <div class="flex gap-2 mt-4">
      <button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/workcenter" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
    </div>
    ${wc ? chatterHtml("mrp.workcenter", wc.id) : ""}`;
  if (wc) loadMessages("mrp.workcenter", wc.id);
}

async function persist() {
  const v = form.values;
  if (!String(v.name).trim()) throw new Error("Nama work center wajib diisi.");
  for (const key of ["costs_hour", "time_efficiency", "oee_target", "time_start", "time_stop"]) {
    if (v[key] === "") v[key] = 0;
    if (!(Number(v[key]) >= 0)) throw new Error("Angka pada work center tidak boleh negatif.");
  }
  if (!(Number(v.time_efficiency) > 0)) throw new Error("Efisiensi waktu harus lebih dari 0%.");
  const toOdoo = {
    name: (x) => x.trim(), code: (x) => x.trim() || false, calendar: (x) => x || false, note: (x) => (String(x).trim() ? `<p>${esc(String(x).trim())}</p>` : false),
  };
  const field = { calendar: "resource_calendar_id" };
  const convert = (key) => (toOdoo[key] ? toOdoo[key](v[key]) : Number(v[key]));
  if (!form.id) {
    const vals = {};
    for (const key of Object.keys(v)) {
      const value = convert(key);
      if (value === false || value === "") continue;
      vals[field[key] ?? key] = value;
    }
    const [newId] = await call("mrp.workcenter", "create", { vals_list: [vals] });
    return newId;
  }
  const changed = changedValues(v, form.initial, Object.keys(v));
  const vals = Object.fromEntries(Object.keys(changed).map((key) => [field[key] ?? key, convert(key)]));
  if (Object.keys(vals).length) await call("mrp.workcenter", "write", { ids: [form.id], vals });
  return form.id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "WorkCenter dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/workcenter/${saved}`;
      else reload();
    }
  } else if (action === "toggle-active") {
    const archiving = el.textContent.trim() === "Arsipkan";
    if (archiving && !window.confirm("Arsipkan work center ini? Operasi BoM yang memakainya tidak berubah.")) return;
    const ok = await guarded(el, () => call("mrp.workcenter", archiving ? "action_archive" : "action_unarchive", { ids: [Number(el.dataset.id)] }));
    if (ok !== undefined) {
      form = null;
      toast(archiving ? "WorkCenter diarsipkan." : "WorkCenter diaktifkan kembali.");
      location.hash = "#/workcenter";
    }
  } else if (action === "apply-features") {
    const vals = Object.fromEntries(FEATURES.map((f) => [f.setting, Boolean(document.querySelector(`[data-feature="${f.setting}"]`)?.checked)]));
    const ok = await guarded(el, async () => {
      const [id] = await call("res.config.settings", "create", { vals_list: [vals] });
      await call("res.config.settings", "execute", { ids: [id] });
      return true;
    });
    if (ok) {
      features = null;
      resetReferences(); // hasGroup() menyimpan hasil per sesi
      toast("Fitur manufaktur diterapkan.");
      reload();
    }
  }
}

export function onInput(event, el) {
  if (form && el.dataset.wc) form.values[el.dataset.wc] = fieldValue(el);
}
