// Employees (hr.employee): master karyawan. Data pekerjaan (departemen, jabatan, jenis) disimpan Odoo 19 pada versi karyawan
// (hr.version, D83); form ini menulis lewat field karyawan sehingga versi berjalan ikut diperbarui. Kontrak ada di halaman Contracts.
import { searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

export const EMPLOYEE_TYPES = [["employee", "Karyawan"], ["worker", "Pekerja"], ["student", "Pelajar"], ["trainee", "Peserta magang"], ["contractor", "Kontraktor"], ["freelance", "Freelancer"]];
const typeLabel = Object.fromEntries(EMPLOYEE_TYPES);
export const PTKP_STATUSES = [
  ["TK/0", "TK/0 - Tidak kawin, tanpa tanggungan"], ["TK/1", "TK/1 - Tidak kawin, 1 tanggungan"], ["TK/2", "TK/2 - Tidak kawin, 2 tanggungan"], ["TK/3", "TK/3 - Tidak kawin, 3 tanggungan"],
  ["K/0", "K/0 - Kawin, tanpa tanggungan"], ["K/1", "K/1 - Kawin, 1 tanggungan"], ["K/2", "K/2 - Kawin, 2 tanggungan"], ["K/3", "K/3 - Kawin, 3 tanggungan"],
];

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
    { key: "leave_manager_id", label: "Penyetuju Cuti", type: "m2o", optionsOf: (refs) => refs.users, hint: "Bila kosong, atasan langsung atau petugas HR yang menyetujui." },
    { key: "expense_manager_id", label: "Penyetuju Biaya", type: "m2o", optionsOf: (refs) => refs.users, hint: "Bila kosong, biaya yang diajukan langsung berstatus Disetujui." },
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
    { key: "kompakapps_ptkp_status", label: "Status PTKP (Pajak)", type: "select", options: PTKP_STATUSES, hint: "Status pada awal tahun pajak; menentukan PTKP dan kategori tarif PPh 21 (A: TK/0, TK/1, K/0; B: TK/2, TK/3, K/1, K/2; C: K/3)." },
    { key: "kompakapps_npwp", label: "NPWP", type: "text", hint: "Tanpa NPWP maupun NIK, PPh 21 dipotong lebih tinggi sesuai ketentuan." },
    { key: "kompakapps_nik", label: "NIK (KTP) untuk Pajak", type: "text", hint: "NIK yang terdaftar di DJP berfungsi sebagai NPWP." },
    { key: "kompakapps_bpjs_kes", label: "BPJS Kesehatan", type: "check", checkLabel: "Ikut BPJS Kesehatan" },
    { key: "kompakapps_bpjs_kes_no", label: "No. Kartu BPJS Kesehatan", type: "text" },
    { key: "kompakapps_bpjs_jht", label: "BPJS JHT", type: "check", checkLabel: "Ikut BPJS JHT (Jaminan Hari Tua)" },
    { key: "kompakapps_bpjs_jp", label: "BPJS JP", type: "check", checkLabel: "Ikut BPJS JP (Jaminan Pensiun)" },
    { key: "kompakapps_bpjs_jkk", label: "BPJS JKK", type: "check", checkLabel: "Ikut BPJS JKK (Kecelakaan Kerja)" },
    { key: "kompakapps_bpjs_jkm", label: "BPJS JKM", type: "check", checkLabel: "Ikut BPJS JKM (Kematian)" },
    { key: "kompakapps_bpjs_tk_no", label: "No. Kartu BPJS Ketenagakerjaan", type: "text" },
  ],
  newValues: () => ({ employee_type: "employee", kompakapps_ptkp_status: "TK/0", kompakapps_bpjs_kes: true, kompakapps_bpjs_jht: true, kompakapps_bpjs_jp: true, kompakapps_bpjs_jkk: true, kompakapps_bpjs_jkm: true }),
  readFields: ["attendance_state", "version_ids"],
  tiles: (r) => [
    { count: r.attendance_state === "checked_in" ? 1 : 0, label: "Sedang hadir", icon: "fa-user-check" },
    { count: r.version_ids?.length ?? 0, label: "Versi/kontrak", icon: "fa-file-contract", href: `#/contract?employee=${r.id}` },
  ],
  formNote: "Karyawan yang diarsipkan tidak muncul di pilihan, tetapi riwayat kehadiran, cuti, dan biayanya tetap utuh.",
});

export const { render, onClick, onInput, onChange, leave } = page;
