// Unit of Measurement Master (uom.uom, Odoo 19): satuan dengan satuan acuan dan faktor. Satuan tanpa acuan adalah
// satuan dasar (mis. Units, kg); "Lusin" berisi 12 Units. Satuan yang dipakai transaksi diarsipkan, bukan dihapus.
import { INPUT, app, call, cell, esc, fieldBlock, filterSelect, guarded, pageHeader, readOne, rowLink, searchBox, searchRead, selectOptions, table, toast, button } from "../common.js";

const FILTERS = [["", "Aktif"], ["archived", "Diarsipkan"]];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 6 });

let form = null; // { id, values, initial }
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const domain = [];
  if (filter === "archived") domain.push(["active", "=", false]);
  if (text) domain.push(["name", "ilike", text]);
  const rows = await searchRead("uom.uom", domain, ["name", "relative_uom_id", "relative_factor", "factor"], { order: "name", limit: 200, context: { active_test: filter !== "archived" } });
  const body = rows
    .map((r) => rowLink(`#/uom/${r.id}`, [cell(r.name, { strong: true }), cell(r.relative_uom_id ? `${nf.format(r.relative_factor)} ${r.relative_uom_id[1]}` : "Satuan dasar"), cell(nf.format(r.factor), { right: true })]))
    .join("");
  app.innerHTML =
    pageHeader(
      "Unit of Measurement Master",
      `${searchBox(text, "Cari satuan")}${filterSelect(FILTERS, filter)}
       <a href="#/uom/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Satuan Baru</a>`,
    ) + table([{ label: "Satuan" }, { label: "Berisi" }, { label: "Faktor Mutlak", right: true }], body, "Tidak ada satuan yang cocok.");
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  let uom = null;
  if (id) {
    uom = await readOne("uom.uom", id, ["name", "relative_uom_id", "relative_factor", "factor", "active"]);
    if (!uom) {
      app.innerHTML = '<p class="text-sm text-rose-600">Satuan tidak ditemukan.</p>';
      return;
    }
  }
  const all = await searchRead("uom.uom", [], ["display_name"], { order: "name", limit: 200 });
  if (!form || form.id !== (uom?.id ?? null)) {
    const values = uom ? { name: uom.name, relative_uom_id: uom.relative_uom_id?.[0] ?? null, relative_factor: uom.relative_factor } : { name: "", relative_uom_id: null, relative_factor: 1 };
    form = { id: uom?.id ?? null, values, initial: uom ? { ...values } : null };
  }
  const v = form.values;
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/uom" class="hover:text-indigo-600">Unit of Measurement Master</a> / ${esc(uom?.name ?? "Baru")}</div>
    <div class="flex flex-wrap gap-2 mb-3">${uom ? button("toggle-active", uom.active ? "Arsipkan" : "Aktifkan Kembali", uom.active ? "danger" : "primary", { id: uom.id }) : ""}</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(uom?.name ?? "Satuan Baru")}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-3 gap-x-8 gap-y-4">
      ${fieldBlock("Nama Satuan", `<input data-uom="name" value="${esc(v.name)}" class="${INPUT}">`)}
      ${fieldBlock("Satuan Acuan", `<select data-uom="relative_uom_id" class="${INPUT}">${selectOptions(all.filter((u) => u.id !== form.id), v.relative_uom_id, "Satuan dasar (tanpa acuan)")}</select>`)}
      ${fieldBlock("Berisi (jumlah satuan acuan)", `<input type="number" min="0" step="any" data-uom="relative_factor" value="${esc(v.relative_factor)}" class="${INPUT} text-right">`)}
    </section>
    <p class="text-xs text-gray-500 mt-3">Contoh: Lusin, acuan Units, berisi 12. Faktor mutlak dihitung Odoo dari rantai acuan.</p>
    <div class="flex gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/uom" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a></div>`;
}

async function persist() {
  const v = form.values;
  if (!v.name.trim()) throw new Error("Nama satuan wajib diisi.");
  if (v.relative_uom_id && !(Number(v.relative_factor) > 0)) throw new Error("Isi jumlah satuan acuan lebih dari 0.");
  const vals = { name: v.name.trim(), relative_uom_id: v.relative_uom_id || false, relative_factor: Number(v.relative_factor) || 1 };
  if (!form.id) {
    const [id] = await call("uom.uom", "create", { vals_list: [vals] });
    return id;
  }
  const before = { name: form.initial.name, relative_uom_id: form.initial.relative_uom_id || false, relative_factor: Number(form.initial.relative_factor) };
  const changed = Object.fromEntries(Object.entries(vals).filter(([key, value]) => value !== before[key]));
  if (Object.keys(changed).length) await call("uom.uom", "write", { ids: [form.id], vals: changed });
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
      toast(wasNew ? "Satuan dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/uom/${saved}`;
      else reload();
    }
  } else if (action === "toggle-active") {
    const archive = el.textContent.trim() === "Arsipkan";
    const ok = await guarded(el, () => call("uom.uom", "write", { ids: [Number(el.dataset.id)], vals: { active: !archive } }));
    if (ok !== undefined) {
      form = null;
      toast(archive ? "Satuan diarsipkan." : "Satuan diaktifkan kembali.");
      reload();
    }
  }
}

export function onInput(event, el) {
  if (form && el.dataset.uom) form.values[el.dataset.uom] = el.dataset.uom === "relative_uom_id" ? Number(el.value) || null : el.value;
}
