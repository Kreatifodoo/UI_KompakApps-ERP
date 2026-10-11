// Jurnal (account.journal): master jurnal penjualan, pembelian, kas, bank, dan umum. Jurnal kas dan bank otomatis membuat akunnya bila akun
// bawaan dikosongkan. Tipe jurnal tidak bisa diubah setelah dipakai; arsipkan jurnal yang tidak dipakai lagi.
import { referenceCurrencies, resetReferences, searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

const TYPES = { sale: "Penjualan", purchase: "Pembelian", cash: "Kas", bank: "Bank", general: "Umum", credit: "Kartu Kredit" };

const page = createMasterPage({
  route: "journalmaster", title: "Journal Master", noun: "Jurnal", model: "account.journal", newLabel: "Jurnal Baru", order: "sequence, code", archive: true,
  empty: "Belum ada jurnal yang cocok.",
  listFields: ["name", "code", "type", "default_account_id", "currency_id", "active"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Kode", value: (r) => r.code },
    { label: "Tipe", value: (r) => TYPES[r.type] ?? r.type },
    { label: "Akun Bawaan", value: (r) => r.default_account_id?.[1] ?? "-" },
    { label: "Mata Uang", value: (r) => r.currency_id?.[1] ?? "-" },
  ],
  search: ["name", "code"],
  filters: [{ key: "type", label: "Semua tipe", options: Object.entries(TYPES), domain: (v) => [["type", "=", v]] }],
  headerExtra: '<a href="#/journal" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-book mr-2"></i>Jurnal Entry</a>',
  fields: [
    { key: "name", label: "Nama Jurnal", type: "text", required: true },
    { key: "code", label: "Kode Singkat (maks 5)", type: "text", required: true, maxlength: 5 },
    { key: "type", label: "Tipe", type: "select", options: Object.entries(TYPES), required: true, hint: "Tidak bisa diubah setelah ada jurnal terposting." },
    { key: "default_account_id", label: "Akun Bawaan", type: "m2o", optionsOf: (r) => r.accounts, blank: "Otomatis", hint: "Kas dan bank: akun likuiditas. Penjualan dan pembelian: akun pendapatan atau beban." },
    { key: "currency_id", label: "Mata Uang Jurnal", type: "m2o", optionsOf: (r) => r.currencies, blank: "Mata uang perusahaan" },
  ],
  loadRefs: async () => {
    const [accounts, currencies] = await Promise.all([searchRead("account.account", [], ["display_name"], { order: "code", limit: 400 }), referenceCurrencies()]);
    return { accounts, currencies };
  },
  newValues: () => ({ type: "bank" }),
  onSaved: resetReferences,
});

export const { render, onClick, onInput, onChange, leave } = page;
