// Salary Structures (hr.payroll.structure): kumpulan aturan gaji yang dipakai kontrak (kolom Struktur Gaji di Contracts). Struktur boleh punya induk;
// aturan induk ikut dihitung lebih dulu. Tombol "Pasang Struktur Umum" membuat struktur "Gaji Standar" yang netral (gaji pokok dari kontrak, tunjangan dan
// potongan dari input slip) tanpa angka hukum apa pun; BPJS, PPh 21, lembur, dan THR ditambahkan kemudian sebagai aturan (D85).
import { button, call, ctx, esc, guarded, money, searchRead, toast } from "../common.js";
import { amountTypeLabel, isPayrollManager, loadPayrollManager } from "../payroll.js";
import { createMasterPage } from "./masters.js";

const amountText = (r) =>
  r.amount_select === "fix" ? money(r.amount_fix) : r.amount_select === "percentage" ? `${r.amount_percentage}%` : amountTypeLabel[r.amount_select] ?? "-";

const page = createMasterPage({
  route: "salarystruct", title: "Salary Structures", noun: "Struktur Gaji", model: "hr.payroll.structure", newLabel: "Struktur Baru", order: "name", limit: 200,
  empty: "Belum ada struktur gaji. Pasang struktur umum atau buat struktur baru.",
  listFields: ["name", "code", "parent_id", "rule_ids"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Kode", value: (r) => r.code || "-" },
    { label: "Induk", value: (r) => r.parent_id?.[1] ?? "-" },
    { label: "Jumlah Aturan", value: (r) => (r.rule_ids ?? []).length, right: true },
  ],
  search: ["name", "code"],
  headerAsync: async () => ((await loadPayrollManager()) ? button("payroll-setup", "Pasang Struktur Umum", "primary") : ""),
  loadRefs: async () => {
    const [structures, rules, journals] = await Promise.all([
      searchRead("hr.payroll.structure", [], ["display_name"], { order: "name", limit: 200 }),
      searchRead("hr.salary.rule", [], ["display_name", "code"], { order: "sequence, id", limit: 300 }),
      searchRead("account.journal", [["type", "=", "general"]], ["display_name"], { order: "sequence, code", limit: 100 }).catch(() => []),
      loadPayrollManager(),
    ]);
    return { structures, journals, rules: rules.map((r) => ({ ...r, display_name: r.code ? `${r.display_name} (${r.code})` : r.display_name })) };
  },
  fields: [
    { key: "name", label: "Nama Struktur", type: "text", required: true },
    { key: "code", label: "Kode", type: "text" },
    { key: "parent_id", label: "Struktur Induk", type: "m2o", optionsOf: (refs, v) => refs.structures, hint: "Aturan struktur induk ikut dihitung (opsional)." },
    { key: "rule_ids", label: "Aturan Gaji", type: "m2m", span2: true, optionsOf: (refs) => refs.rules, hint: "Centang aturan yang dipakai. Urutan hitung mengikuti kolom Urutan di tiap aturan." },
    { key: "kompakapps_journal_id", label: "Jurnal Gaji", type: "m2o", optionsOf: (refs) => refs.journals, readonly: () => !isPayrollManager(), hint: "Jurnal umum tempat jurnal gaji diposting saat slip dikonfirmasi (hanya Manager payroll yang mengubah). Kosong = slip tidak dijurnal. Akun debit dan kredit diatur di tiap aturan gaji." },
    { key: "note", label: "Keterangan", type: "textarea", span2: true },
  ],
  titleOf: (r) => r.name,
  tiles: (r) => [{ count: (r.rule_ids ?? []).length, label: "Aturan", icon: "fa-list-check", always: true }],
  formNote: 'Pilih struktur ini di kolom <strong>Struktur Gaji</strong> pada Contracts agar slip karyawan memakainya. Menyunting aturan dilakukan di <a class="text-indigo-600 hover:underline" href="#/salaryrule">Salary Rules</a> (hanya Manager payroll).',
  extra: async (record) => {
    const ids = record.rule_ids ?? [];
    if (!ids.length) return "";
    const rules = await searchRead("hr.salary.rule", [["id", "in", ids]], ["sequence", "name", "code", "category_id", "amount_select", "amount_fix", "amount_percentage", "active"], { order: "sequence, id" });
    const rows = rules
      .map(
        (r) => `<tr class="border-t border-gray-100"><td class="py-2 pr-3 text-right">${r.sequence}</td><td class="py-2 pr-3"><a class="text-indigo-600 hover:underline" href="#/salaryrule/${r.id}">${esc(r.name)}</a></td>
          <td class="py-2 pr-3 font-mono text-xs">${esc(r.code || "-")}</td><td class="py-2 pr-3">${esc(r.category_id?.[1] ?? "-")}</td><td class="py-2 pr-3">${esc(amountTypeLabel[r.amount_select] ?? "-")}</td><td class="py-2 text-right">${esc(amountText(r))}</td></tr>`,
      )
      .join("");
    return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mt-6"><h2 class="font-semibold text-gray-900 mb-2">Urutan Hitung Aturan</h2>
      <table class="w-full text-sm"><thead><tr class="text-left text-xs uppercase text-gray-500"><th class="pb-2 pr-3 text-right">Urutan</th><th class="pb-2 pr-3">Aturan</th><th class="pb-2 pr-3">Kode</th><th class="pb-2 pr-3">Kategori</th><th class="pb-2 pr-3">Jenis</th><th class="pb-2 text-right">Jumlah</th></tr></thead><tbody>${rows}</tbody></table></section>`;
  },
  onAction: async (action, el, { reload }) => {
    if (action !== "payroll-setup") return;
    if (!isPayrollManager()) return;
    if (!window.confirm('Pasang struktur umum "Gaji Standar"? Berisi Gaji Pokok (dari kontrak), Tunjangan dan Potongan (dari input slip), dan Gaji Bersih, tanpa BPJS, PPh 21, lembur, atau THR. Aman diulang; yang sudah ada tidak ditimpa.')) return;
    const result = await guarded(el, () => call("res.company", "kompakapps_setup_payroll", { ids: [ctx.company.id] }));
    if (result) {
      toast(result.created ? "Struktur Gaji Standar dipasang." : "Struktur Gaji Standar sudah terpasang.");
      if (location.hash === `#/salarystruct/${result.structure_id}`) reload();
      else location.hash = `#/salarystruct/${result.structure_id}`;
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
