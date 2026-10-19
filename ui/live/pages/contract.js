// Contracts (hr.version): Odoo 19 menyimpan kontrak sebagai versi karyawan (hr.version): tanggal efektif, periode kontrak (mulai dan akhir), gaji,
// tipe kontrak, posisi, departemen, dan jadwal kerja. Perubahan gaji atau jabatan di tengah kontrak adalah versi baru dengan periode kontrak yang sama;
// kontrak baru memakai tanggal mulai baru setelah kontrak lama berakhir. Odoo menolak dua kontrak yang periodenya tumpang tindih (D83).
import { badge, button, call, closeModal, dateText, esc, guarded, INPUT, money, openModal, searchRead, selectOptions, toast, today } from "../common.js";
import { EMPLOYEE_TYPES, hrRefs } from "./employee.js";
import { createMasterPage } from "./masters.js";

const STATUS = { running: ["Berjalan", "success"], future: ["Akan datang", "info"], ended: ["Berakhir", "muted"], none: ["Tanpa kontrak", "warning"] };
export const contractStatus = (r) => {
  const now = today();
  if (!r.contract_date_start) return "none";
  if (r.contract_date_start > now) return "future";
  if (r.contract_date_end && r.contract_date_end < now) return "ended";
  return "running";
};
const statusDomain = (value) => {
  const now = today();
  if (value === "running") return [["contract_date_start", "<=", now], "|", ["contract_date_end", "=", false], ["contract_date_end", ">=", now]];
  if (value === "future") return [["contract_date_start", ">", now]];
  if (value === "ended") return [["contract_date_end", "<", now]];
  return [["contract_date_start", "=", false]];
};

let employeesCache = [];

const newVersionModal = () => {
  const body = `<div><label class="text-xs font-medium text-gray-500 uppercase">Karyawan</label><select id="nv-employee" class="${INPUT}">${selectOptions(employeesCache, null, "Pilih karyawan...")}</select></div>
    <div><label class="text-xs font-medium text-gray-500 uppercase">Tanggal Efektif Versi</label><input id="nv-date" type="date" value="${esc(today())}" class="${INPUT}"></div>
    <div><label class="text-xs font-medium text-gray-500 uppercase">Gaji Baru (kosongkan bila tidak berubah)</label><input id="nv-wage" type="number" min="0" step="any" class="${INPUT} text-right"></div>
    <div class="grid grid-cols-2 gap-3"><div><label class="text-xs font-medium text-gray-500 uppercase">Mulai Kontrak Baru</label><input id="nv-start" type="date" class="${INPUT}"></div>
      <div><label class="text-xs font-medium text-gray-500 uppercase">Akhir Kontrak</label><input id="nv-end" type="date" class="${INPUT}"></div></div>
    <p class="text-xs text-gray-500">Kosongkan tanggal kontrak untuk perubahan di dalam kontrak yang berjalan (mis. kenaikan gaji). Isi Mulai Kontrak Baru untuk kontrak baru; kontrak lama harus sudah berakhir sebelum tanggal itu.</p>`;
  openModal("Versi atau Kontrak Baru", body, `${button("modal-close", "Batal")}${button("ver-create", "Buat", "primary")}`);
};

