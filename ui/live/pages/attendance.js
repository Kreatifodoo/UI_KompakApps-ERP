// Attendance (hr.attendance): daftar kehadiran, check in/out untuk pengguna yang tertaut ke karyawan, entri manual, jam kerja,
// dan lembur (persetujuan lembur). Check in membuat catatan baru, check out mengisi waktu keluar pada catatan yang masih terbuka (D83).
import { badge, button, call, ctx, dateTimeText, dayBoundary, guarded, searchRead, toast, today } from "../common.js";
import { hrRefs } from "./employee.js";
import { createMasterPage } from "./masters.js";

const OT = { to_approve: ["Menunggu persetujuan", "warning"], approved: ["Disetujui", "success"], refused: ["Ditolak", "danger"] };
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Jam desimal Odoo menjadi "2 j 30 m". */
export const hm = (hours) => {
  const total = Math.round((hours || 0) * 60);
  return total ? `${Math.floor(total / 60)} j ${total % 60} m` : "-";
};

const PERIODS = [["today", "Hari ini"], ["week", "7 hari terakhir"], ["month", "Bulan ini"], ["open", "Belum check out"]];
const periodDomain = (value) => {
  const now = new Date();
  if (value === "open") return [["check_out", "=", false]];
  if (value === "today") return [["check_in", ">=", dayBoundary(today())], ["check_in", "<=", dayBoundary(today(), true)]];
  if (value === "week") return [["check_in", ">=", dayBoundary(ymd(new Date(now.getTime() - 6 * 86400000)))]];
  if (value === "month") return [["check_in", ">=", dayBoundary(ymd(new Date(now.getFullYear(), now.getMonth(), 1)))]];
  return [];
};

/** Karyawan milik pengguna yang sedang masuk (null bila belum tertaut). */
const myEmployee = async () => (await searchRead("hr.employee", [["user_id", "=", ctx.user.id]], ["name", "attendance_state"], { limit: 1 }))[0] ?? null;

const page = createMasterPage({
  route: "attendance", title: "Attendance", noun: "Kehadiran", model: "hr.attendance", newLabel: "Entri Manual", newTitle: "Entri Kehadiran Manual", order: "check_in desc", limit: 200,
  empty: "Belum ada kehadiran yang cocok.",
  listFields: ["employee_id", "check_in", "check_out", "worked_hours", "overtime_hours", "overtime_status"],
  columns: [
    { label: "Karyawan", value: (r) => r.employee_id[1] },
    { label: "Check In", value: (r) => dateTimeText(r.check_in) },
    { label: "Check Out", value: (r) => (r.check_out ? dateTimeText(r.check_out) : "Masih hadir") },
    { label: "Jam Kerja", value: (r) => hm(r.worked_hours), right: true },
    { label: "Lembur", value: (r) => hm(r.overtime_hours), right: true },
    { label: "Status Lembur", value: (r) => (r.overtime_hours > 0 ? badge(OT, r.overtime_status) : "-"), raw: true },
  ],
  search: ["employee_id.name"],
  filters: [
    { key: "period", label: "Semua periode", options: PERIODS, domain: periodDomain },
    { key: "ot", label: "Semua status lembur", options: Object.entries(OT).map(([k, v]) => [k, v[0]]), domain: (v) => [["overtime_hours", ">", 0], ["overtime_status", "=", v]] },
    { key: "employee", hidden: true, label: "Karyawan", options: [], domain: (v) => [["employee_id", "=", Number(v)]] },
  ],
  headerAsync: async () => {
    const me = await myEmployee();
    if (!me) return '<span class="self-center text-xs text-gray-500">Pengguna Anda belum tertaut ke karyawan, jadi tombol Check In tidak tersedia.</span>';
    return me.attendance_state === "checked_in"
      ? button("att-out", `Check Out (${me.name})`, "danger", { id: me.id })
      : button("att-in", `Check In (${me.name})`, "success", { id: me.id });
  },
  loadRefs: hrRefs,
  fields: [
    { key: "employee_id", label: "Karyawan", type: "m2o", required: true, optionsOf: (refs) => refs.employees },
    { key: "check_in", label: "Check In", type: "datetime", required: true },
    { key: "check_out", label: "Check Out", type: "datetime", hint: "Kosongkan bila karyawan masih hadir." },
  ],
  newValues: () => ({}),
  titleOf: (r) => `${r.employee_id[1]}, ${dateTimeText(r.check_in)}`,
  readFields: ["worked_hours", "overtime_hours", "overtime_status", "in_mode", "out_mode"],
  tiles: (r) => [
    { count: hm(r.worked_hours), label: "Jam kerja", icon: "fa-clock", always: true },
    { count: hm(r.overtime_hours), label: "Lembur", icon: "fa-business-time", always: r.overtime_hours > 0 },
  ],
  validate: (v) => {
    if (v.check_out && v.check_in && new Date(v.check_out) <= new Date(v.check_in)) throw new Error("Check out harus setelah check in.");
  },
  actions: (r) =>
    `${r.overtime_hours > 0 && r.overtime_status === "to_approve" ? button("ot-approve", "Setujui Lembur", "primary", { id: r.id }) + button("ot-refuse", "Tolak Lembur", "danger", { id: r.id }) : ""}${button("att-delete", "Hapus", "danger", { id: r.id })}
     ${r.overtime_hours > 0 ? `<span class="self-center">${badge(OT, r.overtime_status)}</span>` : ""}`,
  formNote: "Jam kerja dan lembur dihitung Odoo dari jadwal kerja karyawan. Entri manual mengisi waktu sendiri dan tercatat sebagai mode manual.",
  onAction: async (action, el, { reload }) => {
    const id = Number(el.dataset.id);
    if (action === "att-in") {
      const ok = await guarded(el, async () => {
        const [open] = await searchRead("hr.attendance", [["employee_id", "=", id], ["check_out", "=", false]], ["id"], { limit: 1 });
        if (open) throw new Error("Karyawan ini sudah check in dan belum check out.");
        return call("hr.attendance", "create", { vals_list: [{ employee_id: id, check_in: new Date().toISOString().slice(0, 19).replace("T", " ") }] });
      });
      if (ok) {
        toast("Check in tercatat.");
        reload();
      }
    } else if (action === "att-out") {
      const ok = await guarded(el, async () => {
        const [open] = await searchRead("hr.attendance", [["employee_id", "=", id], ["check_out", "=", false]], ["id"], { limit: 1 });
        if (!open) throw new Error("Tidak ada check in yang terbuka untuk karyawan ini.");
        return call("hr.attendance", "write", { ids: [open.id], vals: { check_out: new Date().toISOString().slice(0, 19).replace("T", " ") } });
      });
      if (ok !== undefined) {
        toast("Check out tercatat.");
        reload();
      }
    } else if (action === "ot-approve" || action === "ot-refuse") {
      const ok = await guarded(el, () => call("hr.attendance", action === "ot-approve" ? "action_approve_overtime" : "action_refuse_overtime", { ids: [id] }));
      if (ok !== undefined) {
        toast(action === "ot-approve" ? "Lembur disetujui." : "Lembur ditolak.");
        reload();
      }
    } else if (action === "att-delete") {
      if (!window.confirm("Hapus catatan kehadiran ini?")) return;
      const ok = await guarded(el, () => call("hr.attendance", "unlink", { ids: [id] }));
      if (ok !== undefined) {
        toast("Kehadiran dihapus.");
        location.hash = "#/attendance";
      }
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
