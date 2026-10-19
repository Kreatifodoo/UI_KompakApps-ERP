// Pemilih pajak baris transaksi bersama (D40): kolom "Pajak" berupa tag (chip) yang bisa dihapus, dengan kotak cari
// untuk menambah pajak lain. Satu baris boleh punya banyak pajak (mis. PPN 11% dan PPh 23 negatif). Nilai di status
// halaman berupa daftar { id, name, price_include }; ke Odoo ditulis sebagai [[6, 0, ids]] hanya bila berubah.
import { call, esc, registerLookup, searchRead, toast } from "./common.js";

const handlers = {};
/** Penangan per halaman: use = "purchase" | "sale" (type_tax_use) atau daftar jenis (jurnal entry D50), get(key) -> daftar pajak baris, set(key, daftar) menyimpan dan menggambar ulang. */
export function registerTaxes(scope, def) {
  handlers[scope] = def;
  registerLookup(`tax-${scope}`, {
    search: async (q, input) => {
      const chosen = def.get(input.dataset.txKey).map((t) => t.id);
      const domain = [["type_tax_use", Array.isArray(def.use) ? "in" : "=", def.use], ["active", "=", true], ...(chosen.length ? [["id", "not in", chosen]] : []), ...(q ? [["name", "ilike", q]] : [])];
      const rows = await searchRead("account.tax", domain, ["name", "amount", "amount_type", "price_include"], { limit: 12, order: "sequence, name" });
      return rows.map((r) => ({ ...r, display_name: r.name }));
    },
    sub: (r) => `${rateText(r)}${r.price_include ? " · termasuk harga" : ""}`,
    isChosen: () => false,
    choose: (input, item) => {
      const list = def.get(input.dataset.txKey);
      if (list.some((t) => t.id === item.id)) {
        toast("Pajak itu sudah ada pada baris ini.", "error");
        return;
      }
      input.value = "";
      def.set(input.dataset.txKey, [...list, { id: item.id, name: item.name, price_include: item.price_include }]);
    },
  });
}

const rateText = (t) => (t.amount_type === "percent" ? `${String(t.amount).replace(".", ",")}%` : t.amount_type === "fixed" ? `tetap ${t.amount}` : t.amount_type ?? "");
const chip = (t, button) => `<span class="inline-flex items-center gap-1 bg-indigo-50 text-indigo-800 border border-indigo-200 rounded-full pl-2 ${button ? "pr-1" : "pr-2"} py-0.5 text-xs whitespace-nowrap" title="${esc(t.name)}${t.price_include ? " (termasuk harga)" : ""}">${esc(t.name)}${t.price_include ? " *" : ""}${
  button ? `<button type="button" data-tx-del="${t.id}" data-tx-scope="${button.scope}" data-tx-key="${esc(button.key)}" class="text-indigo-400 hover:text-rose-600 px-1" aria-label="Hapus pajak ${esc(t.name)}">&times;</button>` : ""}</span>`;

/** Isi sel Pajak. editable=false menampilkan chip saja (dokumen terkunci). */
export function taxCell(scope, key, taxes, editable = true) {
  const chips = (taxes ?? []).map((t) => chip(t, editable ? { scope, key } : null)).join(" ");
  if (!editable) return `<div class="flex flex-wrap gap-1">${chips || "-"}</div>`;
  return `<div class="flex flex-wrap gap-1 items-center min-w-44">${chips}
    <input data-lookup="tax-${esc(scope)}" data-tx-key="${esc(key)}" autocomplete="off" role="combobox" aria-autocomplete="list" placeholder="${taxes?.length ? "+ pajak" : "Cari pajak..."}"
      class="border border-gray-300 rounded-lg px-2 py-1 text-xs w-24 focus:outline-none focus:ring-2 focus:ring-indigo-500" aria-label="Tambah pajak"></div>`;
}

document.addEventListener("click", (event) => {
  const del = event.target.closest("[data-tx-del]");
  if (!del) return;
  const handler = handlers[del.dataset.txScope];
  const key = del.dataset.txKey;
  if (handler) handler.set(key, handler.get(key).filter((t) => t.id !== Number(del.dataset.txDel)));
});

/* ---------- Posisi fiskal (D79) ---------- */
// Odoo memetakan pajak baris menurut posisi fiskal dokumen saat baris disimpan. Agar chip pada baris baru sama dengan hasil simpan,
// posisi fiskal dibaca dari server (onchange kolom mitra pada dokumen kosong, jadi aturan otomatis Odoo ikut) beserta petanya
// (`tax_map`), lalu dipakai untuk memetakan pajak bawaan produk. JSON-2 tidak bisa memanggil `map_tax` (argumennya recordset).

