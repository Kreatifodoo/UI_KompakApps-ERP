// Parameter Payroll (kompakapps.payroll.parameter): angka hukum dan kebijakan payroll Indonesia bertanggal berlaku (persen BPJS, batas upah, PTKP, biaya jabatan,
// pengali lembur, dan sejenisnya). Aturan gaji membaca nilai yang berlaku pada akhir periode slip. Hanya Manager payroll yang mengubah (D86).
import { isPayrollManager, loadPayrollManager, nf } from "../payroll.js";
import { createMasterPage } from "./masters.js";

export const PARAM_UNITS = [["persen", "Persen"], ["rupiah", "Rupiah"], ["kali", "Kali"], ["angka", "Angka"]];
const unitLabel = Object.fromEntries(PARAM_UNITS);
const valueText = (r) => (r.unit === "rupiah" ? `Rp${nf.format(r.value)}` : r.unit === "persen" ? `${nf.format(r.value)}%` : nf.format(r.value));

const page = createMasterPage({
  route: "payrollparam", title: "Parameter Payroll", noun: "Parameter", model: "kompakapps.payroll.parameter", newLabel: "Parameter Baru", order: "code, date_from desc", limit: 300, chatter: false,
  empty: "Belum ada parameter. Jalankan Pasang Aturan Indonesia di Salary Structures.",
  listFields: ["name", "code", "value", "unit", "date_from", "source"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Kode", value: (r) => r.code, raw: false },
    { label: "Nilai", value: (r) => valueText(r), right: true },
    { label: "Berlaku Mulai", value: (r) => r.date_from },
    { label: "Sumber Hukum", value: (r) => r.source || "-" },
  ],
  search: ["name", "code"],
  readOnly: () => !isPayrollManager(),
  loadListRefs: async () => {
    await loadPayrollManager();
    return {};
  },
  loadRefs: async () => {
    await loadPayrollManager();
    return {};
  },
  fields: [
    { key: "name", label: "Nama", type: "text", required: true },
    { key: "code", label: "Kode", type: "text", required: true, hint: "Dipakai oleh aturan gaji. Jangan diubah untuk parameter bawaan." },
    { key: "value", label: "Nilai", type: "number", step: "0.0001", hint: "Sesuai satuan: persen ditulis apa adanya (4 untuk 4%)." },
    { key: "unit", label: "Satuan", type: "select", options: PARAM_UNITS },
    { key: "date_from", label: "Berlaku Mulai", type: "date", required: true, hint: "Untuk memperbarui, buat parameter baru dengan kode sama dan tanggal berlaku baru; slip memakai nilai yang berlaku pada akhir periodenya." },
    { key: "source", label: "Sumber Hukum", type: "text", span2: true },
    { key: "note", label: "Catatan", type: "textarea", span2: true },
  ],
  newValues: () => ({ unit: "persen", date_from: new Date().toISOString().slice(0, 10) }),
  titleOf: (r) => r.name,
  tiles: (r) => [{ count: unitLabel[r.unit] ?? "-", label: "Satuan", icon: "fa-ruler", always: true }],
  readFields: ["unit"],
  formNote:
    "<strong>Tarif mengikuti ketentuan per tanggal berlaku dan perlu diperiksa akuntan.</strong> Nilai bawaan dimasukkan oleh Pasang Aturan Indonesia dari sumber yang tertera; sesudah itu Anda yang bertanggung jawab memperbaruinya saat ketentuan berubah.",
});

export const { render, onClick, onInput, onChange, leave } = page;
