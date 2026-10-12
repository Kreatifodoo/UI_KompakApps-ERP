// Analytic Account (account.analytic.account): akun analitik untuk melacak pendapatan dan biaya per proyek, departemen, atau
// pusat biaya. Terkait Analytic Plan (pengelompokan). Laporannya ada di Accounting › Reporting › Analytic Report.
import { money, resetReferences, searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

const page = createMasterPage({
  route: "analytic", title: "Analytic Account", noun: "Akun Analitik", model: "account.analytic.account", newLabel: "Akun Analitik Baru", order: "name", archive: true,
  empty: "Belum ada akun analitik. Buat dengan tombol Akun Analitik Baru.",
  listFields: ["name", "code", "plan_id", "partner_id", "debit", "credit", "balance", "active"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Kode", value: (r) => r.code || "-" },
    { label: "Plan", value: (r) => r.plan_id?.[1] ?? "-" },
    { label: "Mitra", value: (r) => r.partner_id?.[1] ?? "-" },
    { label: "Debit", value: (r) => money(r.debit), right: true },
    { label: "Kredit", value: (r) => money(r.credit), right: true },
    { label: "Saldo", value: (r) => money(r.balance), right: true },
  ],
  search: ["name", "code"],
  onSaved: resetReferences, // cache akun dan plan pada pemilih analitik (analyticpick.js)
  headerExtra: '<a href="#/analyticplan" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-layer-group mr-2"></i>Plan</a>',
  fields: [
    { key: "name", label: "Nama", type: "text", required: true },
    { key: "code", label: "Kode", type: "text" },
    { key: "plan_id", label: "Plan", type: "m2o", optionsOf: (r) => r.plans, required: true, blank: "Pilih plan..." },
    { key: "partner_id", label: "Mitra (opsional)", type: "m2o", optionsOf: (r) => r.partners, blank: "-" },
  ],
  loadRefs: async () => ({
    plans: await searchRead("account.analytic.plan", [], ["display_name"], { order: "complete_name" }),
    partners: await searchRead("res.partner", [["customer_rank", ">", 0]], ["display_name"], { order: "name", limit: 200 }),
  }),
  newValues: (r) => ({ plan_id: r.plans[0]?.id ?? null }),
  tiles: (r) => [
    { count: r.invoice_count, label: "Faktur", icon: "fa-file-invoice-dollar" },
    { count: r.vendor_bill_count, label: "Tagihan", icon: "fa-file-invoice" },
    { count: r.production_count, label: "MO", icon: "fa-industry" },
  ],
  readFields: ["invoice_count", "vendor_bill_count", "production_count", "balance", "debit", "credit"],
  formNote: 'Distribusi analitik diisi pada baris faktur, tagihan, dan entri jurnal. Aktifkan fitur Analytic Accounting di pengaturan Odoo bila kolom analitik belum muncul. Lihat <a href="#/acctreport/analytic" class="underline">Analytic Report</a>.',
});

export const { render, onClick, onInput, onChange, leave } = page;
