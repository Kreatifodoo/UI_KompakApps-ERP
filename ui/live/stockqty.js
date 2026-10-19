// Stok di sebuah lokasi untuk pemilih produk: on hand dan tersedia (on hand dikurangi yang sudah dicadangkan), termasuk sublokasi.
import { call, esc, searchRead } from "./common.js";

export const fmtQty = (n) => new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(n ?? 0);

/** Kunci parameter sistem: bila "1", formulir menolak jumlah yang melebihi stok tersedia (Inventory Setting, D70). Bawaan: hanya memberi peringatan merah. */
export const BLOCK_OVER_STOCK = "kompakapps.block_over_stock";
let blockCache = null; // { value, at }; disimpan 30 detik supaya perubahan dari pengguna lain cepat terlihat
export async function blockOverStock() {
  if (!blockCache || Date.now() - blockCache.at > 30_000) {
    try {
      blockCache = { value: (await call("ir.config_parameter", "get_param", { key: BLOCK_OVER_STOCK })) === "1", at: Date.now() };
    } catch {
      blockCache = { value: false, at: Date.now() };
    }
  }
  return blockCache.value;
}
export const resetBlockOverStock = () => {
  blockCache = null;
};

/**
 * Map id produk -> { onhand, available } di lokasi (dan sublokasinya). Produk tanpa stok tidak masuk Map. Galat jaringan menghasilkan Map kosong.
 * `lotId` membatasi ke satu lot atau nomor seri; `strict` hanya menghitung lokasi itu sendiri (tanpa sublokasi), seperti pemeriksaan Scrap Odoo.
 */
export async function stockAt(productIds, locationId, { lotId = null, strict = false } = {}) {
  const out = new Map();
  if (!productIds.length || !locationId) return out;
  try {
    const domain = [["location_id", strict ? "=" : "child_of", locationId], ["product_id", "in", productIds]];
    if (lotId) domain.push(["lot_id", "=", lotId]);
    const rows = await call("stock.quant", "formatted_read_group", {
      domain,
      groupby: ["product_id"],
      aggregates: ["quantity:sum", "reserved_quantity:sum"],
    });
    for (const r of rows) {
      const onhand = r["quantity:sum"] ?? 0;
      out.set(r.product_id[0], { onhand, available: Math.max(0, onhand - (r["reserved_quantity:sum"] ?? 0)) }); // cadangan melebihi stok tidak ditampilkan sebagai tersedia negatif
    }
  } catch {
    /* info stok hanya pelengkap; pemilih produk tetap bekerja tanpanya */
  }
  return out;
}

/** Teks bantu "Tersedia 12 Units di WH/Stock"; kosong bila belum ada produk. */
export function stockText(stock, uom, locationName) {
  if (!stock) return "";
  const parts = [`Tersedia ${fmtQty(stock.available)}${uom ? ` ${uom}` : ""}`];
  if (Math.abs(stock.onhand - stock.available) > 1e-9) parts.push(`on hand ${fmtQty(stock.onhand)}`);
  return parts.join(" · ") + (locationName ? ` di ${locationName}` : "");
}

/** Gudang bawaan dokumen bila pengguna tidak memilih (sama seperti Odoo: urutan sequence, lalu id). */
export const defaultWarehouse = (warehouses) => [...warehouses].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.id - b.id)[0] ?? null;

/** Map id produk -> { onhand, available } di lokasi stok gudang, hanya untuk produk yang dilacak stoknya (is_storable); jasa dan barang habis pakai tidak masuk Map. */
export async function storableStock(productIds, locationId) {
  const ids = [...new Set(productIds.filter(Boolean))];
  const out = new Map();
  if (!ids.length || !locationId) return out;
  let storable = [];
  try {
    storable = (await searchRead("product.product", [["id", "in", ids], ["is_storable", "=", true]], ["id"], { limit: ids.length })).map((p) => p.id);
  } catch {
    return out;
  }
  const stock = await stockAt(storable, locationId);
  for (const id of storable) out.set(id, stock.get(id) ?? { onhand: 0, available: 0 });
  return out;
}

/** Baris petunjuk di bawah produk pada baris dokumen: "Tersedia N unit · on hand M di <gudang>"; merah bila `warn` dan jumlah melebihi stok tersedia. */
export function stockHint(stock, uom, warehouseName, qty, warn = false) {
  if (!stock) return "";
  const over = warn && Number(qty) > stock.available + 1e-9;
  return `<div class="text-xs mt-1 ${over ? "text-rose-600" : "text-gray-500"}">${esc(stockText(stock, uom, warehouseName))}${over ? " · melebihi stok tersedia" : ""}</div>`;
}
