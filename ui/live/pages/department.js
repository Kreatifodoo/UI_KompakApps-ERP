// Departments (hr.department): struktur departemen dan manajernya.
import { searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

const page = createMasterPage({
  route: "department", title: "Departments", noun: "Departemen", model: "hr.department", newLabel: "Departemen Baru", order: "name", archive: true,
  empty: "Belum ada departemen.",
  listFields: ["complete_name", "manager_id", "parent_id", "total_employee", "active"],
  columns: [
    { label: "Departemen", value: (r) => r.complete_name },
    { label: "Manajer", value: (r) => r.manager_id?.[1] ?? "-" },
    { label: "Induk", value: (r) => r.parent_id?.[1] ?? "-" },
    { label: "Karyawan", value: (r) => r.total_employee ?? 0, right: true },
  ],
  search: ["complete_name"],
  loadRefs: async () => ({
    employees: await searchRead("hr.employee", [], ["display_name"], { order: "name", limit: 500 }),
    departments: await searchRead("hr.department", [], ["display_name"], { order: "name", limit: 200 }),
  }),
  fields: [
    { key: "name", label: "Nama", type: "text", required: true },
    { key: "parent_id", label: "Departemen Induk", type: "m2o", optionsOf: (refs) => refs.departments },
    { key: "manager_id", label: "Manajer", type: "m2o", optionsOf: (refs) => refs.employees },
    { key: "note", label: "Catatan", type: "textarea", span2: true },
  ],
  readFields: ["total_employee"],
  tiles: (r) => [{ count: r.total_employee ?? 0, label: "Karyawan", icon: "fa-users", href: `#/employee?dept=${r.id}` }],
});

export const { render, onClick, onInput, onChange, leave } = page;
