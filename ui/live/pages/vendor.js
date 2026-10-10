// Vendor Master (res.partner sebagai pemasok): kerangka bersama ada di partners.js. Bagian khusus: pengaturan
// pembelian dan akun hutang; tombol statistik Pembelian dan Tagihan Vendor.
import {
  referenceCurrencies, referenceFiscalPositions, referencePayableAccounts, referenceTerms, referenceUsers,
} from "../common.js";
import { createPartnerPage } from "./partners.js";

const ID_KEYS = ["buyer_id", "property_supplier_payment_term_id", "property_purchase_currency_id", "property_account_payable_id", "property_account_position_id"];

const page = createPartnerPage({
  route: "vendor", title: "Vendor Master", newLabel: "Vendor Baru", noun: "Vendor",
  rank: { field: "supplier_rank", filterLabel: "Pemasok", defaultFilter: "vendor" },
  empty: "Belum ada pemasok. Buat dengan tombol Vendor Baru.",
  idKeys: ID_KEYS,
  readFields: [...ID_KEYS, "purchase_order_count", "supplier_invoice_count"],
  newDefaults: (ctx) => ({ buyer_id: ctx.user.id }),
  loadRefs: async () => {
    const [currencies, terms, users, payables, positions] = await Promise.all([
      referenceCurrencies(), referenceTerms(), referenceUsers(), referencePayableAccounts(), referenceFiscalPositions(),
    ]);
    return { currencies, terms, users, payables, positions };
  },
  tiles: async (partner) => [
    { count: partner.purchase_order_count, label: "Pembelian", icon: "fa-shopping-cart", href: `#/po?partner=${partner.id}` },
    { count: partner.supplier_invoice_count, label: "Tagihan Vendor", icon: "fa-file-invoice", href: `#/bill?partner=${partner.id}` },
  ],
  sections: (v, refs, h) => `
    <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Pembelian</div>
    ${h.select("buyer_id", "Pembeli", refs.users, "-")}
    ${h.select("property_supplier_payment_term_id", "Syarat Pembayaran Vendor", refs.terms, "-")}
    ${h.select("property_purchase_currency_id", "Mata Uang Pemasok", refs.currencies, "-")}
    ${h.field("ref", "Referensi")}
    <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Akuntansi</div>
    ${h.select("property_account_payable_id", "Akun Hutang", refs.payables, "Bawaan perusahaan")}
    ${h.select("property_account_position_id", "Posisi Fiskal", refs.positions, "-")}`,
});
export const { render, onClick, onInput, onChange, leave } = page;
