// Contribution Registers (hr.contribution.register): pihak ketiga penerima potongan atau iuran dari gaji (mis. badan penyelenggara jaminan, kantor pajak).
// Aturan gaji menautkan register agar total potongan per pihak bisa dilihat dan dibayarkan (D85).
import { searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

const page = createMasterPage({
  route: "contribreg", title: "Contribution Registers", noun: "Register Kontribusi", model: "hr.contribution.register", newLabel: "Register Baru", order: "name", limit: 200,
  empty: "Belum ada register kontribusi.",
  listFields: ["name", "partner_id"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Pihak Penerima", value: (r) => r.partner_id?.[1] ?? "-" },
  ],
  search: ["name"],
  loadRefs: async () => ({ partners: await searchRead("res.partner", [["is_company", "=", true]], ["display_name"], { order: "name", limit: 500 }) }),
  fields: [
    { key: "name", label: "Nama", type: "text", required: true },
    { key: "partner_id", label: "Pihak Penerima", type: "m2o", optionsOf: (refs) => refs.partners, hint: "Pilih dari perusahaan di Customer atau Vendor Master." },
    { key: "note", label: "Keterangan", type: "textarea", span2: true },
  ],
  titleOf: (r) => r.name,
});

export const { render, onClick, onInput, onChange, leave } = page;
