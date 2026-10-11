// Budget Plan Master (mis.budget.by.account, OCA mis_builder_budget): rencana anggaran per akun. Satu rencana punya nama, periode,
// dan status; angkanya (akun, analitik, periode, jumlah) diisi di menu Budget dan dibandingkan dengan realisasi di Budget Report (D31).
import { badge, dateText, searchRead, toast } from "../common.js";
import { createMasterPage } from "./masters.js";

export const STATES = { draft: ["Draft", "muted"], confirmed: ["Dikonfirmasi", "success"], cancelled: ["Dibatalkan", "danger"] };

const year = () => new Date().getFullYear();
const locked = (_record, values) => Boolean(values.state) && values.state !== "draft";

const page = createMasterPage({
  route: "budgetplan", title: "Budget Plan Master", noun: "Rencana Anggaran", model: "mis.budget.by.account", newLabel: "Rencana Anggaran Baru",
  order: "date_from desc, id desc", archive: true,
  empty: "Belum ada rencana anggaran. Buat dengan tombol Rencana Anggaran Baru, lalu isi angkanya di menu Budget.",
  listFields: ["name", "description", "date_from", "date_to", "state", "item_ids"],
  columns: [
    { label: "Rencana", value: (r) => r.name },
    { label: "Periode", value: (r) => `${dateText(r.date_from)} s.d. ${dateText(r.date_to)}` },
    { label: "Keterangan", value: (r) => r.description || "-" },
    { label: "Baris Anggaran", value: (r) => String(r.item_ids.length), right: true },
    { label: "Status", value: (r) => badge(STATES, r.state), raw: true },
  ],
  search: ["name", "description"],
  filters: [{ key: "status", label: "Semua status", options: Object.entries(STATES).map(([k, v]) => [k, v[0]]), domain: (v) => [["state", "=", v]] }],
  headerExtra: '<a href="#/budget" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-coins mr-2"></i>Isi Anggaran</a>',
  fields: [
    { key: "name", label: "Nama Rencana", type: "text", required: true, placeholder: `mis. Anggaran ${year()}` },
    { key: "description", label: "Keterangan", type: "text" },
    { key: "date_from", label: "Periode Dari", type: "date", required: true, readonly: locked },
    { key: "date_to", label: "Periode Sampai", type: "date", required: true, readonly: locked },
    {
      key: "allow_items_overlap", label: "Tumpang tindih", type: "check", readonly: locked,
      checkLabel: "Izinkan baris anggaran tumpang tindih",
      hint: "Matikan bila satu akun hanya boleh punya satu angka per periode. Nyalakan bila satu akun dianggarkan untuk beberapa analitik (proyek atau departemen) pada periode yang sama.",
    },
  ],
  readFields: ["state", "item_ids"],
  virtualValues: (record) => ({ state: record.state }),
  newValues: () => ({ name: `Anggaran ${year()}`, date_from: `${year()}-01-01`, date_to: `${year()}-12-31` }),
  validate: (v) => {
    if (v.date_from && v.date_to && v.date_to < v.date_from) throw new Error("Periode sampai tidak boleh sebelum periode dari.");
  },
  titleOf: (r) => r.name,
  tiles: (r) => [{ count: r.item_ids.length, label: "Baris anggaran", icon: "fa-list", href: `#/budget/${r.id}` }],
  actions: (r) =>
    `<a href="#/budget/${r.id}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Isi Anggaran</a>
     <a href="#/budgetreport/${r.id}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Lihat Laporan</a>`,
  formNote: 'Rencana anggaran adalah wadah angka anggaran per akun, analitik, dan periode. Isi angkanya di <a href="#/budget" class="underline">Budget</a>, lalu bandingkan dengan realisasi di <a href="#/budgetreport" class="underline">Budget Report</a>. Periode dan aturan tumpang tindih terkunci setelah rencana dikonfirmasi; ubah status di halaman Budget.',
  afterSave: async (id, values, created) => {
    if (created) return;
    // Odoo tidak memeriksa baris yang sudah ada saat periode rencana diubah; beri tahu bila ada baris di luar periode baru.
    const outside = await searchRead(
      "mis.budget.by.account.item", [["budget_id", "=", id], "|", ["date_from", "<", values.date_from], ["date_to", ">", values.date_to]], ["id"], { limit: 1 },
    );
    if (outside.length) toast(`Ada baris anggaran di luar periode ${values.date_from} s.d. ${values.date_to}. Ubah barisnya di halaman Budget.`, "error");
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
