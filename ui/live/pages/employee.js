// Employees (hr.employee): master karyawan. Data pekerjaan (departemen, jabatan, jenis) disimpan Odoo 19 pada versi karyawan
// (hr.version, D83); form ini menulis lewat field karyawan sehingga versi berjalan ikut diperbarui. Kontrak ada di halaman Contracts.
import { searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

export const EMPLOYEE_TYPES = [["employee", "Karyawan"], ["worker", "Pekerja"], ["student", "Pelajar"], ["trainee", "Peserta magang"], ["contractor", "Kontraktor"], ["freelance", "Freelancer"]];
const typeLabel = Object.fromEntries(EMPLOYEE_TYPES);

/** Pilihan bersama untuk halaman HR: karyawan, departemen, jabatan, pengguna. */
export const hrRefs = async () => {
  const [employees, departments, jobs, users] = await Promise.all([
    searchRead("hr.employee", [], ["display_name"], { order: "name", limit: 500 }),
    searchRead("hr.department", [], ["display_name"], { order: "name", limit: 200 }),
    searchRead("hr.job", [], ["display_name"], { order: "name", limit: 200 }),
    searchRead("res.users", [["share", "=", false]], ["display_name"], { order: "name", limit: 200 }),
  ]);
  return { employees, departments, jobs, users };
};

const page = createMasterPage({
  route: "employee", title: "Employees", noun: "Karyawan", model: "hr.employee", newLabel: "Karyawan Baru", order: "name", archive: true,
  empty: "Belum ada karyawan yang cocok.",
  listFields: ["name", "job_title", "department_id", "parent_id", "work_email", "employee_type", "attendance_state", "active"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Jabatan", value: (r) => r.job_title || "-" },
    { label: "Departemen", value: (r) => r.department_id?.[1] ?? "-" },
    { label: "Atasan", value: (r) => r.parent_id?.[1] ?? "-" },
    { label: "Email Kerja", value: (r) => r.work_email || "-" },
    { label: "Jenis", value: (r) => typeLabel[r.employee_type] ?? "-" },
    { label: "Kehadiran", value: (r) => (r.attendance_state === "checked_in" ? "Sedang hadir" : "-") },
  ],
  search: ["name", "work_email", "job_title"],
  filters: [{ key: "dept", hidden: true, label: "Departemen", options: [], domain: (v) => [["department_id", "=", Number(v)]] }],
  loadRefs: hrRefs,
  fields: [
    { key: "name", label: "Nama", type: "text", required: true },
    { key: "job_title", label: "Jabatan (teks)", type: "text" },
    { key: "job_id", label: "Posisi", type: "m2o", optionsOf: (refs) => refs.jobs, hint: "Posisi dari menu Jobs." },
    { key: "department_id", label: "Departemen", type: "m2o", optionsOf: (refs) => refs.departments },
    { key: "parent_id", label: "Atasan", type: "m2o", optionsOf: (refs) => refs.employees },
    { key: "user_id", label: "Pengguna Terkait", type: "m2o", optionsOf: (refs) => refs.users, hint: "Pengguna ini bisa check in/out dan mengajukan cuti atas namanya." },
    { key: "employee_type", label: "Jenis Karyawan", type: "select", options: EMPLOYEE_TYPES },
    { key: "work_email", label: "Email Kerja", type: "text" },
    { key: "work_phone", label: "Telepon Kerja", type: "text" },
    { key: "mobile_phone", label: "Ponsel Kerja", type: "text" },
    { key: "private_email", label: "Email Pribadi", type: "text" },
    { key: "private_phone", label: "Telepon Pribadi", type: "text" },
    { key: "birthday", label: "Tanggal Lahir", type: "date" },
    { key: "identification_id", label: "No. KTP", type: "text" },
    { key: "emergency_contact", label: "Kontak Darurat", type: "text" },
    { key: "emergency_phone", label: "Telepon Darurat", type: "text" },
  ],
  newValues: () => ({ employee_type: "employee" }),
  readFields: ["attendance_state", "version_ids"],
  tiles: (r) => [
    { count: r.attendance_state === "checked_in" ? 1 : 0, label: "Sedang hadir", icon: "fa-user-check" },
    { count: r.version_ids?.length ?? 0, label: "Versi/kontrak", icon: "fa-file-contract", href: `#/contract?employee=${r.id}` },
  ],
  formNote: "Karyawan yang diarsipkan tidak muncul di pilihan, tetapi riwayat kehadiran, cuti, dan biayanya tetap utuh.",
});

export const { render, onClick, onInput, onChange, leave } = page;
