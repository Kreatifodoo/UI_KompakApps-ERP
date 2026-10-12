// Stok di sebuah lokasi untuk pemilih produk: on hand dan tersedia (on hand dikurangi yang sudah dicadangkan), termasuk sublokasi.
import { call } from "./common.js";

export const fmtQty = (n) => new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 }).format(n ?? 0);

/** Map id produk -> { onhand, available } di lokasi (dan sublokasinya). Produk tanpa stok tidak masuk Map. Galat jaringan menghasilkan Map kosong. */
export async function stockAt(productIds, locationId) {
  const out = new Map();
  if (!productIds.length || !locationId) return out;
  try {
    const rows = await call("stock.quant", "formatted_read_group", {
      domain: [["location_id", "child_of", locationId], ["product_id", "in", productIds]],
      groupby: ["product_id"],
      aggregates: ["quantity:sum", "reserved_quantity:sum"],
    });
    for (const r of rows) {
      const onhand = r["quantity:sum"] ?? 0;
      out.set(r.product_id[0], { onhand, available: onhand - (r["reserved_quantity:sum"] ?? 0) });
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
