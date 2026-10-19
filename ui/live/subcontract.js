// Subkontrak (Q54, D82): tautan PO, penerimaan, MO, dan Resupply Subcontractor, serta pembuatan resupply komponen.
// PO produk ber-BoM Subcontracting ke pemasok terdaftar membuat penerimaan dan MO subkontrak. Komponen dikirim ke lokasi
// Subcontracting (tipe operasi Resupply Subcontractor, hanya perpindahan antar lokasi internal, tanpa jurnal); validasi penerimaan
// menyelesaikan MO dan memakai komponen di lokasi itu.
import { badge, button, call, esc, guarded, searchRead, toast } from "./common.js";

const MO_STATES = { draft: ["Draft", "muted"], confirmed: ["Dikonfirmasi", "info"], progress: ["Berjalan", "info"], to_close: ["Siap Ditutup", "warning"], done: ["Selesai", "success"], cancel: ["Dibatalkan", "danger"] };
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });

/** MO subkontrak yang menghasilkan gerakan penerimaan (id stock.move) tertentu, lengkap dengan dokumen resupply-nya. */
export async function productionsOf(receiptMoveIds) {
  if (!receiptMoveIds.length) return [];
  const receipts = await searchRead("stock.move", [["id", "in", receiptMoveIds]], ["move_orig_ids"]);
  const origins = receipts.flatMap((m) => m.move_orig_ids);
  if (!origins.length) return [];
  return searchRead("mrp.production", [["move_finished_ids", "in", origins]], ["name", "state", "product_qty", "product_uom_id", "subcontractor_id", "move_raw_ids", "picking_ids", "origin"]);
}

/** Id dokumen resupply (bukan penerimaan) dari daftar MO. */
export async function resupplyIds(productions) {
  const ids = [...new Set(productions.flatMap((p) => p.picking_ids))];
  if (!ids.length) return [];
  return (await searchRead("stock.picking", [["id", "in", ids], ["picking_type_code", "=", "internal"]], ["name"])).map((p) => p.id);
}

/** Tautan PO: id MO dan id resupply untuk kartu statistik (kosong bila PO bukan subkontrak). */
export async function purchaseLinks(poId) {
  const moves = await searchRead("stock.move", [["purchase_line_id.order_id", "=", poId], ["is_subcontract", "=", true]], ["id"]);
  const productions = await productionsOf(moves.map((m) => m.id));
  return { productions: productions.map((p) => p.id), resupply: await resupplyIds(productions) };
}

/** Kebutuhan komponen per MO: jumlah rencana, yang sudah ada di lokasi Subcontracting, resupply yang masih menunggu, dan kekurangannya. */
async function needs(productions) {
  const rawIds = productions.flatMap((p) => p.move_raw_ids);
  const raws = rawIds.length ? await searchRead("stock.move", [["id", "in", rawIds], ["state", "not in", ["done", "cancel"]]], ["product_id", "product_uom_qty", "product_uom", "location_id", "raw_material_production_id"]) : [];
  const locations = [...new Set(raws.map((r) => r.location_id[0]))];
  const quants = raws.length ? await searchRead("stock.quant", [["location_id", "in", locations], ["product_id", "in", [...new Set(raws.map((r) => r.product_id[0]))]]], ["product_id", "location_id", "quantity"]) : [];
  const onHand = new Map();
  for (const q of quants) onHand.set(q.product_id[0], (onHand.get(q.product_id[0]) ?? 0) + q.quantity);
  const pickings = await resupplyIds(productions);
  const pendingMoves = pickings.length && raws.length
    ? await searchRead("stock.move", [["picking_id", "in", pickings], ["state", "not in", ["done", "cancel", "draft"]], ["product_id", "in", [...new Set(raws.map((r) => r.product_id[0]))]]], ["product_id", "product_uom_qty", "quantity"])
    : [];
  const pending = new Map();
  for (const m of pendingMoves) pending.set(m.product_id[0], (pending.get(m.product_id[0]) ?? 0) + m.product_uom_qty);
  const byProduct = new Map();
  for (const r of raws) {
    const row = byProduct.get(r.product_id[0]) ?? { product: r.product_id, uom: r.product_uom, need: 0, location: r.location_id[0], moves: [] };
    row.need += r.product_uom_qty;
    byProduct.set(r.product_id[0], row);
  }
  return [...byProduct.values()].map((r) => {
    const have = onHand.get(r.product[0]) ?? 0;
    const waiting = pending.get(r.product[0]) ?? 0;
    return { ...r, have, waiting, short: Math.max(0, r.need - have - waiting) };
  });
}

