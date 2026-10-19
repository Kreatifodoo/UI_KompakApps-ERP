// Routes (stock.route): daftar rute dan form rute dengan tempat rute bisa dipilih (produk, kategori, gudang, kemasan, Sales Order),
// gudang yang memakai, dan tabel aturan di dalamnya (D81). Rute dan aturan bawaan gudang diberi peringatan dan konfirmasi sebelum diubah;
// rute yang sudah dipakai diarsipkan, bukan dihapus.
import {
  INPUT, app, badge, button, call, cell, esc, fieldBlock, filterSelect, guarded, pageHeader, readOne, referenceWarehouses, resetReferences, rowLink, searchBox, searchRead,
  statTiles, table, toast,
} from "../common.js";
import {
  ACTION_SHORT, BUILTIN_CONFIRM, BUILTIN_NOTE, PROCURE, SELECTABLE, featureHints, flowText, friendlyRuleError, isBuiltinRule, loadBuiltin, note, routeFieldNames, routeUsage,
  selectableText,
} from "../routerules.js";

const FILTERS = [["active", "Rute aktif"], ["archived", "Diarsipkan"]];
const STATUS = { active: ["Aktif", "ok"], archived: ["Diarsipkan", "muted"] };

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
  const state = query.get("state") || "active";
  const text = query.get("q") ?? "";
  const use = query.get("use") ?? "";
  const names = await routeFieldNames();
  const useOptions = SELECTABLE.filter(([key]) => names.has(key));
  const domain = [];
  if (use && names.has(use)) domain.push([use, "=", true]);
  if (text) domain.push(["name", "ilike", text]);
  if (state === "archived") domain.push(["active", "=", false]);
  const [rows, builtin, hints, warehouses] = await Promise.all([
    searchRead("stock.route", domain, ["name", "active", "sequence", "warehouse_ids", "rule_ids", ...useOptions.map(([key]) => key)], {
      order: "sequence, name", limit: 300, context: { active_test: state !== "archived" },
    }),
    loadBuiltin(),
    featureHints(),
    referenceWarehouses(),
  ]);
  const whName = new Map(warehouses.map((w) => [w.id, w.code || w.display_name]));
  const body = rows
    .map((r) =>
      rowLink(`#/route/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(selectableText(r)),
        cell(r.warehouse_ids.map((id) => whName.get(id) ?? id).join(", ") || "-"),
        cell(r.rule_ids.length, { right: true }),
        cell(`${badge(STATUS, r.active ? "active" : "archived")}${builtin.routes.has(r.id) ? ' <span class="px-2 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800">Bawaan gudang</span>' : ""}`, { raw: true }),
      ]),
    )
    .join("");
  const useSelect = `<select data-route-use class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" aria-label="Dapat dipilih pada"><option value="">Dapat dipilih pada: semua</option>${useOptions
    .map(([key, label]) => `<option value="${key}" ${use === key ? "selected" : ""}>${esc(label)}</option>`)
    .join("")}</select>`;
  app.innerHTML =
    pageHeader(
      "Routes",
      `${searchBox(text, "Cari rute")}${useSelect}${filterSelect(FILTERS, state)}
       <a href="#/rule" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-list-check mr-2"></i>Semua Aturan</a>
       <a href="#/route/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Rute Baru</a>`,
    ) +
    hints +
    table([{ label: "Rute" }, { label: "Dapat Dipilih Pada" }, { label: "Gudang" }, { label: "Aturan", right: true }, { label: "Status" }], body, "Belum ada rute yang cocok.") +
    '<p class="text-xs text-gray-500 mt-3">Rute adalah kumpulan aturan pengadaan dan perpindahan barang (beli, produksi, tarik dari gudang lain, simpan setelah terima). Pasang rute pada produk, kategori produk, atau gudang agar aturannya dipakai. Rute bawaan gudang dibuat otomatis dan sebaiknya tidak diubah.</p>';
}

const READ_FIELDS = ["name", "active", "sequence", "company_id", "warehouse_ids", "rule_ids", "product_ids", "categ_ids", "supplied_wh_id", "supplier_wh_id"];

