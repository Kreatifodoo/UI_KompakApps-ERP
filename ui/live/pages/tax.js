// Tax Master (account.tax): pajak penjualan dan pembelian (PPN dan sejenisnya) dengan tarif, cara hitung, label di faktur, kelompok
// pajak, dan akun pajak (akun yang menampung pajak pada baris pajak faktur dan nota kredit).
import { call, resetReferences, searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

const USE = { sale: "Penjualan", purchase: "Pembelian", none: "Tidak ada" };
const AMOUNT_TYPES = { percent: "Persentase", division: "Persentase sudah termasuk harga", fixed: "Nominal tetap" };
const INCLUDE = { "": "Ikuti pengaturan perusahaan", tax_included: "Termasuk harga", tax_excluded: "Belum termasuk harga" };

const taxLines = async (taxId) => {
  const [tax] = await searchRead("account.tax", [["id", "=", taxId]], ["invoice_repartition_line_ids", "refund_repartition_line_ids"], { context: { active_test: false } });
  const ids = [...tax.invoice_repartition_line_ids, ...tax.refund_repartition_line_ids];
  return ids.length ? searchRead("account.tax.repartition.line", [["id", "in", ids], ["repartition_type", "=", "tax"]], ["account_id"]) : [];
};

const page = createMasterPage({
  route: "tax", title: "Tax Master", noun: "Pajak", model: "account.tax", newLabel: "Pajak Baru", order: "type_tax_use, sequence, id", archive: true,
  empty: "Belum ada pajak. Buat dengan tombol Pajak Baru.",
  listFields: ["name", "type_tax_use", "amount_type", "amount", "invoice_label", "tax_group_id", "active"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Jenis", value: (r) => USE[r.type_tax_use] ?? r.type_tax_use },
    { label: "Tarif", value: (r) => (r.amount_type === "fixed" ? String(r.amount) : `${r.amount}%`), right: true },
    { label: "Label di Faktur", value: (r) => r.invoice_label || "-" },
    { label: "Kelompok", value: (r) => r.tax_group_id?.[1] ?? "-" },
  ],
  search: ["name", "invoice_label"],
  filters: [{ key: "use", label: "Semua jenis", options: Object.entries(USE), domain: (v) => [["type_tax_use", "=", v]] }],
  listNote: "Tarif PPN 12% pada data bawaan Indonesia berbasis 11/12 sehingga tarif efektifnya 11%. Pajak yang sudah dipakai transaksi sebaiknya diarsipkan, bukan diubah tarifnya.",
  fields: [
    { key: "name", label: "Nama Pajak", type: "text", required: true },
    { key: "type_tax_use", label: "Jenis", type: "select", options: Object.entries(USE), required: true },
    { key: "amount_type", label: "Cara Hitung", type: "select", options: Object.entries(AMOUNT_TYPES), required: true },
    { key: "amount", label: "Tarif (% atau nominal)", type: "number", required: true, min: 0 },
    { key: "price_include_override", label: "Termasuk Harga", type: "select", options: Object.entries(INCLUDE) },
    { key: "invoice_label", label: "Label di Faktur", type: "text", placeholder: "mis. PPN 11%" },
    { key: "tax_group_id", label: "Kelompok Pajak", type: "m2o", optionsOf: (r) => r.groups, required: true, blank: "Pilih kelompok..." },
    { key: "tax_account_id", label: "Akun Pajak", type: "m2o", virtual: true, optionsOf: (r) => r.accounts, blank: "Tanpa akun (ikut akun baris)", hint: "Akun yang menampung pajak pada faktur dan nota kredit, mis. PPN Keluaran atau PPN Masukan." },
  ],
  loadRefs: async () => {
    const [groups, accounts] = await Promise.all([
      searchRead("account.tax.group", [], ["display_name"], { order: "sequence, id" }),
      searchRead("account.account", [["account_type", "in", ["liability_current", "asset_current", "liability_non_current"]]], ["display_name"], { order: "code", limit: 300 }),
    ]);
    return { groups, accounts };
  },
  newValues: (r) => ({ type_tax_use: "sale", amount_type: "percent", amount: 11, tax_group_id: r.groups[0]?.id ?? null, price_include_override: "" }),
  virtualValues: async (record) => ({ tax_account_id: (await taxLines(record.id)).find((l) => l.account_id)?.account_id?.[0] ?? null }),
  afterSave: async (taxId, values) => {
    const lines = await taxLines(taxId);
    const current = lines.find((l) => l.account_id)?.account_id?.[0] ?? null;
    if (lines.length && (values.tax_account_id || null) !== current) await call("account.tax.repartition.line", "write", { ids: lines.map((l) => l.id), vals: { account_id: values.tax_account_id || false } });
    resetReferences();
  },
  onSaved: resetReferences,
  readFields: ["price_include_override"],
  validate: (v) => {
    if (v.amount_type !== "fixed" && !(Number(v.amount) >= 0 && Number(v.amount) <= 100)) throw new Error("Tarif persentase harus antara 0 dan 100.");
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
