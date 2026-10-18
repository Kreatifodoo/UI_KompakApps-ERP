// Chart of Account (account.account): daftar akun dengan saldo, filter tipe, dan form akun (kode, nama, tipe, rekonsiliasi,
// mata uang, pajak bawaan). Akun yang sudah dipakai di jurnal tidak boleh diubah tipenya oleh Odoo; arsipkan bila tidak dipakai lagi.
import { ctx, money, referenceCurrencies, referenceSelection, referenceTaxes } from "../common.js";
import { createMasterPage } from "./masters.js";

export const ACCOUNT_TYPES = {
  asset_receivable: "Piutang", asset_cash: "Kas dan Bank", asset_current: "Aset Lancar", asset_non_current: "Aset Tidak Lancar", asset_prepayments: "Biaya Dibayar Dimuka",
  asset_fixed: "Aset Tetap", liability_payable: "Hutang", liability_credit_card: "Kartu Kredit", liability_current: "Kewajiban Lancar", liability_non_current: "Kewajiban Tidak Lancar",
  equity: "Ekuitas", equity_unaffected: "Laba Tahun Berjalan", income: "Pendapatan", income_other: "Pendapatan Lain", expense: "Beban", expense_other: "Beban Lain",
  expense_depreciation: "Penyusutan", expense_direct_cost: "Beban Pokok", off_balance: "Di Luar Neraca",
};

/** Jenis akun yang masuk Laba Rugi; sisanya Neraca, kecuali Di Luar Neraca (hanya "Tidak dilaporkan"). */
const PNL_TYPES = ["income", "income_other", "expense", "expense_other", "expense_depreciation", "expense_direct_cost"];
const REPORT_PREFIX = { pl: "Laba Rugi: ", bs: "Neraca: " };
const sectionOf = (type) => (PNL_TYPES.includes(type) ? "pl" : type === "off_balance" ? null : "bs");
/** Pilihan Pos Laporan yang cocok dengan jenis akun (server menolak pos Laba Rugi untuk akun Neraca dan sebaliknya). */
const reportGroupOptions = (refs, values) => {
  const section = sectionOf(values?.account_type);
  const rows = (refs.reportGroups ?? []).filter(([key, label]) => key === "none" || (section && label.startsWith(REPORT_PREFIX[section])));
  return [["", "Otomatis (dari kode dan jenis akun)"], ...rows];
};

const page = createMasterPage({
  route: "account", title: "Chart of Account", noun: "Akun", model: "account.account", newLabel: "Akun Baru", order: "code", limit: 300, archive: true,
  empty: "Belum ada akun yang cocok. Buat dengan tombol Akun Baru.",
  listFields: ["code", "name", "account_type", "kompakapps_report_group", "reconcile", "current_balance", "active"],
  columns: [
    { label: "Kode", value: (r) => r.code || "-" },
    { label: "Nama", value: (r) => r.name },
    { label: "Tipe", value: (r) => ACCOUNT_TYPES[r.account_type] ?? r.account_type },
    { label: "Pos Laporan", value: (r, refs) => refs.groupLabel?.get(r.kompakapps_report_group) ?? "" },
    { label: "Rekonsiliasi", value: (r) => (r.reconcile ? "Ya" : "") },
    { label: "Saldo", value: (r) => money(r.current_balance), right: true },
  ],
  search: ["code", "name"],
  loadListRefs: async () => ({ groupLabel: new Map(await referenceSelection("account.account", "kompakapps_report_group")) }),
  filters: [
    { key: "type", label: "Semua tipe", options: Object.entries(ACCOUNT_TYPES), domain: (v) => [["account_type", "=", v]] },
    { key: "pos", label: "Semua pos laporan", options: [["none", "Tidak dilaporkan"]], domain: (v) => [["kompakapps_report_group", "=", v]] },
  ],
  listNote: "Saldo dari jurnal terposting. Akun yang dipakai transaksi tidak bisa dihapus; arsipkan agar tidak muncul di pilihan.",
  fields: [
    { key: "code", label: "Kode", type: "text", required: true, maxlength: 64 },
    { key: "name", label: "Nama Akun", type: "text", required: true },
    { key: "account_type", label: "Tipe", type: "select", options: Object.entries(ACCOUNT_TYPES), required: true, rerender: true },
    {
      key: "kompakapps_report_group", label: "Pos Laporan", type: "select", optionsOf: reportGroupOptions, rerender: false,
      hint: "Baris tempat akun ini muncul di Laba Rugi, Neraca, Arus Kas, dan Ringkasan Eksekutif, lengkap dengan uraian per akun. Otomatis menurut kode dan jenis akun; pilih Tidak dilaporkan hanya bila saldo akun ini memang tidak boleh masuk laporan (baris pemeriksaan akan menyala).",
    },
    { key: "currency_id", label: "Mata Uang Akun", type: "m2o", optionsOf: (r) => r.currencies, blank: "Mata uang perusahaan", hint: "Isi hanya untuk akun berdenominasi mata uang asing." },
    { key: "reconcile", label: "Rekonsiliasi", type: "check", checkLabel: "Izinkan rekonsiliasi (piutang, hutang, dan akun transit)" },
    { key: "tax_ids", label: "Pajak Bawaan", type: "m2m", optionsOf: (r) => r.taxes },
    { key: "note", label: "Catatan", type: "textarea", span2: true },
  ],
  loadRefs: async () => {
    const [currencies, sale, purchase] = await Promise.all([referenceCurrencies(), referenceTaxes("sale"), referenceTaxes("purchase")]);
    return { currencies, taxes: [...sale, ...purchase], reportGroups: await referenceSelection("account.account", "kompakapps_report_group") };
  },
  newValues: () => ({ account_type: "asset_current" }),
  extraCreate: () => ({ company_ids: [[6, 0, [ctx.company.id]]] }),
  tiles: (r) => [{ count: r.current_balance ? 1 : 0, label: `Saldo ${money(r.current_balance)}`, icon: "fa-scale-balanced", href: "#/ledger/general" }],
  readFields: ["current_balance"],
});

export const { render, onClick, onInput, onChange, leave } = page;