/** Panel pada halaman Penerimaan: MO subkontrak, kebutuhan komponen, dan tombol pembuat resupply. Kosong bila penerimaan bukan subkontrak. */
export async function receiptPanel(pk, moves) {
  const receiptMoves = moves.filter((m) => m.is_subcontract);
  if (!receiptMoves.length) return "";
  const productions = await productionsOf(receiptMoves.map((m) => m.id));
  const resupply = await resupplyIds(productions);
  const open = pk.state !== "done" && pk.state !== "cancel";
  const rows = open && productions.length ? await needs(productions.filter((p) => p.state !== "done" && p.state !== "cancel")) : [];
  const short = rows.some((r) => r.short > 0);
  const mo = productions
    .map((p) => `<li><a href="#/mo/${p.id}" class="text-indigo-700 hover:underline">${esc(p.name)}</a> ${badge(MO_STATES, p.state)} <span class="text-gray-500">${esc(nf.format(p.product_qty))} ${esc(p.product_uom_id?.[1] ?? "")}</span></li>`)
    .join("");
  const table = rows.length
    ? `<table class="w-full text-left mt-3"><thead><tr>${["Komponen", "Dibutuhkan", "Ada di Subkontraktor", "Resupply Menunggu", "Perlu Dikirim"].map((h, i) => `<th class="py-1 pr-4 text-xs font-semibold text-gray-600 uppercase ${i ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        <tbody class="divide-y divide-gray-100">${rows.map((r) => `<tr><td class="py-1 pr-4 text-sm">${esc(r.product[1])}</td><td class="py-1 pr-4 text-sm text-right">${esc(nf.format(r.need))} ${esc(r.uom?.[1] ?? "")}</td><td class="py-1 pr-4 text-sm text-right">${esc(nf.format(r.have))}</td><td class="py-1 pr-4 text-sm text-right">${esc(nf.format(r.waiting))}</td><td class="py-1 pr-4 text-sm text-right ${r.short > 0 ? "text-rose-700 font-medium" : "text-gray-400"}">${esc(nf.format(r.short))}</td></tr>`).join("")}</tbody></table>`
    : "";
  return `<section class="bg-white rounded-xl shadow-sm border border-amber-200 mt-4 p-4">
    <div class="text-sm font-semibold mb-1">Subkontrak</div>
    <p class="text-sm text-gray-600">Penerimaan dari subkontraktor${pk.partner_id ? ` <b>${esc(pk.partner_id[1])}</b>` : ""}. ${open ? "Memvalidasi penerimaan ini menyelesaikan MO subkontrak dan memakai komponen yang sudah dikirim ke lokasi Subcontracting." : ""}</p>
    <ul class="text-sm mt-2 space-y-1">${mo || '<li class="text-gray-500">MO subkontrak belum terbentuk.</li>'}</ul>
    ${resupply.length ? `<p class="text-sm mt-2"><a href="#/transfer?ids=${resupply.join(",")}" class="text-indigo-700 hover:underline"><i class="fas fa-truck-ramp-box mr-1"></i>${resupply.length} dokumen Resupply Subcontractor</a></p>` : ""}
    ${table}
    ${open && short ? `<div class="mt-3">${button("sbc-resupply", "Buat Resupply Komponen", "primary", { id: pk.id })}</div><p class="mt-1 text-xs text-gray-500">Membuat transfer dari gudang ke lokasi Subcontracting sebesar kekurangan di atas (yang sudah ada di subkontraktor atau masih menunggu di dokumen resupply tidak dihitung lagi). Transfer ini tidak dijurnal: nilai komponen tetap di Persediaan sampai dipakai MO.</p>` : ""}
  </section>`;
}

/** Buat dokumen Resupply Subcontractor untuk kekurangan komponen MO penerimaan ini, lalu konfirmasi dan cek ketersediaannya. */
export async function createResupply(el, pkId) {
  return guarded(el, async () => {
    const [pk] = await searchRead("stock.picking", [["id", "=", pkId]], ["name", "partner_id", "picking_type_id", "origin", "company_id"], { limit: 1 });
    const moves = await searchRead("stock.move", [["picking_id", "=", pkId], ["is_subcontract", "=", true]], ["id"]);
    const productions = (await productionsOf(moves.map((m) => m.id))).filter((p) => p.state !== "done" && p.state !== "cancel");
    const rows = (await needs(productions)).filter((r) => r.short > 0);
    if (!rows.length) throw new Error("Komponen sudah lengkap di lokasi Subcontracting.");
    const [type] = await searchRead("stock.picking.type", [["id", "=", pk.picking_type_id[0]]], ["warehouse_id"], { limit: 1 });
    const [wh] = await searchRead("stock.warehouse", [["id", "=", type.warehouse_id[0]]], ["lot_stock_id", "subcontracting_resupply_type_id"], { limit: 1 });
    if (!wh?.subcontracting_resupply_type_id) throw new Error("Gudang ini belum punya tipe operasi Resupply Subcontractor. Aktifkan di pengaturan gudang.");
    const src = wh.lot_stock_id[0];
    const [group] = productions[0] ? await searchRead("mrp.production", [["id", "=", productions[0].id]], ["production_group_id"], { limit: 1 }) : [];
    const groupId = group?.production_group_id?.[0] ?? false; // menautkan resupply ke MO (dan lewat MO ke PO)
    const [id] = await call("stock.picking", "create", {
      vals_list: [{
        picking_type_id: wh.subcontracting_resupply_type_id[0], partner_id: pk.partner_id?.[0] ?? false, location_id: src, location_dest_id: rows[0].location,
        origin: pk.origin || pk.name,
        move_ids: rows.map((r) => [0, 0, { product_id: r.product[0], product_uom_qty: r.short, product_uom: r.uom[0], location_id: src, location_dest_id: r.location, production_group_id: groupId }]),
      }],
    });
    await call("stock.picking", "action_confirm", { ids: [id] });
    await call("stock.picking", "action_assign", { ids: [id] });
    toast("Resupply komponen dibuat.");
    location.hash = `#/transfer/${id}`;
    return id;
  });
}

/** Catatan pada halaman MO: MO subkontrak diselesaikan lewat penerimaan PO-nya. */
export async function moNote(mo) {
  if (!mo.subcontractor_id) return "";
  const moves = await searchRead("stock.move", [["move_orig_ids.production_id", "=", mo.id], ["is_subcontract", "=", true]], ["picking_id", "state", "purchase_line_id"]);
  const receipt = moves[0]?.picking_id;
  return `<p class="mb-3 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">MO subkontrak untuk <b>${esc(mo.subcontractor_id[1])}</b>. Komponen dikirim lewat Resupply Subcontractor ke lokasi Subcontracting; MO ini diselesaikan saat penerimaan${receipt ? ` <a href="#/receipt/${receipt[0]}" class="underline">${esc(receipt[1])}</a>` : ""} divalidasi.</p>`;
}
