// Bagian bersama halaman Routes dan Rules (stock.route, stock.rule): label Indonesia, penjelasan pilihan, pengenal rute dan aturan bawaan
// gudang (yang tidak boleh dirusak), dan pemeriksaan kombinasi aturan yang tak sah (D81).
import { call, esc, hasGroup, searchRead } from "./common.js";

export const ACTIONS = {
  pull: "Tarik dari (Pull)",
  push: "Dorong ke (Push)",
  pull_push: "Tarik dan Dorong",
  buy: "Beli (RFQ)",
  manufacture: "Produksi (MO)",
};
export const ACTION_SHORT = { pull: "Tarik", push: "Dorong", pull_push: "Tarik dan Dorong", buy: "Beli", manufacture: "Produksi" };
export const ACTION_HELP = {
  pull: "Saat barang dibutuhkan di lokasi tujuan, transfer dibuat dari lokasi asal. Dipakai untuk pengiriman, pengambilan (pick), dan pengisian ulang antar lokasi.",
  push: "Saat barang tiba di lokasi asal, transfer baru dibuat otomatis untuk memindahkannya ke lokasi tujuan. Dipakai untuk penyimpanan setelah penerimaan.",
  pull_push: "Gabungan Tarik dan Dorong: aturan yang sama berlaku untuk kebutuhan barang di tujuan dan untuk barang yang tiba di asal.",
  buy: "Saat barang dibutuhkan di lokasi tujuan, Request for Quotation (RFQ) dibuat ke pemasok produk. Wajib memakai tipe operasi Penerimaan; produk perlu punya pemasok (Vendor Price list).",
  manufacture: "Saat barang dibutuhkan di lokasi tujuan, Manufacturing Order dibuat. Wajib memakai tipe operasi Produksi; produk perlu punya BoM, dan lokasi asal (opsional) adalah tempat komponen diambil.",
};
export const PROCURE = {
  make_to_stock: "Ambil dari stok (MTS)",
  make_to_order: "Picu aturan lain (MTO)",
  mts_else_mto: "Ambil dari stok, bila kurang picu aturan lain",
};
export const PROCURE_HELP = {
  make_to_stock: "Barang diambil dari stok yang tersedia di lokasi asal. Bila stok kurang, transfer menunggu sampai stok ada.",
  make_to_order: "Stok di lokasi asal diabaikan: sistem mencari aturan lain yang memasok barang ke lokasi asal (mis. membeli atau memproduksi sesuai pesanan). Pada Sales Order, ini membuat pengiriman menunggu dokumen pengadaan.",
  mts_else_mto: "Barang diambil dari stok bila tersedia; kekurangannya dipasok lewat aturan lain yang memasok lokasi asal.",
};
export const AUTO = {
  manual: "Operasi manual (membuat transfer baru)",
  transparent: "Otomatis tanpa langkah tambahan (mengganti lokasi tujuan)",
};
export const AUTO_HELP = {
  manual: "Transfer tambahan dibuat setelah transfer sekarang, dan harus diproses sendiri.",
  transparent: "Tidak ada transfer baru: lokasi tujuan transfer yang sedang berjalan diganti ke lokasi tujuan aturan ini.",
};
export const PICKING_CODES = { incoming: "Penerimaan", outgoing: "Pengiriman", internal: "Transfer internal", mrp_operation: "Produksi" };
/** Kode tipe operasi yang diwajibkan menurut aksi (sama dengan domain field Operation Type di Odoo); kosong berarti bebas. */
export const ACTION_PICKING_CODE = { buy: "incoming", manufacture: "mrp_operation" };

/** Tempat rute bisa dipilih. `sale_selectable` hanya ada bila modul penjualan-stok terpasang (dicek lewat fields_get). */
export const SELECTABLE = [
  ["product_selectable", "Produk", "Muncul di kolom Rute pada Product Master."],
  ["product_categ_selectable", "Kategori Produk", "Muncul di kolom Rute pada Product Category (berlaku untuk semua produk di kategori itu)."],
  ["warehouse_selectable", "Gudang", "Menjadi rute bawaan untuk barang yang melewati gudang terpilih."],
  ["package_type_selectable", "Tipe Kemasan", "Dapat dipilih pada tipe kemasan."],
  ["sale_selectable", "Baris Sales Order", "Dapat dipilih per baris Sales Order."],
];

