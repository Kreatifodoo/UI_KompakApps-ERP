// Salary Rules (hr.salary.rule): aturan gaji OCA payroll. Aturan menghasilkan satu baris slip: jumlah tetap, persentase dari suatu dasar, atau ekspresi Python,
// dengan syarat berlaku (selalu, rentang, atau Python) dan urutan hitung. Ekspresi Python dijalankan di server saat slip dihitung, jadi hanya Manager payroll yang
// melihat dan mengubahnya; petugas biasa melihat aturan tanpa rumus (D85). Tipe input (kode dan nama isian slip) dikelola di bagian Input di bawah form.
import { INPUT, button, call, esc, guarded, money, searchRead, toast } from "../common.js";
import { AMOUNT_TYPES, CONDITION_TYPES, PYTHON_HIDDEN, PYTHON_WARNING, amountTypeLabel, conditionTypeLabel, isPayrollManager, loadPayrollManager } from "../payroll.js";
import { createMasterPage } from "./masters.js";

const amountText = (r) =>
  r.amount_select === "fix" ? money(r.amount_fix) : r.amount_select === "percentage" ? `${r.amount_percentage}%` : amountTypeLabel[r.amount_select] ?? "-";

const loadCategories = () => searchRead("hr.salary.rule.category", [], ["display_name"], { order: "name", limit: 200 });

