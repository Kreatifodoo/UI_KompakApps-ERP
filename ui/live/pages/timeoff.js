// Time Off (hr.leave): pengajuan cuti. Draft-nya langsung berstatus "Menunggu persetujuan"; penyetuju menekan Setujui atau Tolak sesuai jenis cuti
// (tanpa persetujuan, oleh manajer, oleh petugas HR, atau keduanya). Jenis berunit setengah hari memakai pilihan Pagi/Siang, berunit jam memakai jam mulai dan selesai (D83).
import { badge, button, call, esc, guarded, searchRead, toast } from "../common.js";
import { hrRefs } from "./employee.js";
import { createMasterPage } from "./masters.js";

export const LEAVE_STATES = { confirm: ["Menunggu persetujuan", "warning"], validate1: ["Persetujuan kedua", "info"], validate: ["Disetujui", "success"], refuse: ["Ditolak", "danger"], cancel: ["Dibatalkan", "muted"] };
const PERIODS = [["am", "Pagi"], ["pm", "Siang"]];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });
const hours = Array.from({ length: 48 }, (_, i) => [String(i / 2), `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`]);

let types = [];
const unitOf = (v) => types.find((t) => t.id === v.holiday_status_id)?.request_unit ?? "day";

/** Saldo cuti per jenis untuk satu karyawan (dihitung Odoo lewat konteks employee_id). */
export async function leaveBalance(employeeId) {
  return searchRead("hr.leave.type", [["requires_allocation", "=", true]], ["name", "max_leaves", "leaves_taken", "virtual_remaining_leaves", "request_unit"], { context: { employee_id: employeeId }, order: "sequence, name" });
}
const unitLabel = (type) => (type.request_unit === "hour" ? "jam" : "hari");