function valuesOf(record, names) {
  const values = { name: record?.name ?? "", sequence: record?.sequence ?? 0, warehouse_ids: [...(record?.warehouse_ids ?? [])].sort((a, b) => a - b) };
  for (const [key] of SELECTABLE) if (names.has(key)) values[key] = key === "product_selectable" && !record ? true : Boolean(record?.[key]);
  return values;
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const names = await routeFieldNames();
  const [warehouses, builtin, hints] = await Promise.all([referenceWarehouses(), loadBuiltin(), featureHints()]);
  let route = null;
  if (id) {
    route = await readOne("stock.route", id, [...READ_FIELDS, ...SELECTABLE.filter(([key]) => names.has(key)).map(([key]) => key)]);
    if (!route) {
      app.innerHTML = '<p class="text-sm text-rose-600">Rute tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (route?.id ?? null)) {
    const values = valuesOf(route, names);
    form = { id: route?.id ?? null, values, initial: route ? { ...values, warehouse_ids: [...values.warehouse_ids] } : null };
  }
  const v = form.values;
  const isBuiltin = Boolean(route && builtin.routes.has(route.id));
  const [rules, usage] = route
    ? await Promise.all([
        searchRead("stock.rule", [["route_id", "=", route.id]], ["name", "sequence", "action", "picking_type_id", "location_src_id", "location_dest_id", "procure_method", "warehouse_id", "active"], { order: "sequence, id", context: { active_test: false } }),
        routeUsage(route.id),
      ])
    : [[], null];
  const inUse = usage ? usage.products + usage.categories + usage.warehouses + usage.moves > 0 : false;
  const tiles = route
    ? statTiles([
        { count: rules.length, label: "Aturan", icon: "fa-list-check", always: true },
        { count: usage.products, label: "Produk memakai", icon: "fa-box" },
        { count: usage.categories, label: "Kategori memakai", icon: "fa-tags" },
        { count: usage.warehouses, label: "Gudang memakai", icon: "fa-warehouse" },
        { count: usage.moves, label: "Pergerakan stok", icon: "fa-right-left" },
      ])
    : "";
  const selectable = SELECTABLE.filter(([key]) => names.has(key))
    .map(
      ([key, label, help]) => `<label class="flex items-start gap-3 text-sm"><input type="checkbox" data-rt="${key}" ${v[key] ? "checked" : ""} class="mt-1 rounded border-gray-300 text-indigo-600">
        <span><span class="font-medium text-gray-900">${esc(label)}</span><span class="block text-xs text-gray-500">${esc(help)}</span></span></label>`,
    )
    .join("");
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/route" class="hover:text-indigo-600">Routes</a> / ${esc(route?.name ?? "Baru")}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      ${route ? button("toggle-active", route.active ? "Arsipkan" : "Aktifkan Kembali", route.active ? "danger" : "primary", { id: route.id }) : ""}
      ${route && !isBuiltin && !inUse ? button("delete", "Hapus", "danger", { id: route.id }) : ""}
    </div>
    ${tiles ? `<div class="flex flex-wrap gap-2 mb-4">${tiles}</div>` : ""}
    <div class="mb-3 flex flex-wrap items-center gap-3"><h1 class="text-2xl font-bold text-gray-900">${esc(route?.name ?? "Rute Baru")}</h1>
      ${route && !route.active ? badge(STATUS, "archived") : ""}${isBuiltin ? '<span class="px-2 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800">Bawaan gudang</span>' : ""}</div>
    ${hints}
    ${isBuiltin ? `<div class="mb-4">${note(esc(BUILTIN_NOTE), "warn")}</div>` : ""}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama Rute", `<input data-rt="name" value="${esc(v.name)}" placeholder="mis. Kirim dari Gudang Pusat" class="${INPUT}">`)}
      ${fieldBlock("Urutan", `<input type="number" step="1" data-rt="sequence" data-kind="number" value="${esc(v.sequence)}" class="${INPUT} text-right">`)}
      <div class="md:col-span-2"><div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Dapat dipilih pada</div><div class="grid md:grid-cols-3 gap-4">${selectable}</div>
        <p class="text-xs text-gray-500 mt-2">Urutan menentukan rute mana yang dicoba lebih dulu bila beberapa rute cocok (angka kecil lebih dulu). Rute yang dipasang langsung pada produk dicoba sebelum rute kategori dan gudang.</p></div>
      <div class="md:col-span-2" id="rt-warehouses">${warehouseBox(warehouses)}</div>
      ${route && (route.supplied_wh_id || route.supplier_wh_id) ? `<div class="md:col-span-2">${note(`Rute suplai antar gudang: disuplai gudang <b>${esc(route.supplier_wh_id?.[1] ?? "-")}</b> ke gudang <b>${esc(route.supplied_wh_id?.[1] ?? "-")}</b>. Diatur dari Warehouse & Location Master (Disuplai dari).`)}</div>` : ""}
      ${route?.company_id ? fieldBlock("Perusahaan", `<div class="py-2 text-sm font-medium text-gray-900">${esc(route.company_id[1])}</div>`) : ""}
    </section>
    <div class="flex gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/route" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a></div>
    ${route ? rulesSection(route, rules, builtin) : '<p class="mt-6 text-sm text-gray-500">Simpan rute terlebih dahulu untuk menambahkan aturan.</p>'}`;
}

/** Daftar gudang yang memakai rute; hanya tampil bila rute dapat dipilih pada gudang. */
function warehouseBox(warehouses) {
  const v = form.values;
  if (!("warehouse_selectable" in v) || !v.warehouse_selectable) return "";
  const boxes = warehouses.length
    ? warehouses.map((w) => `<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-rt-wh="${w.id}" ${v.warehouse_ids.includes(w.id) ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"><span>${esc(w.display_name)} <span class="text-gray-500">(${esc(w.code)})</span></span></label>`).join("")
    : '<p class="text-sm text-gray-500">Belum ada gudang.</p>';
  return fieldBlock("Gudang yang memakai rute ini", `<div class="mt-1 grid sm:grid-cols-2 gap-2">${boxes}</div>`) +
    '<p class="text-xs text-amber-800 mt-2">Hati-hati: barang yang melewati gudang terpilih mengikuti rute ini bila produknya tidak punya rute sendiri, dan rute ini dicoba menurut Urutan bersama rute bawaan gudang (penerimaan, pengiriman). Aturan dengan tujuan yang sama dan urutan lebih kecil menggantikan alur bawaan untuk SEMUA produk di gudang itu.</p>';
}

function rulesSection(route, rules, builtin) {
  const rows = rules
    .map(
      (r) => rowLink(`#/rule/${r.id}`, [
        cell(r.sequence, { right: true }), cell(r.name, { strong: true }), cell(ACTION_SHORT[r.action] ?? r.action), cell(r.picking_type_id?.[1] ?? "-"), cell(flowText(r)),
        cell(r.action === "buy" || r.action === "manufacture" || r.action === "push" ? "-" : PROCURE[r.procure_method] ?? r.procure_method),
        cell(`${r.active ? "" : badge(STATUS, "archived")}${isBuiltinRule(builtin, r) ? ' <span class="px-2 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800">Bawaan</span>' : ""}`, { raw: true }),
        cell(isBuiltinRule(builtin, r) ? "" : `<button type="button" data-action="rule-delete" data-id="${r.id}" class="text-gray-400 hover:text-rose-600" aria-label="Hapus aturan"><i class="fas fa-trash-alt"></i></button>`, { raw: true }),
      ]),
    )
    .join("");
  return `<section class="mt-6"><div class="flex items-center justify-between mb-2"><div class="text-sm font-semibold text-gray-900">Aturan dalam rute ini</div>
      <a href="#/rule/new?route=${route.id}" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-plus mr-2"></i>Aturan Baru</a></div>
    ${table([{ label: "Urutan", right: true }, { label: "Aturan" }, { label: "Aksi" }, { label: "Tipe Operasi" }, { label: "Dari -> Ke" }, { label: "Metode" }, { label: "" }, { label: "" }], rows, "Rute ini belum punya aturan. Tanpa aturan, rute tidak berbuat apa-apa.")}
    <p class="text-xs text-gray-500 mt-2">Aturan dipakai berurutan menurut kolom Urutan. Aturan yang sudah dipakai pergerakan stok tidak bisa dihapus; arsipkan lewat form aturan.</p></section>`;
}

async function persist() {
  const v = form.values;
  if (!v.name.trim()) throw new Error("Nama rute wajib diisi.");
  const names = await routeFieldNames();
  const vals = { name: v.name.trim(), sequence: Number(v.sequence) || 0 };
  for (const [key] of SELECTABLE) if (names.has(key)) vals[key] = Boolean(v[key]);
  if (!v.warehouse_selectable) v.warehouse_ids = [];
  if (!form.id) {
    if (v.warehouse_ids.length) vals.warehouse_ids = [[6, 0, v.warehouse_ids]];
    const [id] = await call("stock.route", "create", { vals_list: [vals] });
    return id;
  }
  const changed = {};
  for (const key of Object.keys(vals)) if (JSON.stringify(vals[key]) !== JSON.stringify(form.initial[key])) changed[key] = vals[key];
  if (v.warehouse_ids.join() !== form.initial.warehouse_ids.join()) changed.warehouse_ids = [[6, 0, v.warehouse_ids]];
  if (Object.keys(changed).length) {
    if (form.builtin && !window.confirm(BUILTIN_CONFIRM)) return null;
    await call("stock.route", "write", { ids: [form.id], vals: changed });
  }
  return form.id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "save") {
    form.builtin = (await loadBuiltin()).routes.has(form.id);
    const saved = await guarded(el, async () => {
      try {
        return await persist();
      } catch (error) {
        throw new Error(friendlyRuleError(error.message));
      }
    });
    if (saved) {
      const wasNew = !form.id;
      form = null;
      resetReferences();
      toast(wasNew ? "Rute dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/route/${saved}`;
      else reload();
    }
  } else if (action === "toggle-active") {
    const archiving = el.textContent.trim() === "Arsipkan";
    const id = Number(el.dataset.id);
    const builtin = (await loadBuiltin()).routes.has(id);
    if (archiving && !window.confirm(builtin ? `${BUILTIN_CONFIRM}\n\nMengarsipkan juga menonaktifkan semua aturannya.` : "Arsipkan rute ini? Aturannya ikut dinonaktifkan; data lama tetap utuh.")) return;
    const ok = await guarded(el, () => call("stock.route", "write", { ids: [id], vals: { active: !archiving } }));
    if (ok !== undefined) {
      form = null;
      resetReferences();
      toast(archiving ? "Rute diarsipkan." : "Rute diaktifkan kembali.");
      reload();
    }
  } else if (action === "delete") {
    if (!window.confirm("Hapus rute ini beserta semua aturannya? Tindakan ini tidak bisa dibatalkan.")) return;
    const ok = await guarded(el, async () => {
      try {
        return await call("stock.route", "unlink", { ids: [Number(el.dataset.id)] });
      } catch (error) {
        throw new Error(friendlyRuleError(error.message));
      }
    });
    if (ok !== undefined) {
      form = null;
      resetReferences();
      toast("Rute dihapus.");
      location.hash = "#/route";
    }
  } else if (action === "rule-delete") {
    const id = Number(el.dataset.id);
    const used = await call("stock.move", "search_count", { domain: [["rule_id", "=", id]] });
    if (used) {
      if (!window.confirm(`Aturan ini sudah dipakai ${used} pergerakan stok, jadi tidak bisa dihapus. Arsipkan saja?`)) return;
      const ok = await guarded(el, () => call("stock.rule", "write", { ids: [id], vals: { active: false } }));
      if (ok !== undefined) {
        toast("Aturan diarsipkan.");
        reload();
      }
      return;
    }
    if (!window.confirm("Hapus aturan ini?")) return;
    const ok = await guarded(el, () => call("stock.rule", "unlink", { ids: [id] }));
    if (ok !== undefined) {
      toast("Aturan dihapus.");
      reload();
    }
  }
}

export function onInput(event, el) {
  if (!form || !el.dataset.rt) return;
  const key = el.dataset.rt;
  if (el.type === "checkbox") {
    form.values[key] = el.checked;
    if (key === "warehouse_selectable") {
      if (!el.checked) form.values.warehouse_ids = [];
      referenceWarehouses().then((list) => {
        document.querySelector("#rt-warehouses").innerHTML = warehouseBox(list);
      });
    }
  } else form.values[key] = el.dataset.kind === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
}

export function onChange(event, el) {
  if (el.dataset.routeUse !== undefined) {
    const [path, queryText = ""] = location.hash.replace(/^#\/?/, "").split("?");
    const params = new URLSearchParams(queryText);
    if (el.value) params.set("use", el.value);
    else params.delete("use");
    const qs = params.toString();
    location.hash = `#/${path}${qs ? `?${qs}` : ""}`;
  } else if (form && el.dataset.rtWh) {
    const id = Number(el.dataset.rtWh);
    form.values.warehouse_ids = (el.checked ? [...new Set([...form.values.warehouse_ids, id])] : form.values.warehouse_ids.filter((x) => x !== id)).sort((a, b) => a - b);
  }
}
