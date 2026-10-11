// Analytic Plan (account.analytic.plan): pengelompokan akun analitik, bisa bertingkat.
import { createMasterPage } from "./masters.js";
import { searchRead } from "../common.js";

const APPLICABILITY = { optional: "Opsional", mandatory: "Wajib", unavailable: "Tidak tersedia" };

const page = createMasterPage({
  route: "analyticplan", title: "Analytic Plan", noun: "Plan", model: "account.analytic.plan", newLabel: "Plan Baru", order: "complete_name", archive: false,
  empty: "Belum ada plan analitik. Buat dengan tombol Plan Baru.",
  listFields: ["complete_name", "account_count", "default_applicability"],
  columns: [
    { label: "Plan", value: (r) => r.complete_name },
    { label: "Akun", value: (r) => String(r.account_count), right: true },
    { label: "Penggunaan Bawaan", value: (r) => APPLICABILITY[r.default_applicability] ?? "-" },
  ],
  search: ["name"],
  headerExtra: '<a href="#/analytic" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-diagram-project mr-2"></i>Akun Analitik</a>',
  fields: [
    { key: "name", label: "Nama Plan", type: "text", required: true },
    { key: "parent_id", label: "Plan Induk", type: "m2o", optionsOf: (r) => r.plans, blank: "Tanpa induk" },
    { key: "default_applicability", label: "Penggunaan pada Jurnal", type: "select", options: Object.entries(APPLICABILITY) },
    { key: "description", label: "Deskripsi", type: "textarea", span2: true },
  ],
  loadRefs: async () => ({ plans: await searchRead("account.analytic.plan", [], ["display_name"], { order: "complete_name" }) }),
  newValues: () => ({ default_applicability: "optional" }),
  tiles: (r) => [{ count: r.account_count, label: "Akun Analitik", icon: "fa-diagram-project", href: "#/analytic" }],
  readFields: ["account_count"],
});

export const { render, onClick, onInput, onChange, leave } = page;
