// Rules (stock.rule): daftar semua aturan (filter rute, gudang, aksi) dan form aturan lengkap: aksi, tipe operasi, lokasi asal dan tujuan
// (kotak saran), metode pengadaan, penundaan, propagasi pembatalan, gudang, dan untuk Dorong: jenis gerakan dan syarat penerapan (D81).
// Pilihan yang tak berlaku untuk suatu aksi disembunyikan, kombinasi tak sah ditolak dengan pesan jelas, dan aturan bawaan gudang
// diberi peringatan dan konfirmasi. Aturan yang sudah dipakai pergerakan stok diarsipkan, bukan dihapus.
import {
  INPUT, app, badge, button, call, cell, closeLookup, esc, fieldBlock, filterSelect, guarded, pageHeader, readOne, referenceWarehouses, registerLookup, resetReferences, rowLink, runLookup,
  searchBox, searchRead, statTiles, table, toast,
} from "../common.js";
import {
  ACTIONS, ACTION_HELP, ACTION_PICKING_CODE, ACTION_SHORT, AUTO, AUTO_HELP, BUILTIN_CONFIRM, BUILTIN_NOTE, PICKING_CODES, PROCURE, PROCURE_HELP, featureHints, flowText,
  friendlyRuleError, isBuiltinRule, loadBuiltin, note, ruleMoves, ruleProblem, ruleSentence,
} from "../routerules.js";

const FILTERS = [["active", "Aturan aktif"], ["archived", "Diarsipkan"]];
const STATUS = { archived: ["Diarsipkan", "muted"] };
const USAGE = { internal: "Internal", supplier: "Pemasok", customer: "Pelanggan", inventory: "Inventory Loss", production: "Produksi", transit: "Transit" };
const LIST_FIELDS = ["name", "sequence", "route_id", "action", "picking_type_id", "location_src_id", "location_dest_id", "procure_method", "warehouse_id", "active"];
const FORM_FIELDS = [...LIST_FIELDS, "delay", "propagate_cancel", "auto", "push_domain", "company_id"];

let form = null; // { id, values, initial, builtin, pendingSrc, pendingDest, fromRoute }
let refs = null; // { routes, pickings, warehouses }
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
  refs = null;
};
const reload = () => render(last.sub, last.query);

const searchLocations = (q) =>
  searchRead("stock.location", [["usage", "!=", "view"], ...(q ? [["complete_name", "ilike", q]] : [])], ["display_name", "usage"], { limit: 12, order: "complete_name" });
for (const [kind, key, pending] of [["rule-src", "src", "pendingSrc"], ["rule-dest", "dest", "pendingDest"]]) {
  registerLookup(kind, {
    search: searchLocations,
    sub: (r) => USAGE[r.usage] ?? r.usage,
    isChosen: (input) => form?.values[key]?.display_name === input.value,
    choose: (input, item) => {
      form.values[key] = { id: item.id, display_name: item.display_name };
      form[pending] = false;
      input.value = item.display_name;
      paintSummary();
    },
  });
}

async function loadRefs() {
  const [routes, pickings, warehouses] = await Promise.all([
    searchRead("stock.route", [], ["display_name", "company_id"], { order: "sequence, name" }),
    searchRead("stock.picking.type", [], ["display_name", "code", "default_location_src_id", "default_location_dest_id", "warehouse_id"], { order: "sequence, id" }),
    referenceWarehouses(),
  ]);
  refs = { routes, pickings, warehouses };
}