const page = createMasterPage({
  route: "contract", title: "Contracts", noun: "Kontrak", model: "hr.version", noNew: true, order: "employee_id, date_version desc", limit: 200,
  empty: "Belum ada kontrak yang cocok.",
  listFields: ["employee_id", "date_version", "contract_date_start", "contract_date_end", "contract_type_id", "job_id", "department_id", "wage"],
  columns: [
    { label: "Karyawan", value: (r) => r.employee_id?.[1] ?? "-" },
    { label: "Status", value: (r) => badge(STATUS, contractStatus(r)), raw: true },
    { label: "Efektif", value: (r) => (r.date_version ? dateText(r.date_version) : "-") },
    { label: "Mulai Kontrak", value: (r) => (r.contract_date_start ? dateText(r.contract_date_start) : "-") },
    { label: "Akhir Kontrak", value: (r) => (r.contract_date_end ? dateText(r.contract_date_end) : "-") },
    { label: "Tipe", value: (r) => r.contract_type_id?.[1] ?? "-" },
    { label: "Posisi", value: (r) => r.job_id?.[1] ?? "-" },
    { label: "Gaji", value: (r) => money(r.wage), right: true },
  ],
  search: ["employee_id.name", "job_id.name"],
  filters: [
    { key: "status", label: "Semua status", options: Object.entries(STATUS).map(([k, v]) => [k, v[0]]), domain: statusDomain },
    { key: "employee", hidden: true, label: "Karyawan", options: [], domain: (v) => [["employee_id", "=", Number(v)]] },
  ],
  headerExtra: button("ver-new", "Versi atau Kontrak Baru", "primary"),
  loadRefs: async () => {
    const [base, types, calendars] = await Promise.all([
      hrRefs(),
      searchRead("hr.contract.type", [], ["display_name"], { order: "sequence, name", limit: 100 }),
      searchRead("resource.calendar", [], ["display_name"], { order: "name", limit: 100 }),
    ]);
    employeesCache = base.employees;
    return { ...base, types, calendars };
  },
  fields: [
    { key: "employee_id", label: "Karyawan", type: "m2o", readonly: true, optionsOf: (refs) => refs.employees },
    { key: "date_version", label: "Tanggal Efektif Versi", type: "date", required: true },
    { key: "contract_date_start", label: "Mulai Kontrak", type: "date" },
    { key: "contract_date_end", label: "Akhir Kontrak", type: "date", hint: "Kosongkan untuk kontrak tanpa batas waktu (PKWTT)." },
    { key: "contract_type_id", label: "Tipe Kontrak", type: "m2o", optionsOf: (refs) => refs.types },
    { key: "wage", label: "Gaji Pokok", type: "number", min: 0, step: "any" },
    { key: "job_id", label: "Posisi", type: "m2o", optionsOf: (refs) => refs.jobs },
    { key: "department_id", label: "Departemen", type: "m2o", optionsOf: (refs) => refs.departments },
    { key: "employee_type", label: "Jenis Karyawan", type: "select", options: EMPLOYEE_TYPES },
    { key: "resource_calendar_id", label: "Jadwal Kerja", type: "m2o", optionsOf: (refs) => refs.calendars },
    { key: "additional_note", label: "Catatan Kontrak", type: "textarea", span2: true },
  ],
  readFields: ["contract_date_start", "contract_date_end"],
  titleOf: (r) => `${r.employee_id?.[1] ?? ""}, efektif ${r.date_version}`,
  tiles: (r) => [{ count: STATUS[contractStatus(r)][0], label: "Status kontrak", icon: "fa-file-contract", always: true }],
  actions: (r) => `<span class="self-center">${badge(STATUS, contractStatus(r))}</span>${button("ver-delete", "Hapus Versi", "danger", { id: r.id })}`,
  formNote: "Mengubah tanggal mulai atau akhir kontrak ikut mengubah semua versi pada kontrak yang sama. Gaji di sini dipakai sebagai dasar perhitungan penggajian bila fitur Payroll dibangun.",
  onAction: async (action, el) => {
    if (action === "ver-new") {
      employeesCache = await searchRead("hr.employee", [], ["display_name"], { order: "name", limit: 500 });
      newVersionModal();
    }
    else if (action === "ver-create") {
      const value = (id) => document.getElementById(id).value;
      const employee = Number(value("nv-employee"));
      const ok = await guarded(el, async () => {
        if (!employee) throw new Error("Pilih karyawan.");
        if (!value("nv-date")) throw new Error("Isi tanggal efektif versi.");
        const values = { date_version: value("nv-date") };
        if (value("nv-wage") !== "") values.wage = Number(value("nv-wage"));
        if (value("nv-start")) values.contract_date_start = value("nv-start");
        if (value("nv-end")) values.contract_date_end = value("nv-end");
        if (values.contract_date_start && values.contract_date_end && values.contract_date_end < values.contract_date_start) throw new Error("Akhir kontrak tidak boleh sebelum mulai kontrak.");
        return call("hr.employee", "create_version", { ids: [employee], values });
      });
      if (ok !== undefined) {
        closeModal();
        toast("Versi dibuat.");
        location.hash = `#/contract/${typeof ok === "number" ? ok : Array.isArray(ok) ? ok[0] : ok?.id ?? ""}`;
      }
    } else if (action === "ver-delete") {
      if (!window.confirm("Hapus versi ini? Karyawan harus selalu punya minimal satu versi.")) return;
      const ok = await guarded(el, () => call("hr.version", "unlink", { ids: [Number(el.dataset.id)] }));
      if (ok !== undefined) {
        toast("Versi dihapus.");
        location.hash = "#/contract";
      }
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