const page = createMasterPage({
  route: "timeoff", title: "Time Off", noun: "Pengajuan Cuti", model: "hr.leave", newLabel: "Ajukan Cuti", newTitle: "Pengajuan Cuti Baru", order: "request_date_from desc", limit: 200,
  empty: "Belum ada pengajuan cuti yang cocok.",
  listFields: ["employee_id", "holiday_status_id", "request_date_from", "request_date_to", "duration_display", "state"],
  columns: [
    { label: "Karyawan", value: (r) => r.employee_id[1] },
    { label: "Jenis", value: (r) => r.holiday_status_id[1] },
    { label: "Dari", value: (r) => r.request_date_from },
    { label: "Sampai", value: (r) => r.request_date_to },
    { label: "Durasi", value: (r) => r.duration_display || "-" },
    { label: "Status", value: (r) => badge(LEAVE_STATES, r.state), raw: true },
  ],
  search: ["employee_id.name", "holiday_status_id.name"],
  filters: [
    { key: "status", label: "Semua status", options: Object.entries(LEAVE_STATES).map(([k, v]) => [k, v[0]]), domain: (v) => [["state", "=", v]] },
    { key: "employee", hidden: true, label: "Karyawan", options: [], domain: (v) => [["employee_id", "=", Number(v)]] },
  ],
  loadRefs: async () => {
    const refs = await hrRefs();
    types = await searchRead("hr.leave.type", [], ["display_name", "request_unit"], { order: "sequence, name", limit: 100 });
    return { ...refs, types };
  },
  fields: [
    { key: "employee_id", label: "Karyawan", type: "m2o", required: true, optionsOf: (refs) => refs.employees, readonly: (r) => Boolean(r) && r.state !== "confirm" },
    { key: "holiday_status_id", label: "Jenis Cuti", type: "m2o", required: true, optionsOf: (refs) => refs.types, rerender: true, readonly: (r) => Boolean(r) && r.state !== "confirm" },
    { key: "request_date_from", label: "Tanggal Mulai", type: "date", required: true },
    { key: "request_date_to", label: "Tanggal Selesai", type: "date", required: true },
    { key: "request_date_from_period", label: "Mulai pada", type: "select", options: PERIODS, show: (v) => unitOf(v) === "half_day" },
    { key: "request_date_to_period", label: "Selesai pada", type: "select", options: PERIODS, show: (v) => unitOf(v) === "half_day", hint: "Satu hari penuh: mulai Pagi, selesai Siang." },
    { key: "request_hour_from", label: "Jam Mulai", type: "select", options: hours, show: (v) => unitOf(v) === "hour" },
    { key: "request_hour_to", label: "Jam Selesai", type: "select", options: hours, show: (v) => unitOf(v) === "hour" },
    { key: "private_name", label: "Keterangan", type: "text", span2: true },
  ],
  newValues: (refs) => ({ request_date_from_period: "am", request_date_to_period: "pm", request_hour_from: "9", request_hour_to: "17", holiday_status_id: refs.types?.[0]?.id ?? null }),
  extraCreate: (v) => ({ request_unit_hours: unitOf(v) === "hour" }),
  extraWrite: (v) => ({ request_unit_hours: unitOf(v) === "hour" }),
  readFields: ["state", "number_of_days", "number_of_hours", "can_approve", "can_validate", "can_cancel", "first_approver_id", "employee_id"],
  titleOf: (r) => `${r.employee_id[1]}, ${r.request_date_from}`,
  tiles: (r) => [
    { count: nf.format(r.number_of_days), label: "Hari", icon: "fa-calendar-day", always: true },
    { count: nf.format(r.number_of_hours), label: "Jam kerja", icon: "fa-clock", always: true },
  ],
  validate: (v) => {
    if (v.request_date_to < v.request_date_from) throw new Error("Tanggal selesai tidak boleh sebelum tanggal mulai.");
    if (unitOf(v) === "hour" && Number(v.request_hour_to) <= Number(v.request_hour_from)) throw new Error("Jam selesai harus setelah jam mulai.");
  },
  actions: (r) => {
    const approve = r.state === "confirm" || r.state === "validate1" ? button("leave-approve", r.state === "validate1" ? "Setujui (kedua)" : "Setujui", "primary", { id: r.id }) + button("leave-refuse", "Tolak", "danger", { id: r.id }) : "";
    const reopen = r.state === "validate" ? button("leave-reset", "Kembali ke Persetujuan", "plain", { id: r.id }) : "";
    const del = r.state === "confirm" || r.state === "refuse" ? button("leave-delete", "Hapus", "danger", { id: r.id }) : "";
    return `${approve}${reopen}${del}<span class="self-center">${badge(LEAVE_STATES, r.state)}</span>`;
  },
  extra: async (r) => {
    const rows = await leaveBalance(r.employee_id[0]);
    if (!rows.length) return "";
    const body = rows
      .map((t) => `<tr><td class="py-1 px-2 text-sm">${esc(t.name)}</td><td class="py-1 px-2 text-sm text-right">${nf.format(t.max_leaves)}</td><td class="py-1 px-2 text-sm text-right">${nf.format(t.leaves_taken)}</td><td class="py-1 px-2 text-sm text-right font-medium">${nf.format(t.virtual_remaining_leaves)} ${unitLabel(t)}</td></tr>`)
      .join("");
    return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto"><div class="text-sm font-semibold mb-2">Saldo cuti ${esc(r.employee_id[1])}</div>
      <table class="w-full text-left"><thead><tr><th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase">Jenis</th><th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase text-right">Jatah</th><th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase text-right">Terpakai</th><th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase text-right">Sisa</th></tr></thead><tbody>${body}</tbody></table></section>`;
  },
  formNote: "Cuti disetujui menjadi hari libur pada jadwal kerja karyawan. Jenis yang butuh jatah ditolak bila saldo tidak cukup (kecuali jenis itu mengizinkan saldo negatif).",
  onAction: async (action, el, { reload }) => {
    const id = Number(el.dataset.id);
    const run = async (method, message) => {
      const ok = await guarded(el, () => call("hr.leave", method, { ids: [id] }));
      if (ok !== undefined) {
        toast(message);
        reload();
      }
    };
    if (action === "leave-approve") await run("action_approve", "Cuti disetujui.");
    else if (action === "leave-refuse") await run("action_refuse", "Cuti ditolak.");
    else if (action === "leave-reset") await run("action_back_to_approval", "Cuti dikembalikan ke menunggu persetujuan.");
    else if (action === "leave-delete") {
      if (!window.confirm("Hapus pengajuan cuti ini?")) return;
      const ok = await guarded(el, () => call("hr.leave", "unlink", { ids: [id] }));
      if (ok !== undefined) {
        toast("Pengajuan dihapus.");
        location.hash = "#/timeoff";
      }
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
