// Cetak dokumen berlogo: pratinjau A4 di dialog lalu cetak atau simpan sebagai PDF lewat browser. Dokumen dibangun di sisi klien dari data
// JSON-2 (laporan PDF Odoo dirender oleh server dan tidak bisa dipanggil lewat API key). Kop surat memakai data dari Company Setting:
// logo (bila bukan logo bawaan), nama, alamat, NPWP, kontak, tagline, dan footer.
import { button, call, ctx, dateText, dateTimeText, esc, guarded, openModal, plain } from "./common.js";

const num = (n, currency) => {
  const value = Number(n ?? 0);
  const text = new Intl.NumberFormat("id-ID", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(value);
  return currency ? `${currency} ${text}` : text;
};
const text = (v) => (v ? String(v) : "");
const rich = (html) => plain(html || "");
const name2 = (m2o) => (Array.isArray(m2o) ? m2o[1] : "");

export const printButton = (model, id) => button("print-doc", "Cetak", "plain", { model, id });

/** Partner sebagai blok alamat: nama, alamat, NPWP, dan kontak. */
async function partnerBlock(id) {
  if (!id) return null;
  const [p] = await call("res.partner", "read", { ids: [id], fields: ["name", "street", "street2", "city", "zip", "state_id", "country_id", "vat", "phone", "email"] });
  const cityLine = [p.city, p.zip].filter(Boolean).join(" ");
  const lines = [p.street, p.street2, [cityLine, name2(p.state_id)].filter(Boolean).join(", "), name2(p.country_id)].filter(Boolean);
  const contact = [p.phone && `Telp. ${p.phone}`, p.email].filter(Boolean).join(" · ");
  return { name: p.name, lines: [...lines, ...(p.vat ? [`NPWP: ${p.vat}`] : []), ...(contact ? [contact] : [])] };
}

async function taxNames(rows, key = "tax_ids") {
  const ids = [...new Set(rows.flatMap((r) => r[key] ?? []))];
  if (!ids.length) return {};
  const taxes = await call("account.tax", "read", { ids, fields: ["name"] });
  return Object.fromEntries(taxes.map((t) => [t.id, t.name]));
}
const taxText = (row, names, key = "tax_ids") => (row[key] ?? []).map((id) => names[id]).filter(Boolean).join(", ");
const lineNote = (r) => r.display_type === "line_section" || r.display_type === "line_note";
const lineRow = (r, cells) => (lineNote(r) ? { section: r.display_type === "line_section", note: r.name } : { cells });

/* ---------- Pembentuk dokumen per model ---------- */

const BUILDERS = {
  async "purchase.order"(id) {
    const [o] = await call("purchase.order", "read", {
      ids: [id],
      fields: ["name", "state", "partner_id", "date_order", "date_planned", "partner_ref", "payment_term_id", "user_id", "currency_id", "amount_untaxed", "amount_tax", "amount_total", "note"],
    });
    const lines = await call("purchase.order.line", "search_read", {
      domain: [["order_id", "=", id]],
      fields: ["display_type", "name", "product_qty", "product_uom_id", "price_unit", "tax_ids", "price_subtotal"],
      order: "sequence, id",
    });
    const taxes = await taxNames(lines);
    const cur = o.currency_id?.[1];
    return {
      title: ["draft", "sent", "to approve", "cancel"].includes(o.state) ? "Request for Quotation" : "Purchase Order",
      number: o.name,
      draft: ["draft", "cancel"].includes(o.state),
      parties: [{ label: "Vendor", block: await partnerBlock(o.partner_id?.[0]) }],
      meta: [["Nomor", o.name], ["Tanggal Order", dateText(o.date_order)], ["Tanggal Penerimaan", dateText(o.date_planned)], ["Referensi Vendor", text(o.partner_ref)], ["Syarat Pembayaran", name2(o.payment_term_id)], ["Pembuat", name2(o.user_id)]],
      columns: [["Deskripsi", ""], ["Qty", "r"], ["Satuan", ""], ["Harga Satuan", "r"], ["Pajak", ""], ["Subtotal", "r"]],
      rows: lines.map((r) => lineRow(r, [r.name, num(r.product_qty), name2(r.product_uom_id), num(r.price_unit), taxText(r, taxes), num(r.price_subtotal)])),
      totals: [["Subtotal", num(o.amount_untaxed, cur)], ["Pajak", num(o.amount_tax, cur)], ["Total", num(o.amount_total, cur), true]],
      notes: [["Catatan", rich(o.note)]],
      signatures: ["Dibuat oleh", "Disetujui oleh", "Vendor"],
    };
  },

  async "sale.order"(id) {
    const [o] = await call("sale.order", "read", {
      ids: [id],
      fields: ["name", "state", "partner_id", "partner_invoice_id", "partner_shipping_id", "date_order", "validity_date", "client_order_ref", "payment_term_id", "user_id", "pricelist_id", "currency_id", "amount_untaxed", "amount_tax", "amount_total", "note"],
    });
    const lines = await call("sale.order.line", "search_read", {
      domain: [["order_id", "=", id]],
      fields: ["display_type", "name", "product_uom_qty", "product_uom_id", "price_unit", "discount", "tax_ids", "price_subtotal"],
      order: "sequence, id",
    });
    const taxes = await taxNames(lines);
    const cur = o.currency_id?.[1];
    const parties = [{ label: "Pelanggan", block: await partnerBlock(o.partner_id?.[0]) }];
    if (o.partner_shipping_id?.[0] && o.partner_shipping_id[0] !== o.partner_id?.[0]) parties.push({ label: "Alamat Pengiriman", block: await partnerBlock(o.partner_shipping_id[0]) });
    return {
      title: ["draft", "sent", "cancel"].includes(o.state) ? "Quotation" : "Sales Order",
      number: o.name,
      draft: ["draft", "cancel"].includes(o.state),
      parties,
      meta: [["Nomor", o.name], ["Tanggal Order", dateText(o.date_order)], ["Berlaku Sampai", o.validity_date ? dateText(o.validity_date) : ""], ["Referensi Pelanggan", text(o.client_order_ref)], ["Syarat Pembayaran", name2(o.payment_term_id)], ["Salesperson", name2(o.user_id)], ["Daftar Harga", name2(o.pricelist_id)]],
      columns: [["Deskripsi", ""], ["Qty", "r"], ["Satuan", ""], ["Harga Satuan", "r"], ["Diskon", "r"], ["Pajak", ""], ["Subtotal", "r"]],
      rows: lines.map((r) => lineRow(r, [r.name, num(r.product_uom_qty), name2(r.product_uom_id), num(r.price_unit), r.discount ? `${num(r.discount)}%` : "", taxText(r, taxes), num(r.price_subtotal)])),
      totals: [["Subtotal", num(o.amount_untaxed, cur)], ["Pajak", num(o.amount_tax, cur)], ["Total", num(o.amount_total, cur), true]],
      notes: [["Syarat dan Catatan", rich(o.note)]],
      signatures: ["Hormat kami", "Pelanggan"],
    };
  },

  async "account.move"(id) {
    const [m] = await call("account.move", "read", {
      ids: [id],
      fields: ["name", "state", "move_type", "partner_id", "invoice_date", "date", "invoice_date_due", "invoice_payment_term_id", "ref", "invoice_origin", "invoice_user_id", "currency_id", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "narration", "payment_reference"],
    });
    const lines = await call("account.move.line", "search_read", {
      domain: [["move_id", "=", id], ["display_type", "in", ["product", "line_section", "line_note"]]],
      fields: ["display_type", "name", "quantity", "product_uom_id", "price_unit", "discount", "tax_ids", "price_subtotal"],
      order: "sequence, id",
    });
    const taxes = await taxNames(lines);
    const cur = m.currency_id?.[1];
    const sales = ["out_invoice", "out_refund"].includes(m.move_type);
    const title = { out_invoice: "Faktur Penjualan", in_invoice: "Tagihan Vendor", out_refund: "Nota Kredit", in_refund: "Nota Debit" }[m.move_type] ?? "Jurnal";
    const paid = m.amount_total - m.amount_residual;
    const totals = [["Subtotal", num(m.amount_untaxed, cur)], ["Pajak", num(m.amount_tax, cur)], ["Total", num(m.amount_total, cur), true]];
    if (m.state === "posted" && Math.abs(paid) > 0.004) totals.push(["Sudah dibayar", num(paid, cur)], ["Sisa tagihan", num(m.amount_residual, cur), true]);
    return {
      title,
      number: m.name && m.name !== "/" ? m.name : "Draft",
      draft: m.state !== "posted",
      parties: [{ label: sales ? "Pelanggan" : "Vendor", block: await partnerBlock(m.partner_id?.[0]) }],
      meta: [["Nomor", m.name && m.name !== "/" ? m.name : "Draft"], ["Tanggal", dateText(m.invoice_date || m.date)], ["Jatuh Tempo", m.invoice_date_due ? dateText(m.invoice_date_due) : ""], ["Syarat Pembayaran", name2(m.invoice_payment_term_id)], [sales ? "Referensi Pelanggan" : "Referensi Vendor", text(m.ref)], ["Asal Dokumen", text(m.invoice_origin)], ["Berita Pembayaran", text(m.payment_reference)], ["Salesperson", name2(m.invoice_user_id)]],
      columns: [["Deskripsi", ""], ["Qty", "r"], ["Satuan", ""], ["Harga Satuan", "r"], ["Diskon", "r"], ["Pajak", ""], ["Subtotal", "r"]],
      rows: lines.map((r) => lineRow(r, [r.name, num(r.quantity), name2(r.product_uom_id), num(r.price_unit), r.discount ? `${num(r.discount)}%` : "", taxText(r, taxes), num(r.price_subtotal)])),
      totals,
      notes: [["Catatan", rich(m.narration)]],
      signatures: sales ? ["Hormat kami", "Penerima"] : [],
    };
  },

  async "stock.picking"(id) {
    const [p] = await call("stock.picking", "read", {
      ids: [id],
      fields: ["name", "state", "picking_type_code", "partner_id", "scheduled_date", "date_done", "origin", "location_id", "location_dest_id", "note"],
    });
    const moves = await call("stock.move", "search_read", { domain: [["picking_id", "=", id]], fields: ["product_id", "description_picking", "product_uom_qty", "quantity", "product_uom"], order: "sequence, id" });
    const lots = await call("stock.move.line", "search_read", { domain: [["picking_id", "=", id], ["lot_id", "!=", false]], fields: ["move_id", "lot_id", "quantity"] });
    const lotsByMove = {};
    for (const l of lots) (lotsByMove[l.move_id?.[0]] ??= []).push(`${name2(l.lot_id)} (${num(l.quantity)})`);
    const kind = p.picking_type_code;
    const title = { outgoing: "Surat Jalan", incoming: "Bukti Penerimaan Barang", internal: "Transfer Internal" }[kind] ?? "Transfer Stok";
    const partnerLabel = kind === "incoming" ? "Diterima dari" : kind === "outgoing" ? "Dikirim kepada" : "Mitra";
    return {
      title,
      number: p.name,
      draft: ["draft", "cancel"].includes(p.state),
      parties: p.partner_id ? [{ label: partnerLabel, block: await partnerBlock(p.partner_id[0]) }] : [],
      meta: [["Nomor", p.name], ["Tanggal Dijadwalkan", dateTimeText(p.scheduled_date)], ["Tanggal Selesai", p.date_done ? dateTimeText(p.date_done) : ""], ["Asal Dokumen", text(p.origin)], ["Dari Lokasi", name2(p.location_id)], ["Ke Lokasi", name2(p.location_dest_id)]],
      columns: [["Produk", ""], ["Lot / Serial", ""], ["Permintaan", "r"], ["Selesai", "r"], ["Satuan", ""]],
      rows: moves.map((mv) => ({ cells: [mv.description_picking || name2(mv.product_id), (lotsByMove[mv.id] ?? []).join(", "), num(mv.product_uom_qty), num(mv.quantity), name2(mv.product_uom)] })),
      totals: [],
      notes: [["Catatan", rich(p.note)]],
      signatures: kind === "incoming" ? ["Penerima Gudang", "Pengirim"] : kind === "outgoing" ? ["Pengirim", "Penerima"] : ["Dikeluarkan oleh", "Diterima oleh"],
    };
  },

  async "account.payment"(id) {
    const [p] = await call("account.payment", "read", {
      ids: [id],
      fields: ["name", "state", "payment_type", "partner_id", "amount", "currency_id", "date", "journal_id", "payment_method_line_id", "memo", "reconciled_invoice_ids", "reconciled_bill_ids"],
    });
    const docIds = [...(p.reconciled_invoice_ids ?? []), ...(p.reconciled_bill_ids ?? [])];
    const docs = docIds.length ? await call("account.move", "read", { ids: [...new Set(docIds)], fields: ["name", "invoice_date", "amount_total"] }) : [];
    const cur = p.currency_id?.[1];
    const inbound = p.payment_type === "inbound";
    return {
      title: inbound ? "Bukti Penerimaan" : "Bukti Pembayaran",
      number: p.name && p.name !== "/" ? p.name : "Draft",
      draft: p.state !== "paid" && p.state !== "in_process",
      parties: [{ label: inbound ? "Diterima dari" : "Dibayarkan kepada", block: await partnerBlock(p.partner_id?.[0]) }],
      meta: [["Nomor", p.name && p.name !== "/" ? p.name : "Draft"], ["Tanggal", dateText(p.date)], ["Jurnal", name2(p.journal_id)], ["Metode", name2(p.payment_method_line_id)], ["Memo", text(p.memo)]],
      columns: [["Dokumen yang dilunasi", ""], ["Tanggal", ""], ["Total Dokumen", "r"]],
      rows: docs.map((d) => ({ cells: [d.name, dateText(d.invoice_date), num(d.amount_total)] })),
      totals: [["Jumlah", num(p.amount, cur), true]],
      notes: [],
      signatures: inbound ? ["Kasir", "Pembayar"] : ["Penerima", "Kasir"],
    };
  },

  async "purchase.request"(id) {
    const [r] = await call("purchase.request", "read", { ids: [id], fields: ["name", "state", "requested_by", "assigned_to", "date_start", "origin", "description"] });
    const lines = await call("purchase.request.line", "search_read", { domain: [["request_id", "=", id]], fields: ["name", "product_id", "product_qty", "product_uom_id", "date_required", "estimated_cost"], order: "id" });
    return {
      title: "Purchase Request",
      number: r.name,
      draft: ["draft", "rejected"].includes(r.state),
      parties: [],
      meta: [["Nomor", r.name], ["Pemohon", name2(r.requested_by)], ["Ditugaskan ke", name2(r.assigned_to)], ["Tanggal", dateText(r.date_start)], ["Asal Dokumen", text(r.origin)]],
      columns: [["Barang / Jasa", ""], ["Qty", "r"], ["Satuan", ""], ["Dibutuhkan", ""], ["Estimasi Biaya", "r"]],
      rows: lines.map((l) => ({ cells: [l.name || name2(l.product_id), num(l.product_qty), name2(l.product_uom_id), l.date_required ? dateText(l.date_required) : "", l.estimated_cost ? num(l.estimated_cost) : ""] })),
      totals: [],
      notes: [["Keterangan", text(r.description)]],
      signatures: ["Pemohon", "Disetujui oleh", "Bagian Pembelian"],
    };
  },
};

/* ---------- Tampilan dokumen ---------- */

const STYLE = `
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { margin: 0; padding: 18px 22px; font: 12px/1.45 "Helvetica Neue", Arial, sans-serif; color: #111827; }
.head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111827; padding-bottom: 12px; }
.co { display: flex; gap: 12px; align-items: flex-start; }
.co img { max-height: 64px; max-width: 160px; object-fit: contain; }
.co .name { font-size: 16px; font-weight: 700; }
.co .line { color: #374151; }
.doc { text-align: right; }
.doc .title { font-size: 20px; font-weight: 700; text-transform: uppercase; letter-spacing: .02em; }
.doc .no { font-size: 14px; margin-top: 2px; }
.doc .draft { display: inline-block; margin-top: 6px; border: 1px solid #b45309; color: #b45309; border-radius: 4px; padding: 1px 8px; font-size: 11px; text-transform: uppercase; }
.info { display: flex; gap: 24px; margin-top: 14px; }
.info > div { flex: 1; }
.label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; margin-bottom: 3px; }
.party { margin-bottom: 8px; }
.party .pname { font-weight: 700; }
table { width: 100%; border-collapse: collapse; }
.meta td { padding: 1px 0; vertical-align: top; }
.meta td:first-child { color: #6b7280; width: 42%; padding-right: 8px; }
.lines { margin-top: 14px; }
.lines th { background: #f3f4f6; text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; padding: 6px 8px; border-top: 1px solid #d1d5db; border-bottom: 1px solid #d1d5db; }
.lines td { padding: 6px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
.r { text-align: right; white-space: nowrap; }
.sec td { font-weight: 700; background: #f9fafb; }
.nt td { font-style: italic; color: #4b5563; }
.totals { width: 46%; margin: 10px 0 0 auto; }
.totals td { padding: 3px 8px; }
.totals .strong td { font-weight: 700; font-size: 13px; border-top: 1px solid #111827; }
.notes { margin-top: 14px; }
.notes .body { white-space: pre-wrap; }
.sign { display: flex; gap: 24px; margin-top: 34px; page-break-inside: avoid; }
.sign > div { flex: 1; text-align: center; }
.sign .space { height: 56px; border-bottom: 1px solid #111827; margin: 0 14px 4px; }
.foot { margin-top: 26px; padding-top: 8px; border-top: 1px solid #d1d5db; color: #6b7280; font-size: 10.5px; display: flex; justify-content: space-between; gap: 16px; }
@media print { body { padding: 0; } }
`;

async function loadCompany() {
  const [c] = await call("res.company", "read", { ids: [ctx.company.id], fields: ["name", "street", "street2", "city", "zip", "state_id", "country_id", "phone", "email", "website", "vat", "company_registry", "report_header", "report_footer", "logo", "uses_default_logo"] });
  return c;
}

function companyHtml(c) {
  const cityLine = [c.city, c.zip].filter(Boolean).join(" ");
  const addr = [c.street, c.street2, [cityLine, name2(c.state_id)].filter(Boolean).join(", "), name2(c.country_id)].filter(Boolean).join(", ");
  const contact = [c.phone && `Telp. ${c.phone}`, c.email, c.website].filter(Boolean).join(" · ");
  const logo = c.logo && !c.uses_default_logo ? `<img alt="Logo" src="data:image/png;base64,${c.logo}">` : "";
  return `<div class="co">${logo}<div><div class="name">${esc(c.name)}</div>
    ${rich(c.report_header) ? `<div class="line">${esc(rich(c.report_header))}</div>` : ""}
    ${addr ? `<div class="line">${esc(addr)}</div>` : ""}${contact ? `<div class="line">${esc(contact)}</div>` : ""}
    ${c.vat ? `<div class="line">NPWP: ${esc(c.vat)}</div>` : ""}</div></div>`;
}

function documentHtml(doc, company) {
  const blocks = doc.parties
    .filter((p) => p.block)
    .map((p) => `<div class="party"><div class="label">${esc(p.label)}</div><div class="pname">${esc(p.block.name)}</div>${p.block.lines.map((l) => `<div>${esc(l)}</div>`).join("")}</div>`)
    .join("");
  const meta = doc.meta.filter(([, v]) => v).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("");
  const head = doc.columns.map(([label, align]) => `<th class="${align}">${esc(label)}</th>`).join("");
  const span = doc.columns.length;
  const body = doc.rows.length
    ? doc.rows
        .map((r) =>
          r.cells
            ? `<tr>${r.cells.map((cell, i) => `<td class="${doc.columns[i][1]}">${esc(cell)}</td>`).join("")}</tr>`
            : `<tr class="${r.section ? "sec" : "nt"}"><td colspan="${span}">${esc(r.note)}</td></tr>`,
        )
        .join("")
    : `<tr><td colspan="${span}" style="text-align:center;color:#6b7280">Tidak ada baris.</td></tr>`;
  const totals = doc.totals.length ? `<table class="totals">${doc.totals.map(([k, v, strong]) => `<tr class="${strong ? "strong" : ""}"><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`).join("")}</table>` : "";
  const notes = doc.notes.filter(([, v]) => v).map(([k, v]) => `<div class="notes"><div class="label">${esc(k)}</div><div class="body">${esc(v)}</div></div>`).join("");
  const sign = doc.signatures.length ? `<div class="sign">${doc.signatures.map((s) => `<div><div class="space"></div>${esc(s)}</div>`).join("")}</div>` : "";
  const footer = rich(company.report_footer);
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><title>${esc(doc.number)}</title><style>${STYLE}</style></head><body>
    <div class="head">${companyHtml(company)}<div class="doc"><div class="title">${esc(doc.title)}</div><div class="no">${esc(doc.number)}</div>${doc.draft ? '<div class="draft">Belum final</div>' : ""}</div></div>
    <div class="info"><div>${blocks}</div><div><table class="meta">${meta}</table></div></div>
    <table class="lines"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    ${totals}${notes}${sign}
    <div class="foot"><div>${esc(footer)}</div><div>Dicetak oleh ${esc(ctx.user?.name ?? "")} · ${esc(dateTimeText(new Date().toISOString().replace("T", " ").slice(0, 19)))}</div></div>
  </body></html>`;
}

/** Membuka pratinjau cetak dokumen. Mengembalikan false bila model belum didukung. */
export async function printDocument(model, id, trigger = null) {
  const build = BUILDERS[model];
  if (!build || !id) return false;
  const html = await guarded(trigger, async () => {
    const [doc, company] = await Promise.all([build(id), loadCompany()]);
    return { doc, page: documentHtml(doc, company) };
  });
  if (!html) return true;
  openModal(
    `Pratinjau cetak: ${html.doc.title} ${html.doc.number}`,
    `<iframe id="print-frame" title="Pratinjau dokumen" class="w-full border border-gray-200 rounded bg-white" style="height:70vh" srcdoc="${esc(html.page)}"></iframe>
     <div class="text-xs text-gray-500">Pilih "Cetak" lalu "Simpan sebagai PDF" untuk menyimpan dokumen. Kop surat diambil dari Company Setting.</div>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Tutup</button>
     <button data-action="print-now" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Cetak / Simpan PDF</button>`,
    null,
    { wide: true },
  );
  return true;
}

export function printNow() {
  const frame = document.querySelector("#print-frame");
  frame?.contentWindow?.focus();
  frame?.contentWindow?.print();
}
