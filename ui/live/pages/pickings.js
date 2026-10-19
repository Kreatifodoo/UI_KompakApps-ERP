// Operasi gudang (stock.picking): penerimaan barang (incoming) dan pengiriman barang (outgoing) memakai satu
// kerangka. Struktur form mengikuti view Odoo: tombol Mark as Todo, Check Availability, Validate, Cancel;
// bilah status draft/assigned/done; operasi dengan jumlah yang bisa diedit; wizard backorder saat jumlah
// kurang dari permintaan.
import {
  actionBar, app, badge, call, cell, chatterHtml, closeModal, dateText, dateTimeText, esc, fieldBlock, filterSelect, fromInputDateTime, guarded, loadMessages,
  openModal, money, pageHeader, readOne, readonlyValue, rowLink, searchRead, statTiles, statusbar, table, toast, toInputDateTime, INPUT,
} from "../common.js";
import { deliveryJournals, receiptJournals } from "../stockjournal.js";
import { printButton } from "../print.js";

const STATES = {
  draft: ["Draft", "muted"],
  waiting: ["Menunggu Operasi Lain", "warning"],
  confirmed: ["Menunggu", "warning"],
  assigned: ["Siap", "info"],
  done: ["Selesai", "success"],
  cancel: ["Dibatalkan", "danger"],
};
const FLOW = ["draft", "assigned", "done"];

export const RECEIPT = {
  route: "receipt", code: "incoming", returnRoute: "delivery", title: "Penerimaan Barang", noun: "Penerimaan", partner: "Diterima dari", qty: "Jumlah Diterima", qtyLabel: "diterima",
  source: { field: "purchase_id", route: "po", label: "Purchase Order", icon: "fa-shopping-cart", param: "po" },
  empty: "Belum ada penerimaan barang. Penerimaan terbentuk otomatis saat Purchase Order dikonfirmasi.",
  valuedNote: (pk, journaled) =>
    journaled
      ? `Barang diterima dijurnal saat ini juga: Dr Persediaan, Cr Barang Diterima Belum Ditagih, dengan akun dari Product Category. Tagihan vendor${pk.purchase_id ? ` (<a href="#/po/${pk.purchase_id[0]}" class="underline">${esc(pk.purchase_id[1])}</a>)` : ""} membersihkan akun perantara itu.`
      : `Nilai persediaan sudah tercatat pada pergerakan stok. Penerimaan ini tidak dijurnal saat barang diterima (biaya standar, atau diterima sebelum jurnal per transaksi aktif); jurnal persediaan atau biaya tercipta saat tagihan vendor diposting${pk.purchase_id ? ` (<a href="#/po/${pk.purchase_id[0]}" class="underline">${esc(pk.purchase_id[1])}</a>)` : ""}.`,
};
export const DELIVERY = {
  route: "delivery", code: "outgoing", returnRoute: "receipt", title: "Pengiriman Barang", noun: "Pengiriman", partner: "Dikirim ke", qty: "Jumlah Dikirim", qtyLabel: "dikirim",
  source: { field: "sale_id", route: "sale", label: "Sales Order", icon: "fa-cart-shopping", param: "so" },
  empty: "Belum ada pengiriman barang. Pengiriman terbentuk otomatis saat Sales Order dikonfirmasi.",
  valuedNote: (pk, journaled) =>
    journaled
      ? `Barang keluar dijurnal saat ini juga: Dr Barang Terkirim Belum Ditagih, Cr Persediaan, dengan akun dari Product Category. Faktur pelanggan${pk.sale_id ? ` (<a href="#/sale/${pk.sale_id[0]}" class="underline">${esc(pk.sale_id[1])}</a>)` : ""} mencatat harga pokok (Dr HPP) dan membersihkan akun perantara itu.`
      : `Barang sudah keluar dari gudang dan nilainya tercatat pada pergerakan stok. Pengiriman ini tidak dijurnal saat barang keluar (biaya standar, kasir, atau dikirim sebelum jurnal per transaksi aktif); harga pokok (Dr HPP, Cr Persediaan) tercipta saat faktur pelanggan diposting${pk.sale_id ? ` (<a href="#/sale/${pk.sale_id[0]}" class="underline">${esc(pk.sale_id[1])}</a>)` : ""}.`,
};

/** Halaman tempat dokumen dibuka menurut jenis tipe operasinya (rute suplai antar gudang dan multi-langkah mencampur jenis). */
const ROUTE_OF = { incoming: "receipt", outgoing: "delivery", internal: "transfer" };

