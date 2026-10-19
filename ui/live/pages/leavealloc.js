// Allocations (hr.leave.allocation): jatah cuti per karyawan dan jenis. Jatah baru menunggu persetujuan; setelah disetujui menambah saldo
// cuti karyawan pada rentang tanggalnya (D83). Jatah berkala (accrual) tidak dibuat dari UI ini.
import { badge, button, call, guarded, searchRead, toast, today } from "../common.js";
import { hrRefs } from "./employee.js";
import { createMasterPage } from "./masters.js";

const STATES = { confirm: ["Menunggu persetujuan", "warning"], validate1: ["Persetujuan kedua", "info"], validate: ["Disetujui", "success"], refuse: ["Ditolak", "danger"] };
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

const page = createMasterPage({
  route: "leavealloc", title: "Allocations", noun: "Jatah Cuti", model: "hr.leave.allocation", newLabel: "Jatah Baru", newTitle: "Jatah Cuti Baru", order: "date_from desc, id desc", limit: 200,
  empty: "Belum ada jatah cuti yang cocok.",
  listFields: ["employee_id", "holiday_status_id", "number_of_days", "date_from", "date_to", "state"],
  columns: [
    { label: "Karyawan", value: (r) => r.employee_id[1] },
    { label: "Jenis", value: (r) => r.holiday_status_id[1] },
    { label: "Jumlah Hari", value: (r) => nf.format(r.number_of_days), right: true },
    { label: "Berlaku Mulai", value: (r) => r.date_from || "-" },
    { label: "Sampai", value: (r) => r.date_to || "Tanpa batas" },
    { label: "Status", value: (r) => badge(STATES, r.state), raw: true },
  ],
  search: ["employee_id.name", "holiday_status_id.name", "name"],
  filters: [{ key: "status", label: "Semua status", options: Object.entries(STATES).map(([k, v]) => [k, v[0]]), domain: (v) => [["state", "=", v]] }],
  loadRefs: async () => ({
    ...(await hrRefs()),
    types: await searchRead("hr.leave.type", [["requires_allocation", "=", true]], ["display_name"], { order: "sequence, name", limit: 100 }),
  }),
  fields: [
    { key: "employee_id", label: "Karyawan", type: "m2o", required: true, optionsOf: (refs) => refs.employees, readonly: (r) => Boolean(r) && r.state !== "confirm" },
    { key: "holiday_status_id", label: "Jenis Cuti", type: "m2o", required: true, optionsOf: (refs) => refs.types, hint: "Hanya jenis yang memerlukan jatah.", readonly: (r) => Boolean(r) && r.state !== "confirm" },
    { key: "number_of_days", label: "Jumlah Hari", type: "number", min: 0, step: "any", required: true },
    { key: "name", label: "Keterangan", type: "text" },
    { key: "date_from", label: "Berlaku Mulai", type: "date", required: true },
    { key: "date_to", label: "Berlaku Sampai", type: "date", hint: "Kosongkan bila tidak ada batas waktu." },
  ],
  newValues: (refs) => ({ date_from: today(), holiday_status_id: refs.types?.[0]?.id ?? null, number_of_days: 1 }),
  readFields: ["state"],
  titleOf: (r) => `${r.employee_id[1]}, ${r.holiday_status_id[1]}`,
  validate: (v) => {
    if (!(Number(v.number_of_days) > 0)) throw new Error("Jumlah hari harus lebih dari 0.");
    if (v.date_to && v.date_to < v.date_from) throw new Error("Tanggal akhir tidak boleh sebelum tanggal mulai.");
  },
  actions: (r) =>
    `${r.state === "confirm" || r.state === "validate1" ? button("alloc-approve", "Setujui", "primary", { id: r.id }) + button("alloc-refuse", "Tolak", "danger", { id: r.id }) : ""}${r.state !== "validate" ? button("alloc-delete", "Hapus", "danger", { id: r.id }) : ""}
     <span class="self-center">${badge(STATES, r.state)}</span>`,
  formNote: "Jatah yang sudah disetujui tidak bisa dihapus; tolak atau buat jatah pengurang bila perlu mengoreksi.",
  onAction: async (action, el, { reload }) => {
    const id = Number(el.dataset.id);
    const run = async (method, message) => {
      const ok = await guarded(el, () => call("hr.leave.allocation", method, { ids: [id] }));
      if (ok !== undefined) {
        toast(message);
        reload();
      }
    };
    if (action === "alloc-approve") await run("action_approve", "Jatah disetujui.");
    else if (action === "alloc-refuse") await run("action_refuse", "Jatah ditolak.");
    else if (action === "alloc-delete") {
      if (!window.confirm("Hapus jatah cuti ini?")) return;
      const ok = await guarded(el, () => call("hr.leave.allocation", "unlink", { ids: [id] }));
      if (ok !== undefined) {
        toast("Jatah dihapus.");
        location.hash = "#/leavealloc";
      }
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