let routeFieldCache = null;
/** Nama field stock.route yang tersedia di instalasi ini. */
export async function routeFieldNames() {
  routeFieldCache ??= call("stock.route", "fields_get", { attributes: ["type"] }).then((f) => new Set(Object.keys(f))).catch((error) => {
    routeFieldCache = null;
    throw error;
  });
  return routeFieldCache;
}

/** Ringkas tempat rute bisa dipilih: "Produk, Kategori, Gudang". */
export const selectableText = (route) =>
  SELECTABLE.filter(([key]) => route[key]).map(([, label]) => label).join(", ") || "Tidak dapat dipilih (hanya dipakai gudang)";

const WH_FIELDS = ["resupply_route_ids", "reception_route_id", "delivery_route_id", "pbm_route_id", "mto_pull_id", "buy_pull_id", "manufacture_pull_id", "manufacture_mto_pull_id", "pbm_mto_pull_id"];

/**
 * Rute dan aturan bawaan: yang dibuat gudang (penerimaan, pengiriman, produksi, Beli, MTO, suplai antar gudang) dan yang dibawa modul Odoo.
 * Mengubahnya dapat merusak alur dokumen, jadi halaman memberi peringatan dan meminta konfirmasi sebelum menyimpan.
 */
export async function loadBuiltin() {
  const [warehouses, xmlids] = await Promise.all([
    searchRead("stock.warehouse", [], WH_FIELDS, { context: { active_test: false } }).catch(() => []),
    searchRead("ir.model.data", [["model", "in", ["stock.route", "stock.rule"]], ["module", "not in", ["__export__", "__import__", "kompakapps_base"]]], ["model", "res_id"], { limit: 2000 }).catch(() => []),
  ]);
  const routes = new Set();
  const rules = new Set();
  for (const wh of warehouses) {
    // route_ids gudang tidak dihitung: itu relasi yang juga diisi pengguna (Gudang yang memakai pada form rute)
    for (const id of wh.resupply_route_ids ?? []) routes.add(id);
    for (const key of ["reception_route_id", "delivery_route_id", "pbm_route_id"]) if (wh[key]) routes.add(wh[key][0]);
    for (const key of ["mto_pull_id", "buy_pull_id", "manufacture_pull_id", "manufacture_mto_pull_id", "pbm_mto_pull_id"]) if (wh[key]) rules.add(wh[key][0]);
  }
  for (const x of xmlids) (x.model === "stock.route" ? routes : rules).add(x.res_id);
  if (rules.size) {
    for (const rule of await searchRead("stock.rule", [["id", "in", [...rules]]], ["route_id"], { context: { active_test: false } })) routes.add(rule.route_id[0]);
  }
  return { routes, rules };
}

/** Aturan bawaan bila aturannya sendiri atau rutenya bawaan. */
export const isBuiltinRule = (builtin, rule) => builtin.rules.has(rule.id) || builtin.routes.has(Array.isArray(rule.route_id) ? rule.route_id[0] : rule.route_id);

export const BUILTIN_NOTE = "Rute atau aturan ini dibuat otomatis oleh gudang atau modul Odoo (penerimaan, pengiriman, Beli, Produksi, MTO, suplai antar gudang). Mengubahnya bisa merusak alur dokumen yang berjalan. Ubah langkah penerimaan dan pengiriman lewat Warehouse & Location Master; perubahan di sini tetap bisa disimpan setelah konfirmasi.";
export const BUILTIN_CONFIRM = "Ini rute atau aturan bawaan gudang. Mengubahnya dapat merusak alur penerimaan, pengiriman, pembelian, atau produksi. Lanjutkan menyimpan?";