export async function render(sub, query) {
  last = { sub, query };
  if (!refs) await loadRefs();
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub), query);
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const state = query.get("state") || "active";
  const text = query.get("q") ?? "";
  const routeId = Number(query.get("route")) || null;
  const whId = Number(query.get("wh")) || null;
  const action = query.get("action") || "";
  const domain = [];
  if (routeId) domain.push(["route_id", "=", routeId]);
  if (whId) domain.push(["warehouse_id", "=", whId]);
  if (action) domain.push(["action", "=", action]);
  if (text) domain.push(["name", "ilike", text]);
  if (state === "archived") domain.push(["active", "=", false]);
  const [rows, builtin, hints] = await Promise.all([
    searchRead("stock.rule", domain, LIST_FIELDS, { order: "route_sequence, sequence, id", limit: 300, context: { active_test: state !== "archived" } }),
    loadBuiltin(),
    featureHints(),
  ]);
  const body = rows
    .map((r) =>
      rowLink(`#/rule/${r.id}`, [
        cell(r.name, { strong: true }), cell(r.route_id[1]), cell(ACTION_SHORT[r.action] ?? r.action), cell(r.picking_type_id?.[1] ?? "-"), cell(flowText(r)),
        cell(["pull", "pull_push"].includes(r.action) ? PROCURE[r.procure_method] ?? r.procure_method : "-"), cell(r.warehouse_id?.[1] ?? "-"),
        cell(`${r.active ? "" : badge(STATUS, "archived")}${isBuiltinRule(builtin, r) ? ' <span class="px-2 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800">Bawaan</span>' : ""}`, { raw: true }),
      ]),
    )
    .join("");
  const select = (key, label, options, value) =>
    `<select data-rule-filter="${key}" class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" aria-label="${esc(label)}"><option value="">${esc(label)}</option>${options
      .map(([k, l]) => `<option value="${esc(k)}" ${String(value) === String(k) ? "selected" : ""}>${esc(l)}</option>`)
      .join("")}</select>`;
  app.innerHTML =
    pageHeader(
      "Rules",
      `${searchBox(text, "Cari aturan")}
       ${select("route", "Semua rute", refs.routes.map((r) => [r.id, r.display_name]), routeId ?? "")}
       ${select("wh", "Semua gudang", refs.warehouses.map((w) => [w.id, w.display_name]), whId ?? "")}
       ${select("action", "Semua aksi", Object.entries(ACTIONS), action)}
       ${filterSelect(FILTERS, state)}
       <a href="#/route" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-route mr-2"></i>Routes</a>
       <a href="#/rule/new${routeId ? `?route=${routeId}` : ""}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Aturan Baru</a>`,
    ) +
    hints +
    table([{ label: "Aturan" }, { label: "Rute" }, { label: "Aksi" }, { label: "Tipe Operasi" }, { label: "Dari -> Ke" }, { label: "Metode" }, { label: "Gudang" }, { label: "Status" }], body, "Belum ada aturan yang cocok.") +
    '<p class="text-xs text-gray-500 mt-3">Aturan menjelaskan cara barang dipasok ke satu lokasi: ditarik dari lokasi lain, didorong setelah tiba, dibeli, atau diproduksi. Aturan hanya dipakai bila rutenya terpasang pada produk, kategori produk, atau gudang.</p>' +
    (rows.length >= 300 ? '<p class="text-xs text-gray-500 mt-1">Menampilkan 300 pertama; gunakan pencarian atau filter.</p>' : "");
}

const asRef = (value) => (Array.isArray(value) ? { id: value[0], display_name: value[1] } : null);

function valuesOf(rule, query) {
  if (rule) {
    return {
      name: rule.name, route: rule.route_id[0], action: rule.action, picking: rule.picking_type_id?.[0] ?? null, src: asRef(rule.location_src_id), dest: asRef(rule.location_dest_id),
      procure_method: rule.procure_method, delay: rule.delay ?? 0, propagate_cancel: Boolean(rule.propagate_cancel), warehouse: rule.warehouse_id?.[0] ?? null, auto: rule.auto || "manual",
      push_domain: rule.push_domain || "", sequence: rule.sequence ?? 20,
    };
  }
  const routeId = Number(query.get("route")) || null;
  return {
    name: "", route: routeId, action: "pull", picking: null, src: null, dest: null, procure_method: "make_to_stock", delay: 0, propagate_cancel: false, warehouse: null, auto: "manual",
    push_domain: "", sequence: 20,
  };
}

