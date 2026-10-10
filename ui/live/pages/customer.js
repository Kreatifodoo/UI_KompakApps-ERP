// Master Customer (res.partner sebagai pelanggan): kerangka bersama ada di partners.js. Bagian khusus:
// pengaturan penjualan (salesperson, syarat bayar, daftar harga), batas kredit, identitas pembeli untuk
// e-Faktur Coretax, akun piutang; tombol statistik Penjualan dan Faktur Pelanggan.
import {
  call, referenceFiscalPositions, referencePricelists, referenceSelection, referenceTerms, referenceUsers, searchRead,
} from "../common.js";
import { createPartnerPage } from "./partners.js";

const ID_KEYS = ["user_id", "property_payment_term_id", "property_product_pricelist", "property_account_receivable_id", "property_account_position_id"];
const receivableAccounts = () => searchRead("account.account", [["account_type", "=", "asset_receivable"]], ["display_name"], { order: "code" });

const page = createPartnerPage({
  route: "customer", title: "Master Customer", newLabel: "Customer Baru", noun: "Customer",
  rank: { field: "customer_rank", filterLabel: "Pelanggan", defaultFilter: "customer" },
  empty: "Belum ada pelanggan. Buat dengan tombol Customer Baru.",
  idKeys: ID_KEYS,
  textKeys: ["l10n_id_nik", "l10n_id_buyer_document_number", "l10n_id_tku"],
  boolKeys: ["use_partner_credit_limit"],
  numKeys: ["credit_limit"],
  selectKeys: ["l10n_id_buyer_document_type"],
  rerenderKeys: ["use_partner_credit_limit"],
  readFields: [
    ...ID_KEYS, "l10n_id_nik", "l10n_id_buyer_document_number", "l10n_id_tku", "use_partner_credit_limit", "credit_limit", "l10n_id_buyer_document_type",
    "sale_order_count",
  ],
  newDefaults: (ctx) => ({ user_id: ctx.user.id }),
  loadRefs: async () => {
    const [users, terms, pricelists, positions, receivables, documentTypes] = await Promise.all([
      referenceUsers(), referenceTerms(), referencePricelists(), referenceFiscalPositions(), receivableAccounts(),
      referenceSelection("res.partner", "l10n_id_buyer_document_type"),
    ]);
    return { users, terms, pricelists, positions, receivables, documentTypes };
  },
  tiles: async (partner) => {
    const invoices = await call("account.move", "search_count", { domain: [["partner_id", "=", partner.id], ["move_type", "=", "out_invoice"]] });
    return [
      { count: partner.sale_order_count, label: "Penjualan", icon: "fa-cart-shopping", href: `#/sale?partner=${partner.id}` },
      { count: invoices, label: "Faktur Pelanggan", icon: "fa-file-invoice-dollar", href: `#/invoice?partner=${partner.id}` },
    ];
  },
  sections: (v, refs, h) => `
    <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Penjualan</div>
    ${h.select("user_id", "Salesperson", refs.users, "-")}
    ${h.select("property_payment_term_id", "Syarat Pembayaran", refs.terms, "-")}
    ${h.select("property_product_pricelist", "Daftar Harga", refs.pricelists, "-")}
    ${h.field("ref", "Referensi")}
    <div class="flex flex-col justify-end gap-2">${h.checkboxField("use_partner_credit_limit", "Batas kredit", v.use_partner_credit_limit)}</div>
    ${v.use_partner_credit_limit
      ? h.field("credit_limit", "Batas Kredit", `<input type="number" min="0" step="any" data-value="credit_limit" data-kind="number" value="${h.esc(v.credit_limit)}" class="${h.INPUT} text-right">`)
      : ""}
    <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Identitas Pembeli (e-Faktur Coretax)</div>
    ${h.field("l10n_id_nik", "NIK")}
    ${h.field("l10n_id_buyer_document_type", "Tipe Dokumen", `<select data-value="l10n_id_buyer_document_type" class="${h.INPUT}"><option value="">-</option>${refs.documentTypes.map(([k, label]) => `<option value="${h.esc(k)}" ${k === v.l10n_id_buyer_document_type ? "selected" : ""}>${h.esc(label)}</option>`).join("")}</select>`)}
    ${h.field("l10n_id_buyer_document_number", "Nomor Dokumen")}
    ${h.field("l10n_id_tku", "TKU")}
    <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Akuntansi</div>
    ${h.select("property_account_receivable_id", "Akun Piutang", refs.receivables, "Bawaan perusahaan")}
    ${h.select("property_account_position_id", "Posisi Fiskal", refs.positions, "-")}`,
});
export const { render, onClick, onInput, onChange, leave } = page;