/** Kotak peringatan fitur yang belum aktif (Multi-Step Routes dan Storage Locations), dengan tautan ke Inventory Setting. */
export async function featureHints() {
  const [advanced, locations] = await Promise.all([hasGroup("stock.group_adv_location"), hasGroup("stock.group_stock_multi_locations")]);
  const missing = [];
  if (!advanced) missing.push("<b>Multi-Step Routes</b> (penerimaan atau pengiriman lebih dari 1 langkah, rute suplai antar gudang)");
  if (!locations) missing.push("<b>Storage Locations</b> (lokasi di dalam gudang selain Stock, untuk asal dan tujuan aturan)");
  if (!missing.length) return "";
  return `<p class="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-4">Fitur berikut belum aktif: ${missing.join("; ")}. Rute dan aturan buatan sendiri tetap bisa dibuat, tetapi pilihan lokasi dan langkah gudang terbatas. Aktifkan di <a href="#/modsetting/inventory" class="underline">Inventory &gt; Setting</a> (bagian Gudang).</p>`;
}

/**
 * Pemeriksaan aturan sebelum disimpan. Mengembalikan pesan Indonesia untuk kombinasi yang tidak sah, atau "" bila aman.
 * `v`: { name, route, action, picking, src, dest, delay, push_domain }; `picking`: tipe operasi terpilih ({ code, display_name }) atau null.
 */
export function ruleProblem(v, picking) {
  if (!String(v.name ?? "").trim()) return "Nama aturan wajib diisi.";
  if (!v.route) return "Pilih rute tempat aturan ini berada.";
  if (!picking) return "Pilih tipe operasi: dokumen yang dibuat aturan ini.";
  if (!v.dest) return "Pilih lokasi tujuan.";
  const need = ACTION_PICKING_CODE[v.action];
  if (need && picking.code !== need) return `Aksi ${ACTION_SHORT[v.action]} harus memakai tipe operasi ${PICKING_CODES[need]}; "${picking.display_name}" adalah ${PICKING_CODES[picking.code] ?? picking.code}.`;
  if ((v.action === "pull" || v.action === "pull_push") && !v.src) return "Aksi Tarik membutuhkan lokasi asal: dari sanalah barang diambil.";
  if (v.action === "push" && !v.src) return "Aksi Dorong membutuhkan lokasi asal: aturan berlaku saat barang tiba di lokasi itu.";
  if (["pull", "push", "pull_push"].includes(v.action) && v.src && v.dest && v.src.id === v.dest.id) return "Lokasi asal dan tujuan tidak boleh sama: barang tidak akan bergerak.";
  const delay = Number(v.delay);
  if (v.delay === "" || !Number.isInteger(delay) || delay < 0) return "Penundaan (lead time) harus bilangan bulat hari, 0 atau lebih.";
  const domain = String(v.push_domain ?? "").trim();
  if (domain && !(domain.startsWith("[") && domain.endsWith("]"))) return 'Syarat Dorong harus berupa domain Odoo, mis. [("product_id.categ_id", "=", 3)].';
  return "";
}

/** Galat Odoo yang umum pada rute dan aturan, diterjemahkan; selain itu baris pertama pesan asli. */
export function friendlyRuleError(message) {
  const text = String(message ?? "");
  if (/belongs to .* while the route belongs to/i.test(text)) return "Perusahaan aturan berbeda dengan perusahaan rute. Samakan perusahaannya.";
  if (/another model is using|violates foreign key|still referenced|is still used/i.test(text)) return "Masih dipakai dokumen atau data lain, jadi tidak bisa dihapus. Arsipkan saja.";
  return text.split("\n")[0] || "Gagal menyimpan.";
}

/** Jumlah penggunaan rute: produk, kategori, gudang, aturan, dan pergerakan stok yang lahir dari aturannya. */
export async function routeUsage(id) {
  const count = (model, domain) => call(model, "search_count", { domain, context: { active_test: false } });
  const [products, categories, warehouses, moves] = await Promise.all([
    count("product.template", [["route_ids", "in", [id]]]),
    count("product.category", [["route_ids", "in", [id]]]),
    count("stock.warehouse", [["route_ids", "in", [id]]]),
    count("stock.move", [["rule_id.route_id", "=", id]]),
  ]);
  return { products, categories, warehouses, moves };
}

