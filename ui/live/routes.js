// Rute pengisian ulang (stock.route) untuk aturan stok: pilihan rute, label Indonesia, dan peringatan per produk.
// Dipakai Reorder Level (orderpoint.js) dan Replenishment (replenish.js), D47.
import { searchRead } from "./common.js";

/** Domain rute yang boleh dipilih pada aturan stok (sama dengan domain field route_id Odoo): rute produk, atau rute Beli dan Produksi gudang. */
const ROUTE_DOMAIN = ["|", ["product_selectable", "=", true], ["rule_ids.action", "in", ["buy", "manufacture"]]];

/** Rute yang tersedia, dengan jenisnya: buy (RFQ), manufacture (MO), resupply (transfer antar gudang), atau other. */
export async function loadRoutes() {
  const routes = await searchRead("stock.route", ROUTE_DOMAIN, ["display_name", "supplied_wh_id", "supplier_wh_id", "rule_ids"], { order: "sequence, name" });
  const rules = routes.length ? await searchRead("stock.rule", [["route_id", "in", routes.map((r) => r.id)], ["action", "in", ["buy", "manufacture"]]], ["route_id", "action"]) : [];
  const action = new Map(rules.map((r) => [r.route_id[0], r.action]));
  return routes.map((r) => {
    const kind = r.supplied_wh_id ? "resupply" : (action.get(r.id) ?? "other");
    return { ...r, kind, label: routeLabel(r, kind) };
  });
}

const routeLabel = (route, kind) =>
  kind === "buy" ? "Beli dari pemasok (RFQ)"
    : kind === "manufacture" ? "Produksi (Manufacturing Order)"
      : kind === "resupply" ? `Suplai dari ${route.supplier_wh_id?.[1] ?? "gudang lain"} (transfer antar gudang)`
        : route.display_name;

/** Rute suplai antar gudang hanya berlaku untuk gudang yang disuplai; rute yang sedang terpilih tetap tampil agar tidak hilang diam-diam. */
export const routesFor = (routes, warehouse, selected) => routes.filter((x) => !x.supplied_wh_id || x.supplied_wh_id[0] === warehouse || x.id === selected);

/** Jenis rute yang berlaku: rute yang dipilih, atau rute bawaan Odoo (effective_route_id) bila kosong. */
export const effectiveKind = (routes, routeId, effectiveId) => {
  const id = routeId || effectiveId;
  return id ? (routes.find((r) => r.id === id)?.kind ?? "other") : "none";
};

/** Produk (template) yang punya BoM normal dan yang punya pemasok, untuk peringatan rute. */
export async function productSupport(tmplIds) {
  const ids = [...new Set(tmplIds)];
  if (!ids.length) return { bom: new Set(), seller: new Set() };
  const [boms, sellers] = await Promise.all([
    searchRead("mrp.bom", [["product_tmpl_id", "in", ids], ["type", "=", "normal"]], ["product_tmpl_id"]),
    searchRead("product.supplierinfo", [["product_tmpl_id", "in", ids]], ["product_tmpl_id"]),
  ]);
  return { bom: new Set(boms.map((b) => b.product_tmpl_id[0])), seller: new Set(sellers.map((s) => s.product_tmpl_id[0])) };
};

/** Peringatan Indonesia bila rute yang berlaku tidak akan berhasil atau menghasilkan dokumen yang tidak lengkap; kosong bila aman. */
export function routeWarning(kind, support, tmplId) {
  if (kind === "manufacture" && !support.bom.has(tmplId)) return "Produk ini belum punya BoM: MO tetap dibuat tetapi tanpa komponen. Buat BoM di Manufacture > Bill of Materials lebih dulu.";
  if (kind === "buy" && !support.seller.has(tmplId)) return "Produk ini belum punya pemasok (Vendor Price list): RFQ tidak bisa dibuat. Tambahkan pemasok di halaman produk.";
  if (kind === "none") return "Tidak ada rute yang berlaku. Pilih rute Beli atau Produksi, atau lengkapi Vendor Price list atau BoM produk.";
  return "";
}

/** Galat Odoo yang umum pada pengisian ulang, diterjemahkan; selain itu pesan aslinya dipakai apa adanya. */
export function friendlyReplenishError(message, productName = "produk ini") {
  const text = String(message ?? "");
  if (text.includes("No rule has been found")) return `Tidak ada rute pengisian untuk ${productName}. Pilih rute Beli atau Produksi, atau lengkapi Vendor Price list atau BoM produk.`;
  if (text.includes("no matching vendor price")) return `${productName} belum punya pemasok yang cocok (Vendor Price list), RFQ tidak bisa dibuat.`;
  return text.split("\n")[0] || "Pengisian ulang gagal.";
}
