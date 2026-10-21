// Bantuan bersama halaman Payroll (D85): peran Manager payroll, jenis jumlah dan syarat aturan gaji.
// Ekspresi Python pada aturan gaji dijalankan di server saat slip dihitung; hanya Manager payroll yang boleh melihat dan mengubahnya di UI
// (di server, hanya Manager yang boleh menulis aturan).
import { hasGroup } from "./common.js";

export const AMOUNT_TYPES = [["fix", "Jumlah tetap"], ["percentage", "Persentase"], ["code", "Ekspresi Python"]];
export const CONDITION_TYPES = [["none", "Selalu berlaku"], ["range", "Rentang"], ["python", "Ekspresi Python"]];
export const amountTypeLabel = Object.fromEntries(AMOUNT_TYPES);
export const conditionTypeLabel = Object.fromEntries(CONDITION_TYPES);

let manager = false;
/** Muat peran pengguna; panggil sebelum membangun halaman. Hasilnya disimpan untuk isPayrollManager(). */
export const loadPayrollManager = async () => {
  manager = await hasGroup("payroll.group_payroll_manager").catch(() => false);
  return manager;
};
export const isPayrollManager = () => manager;

export const PYTHON_WARNING =
  '<div class="rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs p-3 mb-1"><i class="fas fa-triangle-exclamation mr-1"></i><strong>Ekspresi Python.</strong> Kolom berlabel rumus atau Python dijalankan di server setiap kali slip dihitung. Ubah hanya bila Anda memahaminya: rumus yang salah membuat perhitungan semua slip yang memakai aturan ini gagal, dan rumus yang keliru mengubah gaji yang dibayarkan.</div>';
export const PYTHON_HIDDEN =
  '<div class="rounded-lg border border-gray-200 bg-gray-50 text-gray-700 text-xs p-3"><i class="fas fa-lock mr-1"></i>Rumus aturan ini (ekspresi Python) hanya terlihat dan dapat diubah oleh Manager payroll.</div>';
