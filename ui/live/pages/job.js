// Jobs (hr.job): posisi atau jabatan yang dipakai pada karyawan dan kontrak.
import { searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

const page = createMasterPage({
  route: "job", title: "Jobs", noun: "Posisi", model: "hr.job", newLabel: "Posisi Baru", order: "name", archive: true,
  empty: "Belum ada posisi.",
  listFields: ["name", "department_id", "no_of_employee", "no_of_recruitment", "active"],
  columns: [
    { label: "Posisi", value: (r) => r.name },
    { label: "Departemen", value: (r) => r.department_id?.[1] ?? "-" },
    { label: "Karyawan", value: (r) => r.no_of_employee ?? 0, right: true },
    { label: "Target Rekrut", value: (r) => r.no_of_recruitment ?? 0, right: true },
  ],
  search: ["name"],
  loadRefs: async () => ({ departments: await searchRead("hr.department", [], ["display_name"], { order: "name", limit: 200 }) }),
  fields: [
    { key: "name", label: "Nama Posisi", type: "text", required: true },
    { key: "department_id", label: "Departemen", type: "m2o", optionsOf: (refs) => refs.departments },
    { key: "no_of_recruitment", label: "Target Rekrut", type: "number", min: 0, step: 1 },
    { key: "requirements", label: "Persyaratan", type: "textarea", span2: true },
  ],
  newValues: () => ({ no_of_recruitment: 1 }),
  readFields: ["no_of_employee"],
  tiles: (r) => [{ count: r.no_of_employee ?? 0, label: "Karyawan", icon: "fa-users" }],
});

export const { render, onClick, onInput, onChange, leave } = page;
