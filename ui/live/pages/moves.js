// Riwayat Pergerakan Stok (stock.move.line selesai): tanggal, dokumen, produk, lot, dari dan ke lokasi, jumlah.
// Mode "loss" menampilkan hanya pergerakan dari atau ke lokasi Inventory Loss (penyesuaian stok dan scrap).
import { INPUT, app, dateTimeText, esc, filterSelect, pageHeader, searchBox, searchRead, table, cell, rowLink } from "../common.js";

const DIRECTIONS = [["", "Semua arah"], ["in", "Masuk ke gudang"], ["out", "Keluar dari gudang"], ["adjust", "Penyesuaian dan scrap"]];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {};

export async function render(sub, query) {
  last = { sub, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const loss = query.get("kind") === "loss";
  const direction = loss ? "adjust" : query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  const domain = [["state", "=", "done"]];
  if (direction === "in") domain.push(["location_id.usage", "!=", "internal"], ["location_dest_id.usage", "=", "internal"], ["location_id.usage", "!=", "inventory"]);
  else if (direction === "out") domain.push(["location_id.usage", "=", "internal"], ["location_dest_id.usage", "!=", "internal"], ["location_dest_id.usage", "!=", "inventory"]);
  else if (direction === "adjust") domain.push("|", ["location_id.usage", "=", "inventory"], ["location_dest_id.usage", "=", "inventory"]);
  if (from) domain.push(["date", ">=", `${from} 00:00:00`]);
  if (to) domain.push(["date", "<=", `${to} 23:59:59`]);
  if (text) domain.push("|", "|", ["product_id.name", "ilike", text], ["reference", "ilike", text], ["lot_id.name", "ilike", text]);
  const rows = await searchRead(
    "stock.move.line", domain,
    ["date", "reference", "product_id", "lot_id", "location_id", "location_dest_id", "quantity", "product_uom_id", "picking_id", "picking_code"],
    { order: "date desc, id desc", limit: 200 },
  );
  const route = { incoming: "receipt", outgoing: "delivery" };
  const body = rows
    .map((r) => {
      const href = r.picking_id && route[r.picking_code] ? `#/${route[r.picking_code]}/${r.picking_id[0]}` : null;
      const cells = [
        cell(dateTimeText(r.date)),
        cell(r.reference || "-", { strong: Boolean(href) }),
        cell(r.product_id[1]),
        cell(r.lot_id?.[1] ?? ""),
        cell(r.location_id[1]),
        cell(r.location_dest_id[1]),
        cell(`${nf.format(r.quantity)} ${r.product_uom_id?.[1] ?? ""}`, { right: true }),
      ];
      return href ? rowLink(href, cells) : `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  app.innerHTML =
    pageHeader(
      loss ? "Inventory Loss" : "Riwayat Pergerakan Stok",
      `${searchBox(text, "Cari produk, dokumen, lot")}
       ${loss ? "" : filterSelect(DIRECTIONS, direction)}
       <label class="text-xs font-medium text-gray-500 uppercase">Dari<input type="date" data-moves="from" value="${esc(from)}" class="${INPUT} mt-1 w-40"></label>
       <label class="text-xs font-medium text-gray-500 uppercase">Sampai<input type="date" data-moves="to" value="${esc(to)}" max="${today()}" class="${INPUT} mt-1 w-40"></label>`,
    ) +
    table(
      [{ label: "Tanggal" }, { label: "Dokumen" }, { label: "Produk" }, { label: "Lot/Serial" }, { label: "Dari" }, { label: "Ke" }, { label: "Jumlah", right: true }],
      body,
      loss ? "Belum ada penyesuaian stok atau scrap." : "Belum ada pergerakan stok.",
    ) +
    `<p class="text-xs text-gray-500 mt-3">Hanya pergerakan yang sudah selesai.${rows.length >= 200 ? " Menampilkan 200 terbaru; persempit dengan tanggal." : ""}${loss ? " Odoo 19 mencatat nilainya pada pergerakan stok tetapi tidak membuat jurnal otomatis." : ""}</p>`;
}

export function onChange(event, el) {
  if (!el.dataset.moves) return;
  const [path, queryText = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(queryText);
  if (el.value) params.set(el.dataset.moves, el.value);
  else params.delete(el.dataset.moves);
  const qs = params.toString();
  location.hash = `#/${path}${qs ? `?${qs}` : ""}`;
}