/** Pergerakan stok yang dibuat oleh sebuah aturan. */
export const ruleMoves = (id) => call("stock.move", "search_count", { domain: [["rule_id", "=", id]], context: { active_test: false } });

/** Nama lokasi atau tipe operasi untuk sel tabel "Dari -> Ke". */
export const flowText = (rule) => `${rule.location_src_id?.[1] ?? "-"} -> ${rule.location_dest_id?.[1] ?? "-"}`;

/** Satu baris ringkasan aturan dalam bahasa biasa untuk kotak penjelasan di form aturan. */
export function ruleSentence(v, picking, wh) {
  const src = v.src?.display_name ?? "lokasi asal";
  const dest = v.dest?.display_name ?? "lokasi tujuan";
  const op = picking?.display_name ?? "tipe operasi";
  const where = wh ? ` (gudang ${wh})` : "";
  switch (v.action) {
    case "pull": return `Saat barang dibutuhkan di ${dest}, dibuat ${op} dari ${src}${where}.`;
    case "push": return `Saat barang tiba di ${src}, dibuat ${op} untuk memindahkannya ke ${dest}${where}.`;
    case "pull_push": return `Saat barang dibutuhkan di ${dest}, dibuat ${op} dari ${src}; saat barang tiba di ${src}, ia dipindahkan ke ${dest}${where}.`;
    case "buy": return `Saat barang dibutuhkan di ${dest}, dibuat RFQ ke pemasok produk, diterima lewat ${op}${where}.`;
    case "manufacture": return `Saat barang dibutuhkan di ${dest}, dibuat Manufacturing Order (${op})${v.src ? `; komponen diambil dari ${src}` : ""}${where}.`;
    default: return "";
  }
}

export const note = (html, tone = "info") =>
  `<p class="text-sm rounded-lg px-4 py-3 border ${tone === "warn" ? "text-amber-900 bg-amber-50 border-amber-200" : "text-sky-900 bg-sky-50 border-sky-200"}">${html}</p>`;

/**
 * Pilihan rute untuk produk atau kategori produk (field `route_ids`): rute yang dapat dipilih pada `selectableField`, ditambah rute yang sudah terpasang
 * atau diwarisi agar tidak hilang diam-diam. Tiap rute membawa ringkasan aturannya (aksi, MTO) untuk peringatan efeknya.
 */
export async function loadRouteChoices(selectableField, selected = [], inherited = []) {
  const want = [...new Set([...selected, ...inherited])];
  const domain = want.length ? ["|", [selectableField, "=", true], ["id", "in", want]] : [[selectableField, "=", true]];
  const routes = await searchRead("stock.route", domain, ["display_name", "sequence"], { order: "sequence, name" });
  const rules = routes.length ? await searchRead("stock.rule", [["route_id", "in", routes.map((r) => r.id)]], ["route_id", "action", "procure_method"]) : [];
  const info = new Map(routes.map((r) => [r.id, { actions: new Set(), mto: false, mtsMto: false, rules: 0 }]));
  for (const rule of rules) {
    const item = info.get(rule.route_id[0]);
    item.rules += 1;
    item.actions.add(rule.action);
    if (rule.action === "pull" || rule.action === "pull_push") {
      if (rule.procure_method === "make_to_order") item.mto = true;
      else if (rule.procure_method === "mts_else_mto") item.mtsMto = true;
    }
  }
  return routes.map((r) => ({ ...r, ...info.get(r.id) }));
}

/** Label singkat isi rute di samping namanya: "Beli", "Produksi", "MTO", dst. */
const routeTags = (route) => [route.actions.has("buy") ? "Beli" : "", route.actions.has("manufacture") ? "Produksi" : "", route.mto ? "MTO" : "", route.mtsMto ? "Stok lalu MTO" : ""].filter(Boolean);

