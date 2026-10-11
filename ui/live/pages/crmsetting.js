// CRM Setting: sakelar fitur Leads, tahap pipeline (crm.stage), alasan kalah (crm.lost.reason), dan tag (crm.tag).
// Tiap bagian berupa tabel yang bisa diubah; Simpan menulis baris baru, baris yang berubah, dan baris yang dihapus.
import { INPUT, app, call, esc, guarded, hasGroup, pageHeader, resetReferences, searchRead, toast } from "../common.js";

const SECTIONS = {
  stages: {
    model: "crm.stage", title: "Tahap Pipeline", hint: "Urutan menurut angka urutan. Tahap Menang menandai opportunity yang masuk sebagai menang.",
    order: "sequence, id", fields: ["name", "sequence", "is_won"],
    columns: [{ key: "name", label: "Nama", type: "text" }, { key: "sequence", label: "Urutan", type: "number" }, { key: "is_won", label: "Tahap menang", type: "check" }],
    blank: () => ({ name: "", sequence: 10, is_won: false }),
  },
  reasons: {
    model: "crm.lost.reason", title: "Alasan Kalah", hint: "Alasan yang dipilih saat opportunity ditandai kalah.",
    order: "name", fields: ["name"], columns: [{ key: "name", label: "Alasan", type: "text" }], blank: () => ({ name: "" }),
  },
  tags: {
    model: "crm.tag", title: "Tag", hint: "Label untuk mengelompokkan lead dan opportunity.",
    order: "name", fields: ["name"], columns: [{ key: "name", label: "Tag", type: "text" }], blank: () => ({ name: "" }),
  },
};

let data = null; // { key: { rows: [{id, values, initial}], removed: [] } }
let leadsOn = false;
export const leave = () => {
  data = null;
};

async function load() {
  data = {};
  for (const [key, section] of Object.entries(SECTIONS)) {
    const rows = await searchRead(section.model, [], section.fields, { order: section.order, context: { active_test: true } });
    data[key] = { rows: rows.map((r) => ({ id: r.id, values: Object.fromEntries(section.fields.map((f) => [f, r[f]])), initial: Object.fromEntries(section.fields.map((f) => [f, r[f]])) })), removed: [] };
  }
  leadsOn = await hasGroup("crm.group_use_lead");
}

function sectionHtml(key) {
  const section = SECTIONS[key];
  const rows = data[key].rows
    .map(
      (row, i) => `<tr>${section.columns
        .map((c) => {
          const v = row.values[c.key];
          if (c.type === "check") return `<td class="py-2 px-3 w-32"><input type="checkbox" data-sec="${key}" data-row="${i}" data-col="${c.key}" ${v ? "checked" : ""} class="rounded border-gray-300 text-indigo-600" aria-label="${esc(c.label)}"></td>`;
          return `<td class="py-2 px-3 ${c.type === "number" ? "w-28" : ""}"><input ${c.type === "number" ? 'type="number" step="1"' : ""} data-sec="${key}" data-row="${i}" data-col="${c.key}" value="${esc(v)}" class="${INPUT} ${c.type === "number" ? "text-right" : ""}" aria-label="${esc(c.label)}"></td>`;
        })
        .join("")}
        <td class="py-2 px-3 w-10 text-center"><button type="button" data-action="row-remove" data-sec="${key}" data-row="${i}" class="text-gray-400 hover:text-rose-600" aria-label="Hapus baris"><i class="fas fa-trash-alt"></i></button></td></tr>`,
    )
    .join("");
  return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4 overflow-x-auto" id="sec-${key}">
    <div class="px-4 py-3 border-b border-gray-200"><div class="text-sm font-semibold">${esc(section.title)}</div><div class="text-xs text-gray-500 mt-0.5">${esc(section.hint)}</div></div>
    <table class="w-full text-left"><thead class="bg-gray-50"><tr>${section.columns.map((c) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase">${esc(c.label)}</th>`).join("")}<th></th></tr></thead><tbody class="divide-y divide-gray-100">${rows}</tbody></table>
    <div class="px-4 py-3 border-t border-gray-100 flex gap-2">
      <button type="button" data-action="row-add" data-sec="${key}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-plus mr-1"></i>Tambah baris</button>
      <button type="button" data-action="sec-save" data-sec="${key}" class="px-3 py-1 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">Simpan ${esc(section.title)}</button></div></section>`;
}

export async function render() {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  if (!data) await load();
  app.innerHTML =
    pageHeader("CRM Setting") +
    `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-4"><div class="text-sm font-semibold mb-3">Fitur CRM</div>
       <label class="flex items-start gap-3 text-sm"><input type="checkbox" data-feature="group_use_lead" ${leadsOn ? "checked" : ""} class="mt-1 rounded border-gray-300 text-indigo-600">
         <span><span class="font-medium text-gray-900">Leads</span><span class="block text-gray-500">Kontak masuk ditampung sebagai lead lebih dulu, lalu dikonversi menjadi opportunity. Tanpa ini, kontak baru langsung menjadi opportunity.</span></span></label>
       <div class="mt-4"><button data-action="apply-features" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Terapkan Fitur</button></div></section>` +
    Object.keys(SECTIONS).map(sectionHtml).join("");
}

async function saveSection(key) {
  const section = SECTIONS[key];
  const state = data[key];
  const clean = (values) => {
    const out = {};
    for (const c of section.columns) {
      const v = values[c.key];
      out[c.key] = c.type === "number" ? Number(v) || 0 : c.type === "check" ? Boolean(v) : String(v ?? "").trim();
    }
    return out;
  };
  for (const row of state.rows) {
    if (!clean(row.values).name) throw new Error(`${section.title}: nama tidak boleh kosong.`);
  }
  if (state.removed.length) await call(section.model, "unlink", { ids: state.removed });
  for (const row of state.rows) {
    const values = clean(row.values);
    if (!row.id) await call(section.model, "create", { vals_list: [values] });
    else {
      const before = clean(row.initial);
      const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => v !== before[k]));
      if (Object.keys(changed).length) await call(section.model, "write", { ids: [row.id], vals: changed });
    }
  }
  return true;
}

export async function onClick(event, el) {
  const { action, sec } = el.dataset;
  if (action === "row-add") {
    data[sec].rows.push({ id: null, values: SECTIONS[sec].blank(), initial: SECTIONS[sec].blank() });
    document.querySelector(`#sec-${sec}`).outerHTML = sectionHtml(sec);
  } else if (action === "row-remove") {
    const [removed] = data[sec].rows.splice(Number(el.dataset.row), 1);
    if (removed?.id) data[sec].removed.push(removed.id);
    document.querySelector(`#sec-${sec}`).outerHTML = sectionHtml(sec);
  } else if (action === "sec-save") {
    const ok = await guarded(el, () => saveSection(sec));
    if (ok) {
      resetReferences();
      data = null;
      toast(`${SECTIONS[sec].title} disimpan.`);
      render();
    }
  } else if (action === "apply-features") {
    const ok = await guarded(el, async () => {
      const [id] = await call("res.config.settings", "create", { vals_list: [{ group_use_lead: Boolean(document.querySelector('[data-feature="group_use_lead"]').checked) }] });
      await call("res.config.settings", "execute", { ids: [id] });
      return true;
    });
    if (ok) {
      resetReferences();
      data = null;
      toast("Fitur CRM diterapkan.");
      render();
    }
  }
}

export function onInput(event, el) {
  const { sec, col } = el.dataset;
  if (!sec || !data) return;
  const row = data[sec].rows[Number(el.dataset.row)];
  row.values[col] = el.type === "checkbox" ? el.checked : el.value;
}
