// Leave Types (hr.leave.type): jenis cuti, satuan (hari, setengah hari, jam), kebutuhan jatah, dan alur persetujuannya.
import { createMasterPage } from "./masters.js";

const UNITS = [["day", "Hari"], ["half_day", "Setengah hari"], ["hour", "Jam"]];
const APPROVAL = [["no_validation", "Tanpa persetujuan"], ["hr", "Petugas HR"], ["manager", "Manajer langsung"], ["both", "Manajer lalu petugas HR"]];
const label = (list, key) => list.find((x) => x[0] === key)?.[1] ?? "-";

const page = createMasterPage({
  route: "leavetype", title: "Leave Types", noun: "Jenis Cuti", model: "hr.leave.type", newLabel: "Jenis Cuti Baru", order: "sequence, name", archive: true,
  empty: "Belum ada jenis cuti.",
  listFields: ["name", "request_unit", "requires_allocation", "leave_validation_type", "unpaid", "active"],
  columns: [
    { label: "Jenis Cuti", value: (r) => r.name },
    { label: "Satuan", value: (r) => label(UNITS, r.request_unit) },
    { label: "Butuh Jatah", value: (r) => (r.requires_allocation ? "Ya" : "Tidak") },
    { label: "Persetujuan", value: (r) => label(APPROVAL, r.leave_validation_type) },
    { label: "Tidak Dibayar", value: (r) => (r.unpaid ? "Ya" : "-") },
  ],
  search: ["name"],
  fields: [
    { key: "name", label: "Nama", type: "text", required: true },
    { key: "request_unit", label: "Satuan Pengajuan", type: "select", options: UNITS },
    { key: "leave_validation_type", label: "Persetujuan Pengajuan", type: "select", options: APPROVAL },
    { key: "requires_allocation", label: "Butuh Jatah", type: "check", checkLabel: "Karyawan harus punya jatah sebelum mengajukan" },
    { key: "allows_negative", label: "Saldo Negatif", type: "check", checkLabel: "Izinkan saldo melewati jatah" },
    { key: "unpaid", label: "Tidak Dibayar", type: "check", checkLabel: "Cuti tanpa gaji" },
  ],
  newValues: () => ({ request_unit: "day", leave_validation_type: "hr", requires_allocation: false }),
  formNote: "Jenis cuti yang sudah dipakai sebaiknya diarsipkan, bukan dihapus.",
});

export const { render, onClick, onInput, onChange, leave } = page;