async function renderForm(id, query) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  let rule = null;
  if (id) {
    rule = await readOne("stock.rule", id, FORM_FIELDS);
    if (!rule) {
      app.innerHTML = '<p class="text-sm text-rose-600">Aturan tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (rule?.id ?? null)) {
    const values = valuesOf(rule, query);
    form = {
      id: rule?.id ?? null, values, initial: rule ? { ...values, src: values.src?.id ?? null, dest: values.dest?.id ?? null } : null, pendingSrc: false, pendingDest: false,
      fromRoute: Number(query.get("route")) || null,
    };
  }
  const [builtin, hints, moves] = await Promise.all([loadBuiltin(), featureHints(), rule ? ruleMoves(rule.id) : 0]);
  form.builtin = Boolean(rule && isBuiltinRule(builtin, rule));
  form.company = rule?.company_id ?? null;
  const routeId = form.values.route;
  const routeName = refs.routes.find((r) => r.id === routeId)?.display_name;
  const title = rule?.name ?? "Aturan Baru";
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/rule" class="hover:text-indigo-600">Rules</a>${routeId ? ` / <a href="#/route/${routeId}" class="hover:text-indigo-600">${esc(routeName ?? "Rute")}</a>` : ""} / ${esc(rule?.name ?? "Baru")}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      ${rule ? button("toggle-active", rule.active ? "Arsipkan" : "Aktifkan Kembali", rule.active ? "danger" : "primary", { id: rule.id }) : ""}
      ${rule && !form.builtin && !moves ? button("delete", "Hapus", "danger", { id: rule.id }) : ""}
    </div>
    ${rule ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([{ count: moves, label: "Pergerakan stok dari aturan ini", icon: "fa-right-left", always: true }])}</div>` : ""}
    <div class="mb-3 flex flex-wrap items-center gap-3"><h1 class="text-2xl font-bold text-gray-900">${esc(title)}</h1>
      ${rule && !rule.active ? badge(STATUS, "archived") : ""}${form.builtin ? '<span class="px-2 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-800">Bawaan</span>' : ""}</div>
    ${hints}
    ${form.builtin ? `<div class="mb-4">${note(esc(BUILTIN_NOTE), "warn")}</div>` : ""}
    <div id="rule-body">${body()}</div>
    <div class="flex gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="${form.fromRoute ? `#/route/${form.fromRoute}` : "#/rule"}" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a></div>`;
}

const pickingOf = (v) => refs.pickings.find((p) => p.id === v.picking) ?? null;
const warehouseName = (v) => refs.warehouses.find((w) => w.id === v.warehouse)?.display_name ?? "";
const compatiblePickings = (action) => refs.pickings.filter((p) => !ACTION_PICKING_CODE[action] || p.code === ACTION_PICKING_CODE[action]);