const page = createMasterPage({
  route: "salaryrule", title: "Salary Rules", noun: "Aturan Gaji", model: "hr.salary.rule", newLabel: "Aturan Baru", order: "sequence, id", archive: true, limit: 300,
  empty: "Belum ada aturan gaji. Pasang struktur umum di Salary Structures atau buat aturan baru.",
  listFields: ["sequence", "name", "code", "category_id", "amount_select", "amount_fix", "amount_percentage", "condition_select", "appears_on_payslip"],
  columns: [
    { label: "Urutan", value: (r) => r.sequence, right: true },
    { label: "Nama", value: (r) => r.name },
    { label: "Kode", value: (r) => r.code || "-" },
    { label: "Kategori", value: (r) => r.category_id?.[1] ?? "-" },
    { label: "Jenis Jumlah", value: (r) => amountTypeLabel[r.amount_select] ?? "-" },
    { label: "Jumlah", value: (r) => amountText(r), right: true },
    { label: "Syarat", value: (r) => conditionTypeLabel[r.condition_select] ?? "-" },
    { label: "Di Slip", value: (r) => (r.appears_on_payslip ? "Ya" : "Tidak") },
  ],
  search: ["name", "code"],
  filters: [
    { key: "kind", label: "Semua jenis", options: AMOUNT_TYPES, domain: (v) => [["amount_select", "=", v]] },
    { key: "category", hidden: true, label: "Kategori", options: [], domain: (v) => [["category_id", "=", Number(v)]] },
  ],
  readOnly: () => !isPayrollManager(),
  loadListRefs: async () => {
    await loadPayrollManager();
    return {};
  },
  loadRefs: async () => {
    const [categories, rules, registers] = await Promise.all([
      loadCategories(),
      searchRead("hr.salary.rule", [], ["display_name"], { order: "sequence, id", limit: 300 }),
      searchRead("hr.contribution.register", [], ["display_name"], { order: "name", limit: 100 }),
      loadPayrollManager(),
    ]);
    return { categories, rules, registers };
  },
  newValues: () => ({ sequence: 5, amount_select: "fix", condition_select: "none", appears_on_payslip: true, quantity: "1.0", condition_range: "contract.wage" }),
  fields: [
    { key: "name", label: "Nama Aturan", type: "text", required: true },
    { key: "code", label: "Kode", type: "text", hint: "Dipakai rumus aturan lain, peka huruf besar-kecil. Contoh: GAPOK, TUNJ." },
    { key: "sequence", label: "Urutan Hitung", type: "number", step: 1, min: 0, required: true, hint: "Aturan dihitung dari urutan kecil ke besar; aturan yang memakai hasil aturan lain harus berurutan setelahnya." },
    { key: "category_id", label: "Kategori", type: "m2o", optionsOf: (refs) => refs.categories },
    { key: "amount_select", label: "Jenis Jumlah", type: "select", options: AMOUNT_TYPES, required: true, rerender: true },
    { key: "amount_fix", label: "Jumlah Tetap", type: "number", step: "any", show: (v) => v.amount_select === "fix" },
    { key: "amount_percentage", label: "Persentase (%)", type: "number", step: "any", show: (v) => v.amount_select === "percentage", hint: "Contoh: 100 untuk seluruh dasar." },
    { key: "amount_percentage_base", label: "Persentase dari (rumus)", type: "text", show: (v) => isPayrollManager() && v.amount_select === "percentage", hint: "Rumus Python, mis. <code>contract.wage</code> atau <code>categories.BASIC</code>." },
    { key: "quantity", label: "Kuantitas (rumus)", type: "text", show: (v) => isPayrollManager() && v.amount_select !== "code", hint: "Rumus Python; 1.0 berarti satu kali. Gunakan -1 untuk pengurang." },
    { key: "amount_python_compute", label: "Kode Python", type: "textarea", span2: true, show: (v) => isPayrollManager() && v.amount_select === "code", hint: "Isi variabel <code>result</code>; tersedia <code>contract</code>, <code>employee</code>, <code>categories</code>, <code>inputs</code>, <code>worked_days</code>, <code>rules</code>." },
    { key: "condition_select", label: "Syarat Berlaku", type: "select", options: CONDITION_TYPES, required: true, rerender: true },
    { key: "condition_range", label: "Rentang dari (rumus)", type: "text", show: (v) => isPayrollManager() && v.condition_select === "range", hint: "Nilai yang dibandingkan dengan rentang, mis. <code>contract.wage</code>." },
    { key: "condition_range_min", label: "Rentang Minimum", type: "number", step: "any", show: (v) => v.condition_select === "range" },
    { key: "condition_range_max", label: "Rentang Maksimum", type: "number", step: "any", show: (v) => v.condition_select === "range" },
    { key: "condition_python", label: "Syarat Python", type: "textarea", span2: true, show: (v) => isPayrollManager() && v.condition_select === "python", hint: "Isi variabel <code>result</code> dengan True atau False." },
    { key: "appears_on_payslip", type: "check", label: "Tampil di slip", checkLabel: "Tampil di slip gaji" },
    { key: "parent_rule_id", label: "Aturan Induk", type: "m2o", optionsOf: (refs) => refs.rules, hint: "Aturan anak hanya berlaku bila aturan induknya berlaku." },
    { key: "register_id", label: "Register Kontribusi", type: "m2o", optionsOf: (refs) => refs.registers, hint: "Pihak ketiga penerima potongan (mis. badan penyelenggara)." },
    { key: "note", label: "Keterangan", type: "textarea", span2: true },
  ],
  titleOf: (r) => r.name,
  formTop: () => (isPayrollManager() ? PYTHON_WARNING : PYTHON_HIDDEN),
  formNote: "Aturan menghasilkan satu baris slip dengan jumlah = kuantitas x persentase x dasar, atau nilai dari kode Python. Struktur gaji memilih aturan mana yang dipakai.",
  extra: async (record) => {
    const [inputs, structures] = await Promise.all([
      searchRead("hr.rule.input", [["input_id", "=", record.id]], ["name", "code"], { order: "id" }),
      searchRead("hr.payroll.structure", [["rule_ids", "in", [record.id]]], ["display_name"], { order: "name" }),
    ]);
    const manager = isPayrollManager();
    const rows = inputs
      .map((i) => `<tr class="border-t border-gray-100"><td class="py-2 pr-3 font-mono text-xs">${esc(i.code)}</td><td class="py-2 pr-3">${esc(i.name)}</td><td class="py-2 text-right">${manager ? button("ruleinput-del", "Hapus", "danger", { id: i.id }) : ""}</td></tr>`)
      .join("");
    const add = manager
      ? `<div class="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2 mt-3 items-end">
          <div><label class="text-xs font-medium text-gray-500 uppercase">Kode Input</label><input id="ri-code" class="${INPUT}" placeholder="TUNJ"></div>
          <div><label class="text-xs font-medium text-gray-500 uppercase">Nama Input</label><input id="ri-name" class="${INPUT}" placeholder="Tunjangan"></div>
          ${button("ruleinput-add", "Tambah Input", "primary", { id: record.id })}
        </div>`
      : "";
    const structureLinks = structures.length
      ? structures.map((s) => `<a class="text-indigo-600 hover:underline" href="#/salarystruct/${s.id}">${esc(s.display_name)}</a>`).join(", ")
      : "Belum dipakai struktur mana pun.";
    return `
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mt-6">
        <h2 class="font-semibold text-gray-900 mb-1">Input Slip</h2>
        <p class="text-xs text-gray-500 mb-3">Tipe input yang muncul sebagai isian di setiap slip yang memakai aturan ini; rumus membacanya dengan <code>inputs.KODE.amount</code>.</p>
        ${inputs.length ? `<table class="w-full text-sm"><thead><tr class="text-left text-xs uppercase text-gray-500"><th class="pb-2 pr-3">Kode</th><th class="pb-2 pr-3">Nama</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="text-sm text-gray-500">Aturan ini tidak punya input.</p>'}
        ${add}
      </section>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mt-4"><h2 class="font-semibold text-gray-900 mb-1">Dipakai di Struktur</h2><p class="text-sm">${structureLinks}</p></section>`;
  },
  onAction: async (action, el, { reload }) => {
    if (action === "ruleinput-add") {
      const code = document.getElementById("ri-code").value.trim();
      const name = document.getElementById("ri-name").value.trim();
      const ok = await guarded(el, async () => {
        if (!code || !name) throw new Error("Isi kode dan nama input.");
        return call("hr.rule.input", "create", { vals_list: [{ code, name, input_id: Number(el.dataset.id) }] });
      });
      if (ok !== undefined) {
        toast("Input ditambahkan.");
        reload();
      }
    } else if (action === "ruleinput-del") {
      if (!window.confirm("Hapus input ini dari aturan?")) return;
      const ok = await guarded(el, () => call("hr.rule.input", "unlink", { ids: [Number(el.dataset.id)] }));
      if (ok !== undefined) {
        toast("Input dihapus.");
        reload();
      }
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