const positions = new Map();
const POSITION_TTL = 60_000;
async function loadPosition(model, partnerId, values) {
  const result = await call(model, "onchange", { ids: [], values: { ...values, partner_id: partnerId }, field_names: [], fields_spec: { fiscal_position_id: { fields: { display_name: {} } } } });
  const id = result?.value?.fiscal_position_id?.id;
  if (!id) return null;
  const [position] = await call("account.fiscal.position", "read", { ids: [id], fields: ["name", "tax_ids", "tax_map"] });
  return { id, name: position.name, mapped: (position.tax_ids ?? []).length > 0, map: position.tax_map ?? {} };
}
/** Posisi fiskal yang dipakai Odoo untuk dokumen model ini dengan mitra itu ({ id, name, mapped, map }), null bila tanpa posisi fiskal atau tak terbaca. Disimpan semenit per mitra. */
export function fiscalPosition(model, partnerId, values = {}) {
  if (!partnerId) return Promise.resolve(null);
  const key = `${model}|${partnerId}|${JSON.stringify(values)}`;
  const hit = positions.get(key);
  if (hit && Date.now() - hit.at < POSITION_TTL) return hit.promise;
  const promise = loadPosition(model, partnerId, values).catch(() => null);
  positions.set(key, { at: Date.now(), promise });
  return promise;
}

/** Pajak setelah dipetakan posisi fiskal seperti `map_tax` Odoo: posisi tanpa pemetaan hanya membuang pajak yang terikat pada posisi fiskal tertentu; selain itu tiap pajak diganti pajak tujuannya, dan pajak tanpa pemetaan tetap. */
export async function mapTaxes(taxes, position) {
  if (!position || !taxes.length) return taxes;
  if (!position.mapped) {
    const bound = await searchRead("account.tax", [["id", "in", taxes.map((t) => t.id)], ["fiscal_position_ids", "!=", false]], ["id"], { context: { active_test: false } });
    const drop = new Set(bound.map((t) => t.id));
    return drop.size ? taxes.filter((t) => !drop.has(t.id)) : taxes;
  }
  const ids = [...new Set(taxes.flatMap((t) => position.map[String(t.id)] ?? [t.id]))];
  if (ids.length === taxes.length && ids.every((id) => taxes.some((t) => t.id === id))) return taxes;
  return taxList(ids, await loadTaxNames(ids));
}

/** Pajak bawaan produk: "purchase" memakai supplier_taxes_id, "sale" memakai taxes_id. Dengan `doc` ({ model, partnerId, values }) hasilnya sudah dipetakan posisi fiskal mitra dokumen itu. */
export async function productDefaultTaxes(productId, use, doc = null) {
  const field = use === "purchase" ? "supplier_taxes_id" : "taxes_id";
  const [product] = await call("product.product", "read", { ids: [productId], fields: [field] });
  const ids = product?.[field] ?? [];
  const taxes = ids.length ? await searchRead("account.tax", [["id", "in", ids]], ["name", "price_include"], { order: "sequence, name" }) : [];
  if (!doc?.partnerId || !taxes.length) return taxes;
  return mapTaxes(taxes, await fiscalPosition(doc.model, doc.partnerId, doc.values));
}

/** Daftar {id, name} dari id pajak baris Odoo dan peta nama. */
export const taxList = (ids, names) => (ids ?? []).map((id) => ({ id, name: names.get(id) ?? `#${id}`, price_include: names.price?.get(id) ?? false }));

/** Memuat nama pajak untuk sekumpulan id; hasilnya Map(id -> name) dengan properti .price Map(id -> price_include). */
export async function loadTaxNames(ids) {
  const unique = [...new Set(ids)];
  const rows = unique.length ? await searchRead("account.tax", [["id", "in", unique]], ["name", "price_include"], { context: { active_test: false } }) : [];
  const names = new Map(rows.map((t) => [t.id, t.name]));
  names.price = new Map(rows.map((t) => [t.id, t.price_include]));
  return names;
}

const sameIds = (a, b) => a.length === b.length && a.every((id) => b.includes(id));
/** Nilai tax_ids untuk ditulis ke Odoo bila berubah dari awal, undefined bila tidak. initial undefined = baris baru (kirim hanya bila disentuh). */
export function taxChange(current, initial, touched) {
  if (!touched) return undefined;
  const ids = current.map((t) => t.id);
  if (initial && sameIds(ids, initial)) return undefined;
  return [[6, 0, ids]];
}
