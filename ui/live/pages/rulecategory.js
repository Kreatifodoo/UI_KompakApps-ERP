// Rule Categories (hr.salary.rule.category): pengelompokan baris slip (Gaji Pokok, Tunjangan, Potongan, Gaji Bersih). Kode kategori dipakai rumus
// aturan untuk menjumlah, mis. categories.BASIC + categories.ALW. Induk hanya untuk pelaporan (D85).
import { searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

const page = createMasterPage({
  route: "rulecategory", title: "Rule Categories", noun: "Kategori Aturan", model: "hr.salary.rule.category", newLabel: "Kategori Baru", order: "name", limit: 200,
  empty: "Belum ada kategori aturan.",
  listFields: ["name", "code", "parent_id"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Kode", value: (r) => r.code || "-" },
    { label: "Induk", value: (r) => r.parent_id?.[1] ?? "-" },
  ],
  search: ["name", "code"],
  loadRefs: async () => ({ categories: await searchRead("hr.salary.rule.category", [], ["display_name"], { order: "name", limit: 200 }) }),
  fields: [
    { key: "name", label: "Nama", type: "text", required: true },
    { key: "code", label: "Kode", type: "text", hint: "Dipakai rumus aturan, mis. BASIC, ALW, DED, NET." },
    { key: "parent_id", label: "Kategori Induk", type: "m2o", optionsOf: (refs) => refs.categories },
    { key: "note", label: "Keterangan", type: "textarea", span2: true },
  ],
  titleOf: (r) => r.name,
});

export const { render, onClick, onInput, onChange, leave } = page;