export function createPickingPage(config) {
  const BUTTONS = [
    { action: "todo", label: "Tandai To-Do", method: "action_confirm", kind: "primary", show: (p) => p.state === "draft" },
    { action: "assign", label: "Cek Ketersediaan", method: "action_assign", kind: "primary", show: (p) => p.show_check_availability },
    { action: "validate", label: "Validasi", method: null, kind: "primary", show: (p) => !["done", "cancel"].includes(p.state) },
    ...(config.returnRoute ? [{ action: "return", label: "Retur", method: null, show: (p) => p.state === "done" }] : []),
    { action: "cancel", label: "Batalkan", method: "action_cancel", kind: "danger", show: (p) => ["assigned", "confirmed", "draft", "waiting"].includes(p.state) },
  ];
  const DONE_MESSAGE = { todo: `${config.noun} ditandai to-do.`, assign: "Ketersediaan diperiksa.", cancel: `${config.noun} dibatalkan.` };

  let edits = new Map(); // id move -> jumlah yang sedang diedit
  let moves = [];
  let lotEdits = new Map(); // id move berlacak -> baris lot yang sedang diedit
  let lotOptions = new Map(); // id produk -> lot yang punya stok di lokasi asal
  let expiryProducts = new Set(); // id produk yang memakai tanggal kedaluwarsa
  let lotMode = { create: false, existing: true }; // tipe operasi: lot baru diketik, atau dipilih dari stok
  let last = { sub: "", query: new URLSearchParams() };
  let pendingBackorder = null;
  let pendingExpiry = null;
  let returning = null; // { pickingId, wizardId, context, lines }
  const leave = () => {
    edits = new Map();
    lotEdits = new Map();
    lotOptions = new Map();
    expiryProducts = new Set();
  };
  const reload = () => render(last.sub, last.query);

  async function render(sub, query) {
    last = { sub, query };
    if (sub === "") return renderList(query);
    return renderForm(Number(sub));
  }

  async function renderList(query) {
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    const filter = query.get("state") ?? "";
    const ids = (query.get("ids") ?? "").split(",").map(Number).filter(Boolean);
    const source = config.source ? Number(query.get(config.source.param)) || null : null;
    const returnsOnly = query.get("returns") === "1";
    const transit = config.code === "internal" && query.get("scope") === "transit";
    const mixed = ids.length > 0 || transit; // tautan dari PO, SO, dan Replenishment bisa memuat beberapa jenis dokumen
    const domain = mixed ? [["picking_type_code", "in", Object.keys(ROUTE_OF)]] : [["picking_type_code", "=", config.code]];
    if (transit) domain.push("|", ["location_id.usage", "=", "transit"], ["location_dest_id.usage", "=", "transit"]);
    if (returnsOnly) domain.push(["return_id", "!=", false]);
    if (filter) domain.push(["state", "=", filter]);
    if (ids.length) domain.push(["id", "in", ids]);
    if (source) domain.push([config.source.field, "=", source]);
    const rows = await searchRead("stock.picking", domain, ["name", "partner_id", "scheduled_date", "origin", "state", "picking_type_id", "picking_type_code", "location_id", "location_dest_id"], { order: "id desc", limit: 80 });
    const options = [["", "Semua status"], ...Object.entries(STATES).map(([k, v]) => [k, v[0]])];
    const wide = config.code === "internal" || mixed; // gudang asal dan tujuan terlihat dari nama lokasi (kode gudang di depan)
    const body = rows
      .map((r) =>
        rowLink(`#/${ROUTE_OF[r.picking_type_code] ?? config.route}/${r.id}`, [
          cell(r.name, { strong: true }),
          cell(r.partner_id?.[1] ?? ""),
          ...(wide ? [cell(r.picking_type_id?.[1] ?? ""), cell(r.location_id?.[1] ?? ""), cell(r.location_dest_id?.[1] ?? "")] : []),
          cell(dateTimeText(r.scheduled_date)),
          cell(r.origin || "-"),
          cell(badge(STATES, r.state), { raw: true }),
        ]),
      )
      .join("");
    const scopeLink = config.code === "internal"
      ? `<a href="#/${config.route}${transit ? "" : "?scope=transit"}" class="px-4 py-2 border rounded-lg text-sm ${transit ? "bg-indigo-50 border-indigo-300 text-indigo-700" : "bg-white border-gray-300 hover:bg-gray-50"}"><i class="fas fa-truck-ramp-box mr-2"></i>Antar Gudang</a>`
      : "";
    app.innerHTML =
      pageHeader(
        returnsOnly ? `Retur ${config.code === "outgoing" ? "Penerimaan (keluar)" : "Pengiriman (masuk)"}` : transit ? "Transfer Antar Gudang" : config.title,
        `${filterSelect(options, filter)}${scopeLink}
         <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
         ${config.newHref ? `<a href="${config.newHref}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>${config.newLabel}</a>` : ""}`,
      ) +
      (transit ? '<p class="text-sm text-gray-600 mb-3">Dokumen yang keluar dari atau masuk ke lokasi transit antar gudang: pengiriman keluar dari gudang pemasok, lalu penerimaan di gudang tujuan (dari rute suplai di Reorder Level).</p>' : "") +
      table(
        [{ label: "Referensi" }, { label: config.partner }, ...(wide ? [{ label: "Tipe Operasi" }, { label: "Dari" }, { label: "Ke" }] : []), { label: "Tanggal Terjadwal" }, { label: "Dokumen Sumber" }, { label: "Status" }],
        body,
        transit ? "Belum ada transfer antar gudang." : config.empty,
      );
  }

  /** Langkah sebelum dan sesudah dokumen ini (multi-langkah dan antar gudang: keluar, transit, terima, simpan). */
  async function chainSteps(id, list) {
    const linked = [...new Set(list.flatMap((m) => [...m.move_orig_ids, ...m.move_dest_ids]))];
    if (!linked.length) return "";
    const rows = await searchRead("stock.move", [["id", "in", linked], ["picking_id", "!=", false]], ["picking_id", "state"]);
    const before = new Set(list.flatMap((m) => m.move_orig_ids));
    const items = new Map();
    for (const r of rows) {
      if (r.picking_id[0] === id) continue;
      if (!items.has(r.picking_id[0])) items.set(r.picking_id[0], { id: r.picking_id[0], name: r.picking_id[1], after: !before.has(r.id) });
    }
    if (!items.size) return "";
    const pickings = await searchRead("stock.picking", [["id", "in", [...items.keys()]]], ["name", "state", "picking_type_code", "picking_type_id"], { order: "id" });
    const li = (p) => `<li>${items.get(p.id).after ? "Langkah berikutnya" : "Langkah sebelumnya"}: <a href="#/${ROUTE_OF[p.picking_type_code] ?? config.route}/${p.id}" class="text-indigo-700 hover:underline">${esc(p.name)}</a> <span class="text-gray-500">(${esc(p.picking_type_id?.[1] ?? "")})</span> ${badge(STATES, p.state)}</li>`;
    return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4"><div class="text-sm font-semibold mb-2">Rangkaian operasi</div><ul class="text-sm space-y-1">${pickings.map(li).join("")}</ul></section>`;
  }

  async function renderForm(id) {
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    const pk = await readOne("stock.picking", id, [
      "name", "state", "partner_id", "picking_type_id", "picking_type_code", "location_id", "location_dest_id", "scheduled_date", "date_deadline", "date_done",
      "origin", "backorder_id", ...(config.source ? [config.source.field] : []), "show_check_availability", "return_count", "return_id", "return_ids",
    ]);
    if (pk && pk.picking_type_code !== config.code && ROUTE_OF[pk.picking_type_code]) {
      location.replace(`#/${ROUTE_OF[pk.picking_type_code]}/${id}`); // mis. Storage atau Pick dari PO atau SO multi-langkah
      return;
    }
    if (!pk || pk.picking_type_code !== config.code) {
      app.innerHTML = `<p class="text-sm text-rose-600">${config.noun} tidak ditemukan.</p>`;
      return;
    }
    moves = await searchRead(
      "stock.move",
      [["picking_id", "=", id]],
      ["product_id", "description_picking", "product_uom_qty", "quantity", "product_uom", "picked", "state", "value", "has_tracking", "location_id", "location_dest_id", "move_orig_ids", "move_dest_ids", "account_move_id"],
      { order: "id" },
    );
    const chain = await chainSteps(id, moves);
    // jurnal sungguhan dari tagihan vendor (penerimaan) atau faktur pelanggan (pengiriman) yang memuat nilai stok ini
    const journal = pk.state === "done" && config.code === "incoming" ? await receiptJournals(pk, moves) : pk.state === "done" && config.code === "outgoing" ? await deliveryJournals(pk, moves) : "";
    edits = new Map();
    await loadLots(pk);
    last.state = pk.state;
    const editable = !["done", "cancel"].includes(pk.state);
    const valued = pk.state === "done" && moves.some((m) => m.value);
    const src = config.source ? pk[config.source.field] : null;

    const cols = valued ? 6 : 5;
    const rows = moves
      .map((m) => {
        const tracked = isTracked(m);
        const qtyCell = tracked
          ? `<span data-lot-total="${m.id}">${esc(lotTotal(m))}</span>`
          : editable
            ? `<input type="number" min="0" step="any" data-move="${m.id}" value="${esc(m.quantity)}" class="${INPUT} text-right" aria-label="${esc(config.qty)} untuk ${esc(m.product_id?.[1])}">`
            : esc(m.quantity);
        const main = `<tr class="align-top">
          <td class="py-2 px-4 text-sm">${esc(m.product_id?.[1])}${tracked ? ` <span class="ml-1 px-2 py-0.5 rounded-full text-xs bg-indigo-50 text-indigo-700">${m.has_tracking === "serial" ? "Nomor seri" : "Lot"}</span>` : ""}</td>
          <td class="py-2 px-4 text-sm">${esc(m.description_picking || "")}</td>
          <td class="py-2 px-4 text-sm text-right">${esc(m.product_uom_qty)}</td>
          <td class="py-2 px-4 text-sm text-right ${tracked ? "" : "w-36"}">${qtyCell}</td>
          <td class="py-2 px-4 text-sm">${esc(m.product_uom?.[1])}</td>
          ${valued ? `<td class="py-2 px-4 text-sm text-right">${money(Math.abs(m.value))}</td>` : ""}
        </tr>`;
        if (!tracked) return main;
        return `${main}<tr class="bg-gray-50"><td colspan="${cols}" class="px-4 pb-3 pt-1"><div id="lots-${m.id}">${lotEditorHtml(m, pk.state)}</div></td></tr>`;
      })
      .join("");

    app.innerHTML = `
      <div class="text-sm text-gray-500 mb-2"><a href="#/${config.route}" class="hover:text-indigo-600">${config.title}</a> / ${esc(pk.name)}</div>
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
        <div class="flex flex-wrap gap-2">${actionBar(BUTTONS, pk)}${printButton("stock.picking", pk.id)}</div>
        ${statusbar(FLOW, STATES, pk.state)}
      </div>
      <div class="flex flex-wrap gap-2 mb-4">${statTiles([
        ...(config.source ? [{ count: src ? 1 : 0, label: `${config.source.label} ${src?.[1] ?? ""}`, icon: config.source.icon, href: `#/${config.source.route}/${src?.[0]}` }] : []),
        { count: pk.backorder_id ? 1 : 0, label: `Backorder dari ${pk.backorder_id?.[1] ?? ""}`, icon: "fa-rotate-left", href: `#/${config.route}/${pk.backorder_id?.[0]}` },
        ...(config.returnRoute
          ? [
              { count: pk.return_id ? 1 : 0, label: `Retur dari ${pk.return_id?.[1] ?? ""}`, icon: "fa-rotate-left", href: `#/${config.route === "receipt" ? "delivery" : "receipt"}/${pk.return_id?.[0]}` },
              { count: pk.return_count, label: "Retur", icon: "fa-rotate-left", href: `#/${config.returnRoute}?ids=${pk.return_ids.join(",")}` },
            ]
          : []),
      ])}</div>
      <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(pk.name)}</h1>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
        ${fieldBlock(config.partner, readonlyValue(pk.partner_id?.[1]))}
        ${fieldBlock("Tipe Operasi", readonlyValue(pk.picking_type_id?.[1]))}
        ${fieldBlock("Lokasi Asal", readonlyValue(pk.location_id?.[1]))}
        ${fieldBlock("Lokasi Tujuan", readonlyValue(pk.location_dest_id?.[1]))}
        ${fieldBlock("Tanggal Terjadwal", readonlyValue(pk.scheduled_date ? dateTimeText(pk.scheduled_date) : ""))}
        ${fieldBlock(pk.state === "done" ? "Tanggal Efektif" : "Batas Waktu", readonlyValue(pk.state === "done" ? dateTimeText(pk.date_done) : pk.date_deadline ? dateTimeText(pk.date_deadline) : ""))}
        ${fieldBlock("Dokumen Sumber", readonlyValue(pk.origin))}
      </section>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
        <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Operasi</div>
        <table class="w-full text-left"><thead class="bg-gray-50"><tr>${[...["Produk", "Deskripsi", "Permintaan", config.qty, "Satuan"], ...(valued ? ["Nilai Persediaan"] : [])]
          .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i === 2 || i === 3 || i === 5 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
          <tbody class="divide-y divide-gray-100">${rows}</tbody></table>
      </section>
      ${chain}
      ${valued && config.valuedNote ? `<p class="mt-3 text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3">${config.valuedNote(pk, moves.some((m) => m.account_move_id))}</p>` : ""}
      ${journal}
      ${chatterHtml("stock.picking", pk.id)}`;
    loadMessages("stock.picking", pk.id);
  }

  /* ---------- Lot dan nomor seri ---------- */

  const isTracked = (m) => Boolean(m.has_tracking) && m.has_tracking !== "none";
  const lotLines = (m) => lotEdits.get(m.id) ?? [];
  const lotTotal = (m) => lotLines(m).reduce((sum, l) => sum + (Number(l.qty) || 0), 0);
  const MAX_EXPANDED_SERIALS = 100;

  /** Baris lot per pergerakan berlacak, dari move line Odoo. Nomor seri tanpa nama dipecah menjadi satu baris per unit. */
  async function loadLots(pk) {
    lotEdits = new Map();
    lotOptions = new Map();
    expiryProducts = new Set();
    const tracked = moves.filter(isTracked);
    if (!tracked.length) return;
    const [type, lines, products] = await Promise.all([
      readOne("stock.picking.type", pk.picking_type_id[0], ["use_create_lots", "use_existing_lots"]),
      searchRead(
        "stock.move.line", [["picking_id", "=", pk.id], ["move_id", "in", tracked.map((m) => m.id)]],
        ["move_id", "lot_id", "lot_name", "quantity", "location_id", "location_dest_id", "expiration_date"], { order: "id" },
      ),
      searchRead("product.product", [["id", "in", [...new Set(tracked.map((m) => m.product_id[0]))]]], ["use_expiration_date"]),
    ]);
    expiryProducts = new Set(products.filter((p) => p.use_expiration_date).map((p) => p.id));
    lotMode = { create: Boolean(type?.use_create_lots), existing: Boolean(type?.use_existing_lots) };
    for (const m of tracked) {
      const rows = [];
      for (const l of lines.filter((x) => x.move_id[0] === m.id)) {
        const name = l.lot_id?.[1] || l.lot_name || ""; // lot_name kosong dikirim Odoo sebagai false
        const base = {
          id: l.id, lotId: l.lot_id?.[0] ?? null, name, qty: l.quantity, expiry: l.expiration_date ? toInputDateTime(l.expiration_date) : "",
          orig: { lotId: l.lot_id?.[0] ?? null, name, qty: l.quantity, expiry: l.expiration_date ? toInputDateTime(l.expiration_date) : "" },
          loc: l.location_id[0], locDest: l.location_dest_id[0], usesExpiry: expiryProducts.has(m.product_id[0]),
        };
        if (m.has_tracking === "serial" && !name && l.quantity > 1 && l.quantity <= MAX_EXPANDED_SERIALS) {
          rows.push({ ...base, qty: 1 });
          for (let i = 1; i < l.quantity; i++) rows.push({ ...base, id: null, qty: 1, orig: null });
        } else rows.push(base);
      }
      lotEdits.set(m.id, rows);
    }
    if (lotMode.create || ["done", "cancel", "draft"].includes(pk.state)) return;
    // Pilihan lot untuk pengiriman dan transfer: lot yang punya stok di lokasi asal.
    const quants = await searchRead(
      "stock.quant", [["product_id", "in", [...new Set(tracked.map((m) => m.product_id[0]))]], ["location_id", "child_of", pk.location_id[0]], ["lot_id", "!=", false], ["quantity", ">", 0]],
      ["product_id", "lot_id", "quantity"], { limit: 500 },
    );
    for (const q of quants) {
      const list = lotOptions.get(q.product_id[0]) ?? new Map();
      const entry = list.get(q.lot_id[0]) ?? { id: q.lot_id[0], name: q.lot_id[1], qty: 0 };
      entry.qty += q.quantity;
      list.set(q.lot_id[0], entry);
      lotOptions.set(q.product_id[0], list);
    }
  }

  const lotInput = (m, i, field, value, extra = "") =>
    `<input data-lotline="${m.id}" data-idx="${i}" data-f="${field}" value="${esc(value)}" ${extra} class="${INPUT}">`;

  function lotRowHtml(m, line, i) {
    const serial = m.has_tracking === "serial";
    let nameCell;
    if (lotMode.create) {
      nameCell = lotInput(m, i, "name", line.name, `placeholder="${serial ? "Nomor seri" : "Nomor lot"}" aria-label="${serial ? "Nomor seri" : "Nomor lot"}" maxlength="120"`);
    } else {
      const options = [...(lotOptions.get(m.product_id[0])?.values() ?? [])];
      if (line.lotId && !options.some((o) => o.id === line.lotId)) options.push({ id: line.lotId, name: line.name, qty: 0 });
      nameCell = `<select data-lotline="${m.id}" data-idx="${i}" data-f="lot" class="${INPUT}" aria-label="Lot/Serial"><option value="">Pilih lot...</option>${options
        .map((o) => `<option value="${o.id}" data-name="${esc(o.name)}" ${o.id === line.lotId ? "selected" : ""}>${esc(o.name)} (${esc(o.qty)} tersedia)</option>`)
        .join("")}</select>`;
    }
    return `<div class="flex flex-wrap items-center gap-2 mb-2">
      <div class="flex-1 min-w-[12rem]">${nameCell}</div>
      ${lotMode.create && line.usesExpiry ? `<input type="datetime-local" data-lotline="${m.id}" data-idx="${i}" data-f="expiry" value="${esc(line.expiry)}" class="${INPUT} w-52" aria-label="Tanggal kedaluwarsa">` : ""}
      <input type="number" min="0" step="any" data-lotline="${m.id}" data-idx="${i}" data-f="qty" value="${esc(line.qty)}" ${serial ? "disabled" : ""} class="${INPUT} w-28 text-right" aria-label="Jumlah">
      <button type="button" data-action="lot-remove" data-move="${m.id}" data-idx="${i}" class="px-2 py-2 text-rose-600 hover:bg-rose-50 rounded-lg" aria-label="Hapus baris lot"><i class="fas fa-trash"></i></button></div>`;
  }

  function lotEditorHtml(m, state) {
    const lines = lotLines(m);
    if (["done", "cancel"].includes(state)) {
      const shown = lines.filter((l) => Number(l.qty) > 0 && (l.name || l.lotId));
      if (!shown.length) return '<div class="text-xs text-gray-500">Tidak ada lot tercatat.</div>';
      return `<div class="text-xs font-semibold text-gray-500 uppercase mb-1">Lot/Serial</div>${shown
        .map((l) => `<div class="text-sm text-gray-700">${l.lotId ? `<a href="#/lot/${l.lotId}" class="text-indigo-700 hover:underline">${esc(l.name)}</a>` : esc(l.name)} <span class="text-gray-500">· ${esc(l.qty)}${l.expiry ? ` · kedaluwarsa ${esc(dateText(fromInputDateTime(l.expiry)))}` : ""}</span></div>`)
        .join("")}`;
    }
    if (state === "draft") return '<div class="text-xs text-gray-500">Nomor lot diisi setelah dokumen ditandai to-do.</div>';
    const serial = m.has_tracking === "serial";
    return `<div class="text-xs font-semibold text-gray-500 uppercase mb-2">${serial ? "Nomor Seri" : "Lot"} <span class="normal-case font-normal text-gray-400">${lotMode.create ? "(ketik nomor baru atau yang sudah ada)" : "(pilih dari stok di lokasi asal)"}</span></div>
      ${lines.map((l, i) => lotRowHtml(m, l, i)).join("") || '<div class="text-sm text-gray-500 mb-2">Belum ada baris. Tambahkan lot di bawah.</div>'}
      <div class="flex gap-2"><button type="button" data-action="lot-add" data-move="${m.id}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-plus mr-1"></i>${serial ? "Tambah Nomor Seri" : "Tambah Lot"}</button>
      ${serial && lotMode.create ? `<button type="button" data-action="lot-bulk" data-move="${m.id}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Tempel Banyak Nomor Seri</button>` : ""}</div>`;
  }

  const repaintLots = (m, state) => {
    const box = document.getElementById(`lots-${m.id}`);
    if (box) box.innerHTML = lotEditorHtml(m, state);
    const total = document.querySelector(`[data-lot-total="${m.id}"]`);
    if (total) total.textContent = lotTotal(m);
  };
  const stateNow = () => last.state ?? "assigned";

  /** Memeriksa baris lot sebelum dikirim: nama terisi, seri 1 per unit, tidak ada nomor ganda. */
  function checkLots(m) {
    const lines = lotLines(m).filter((l) => Number(l.qty) > 0);
    const seen = new Set();
    for (const l of lines) {
      const key = lotMode.create ? l.name.trim() : l.lotId;
      if (!key) throw new Error(`Isi ${m.has_tracking === "serial" ? "nomor seri" : "nomor lot"} untuk ${m.product_id[1]}.`);
      if (seen.has(key)) throw new Error(`${m.product_id[1]}: nomor ${lotMode.create ? l.name.trim() : l.name} dipakai dua kali. Gabungkan jumlahnya dalam satu baris.`);
      seen.add(key);
      if (m.has_tracking === "serial" && Number(l.qty) !== 1) throw new Error(`${m.product_id[1]}: satu nomor seri hanya untuk satu unit.`);
    }
    for (const l of lotLines(m)) if (!(Number(l.qty) >= 0)) throw new Error("Jumlah lot tidak boleh negatif.");
  }

  /** Menyimpan baris lot sebuah pergerakan: hapus yang dibuang, ubah yang berubah, buat yang baru. */
  async function saveLots(m, pickingId) {
    const lines = lotLines(m);
    const keep = new Set(lines.map((l) => l.id).filter(Boolean));
    const existing = await searchRead("stock.move.line", [["move_id", "=", m.id]], ["id"]);
    const drop = existing.map((r) => r.id).filter((id) => !keep.has(id));
    if (drop.length) await call("stock.move.line", "unlink", { ids: drop });
    for (const l of lines) {
      const qty = Number(l.qty) || 0;
      const vals = { quantity: qty, picked: qty > 0 };
      if (lotMode.create) {
        const name = l.name.trim();
        if (!l.id) vals.lot_name = name || false;
        else if (name !== l.orig.name) Object.assign(vals, { lot_id: false, lot_name: name || false });
        if (l.usesExpiry && l.expiry && l.expiry !== l.orig?.expiry) vals.expiration_date = fromInputDateTime(l.expiry);
      } else if (!l.id) vals.lot_id = l.lotId || false;
      else if (l.lotId !== l.orig.lotId) vals.lot_id = l.lotId || false;
      if (l.id) {
        const changed = vals.lot_id !== undefined || vals.lot_name !== undefined || vals.expiration_date !== undefined || qty !== l.orig.qty || (qty > 0) !== (l.orig.qty > 0);
        if (changed) await call("stock.move.line", "write", { ids: [l.id], vals });
      } else {
        await call("stock.move.line", "create", {
          vals_list: [{ move_id: m.id, picking_id: pickingId, product_id: m.product_id[0], product_uom_id: m.product_uom[0], location_id: m.location_id[0], location_dest_id: m.location_dest_id[0], ...vals }],
        });
      }
    }
  }

  function addLotLine(m) {
    const lines = lotLines(m);
    const serial = m.has_tracking === "serial";
    const rest = Math.max(0, m.product_uom_qty - lotTotal(m));
    lotEdits.set(m.id, [...lines, { id: null, lotId: null, name: "", qty: serial ? 1 : rest || 1, expiry: "", orig: null, loc: m.location_id[0], locDest: m.location_dest_id[0], usesExpiry: expiryProducts.has(m.product_id[0]) }]);
  }

  function bulkSerials(button, moveId) {
    const m = moves.find((x) => x.id === moveId);
    openModal(
      "Tempel Nomor Seri",
      `<form data-form="serials" data-move="${m.id}" class="space-y-3">
         <p class="text-sm text-gray-600">Satu nomor seri per baris untuk <b>${esc(m.product_id[1])}</b>. Baris kosong dilewati.</p>
         <textarea data-bulk="serials" rows="8" class="${INPUT} font-mono" aria-label="Daftar nomor seri"></textarea></form>`,
      `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
       <button data-action="serials-confirm" data-move="${m.id}" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Tambahkan</button>`,
    );
  }

  function confirmSerials(moveId) {
    const m = moves.find((x) => x.id === moveId);
    const names = document.querySelector('[data-bulk="serials"]').value.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (!names.length) {
      toast("Isi minimal satu nomor seri.", "error");
      return;
    }
    if (new Set(names).size !== names.length) {
      toast("Ada nomor seri yang dobel dalam daftar.", "error");
      return;
    }
    const lines = lotLines(m);
    const queue = [...names];
    for (const l of lines) if (!l.name && queue.length) l.name = queue.shift(); // isi baris kosong dulu
    for (const name of queue) lines.push({ id: null, lotId: null, name, qty: 1, expiry: "", orig: null, loc: m.location_id[0], locDest: m.location_dest_id[0], usesExpiry: expiryProducts.has(m.product_id[0]) });
    lotEdits.set(m.id, lines);
    closeModal();
    repaintLots(m, stateNow());
  }

  /* ---------- Validasi dan backorder ---------- */

  function askBackorder() {
    return new Promise((resolve) => {
      openModal(
        "Buat Backorder?",
        `<p class="text-sm text-gray-700">Jumlah yang ${config.qtyLabel} kurang dari yang diminta. Buat backorder untuk sisanya, atau tutup tanpa backorder?</p>`,
        `<button data-action="backorder-none" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Tanpa Backorder</button>
         <button data-action="backorder-yes" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Buat Backorder</button>
         <button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>`,
        () => resolve(null),
      );
      pendingBackorder = (choice) => {
        resolve(choice);
        closeModal(); // onClose memanggil resolve(null) yang diabaikan karena sudah terselesaikan
      };
    });
  }

  /** Konfirmasi lot kedaluwarsa atau hampir kedaluwarsa (modul product_expiry). Hasil: "go", "skip", atau null. */
  function askExpiry(lotNames) {
    return new Promise((resolve) => {
      openModal(
        "Lot Kedaluwarsa atau Hampir Kedaluwarsa",
        `<p class="text-sm text-gray-700 mb-2">Lot berikut sudah kedaluwarsa atau sudah melewati tanggal penarikan/peringatan:</p>
         <ul class="list-disc pl-5 text-sm text-gray-800 mb-3">${lotNames.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
         <p class="text-sm text-gray-700">Lanjutkan ${config.noun.toLowerCase()} dengan lot ini?</p>`,
        `<button data-action="expiry-cancel" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
         ${config.code !== "incoming" ? '<button data-action="expiry-skip" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Lewati Lot yang Kedaluwarsa</button>' : ""}
         <button data-action="expiry-go" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Tetap Lanjutkan</button>`,
        () => resolve(null),
      );
      pendingExpiry = (choice) => {
        resolve(choice);
        closeModal();
      };
    });
  }

  async function validate(button, id) {
    const ok = await guarded(button, async () => {
      for (const m of moves) {
        if (isTracked(m)) {
          checkLots(m);
          await saveLots(m, id);
          continue;
        }
        const qty = Number(edits.get(m.id) ?? m.quantity);
        if (!(qty >= 0)) throw new Error(`Jumlah yang ${config.qtyLabel} tidak boleh negatif.`);
        if (qty !== m.quantity || (qty > 0) !== m.picked) {
          await call("stock.move", "write", { ids: [m.id], vals: { quantity: qty, picked: qty > 0 } });
        }
      }
      let result = await call("stock.picking", "button_validate", { ids: [id] });
      // Odoo bisa meminta beberapa langkah berturut-turut (konfirmasi kedaluwarsa, lalu backorder).
      for (let step = 0; step < 4; step++) {
        if (result === true || result === false || result == null) return true;
        const context = result.context ?? {};
        if (result.res_model === "stock.backorder.confirmation") {
          const choice = await askBackorder();
          if (!choice) return false;
          const wizard = await call("stock.backorder.confirmation", "create", { vals_list: [{}], context });
          await call("stock.backorder.confirmation", choice === "backorder" ? "process" : "process_cancel_backorder", { ids: wizard, context });
          return true;
        }
        if (result.res_model === "expiry.picking.confirmation") {
          const [wizardId] = await call("expiry.picking.confirmation", "create", { vals_list: [{}], context });
          const [wizard] = await call("expiry.picking.confirmation", "read", { ids: [wizardId], fields: ["lot_ids"], context });
          // Lot yang baru diterima belum ada saat Odoo memeriksa; namanya dibawa lewat konteks wizard.
          const lots = wizard.lot_ids.length ? await call("stock.lot", "read", { ids: wizard.lot_ids, fields: ["display_name"] }) : [];
          const names = lots.length ? lots.map((l) => l.display_name) : [[context.expired_product_name, context.expired_lot_name].filter(Boolean).join(" · ") || "lot pada dokumen ini"];
          const choice = await askExpiry(names);
          if (!choice) return false;
          result = await call("expiry.picking.confirmation", choice === "skip" ? "process_no_expired" : "process", { ids: [wizardId], context });
          continue;
        }
        break;
      }
      throw new Error(`Odoo meminta langkah tambahan ("${result.name ?? result.res_model}") yang belum didukung UI ini. Selesaikan di Odoo.`);
    });
    if (ok) {
      toast(`${config.noun} divalidasi.`);
      reload();
    }
  }

  /* ---------- Dialog Retur (wizard stock.return.picking) ---------- */

  async function openReturn(button, id) {
    const context = { active_model: "stock.picking", active_ids: [id], active_id: id };
    const ready = await guarded(button, async () => {
      const [wizardId] = await call("stock.return.picking", "create", { vals_list: [{}], context });
      const lines = await searchRead("stock.return.picking.line", [["wizard_id", "=", wizardId]], ["product_id", "quantity", "to_refund"], { context });
      returning = { pickingId: id, wizardId, context, lines };
      return true;
    });
    if (!ready) return;
    const rows = returning.lines
      .map(
        (l) => `<tr>
          <td class="py-2 pr-3 text-sm">${esc(l.product_id?.[1])}</td>
          <td class="py-2 px-3 w-32"><input type="number" min="0" step="any" data-return-qty="${l.id}" value="${esc(l.quantity)}" class="${INPUT} text-right" aria-label="Jumlah retur ${esc(l.product_id?.[1])}"></td>
          <td class="py-2 pl-3 text-center"><input type="checkbox" data-return-refund="${l.id}" ${l.to_refund ? "checked" : ""} class="rounded border-gray-300 text-indigo-600" aria-label="Perbarui kuantitas di dokumen sumber"></td>
        </tr>`,
      )
      .join("");
    openModal(
      "Retur Barang",
      `<form data-form="return" class="space-y-3">
         <table class="w-full text-left"><thead><tr><th class="pb-2 text-xs font-semibold text-gray-600 uppercase">Produk</th><th class="pb-2 px-3 text-xs font-semibold text-gray-600 uppercase text-right">Jumlah Retur</th><th class="pb-2 pl-3 text-xs font-semibold text-gray-600 uppercase text-center">Perbarui SO/PO</th></tr></thead><tbody>${rows}</tbody></table>
         <p class="text-xs text-gray-500">Retur membuat dokumen baru (draft siap validasi). Nota kredit atau debit dibuat terpisah dari faktur atau tagihan.</p>
       </form>`,
      `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
       <button data-action="return-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Buat Retur</button>`,
      () => {
        returning = null;
      },
    );
  }

  async function confirmReturn(button) {
    const { wizardId, context, lines } = returning;
    const created = await guarded(button, async () => {
      let total = 0;
      for (const l of lines) {
        const qty = Number(document.querySelector(`[data-return-qty="${l.id}"]`).value);
        if (!(qty >= 0)) throw new Error("Jumlah retur tidak boleh negatif.");
        total += qty;
        const refund = document.querySelector(`[data-return-refund="${l.id}"]`).checked;
        if (qty !== l.quantity || refund !== l.to_refund) await call("stock.return.picking.line", "write", { ids: [l.id], vals: { quantity: qty, to_refund: refund }, context });
      }
      if (!(total > 0)) throw new Error("Isi jumlah retur untuk minimal satu produk.");
      const result = await call("stock.return.picking", "action_create_returns", { ids: [wizardId], context });
      if (!result?.res_id) throw new Error("Odoo tidak mengembalikan dokumen retur. Periksa di Odoo.");
      return result.res_id;
    });
    if (!created) return;
    closeModal();
    toast("Retur dibuat.");
    location.hash = `#/${config.returnRoute}/${created}`;
  }

  async function onClick(event, el) {
    const { action } = el.dataset;
    const id = Number(el.dataset.id) || null;
    const def = BUTTONS.find((b) => b.action === action);

    if (action === "refresh") reload();
    else if (action === "lot-add" || action === "lot-remove" || action === "lot-bulk") {
      const m = moves.find((x) => x.id === Number(el.dataset.move));
      if (action === "lot-bulk") bulkSerials(el, m.id);
      else {
        if (action === "lot-add") addLotLine(m);
        else lotEdits.set(m.id, lotLines(m).filter((_, i) => i !== Number(el.dataset.idx)));
        repaintLots(m, stateNow());
      }
    } else if (action === "serials-confirm") confirmSerials(Number(el.dataset.move));
    else if (action === "validate") await validate(el, id);
    else if (action === "return") await openReturn(el, id);
    else if (action === "return-confirm") await confirmReturn(el);
    else if (action === "expiry-go") pendingExpiry?.("go");
    else if (action === "expiry-skip") pendingExpiry?.("skip");
    else if (action === "expiry-cancel") pendingExpiry?.(null);
    else if (action === "backorder-yes") pendingBackorder?.("backorder");
    else if (action === "backorder-none") pendingBackorder?.("none");
    else if (action === "cancel" && !window.confirm(`Batalkan ${config.noun.toLowerCase()} ini?`)) {
      /* dibatalkan pengguna */
    } else if (def?.method) {
      const ok = await guarded(el, () => call("stock.picking", def.method, { ids: [id] }));
      if (ok !== undefined) {
        toast(DONE_MESSAGE[action]);
        reload();
      }
    }
  }

  function onInput(event, el) {
    if (el.dataset.move) edits.set(Number(el.dataset.move), el.value);
    else if (el.dataset.lotline) {
      const m = moves.find((x) => x.id === Number(el.dataset.lotline));
      const line = lotLines(m)[Number(el.dataset.idx)];
      if (!line) return;
      const field = el.dataset.f;
      if (field === "lot") {
        line.lotId = el.value ? Number(el.value) : null;
        line.name = el.selectedOptions[0]?.dataset.name ?? "";
      } else line[field] = el.value;
      if (field === "qty") {
        const total = document.querySelector(`[data-lot-total="${m.id}"]`);
        if (total) total.textContent = lotTotal(m);
      }
    }
  }

  async function onSubmit(event, formEl, kind) {
    if (kind === "return") await confirmReturn(null);
  }

  return { render, onClick, onInput, onSubmit, leave };
}
