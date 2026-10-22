// Tabel Tarif Pajak (kompakapps.payroll.bracket): tarif efektif bulanan (TER) kategori A, B, C dan lapisan tarif Pasal 17 untuk PPh 21, bertanggal berlaku.
// Satu versi tabel = semua baris dengan tanggal berlaku yang sama. Tombol "Salin ke Tanggal Baru" menyalin satu versi supaya bisa disunting tanpa mengubah yang lama (D86).
import { button, call, guarded, toast } from "../common.js";
import { isPayrollManager, loadPayrollManager, nf } from "../payroll.js";
import { createMasterPage } from "./masters.js";

export const TABLES = [["ter_a", "TER Bulanan Kategori A"], ["ter_b", "TER Bulanan Kategori B"], ["ter_c", "TER Bulanan Kategori C"], ["pasal17", "Tarif Pasal 17 (Tahunan)"]];
const tableLabel = Object.fromEntries(TABLES);

const page = createMasterPage({
  route: "payrolltable", title: "Tabel Tarif Pajak", noun: "Baris Tarif", model: "kompakapps.payroll.bracket", newLabel: "Baris Baru", order: "table, date_from desc, lower", limit: 400, chatter: false,
  empty: "Belum ada tabel tarif. Jalankan Pasang Aturan Indonesia di Salary Structures.",
  listFields: ["table", "date_from", "lower", "upper", "rate"],
  columns: [
    { label: "Tabel", value: (r) => tableLabel[r.table] ?? r.table },
    { label: "Berlaku Mulai", value: (r) => r.date_from },
    { label: "Di Atas (Rp)", value: (r) => nf.format(r.lower), right: true },
    { label: "Sampai Dengan (Rp)", value: (r) => (r.upper ? nf.format(r.upper) : "tanpa batas"), right: true },
    { label: "Tarif", value: (r) => `${nf.format(r.rate)}%`, right: true },
  ],
  filters: [{ key: "table", label: "Semua tabel", options: TABLES, domain: (v) => [["table", "=", v]] }],
  headerAsync: async () => ((await loadPayrollManager()) ? button("bracket-clone", "Salin ke Tanggal Baru", "plain") : ""),
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
    { key: "table", label: "Tabel", type: "select", options: TABLES, required: true },
    { key: "date_from", label: "Berlaku Mulai", type: "date", required: true },
    { key: "lower", label: "Di Atas (Rp)", type: "number", step: "0.01", hint: "Batas bawah, tidak termasuk." },
    { key: "upper", label: "Sampai Dengan (Rp)", type: "number", step: "0.01", hint: "Batas atas, termasuk. 0 = tanpa batas atas." },
    { key: "rate", label: "Tarif (%)", type: "number", step: "0.0001" },
    { key: "source", label: "Sumber Hukum", type: "text", span2: true },
  ],
  newValues: () => ({ table: "ter_a", date_from: new Date().toISOString().slice(0, 10) }),
  titleOf: (r) => `${tableLabel[r.table] ?? r.table}: ${nf.format(r.lower)} - ${r.upper ? nf.format(r.upper) : "tanpa batas"}`,
  formNote:
    "<strong>Tarif mengikuti ketentuan per tanggal berlaku dan perlu diperiksa akuntan.</strong> TER dan Pasal 17 bawaan berasal dari PP 58/2023 dan UU 7/2021. Untuk perubahan tarif, salin satu tabel ke tanggal berlaku baru lalu sunting salinannya; slip memakai versi yang berlaku pada akhir periodenya.",
  onAction: async (action, el, { reload }) => {
    if (action !== "bracket-clone") return;
    const table = window.prompt("Tabel yang disalin (ter_a, ter_b, ter_c, atau pasal17):", "ter_a");
    if (!table) return;
    const from = window.prompt("Salin dari versi yang berlaku mulai (YYYY-MM-DD):", "2024-01-01");
    if (!from) return;
    const to = window.prompt("Tanggal berlaku baru (YYYY-MM-DD):");
    if (!to) return;
    const rows = await guarded(el, () => call("kompakapps.payroll.bracket", "kompakapps_clone_version", { table, date_from: from, new_date_from: to }));
    if (rows) {
      toast(`${rows} baris disalin ke tanggal berlaku ${to}.`);
      reload();
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
