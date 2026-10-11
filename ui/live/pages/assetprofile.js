// Asset Model (account.asset.profile, OCA account_asset_management): templat aset tetap berisi akun aset, akun akumulasi dan beban
// penyusutan, jurnal, serta metode penyusutan. Asset yang dibuat dari profil ini mewarisi pengaturannya.
import { searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

export const METHODS = { linear: "Garis lurus", "linear-limit": "Garis lurus sampai nilai sisa", degressive: "Saldo menurun", "degr-linear": "Saldo menurun lalu garis lurus", "degr-limit": "Saldo menurun sampai nilai sisa" };
export const PERIODS = { month: "Bulanan", quarter: "Triwulan", year: "Tahunan" };
const TIMES = { number: "Jumlah penyusutan", year: "Jumlah tahun atau tanggal akhir" };

const page = createMasterPage({
  route: "assetprofile", title: "Asset Model", noun: "Model Aset", model: "account.asset.profile", newLabel: "Model Aset Baru", order: "name", archive: true,
  empty: "Belum ada model aset. Buat dengan tombol Model Aset Baru; model dipakai saat membuat Asset.",
  listFields: ["name", "journal_id", "method", "method_number", "method_period", "active"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Jurnal", value: (r) => r.journal_id?.[1] ?? "-" },
    { label: "Metode", value: (r) => METHODS[r.method] ?? r.method },
    { label: "Jumlah", value: (r) => String(r.method_number), right: true },
    { label: "Periode", value: (r) => PERIODS[r.method_period] ?? r.method_period },
  ],
  search: ["name"],
  fields: [
    { key: "name", label: "Nama Model", type: "text", required: true },
    { key: "journal_id", label: "Jurnal Penyusutan", type: "m2o", optionsOf: (r) => r.journals, required: true, blank: "Pilih jurnal..." },
    { key: "account_asset_id", label: "Akun Aset", type: "m2o", optionsOf: (r) => r.assetAccounts, required: true, blank: "Pilih akun...", hint: "Akun yang mencatat nilai perolehan aset." },
    { key: "account_depreciation_id", label: "Akun Akumulasi Penyusutan", type: "m2o", optionsOf: (r) => r.assetAccounts, required: true, blank: "Pilih akun..." },
    { key: "account_expense_depreciation_id", label: "Akun Beban Penyusutan", type: "m2o", optionsOf: (r) => r.expenseAccounts, required: true, blank: "Pilih akun..." },
    { key: "method", label: "Metode Penyusutan", type: "select", options: Object.entries(METHODS), rerender: true, required: true },
    { key: "method_time", label: "Ditentukan oleh", type: "select", options: Object.entries(TIMES), required: true },
    { key: "method_number", label: "Jumlah Penyusutan", type: "number", min: 1, step: 1, required: true },
    { key: "method_period", label: "Periode", type: "select", options: Object.entries(PERIODS), required: true },
    { key: "method_progress_factor", label: "Faktor Saldo Menurun", type: "number", min: 0, show: (v) => String(v.method).startsWith("degr") },
    { key: "prorata", label: "Prorata", type: "check", checkLabel: "Hitung penyusutan pertama secara prorata sejak tanggal mulai" },
    { key: "open_asset", label: "Langsung Jalan", type: "check", checkLabel: "Konfirmasi aset otomatis saat dibuat dari tagihan vendor" },
    { key: "note", label: "Catatan", type: "textarea", span2: true },
  ],
  loadRefs: async () => {
    const [journals, assetAccounts, expenseAccounts] = await Promise.all([
      searchRead("account.journal", [["type", "=", "general"]], ["display_name"], { order: "sequence, code" }),
      searchRead("account.account", [["account_type", "in", ["asset_fixed", "asset_non_current"]]], ["display_name"], { order: "code", limit: 300 }),
      searchRead("account.account", [["account_type", "=", "expense_depreciation"]], ["display_name"], { order: "code", limit: 300 }),
    ]);
    // Bila bagan akun tidak punya akun beban penyusutan, tawarkan akun beban biasa.
    if (!expenseAccounts.length) expenseAccounts.push(...(await searchRead("account.account", [["account_type", "in", ["expense", "expense_other"]]], ["display_name"], { order: "code", limit: 300 })));
    return { journals, assetAccounts, expenseAccounts };
  },
  newValues: (r) => ({ method: "linear", method_time: "number", method_number: 5, method_period: "year", method_progress_factor: 0.3, journal_id: r.journals[0]?.id ?? null }),
  formNote: "Aset baru yang memakai model ini langsung mewarisi akun dan metodenya. Perubahan model tidak mengubah aset yang sudah berjalan.",
});

export const { render, onClick, onInput, onChange, leave } = page;
