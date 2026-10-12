// Pemilih pajak baris transaksi bersama (D40): kolom "Pajak" berupa tag (chip) yang bisa dihapus, dengan kotak cari
// untuk menambah pajak lain. Satu baris boleh punya banyak pajak (mis. PPN 11% dan PPh 23 negatif). Nilai di status
// halaman berupa daftar { id, name, price_include }; ke Odoo ditulis sebagai [[6, 0, ids]] hanya bila berubah.
import { call, esc, registerLookup, searchRead, toast } from "./common.js";

const handlers = {};
/** Penangan per halaman: use = "purchase" | "sale" (type_tax_use), get(key) -> daftar pajak baris, set(key, daftar) menyimpan dan menggambar ulang. */
export function registerTaxes(scope, def) {
  handlers[scope] = def;
  registerLookup(`tax-${scope}`, {
    search: async (q, input) => {
      const chosen = def.get(input.dataset.txKey).map((t) => t.id);
      const domain = [["type_tax_use", "=", def.use], ["active", "=", true], ...(chosen.length ? [["id", "not in", chosen]] : []), ...(q ? [["name", "ilike", q]] : [])];
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

/** Pajak bawaan produk: "purchase" memakai supplier_taxes_id, "sale" memakai taxes_id. */
export async function productDefaultTaxes(productId, use) {
  const field = use === "purchase" ? "supplier_taxes_id" : "taxes_id";
  const [product] = await call("product.product", "read", { ids: [productId], fields: [field] });
  const ids = product?.[field] ?? [];
  return ids.length ? searchRead("account.tax", [["id", "in", ids]], ["name", "price_include"], { order: "sequence, name" }) : [];
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