/** Daftar kotak centang rute; `key` menandai milik siapa (data-route-box) dan `inherited` adalah rute turunan kategori (hanya info). */
export function routeBoxHtml(choices, selected, { inherited = [], emptyHint = "" } = {}) {
  const boxes = choices
    .filter((r) => !inherited.includes(r.id) || selected.includes(r.id))
    .map((r) => {
      const tags = routeTags(r).map((t) => `<span class="ml-1 px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-xs">${esc(t)}</span>`).join("");
      return `<label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-route-box="${r.id}" ${selected.includes(r.id) ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"><span>${esc(r.display_name)}${tags}</span></label>`;
    })
    .join("");
  const inheritedNames = choices.filter((r) => inherited.includes(r.id) && !selected.includes(r.id)).map((r) => esc(r.display_name));
  return `${boxes ? `<div class="grid sm:grid-cols-2 gap-2">${boxes}</div>` : `<p class="text-sm text-gray-500">${emptyHint}</p>`}
    ${inheritedNames.length ? `<p class="text-xs text-gray-500 mt-2">Rute dari kategori (otomatis berlaku): <b>${inheritedNames.join(", ")}</b>.</p>` : ""}`;
}

/**
 * Peringatan efek rute terpilih. `scope`: "produk" atau "kategori". `support` (produk tersimpan): { bom: Set, seller: Set, tmplId } untuk memeriksa
 * pemasok dan BoM yang dibutuhkan aturan Beli dan Produksi.
 */
export function routeWarningsHtml(choices, selected, { scope = "produk", support = null } = {}) {
  const chosen = choices.filter((r) => selected.includes(r.id));
  const who = scope === "kategori" ? "produk di kategori ini" : "produk ini";
  const out = [];
  for (const r of chosen) {
    if (!r.rules) out.push([`Rute <b>${esc(r.display_name)}</b> belum punya aturan aktif, jadi tidak berbuat apa-apa. Tambahkan aturan di <a href="#/route/${r.id}" class="underline">Routes</a>.`, "warn"]);
    if (r.mto) out.push([`Rute <b>${esc(r.display_name)}</b> memakai metode MTO (Picu aturan lain): pengiriman Sales Order ${esc(who)} tidak mengambil dari stok, melainkan menunggu dokumen pengadaan (RFQ atau MO) yang dibuat saat Sales Order dikonfirmasi.`, "warn"]);
    else if (r.mtsMto) out.push([`Rute <b>${esc(r.display_name)}</b>: stok dipakai bila ada, kekurangannya memicu pengadaan (RFQ atau MO) saat Sales Order dikonfirmasi.`, "info"]);
    if (r.actions.has("buy")) {
      if (support && !support.seller.has(support.tmplId)) out.push([`Rute <b>${esc(r.display_name)}</b> membeli, tetapi produk ini belum punya pemasok (Vendor Price list): RFQ tidak bisa dibuat.`, "warn"]);
      else if (!support) out.push([`Rute <b>${esc(r.display_name)}</b> membeli: ${esc(who)} perlu punya pemasok (Vendor Price list) agar RFQ bisa dibuat.`, "info"]);
    }
    if (r.actions.has("manufacture")) {
      if (support && !support.bom.has(support.tmplId)) out.push([`Rute <b>${esc(r.display_name)}</b> memproduksi, tetapi produk ini belum punya BoM: MO dibuat tanpa komponen.`, "warn"]);
      else if (!support) out.push([`Rute <b>${esc(r.display_name)}</b> memproduksi: ${esc(who)} perlu punya BoM agar MO membawa komponen.`, "info"]);
    }
  }
  if (chosen.length > 1) out.push(["Beberapa rute dipilih: Odoo memakai rute berurutan terkecil (lihat Routes) yang punya aturan cocok untuk lokasi yang dibutuhkan.", "info"]);
  if (chosen.length) out.push(["Rute pada produk atau kategori mengalahkan rute bawaan gudang (Beli, Produksi, pengiriman) untuk barang itu.", "info"]);
  return out.map(([html, tone]) => note(html, tone)).join("");
}