/** Isi form menurut aksi: isian yang tak berlaku untuk aksi itu disembunyikan agar tidak membingungkan. */
function body() {
  const v = form.values;
  const a = v.action;
  const pull = a === "pull" || a === "pull_push";
  const push = a === "push" || a === "pull_push";
  const options = (list, current, blank) => (blank ? `<option value="">${esc(blank)}</option>` : "") + list.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(current ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("");
  const lookup = (kind, value, placeholder) =>
    `<input data-lookup="${kind}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(value?.display_name ?? "")}" placeholder="${esc(placeholder)}" class="${INPUT}">`;
  const help = (text, id = "") => `<div class="text-xs text-gray-500 mt-1" ${id ? `id="${id}"` : ""}>${esc(text)}</div>`;
  const pickings = compatiblePickings(a).map((p) => [p.id, `${p.display_name} (${PICKING_CODES[p.code] ?? p.code})`]);
  const srcLabel = a === "manufacture" ? "Lokasi Asal Komponen (opsional)" : push && !pull ? "Lokasi Asal (tempat barang tiba)" : "Lokasi Asal";
  return `
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama Aturan", `<input data-ru="name" value="${esc(v.name)}" placeholder="mis. Stock -> Pelanggan" class="${INPUT}">${help("Nama dipakai sebagai sumber (origin) pada transfer yang dibuat.")}`)}
      ${fieldBlock("Rute", `<select data-ru="route" data-kind="id" class="${INPUT}">${options(refs.routes.map((r) => [r.id, r.display_name]), v.route, "- pilih rute -")}</select>`)}
      ${fieldBlock("Aksi", `<select data-ru="action" class="${INPUT}">${options(Object.entries(ACTIONS), a)}</select>${help(ACTION_HELP[a] ?? "", "ru-action-help")}`)}
      ${fieldBlock("Tipe Operasi", `<select data-ru="picking" data-kind="id" class="${INPUT}">${options(pickings, v.picking, "- pilih tipe operasi -")}</select>${help(ACTION_PICKING_CODE[a] ? `Aksi ini hanya memakai tipe operasi ${PICKING_CODES[ACTION_PICKING_CODE[a]]}. Memilih tipe operasi mengisi lokasi asal dan tujuan bawaannya.` : "Dokumen yang dibuat aturan ini. Memilih tipe operasi mengisi lokasi asal dan tujuan bawaannya.")}`)}
      ${a === "buy" ? "" : fieldBlock(srcLabel, `${lookup("rule-src", v.src, "Cari lokasi...")}${help(a === "manufacture" ? "Tempat komponen diambil saat MO dibuat; kosong = lokasi bawaan tipe operasi produksi." : push && !pull ? "Aturan berlaku saat barang tiba di lokasi ini." : "Dari lokasi inilah barang diambil.")}`)}
      ${fieldBlock("Lokasi Tujuan", `${lookup("rule-dest", v.dest, "Cari lokasi...")}${help(a === "buy" || a === "manufacture" ? "Lokasi tempat barang dibutuhkan; kosong tidak diizinkan." : "Ke lokasi inilah barang dikirim.")}`)}
      ${pull ? fieldBlock("Metode Pengadaan", `<select data-ru="procure_method" class="${INPUT}">${options(Object.entries(PROCURE), v.procure_method)}</select>${help(PROCURE_HELP[v.procure_method] ?? "", "ru-procure-help")}`) : ""}
      ${a === "buy" ? "" : fieldBlock("Penundaan (hari)", `<input type="number" min="0" step="1" data-ru="delay" data-kind="number" value="${esc(v.delay)}" class="${INPUT} text-right">${help("Lead time: tanggal rencana transfer dimundurkan sebanyak hari ini.")}`)}
      ${fieldBlock("Gudang", `<select data-ru="warehouse" data-kind="id" class="${INPUT}">${options(refs.warehouses.map((w) => [w.id, w.display_name]), v.warehouse, "- semua gudang -")}</select>${help("Kosong = berlaku untuk semua gudang. Isi bila aturan khusus satu gudang.")}`)}
      ${fieldBlock("Urutan", `<input type="number" step="1" data-ru="sequence" data-kind="number" value="${esc(v.sequence)}" class="${INPUT} text-right">${help("Aturan dalam satu rute dicoba dari angka terkecil.")}`)}
      ${push ? fieldBlock("Jenis Gerakan (Dorong)", `<select data-ru="auto" class="${INPUT}">${options(Object.entries(AUTO), v.auto)}</select>${help(AUTO_HELP[v.auto] ?? "", "ru-auto-help")}`) : ""}
      ${push ? fieldBlock("Syarat Penerapan (Dorong, opsional)", `<input data-ru="push_domain" value="${esc(v.push_domain)}" placeholder='mis. [("product_id.categ_id", "=", 3)]' class="${INPUT}">${help("Domain Odoo: aturan hanya dipakai untuk transfer yang cocok. Kosong = selalu.")}`) : ""}
      ${a === "buy" || a === "manufacture" ? "" : `<div class="md:col-span-2"><label class="flex items-start gap-3 text-sm"><input type="checkbox" data-ru="propagate_cancel" ${v.propagate_cancel ? "checked" : ""} class="mt-1 rounded border-gray-300 text-indigo-600"><span><span class="font-medium text-gray-900">Batalkan transfer berikutnya</span><span class="block text-xs text-gray-500">Bila transfer dari aturan ini dibatalkan, transfer lanjutannya ikut dibatalkan.</span></span></label></div>`}
      <div class="md:col-span-2" id="rule-summary">${summary()}</div>
    </section>`;
}

const summary = () => note(`<b>Ringkasan:</b> ${esc(ruleSentence(form.values, pickingOf(form.values), warehouseName(form.values)))}`);
function paintSummary() {
  const el = document.querySelector("#rule-summary");
  if (el && form) el.innerHTML = summary();
}
function paintBody() {
  closeLookup();
  document.querySelector("#rule-body").innerHTML = body();
}

async function persist() {
  const v = form.values;
  if (form.pendingSrc || form.pendingDest) throw new Error("Pilih lokasi dari kotak saran, atau kosongkan isiannya.");
  const picking = pickingOf(v);
  const problem = ruleProblem(v, picking);
  if (problem) throw new Error(problem);
  const a = v.action;
  const pull = a === "pull" || a === "pull_push";
  const push = a === "push" || a === "pull_push";
  const route = refs.routes.find((r) => r.id === v.route);
  const vals = {
    name: v.name.trim(), route_id: v.route, action: a, picking_type_id: v.picking, location_dest_id: v.dest.id, location_src_id: a === "buy" ? false : v.src?.id ?? false,
    delay: a === "buy" ? 0 : Number(v.delay), warehouse_id: v.warehouse || false, sequence: Number(v.sequence) || 0,
    propagate_cancel: a === "buy" || a === "manufacture" ? false : Boolean(v.propagate_cancel),
  };
  if (pull) vals.procure_method = v.procure_method;
  if (push) {
    vals.auto = v.auto;
    vals.push_domain = String(v.push_domain).trim() || false;
  } else vals.push_domain = false;
  if (!form.id) {
    if (route?.company_id) vals.company_id = route.company_id[0];
    const [id] = await call("stock.rule", "create", { vals_list: [vals] });
    return id;
  }
  const init = form.initial;
  const before = {
    name: init.name, route_id: init.route, action: init.action, picking_type_id: init.picking, location_dest_id: init.dest, location_src_id: init.src ?? false, delay: Number(init.delay),
    warehouse_id: init.warehouse || false, sequence: Number(init.sequence) || 0, propagate_cancel: Boolean(init.propagate_cancel), procure_method: init.procure_method,
    auto: init.auto, push_domain: String(init.push_domain).trim() || false,
  };
  const changed = Object.fromEntries(Object.entries(vals).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(before[key])));
  if (Object.keys(changed).length) {
    if (form.builtin && !window.confirm(BUILTIN_CONFIRM)) return null;
    await call("stock.rule", "write", { ids: [form.id], vals: changed });
  }
  return form.id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "save") {
    const saved = await guarded(el, async () => {
      try {
        return await persist();
      } catch (error) {
        throw new Error(friendlyRuleError(error.message));
      }
    });
    if (saved) {
      const wasNew = !form.id;
      const back = form.fromRoute;
      form = null;
      resetReferences();
      toast(wasNew ? "Aturan dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = back ? `#/route/${back}` : `#/rule/${saved}`;
      else reload();
    }
  } else if (action === "toggle-active") {
    const archiving = el.textContent.trim() === "Arsipkan";
    if (archiving && !window.confirm(form?.builtin ? `${BUILTIN_CONFIRM}\n\nAturan diarsipkan tidak dipakai lagi.` : "Arsipkan aturan ini? Aturan tidak dipakai lagi; pergerakan stok lama tetap utuh.")) return;
    const ok = await guarded(el, () => call("stock.rule", "write", { ids: [Number(el.dataset.id)], vals: { active: !archiving } }));
    if (ok !== undefined) {
      form = null;
      toast(archiving ? "Aturan diarsipkan." : "Aturan diaktifkan kembali.");
      reload();
    }
  } else if (action === "delete") {
    if (!window.confirm("Hapus aturan ini? Tindakan ini tidak bisa dibatalkan.")) return;
    const route = form?.values.route;
    const ok = await guarded(el, async () => {
      try {
        return await call("stock.rule", "unlink", { ids: [Number(el.dataset.id)] });
      } catch (error) {
        throw new Error(friendlyRuleError(error.message));
      }
    });
    if (ok !== undefined) {
      form = null;
      toast("Aturan dihapus.");
      location.hash = route ? `#/route/${route}` : "#/rule";
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.lookup === "rule-src" || el.dataset.lookup === "rule-dest") {
    const key = el.dataset.lookup === "rule-src" ? "src" : "dest";
    form.values[key] = null;
    form[key === "src" ? "pendingSrc" : "pendingDest"] = Boolean(el.value.trim());
    runLookup(el, 250);
    paintSummary();
    return;
  }
  const key = el.dataset.ru;
  if (!key) return;
  const v = form.values;
  v[key] = el.type === "checkbox" ? el.checked : el.dataset.kind === "id" ? (el.value ? Number(el.value) : null) : el.dataset.kind === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
  if (key === "action") {
    const need = ACTION_PICKING_CODE[v.action];
    if (need && pickingOf(v)?.code !== need) v.picking = null; // tipe operasi yang tak cocok dengan aksi baru dilepas
    if (v.action === "buy") {
      v.src = null;
      form.pendingSrc = false;
    }
    paintBody();
  } else if (key === "picking") {
    const p = pickingOf(v);
    if (p) {
      v.src = v.action === "buy" ? null : asRef(p.default_location_src_id);
      v.dest = asRef(p.default_location_dest_id);
      form.pendingSrc = false;
      form.pendingDest = false;
    }
    paintBody();
  } else {
    if (key === "procure_method") document.querySelector("#ru-procure-help").textContent = PROCURE_HELP[v.procure_method] ?? "";
    if (key === "auto") document.querySelector("#ru-auto-help").textContent = AUTO_HELP[v.auto] ?? "";
    paintSummary();
  }
}

export function onChange(event, el) {
  if (el.dataset.ruleFilter === undefined) return;
  const [path, queryText = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(queryText);
  if (el.value) params.set(el.dataset.ruleFilter, el.value);
  else params.delete(el.dataset.ruleFilter);
  const qs = params.toString();
  location.hash = `#/${path}${qs ? `?${qs}` : ""}`;
}
