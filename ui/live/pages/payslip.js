// Payslips (hr.payslip): slip gaji OCA payroll. Slip dibuat dari kontrak berjalan karyawan pada periode (hr.payslip.kompakapps_create_payslip: struktur dari kontrak,
// isian input dari aturan struktur, hari kerja dari jadwal kerja). Alur: Draf, Hitung (aturan dijalankan, status Dihitung), Konfirmasi (Selesai), dengan Kembali ke Draf,
// Batalkan, dan Refund (slip koreksi) untuk slip selesai. Input (tunjangan, potongan, dan sejenisnya) dan hari kerja diedit sebelum Hitung (D85).
import { badge, button, call, closeModal, dateText, esc, guarded, INPUT, money, openModal, searchRead, selectOptions, statusbar, toast, today } from "../common.js";
import { printButton } from "../print.js";
import { SLIP_STATES, monthBounds, nf, workedLabel } from "../payroll.js";
import { hrRefs } from "./employee.js";
import { createMasterPage } from "./masters.js";

const EDITABLE = ["draft", "verify"];
let employeesCache = [];
let structuresCache = [];

const slipNet = async (ids) => {
  if (!ids.length) return new Map();
  const lines = await searchRead("hr.payslip.line", [["slip_id", "in", ids], ["code", "=", "NET"]], ["slip_id", "total"], { limit: 2000 });
  return new Map(lines.map((l) => [l.slip_id[0], l.total]));
};

const journalHtml = (record, link) => {
  if (record.kompakapps_move_id) return link(`#/journal/${record.kompakapps_move_id[0]}`, record.kompakapps_move_id[1]);
  if (record.kompakapps_move_note) return `<span class="text-amber-700 text-xs font-normal">Jurnal belum dibuat. ${esc(record.kompakapps_move_note)}</span>`;
  return record.state === "done" ? "-" : '<span class="text-gray-500 text-xs font-normal">Dibuat saat slip dikonfirmasi</span>';
};

const newSlipModal = () => {
  const [from, to] = monthBounds(today());
  const label = "text-xs font-medium text-gray-500 uppercase";
  const body = `<div><label class="${label}">Karyawan</label><select id="ns-employee" class="${INPUT}">${selectOptions(employeesCache, null, "Pilih karyawan...")}</select></div>
    <div class="grid grid-cols-2 gap-3"><div><label class="${label}">Periode Dari</label><input id="ns-from" type="date" value="${from}" class="${INPUT}"></div>
      <div><label class="${label}">Periode Sampai</label><input id="ns-to" type="date" value="${to}" class="${INPUT}"></div></div>
    <div><label class="${label}">Struktur Gaji</label><select id="ns-struct" class="${INPUT}">${selectOptions(structuresCache, null, "Ikuti kontrak karyawan")}</select></div>
    <p class="text-xs text-gray-500">Slip memakai kontrak yang berjalan pada periode dan struktur gaji dari kontrak itu. Karyawan tanpa kontrak berjalan atau tanpa struktur gaji ditolak; slip kedua pada periode yang beririsan juga ditolak.</p>`;
  openModal("Slip Gaji Baru", body, `${button("modal-close", "Batal")}${button("slip-create", "Buat Slip", "primary")}`);
};

const sectionTable = (title, note, head, rows, empty) =>
  `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mt-6"><h2 class="font-semibold text-gray-900 mb-1">${esc(title)}</h2>${note ? `<p class="text-xs text-gray-500 mb-3">${note}</p>` : ""}
    ${rows ? `<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs uppercase text-gray-500">${head}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="text-sm text-gray-500">${esc(empty)}</p>`}</section>`;
const th = (label, right = false) => `<th class="pb-2 pr-3 ${right ? "text-right" : ""}">${esc(label)}</th>`;
const td = (html, right = false, extra = "") => `<td class="py-2 pr-3 ${right ? "text-right" : ""} ${extra}">${html}</td>`;
const numInput = (kind, id, field, value) => `<input type="number" step="any" data-slip-edit="${kind}" data-id="${id}" data-field="${field}" value="${esc(value)}" class="${INPUT} text-right w-36 py-1">`;

/** Simpan isian input dan hari kerja yang diedit di layar (hanya yang berubah). */
async function saveEdits() {
  const jobs = [];
  for (const el of document.querySelectorAll("[data-slip-edit]")) {
    const value = el.value === "" ? 0 : Number(el.value);
    if (value === Number(el.defaultValue || 0)) continue;
    const model = el.dataset.slipEdit === "input" ? "hr.payslip.input" : "hr.payslip.worked_days";
    jobs.push(call(model, "write", { ids: [Number(el.dataset.id)], vals: { [el.dataset.field]: value } }));
  }
  await Promise.all(jobs);
  return jobs.length;
}

const page = createMasterPage({
  route: "payslip", title: "Payslips", noun: "Slip Gaji", model: "hr.payslip", noNew: true, order: "date_from desc, id desc", limit: 200,
  empty: "Belum ada slip gaji. Buat slip baru atau buat dari Batch.",
  listFields: ["number", "name", "employee_id", "date_from", "date_to", "struct_id", "payslip_run_id", "state", "credit_note"],
  columns: [
    { label: "Nomor", value: (r) => r.number || "-" },
    { label: "Karyawan", value: (r) => r.employee_id?.[1] ?? "-" },
    { label: "Periode", value: (r) => `${dateText(r.date_from)} - ${dateText(r.date_to)}` },
    { label: "Struktur", value: (r) => r.struct_id?.[1] ?? "-" },
    { label: "Batch", value: (r) => r.payslip_run_id?.[1] ?? "-" },
    { label: "Jenis", value: (r) => (r.credit_note ? "Koreksi (refund)" : "Slip") },
    { label: "Status", value: (r) => badge(SLIP_STATES, r.state), raw: true },
    { label: "Gaji Bersih", value: (r, refs) => (refs.net.has(r.id) ? money(r.credit_note ? -refs.net.get(r.id) : refs.net.get(r.id)) : "-"), right: true },
  ],
  search: ["number", "employee_id.name", "name"],
  filters: [
    { key: "status", label: "Semua status", options: Object.entries(SLIP_STATES).map(([k, v]) => [k, v[0]]), domain: (v) => [["state", "=", v]] },
    { key: "employee", hidden: true, label: "Karyawan", options: [], domain: (v) => [["employee_id", "=", Number(v)]] },
    { key: "run", hidden: true, label: "Batch", options: [], domain: (v) => [["payslip_run_id", "=", Number(v)]] },
  ],
  headerExtra: button("slip-new", "Slip Baru", "primary"),
  loadListRefs: async (rows) => ({ net: await slipNet(rows.map((r) => r.id)) }),
  loadRefs: async () => ({}),
  fields: [
    { key: "name", label: "Nama Slip", type: "text", required: true, readonly: (r) => Boolean(r) && !EDITABLE.includes(r.state), span2: true },
    { key: "note", label: "Catatan Internal", type: "textarea", span2: true, readonly: (r) => Boolean(r) && !EDITABLE.includes(r.state) },
  ],
  readFields: ["state", "number", "employee_id", "contract_id", "struct_id", "payslip_run_id", "date_from", "date_to", "company_id", "credit_note", "refunded_id", "line_ids", "kompakapps_move_id", "kompakapps_move_note", "allow_cancel_payslips"],
  titleOf: (r) => r.name || r.number || "Slip Gaji",
  formTop: async (record) => {
    if (!record) return "";
    const [[contract], net] = await Promise.all([
      record.contract_id ? call("hr.version", "read", { ids: [record.contract_id[0]], fields: ["wage", "contract_date_start", "contract_date_end"] }) : [null],
      slipNet([record.id]),
    ]);
    const link = (href, text) => `<a class="text-indigo-600 hover:underline" href="${href}">${esc(text)}</a>`;
    const item = (label, html) => `<div><div class="text-xs font-medium text-gray-500 uppercase tracking-wide">${esc(label)}</div><div class="py-1 text-sm font-medium text-gray-900">${html || '<span class="text-gray-400">-</span>'}</div></div>`;
    const netValue = net.has(record.id) ? money(record.credit_note ? -net.get(record.id) : net.get(record.id)) : "";
    return `<div class="mb-3">${statusbar(["draft", "verify", "done"], SLIP_STATES, record.state)}</div>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mb-3 grid md:grid-cols-3 gap-x-8 gap-y-3">
        ${item("Nomor", esc(record.number || "Terbit saat dihitung"))}
        ${item("Karyawan", record.employee_id ? link(`#/employee/${record.employee_id[0]}`, record.employee_id[1]) : "")}
        ${item("Periode", esc(`${dateText(record.date_from)} - ${dateText(record.date_to)}`))}
        ${item("Kontrak", record.contract_id ? link(`#/contract/${record.contract_id[0]}`, `Gaji pokok ${money(contract?.wage ?? 0)}`) : "")}
        ${item("Struktur Gaji", record.struct_id ? link(`#/salarystruct/${record.struct_id[0]}`, record.struct_id[1]) : "")}
        ${item("Batch", record.payslip_run_id ? link(`#/payslipbatch/${record.payslip_run_id[0]}`, record.payslip_run_id[1]) : "")}
        ${record.credit_note ? item("Jenis", "Koreksi (refund)") : ""}
        ${record.refunded_id ? item("Dikoreksi oleh", link(`#/payslip/${record.refunded_id[0]}`, "Lihat slip koreksi")) : ""}
        ${item("Gaji Bersih", `<span class="text-base">${esc(netValue || "belum dihitung")}</span>`)}
        ${item("Jurnal", journalHtml(record, link))}
      </section>`;
  },
  actions: (r) => {
    const parts = [];
    if (EDITABLE.includes(r.state)) parts.push(button("slip-compute", r.state === "draft" ? "Hitung" : "Hitung Ulang", "primary", { id: r.id }));
    if (r.state === "verify") parts.push(button("slip-confirm", "Konfirmasi", "success", { id: r.id }));
    if (r.state === "verify" || r.state === "cancel") parts.push(button("slip-draft", "Kembali ke Draf", "plain", { id: r.id }));
    if (EDITABLE.includes(r.state) || (r.state === "done" && r.allow_cancel_payslips)) parts.push(button("slip-cancel", "Batalkan", "danger", { id: r.id }));
    if (r.state === "done" && !r.kompakapps_move_id) parts.push(button("slip-journal", "Buat Jurnal", "plain", { id: r.id }));
    if (r.state === "done" && !r.credit_note && !r.refunded_id) parts.push(button("slip-refund", "Refund (Slip Koreksi)", "plain", { id: r.id }));
    if (r.state === "draft" || r.state === "cancel") parts.push(button("slip-delete", "Hapus", "danger", { id: r.id }));
    if (r.line_ids?.length) parts.push(printButton("hr.payslip", r.id, "Cetak Slip"));
    return parts.join("");
  },
  formNote: "Input dan hari kerja diedit di bawah lalu disimpan otomatis saat Hitung. Slip selesai tidak dapat diubah; gunakan Refund untuk membuat slip koreksi.",
  extra: async (record) => {
    const [inputs, days, lines] = await Promise.all([
      searchRead("hr.payslip.input", [["payslip_id", "=", record.id]], ["name", "code", "amount", "amount_qty"], { order: "sequence, id" }),
      searchRead("hr.payslip.worked_days", [["payslip_id", "=", record.id]], ["name", "code", "number_of_days", "number_of_hours"], { order: "sequence, id" }),
      searchRead("hr.payslip.line", [["slip_id", "=", record.id]], ["name", "code", "category_id", "quantity", "rate", "amount", "total", "appears_on_payslip"], { order: "sequence, id" }),
    ]);
    const editable = EDITABLE.includes(record.state);
    const inputRows = inputs
      .map((i) => `<tr class="border-t border-gray-100">${td(esc(i.name))}${td(`<span class="font-mono text-xs">${esc(i.code)}</span>`)}${td(editable ? numInput("input", i.id, "amount", i.amount) : esc(nf.format(i.amount)), true)}${td(editable ? numInput("input", i.id, "amount_qty", i.amount_qty) : esc(nf.format(i.amount_qty)), true)}</tr>`)
      .join("");
    const dayRows = days
      .map((d) => `<tr class="border-t border-gray-100">${td(esc(workedLabel(d)))}${td(`<span class="font-mono text-xs">${esc(d.code)}</span>`)}${td(editable ? numInput("days", d.id, "number_of_days", d.number_of_days) : esc(nf.format(d.number_of_days)), true)}${td(editable ? numInput("days", d.id, "number_of_hours", d.number_of_hours) : esc(nf.format(d.number_of_hours)), true)}</tr>`)
      .join("");
    const lineRows = lines
      .map((l) => `<tr class="border-t border-gray-100 ${l.code === "NET" ? "font-semibold bg-gray-50" : ""}">${td(esc(l.name))}${td(`<span class="font-mono text-xs">${esc(l.code || "-")}</span>`)}${td(esc(l.category_id?.[1] ?? "-"))}${td(esc(nf.format(l.quantity)), true)}${td(esc(nf.format(l.rate)), true)}${td(esc(nf.format(l.amount)), true)}${td(esc(money(l.total)), true)}</tr>`)
      .join("");
    return (
      sectionTable("Input Slip", "Isian dari aturan struktur (mis. Tunjangan dan Potongan); rumus aturan membacanya dengan inputs.KODE.amount.", `${th("Keterangan")}${th("Kode")}${th("Jumlah", true)}${th("Kuantitas", true)}`, inputRows, "Struktur ini tidak punya input.") +
      sectionTable("Hari Kerja", "Diturunkan dari jadwal kerja kontrak dan cuti pada periode; bisa dikoreksi sebelum Hitung.", `${th("Keterangan")}${th("Kode")}${th("Hari", true)}${th("Jam", true)}`, dayRows, "Belum ada data hari kerja (kontrak tanpa jadwal kerja).") +
      sectionTable("Hasil Perhitungan", record.state === "draft" ? "" : "", `${th("Aturan")}${th("Kode")}${th("Kategori")}${th("Kuantitas", true)}${th("Tarif (%)", true)}${th("Dasar", true)}${th("Total", true)}`, lineRows, "Belum dihitung. Tekan Hitung.")
    );
  },
  onAction: async (action, el, { reload }) => {
    const id = Number(el.dataset.id);
    const run = async (work, doneText) => {
      const ok = await guarded(el, work);
      if (ok !== undefined) {
        toast(doneText);
        reload();
      }
    };
    if (action === "slip-new") {
      [employeesCache, structuresCache] = await Promise.all([hrRefs().then((r) => r.employees), searchRead("hr.payroll.structure", [], ["display_name"], { order: "name", limit: 100 })]);
      newSlipModal();
    } else if (action === "slip-create") {
      const value = (key) => document.getElementById(key).value;
      const created = await guarded(el, async () => {
        const employee = Number(value("ns-employee"));
        if (!employee) throw new Error("Pilih karyawan.");
        if (!value("ns-from") || !value("ns-to")) throw new Error("Isi periode slip.");
        if (value("ns-to") < value("ns-from")) throw new Error("Akhir periode tidak boleh sebelum awal periode.");
        return call("hr.payslip", "kompakapps_create_payslip", { employee_id: employee, date_from: value("ns-from"), date_to: value("ns-to"), struct_id: Number(value("ns-struct")) || false });
      });
      if (created) {
        closeModal();
        toast("Slip dibuat.");
        location.hash = `#/payslip/${created}`;
      }
    } else if (action === "slip-compute") await run(async () => (await saveEdits(), call("hr.payslip", "compute_sheet", { ids: [id] })), "Slip dihitung.");
    else if (action === "slip-confirm") {
      if (!window.confirm("Konfirmasi slip ini? Setelah selesai slip tidak dapat diubah (koreksi lewat Refund).")) return;
      const confirmed = await guarded(el, async () => {
        await saveEdits();
        await call("hr.payslip", "action_payslip_done", { ids: [id] });
        const [slip] = await call("hr.payslip", "read", { ids: [id], fields: ["kompakapps_move_id", "kompakapps_move_note"] });
        return slip;
      });
      if (confirmed) {
        toast(confirmed.kompakapps_move_id ? `Slip dikonfirmasi. Jurnal ${confirmed.kompakapps_move_id[1]} diposting.` : `Slip dikonfirmasi tanpa jurnal. ${confirmed.kompakapps_move_note || ""}`);
        reload();
      }
    } else if (action === "slip-draft") await run(() => call("hr.payslip", "action_payslip_draft", { ids: [id] }), "Slip dikembalikan ke draf.");
    else if (action === "slip-cancel") {
      if (!window.confirm("Batalkan slip ini? Jurnal gaji yang sudah diposting akan dibalik.")) return;
      await run(() => call("hr.payslip", "action_payslip_cancel", { ids: [id] }), "Slip dibatalkan.");
    } else if (action === "slip-journal") await run(() => call("hr.payslip", "kompakapps_post_journal", { ids: [id] }), "Jurnal gaji diposting.");
    else if (action === "slip-refund") {
      if (!window.confirm("Buat slip koreksi (refund) untuk slip ini? Slip koreksi langsung berstatus Selesai.")) return;
      const ok = await guarded(el, async () => {
        await call("hr.payslip", "refund_sheet", { ids: [id] });
        const [slip] = await call("hr.payslip", "read", { ids: [id], fields: ["refunded_id"] });
        return slip.refunded_id?.[0] ?? true;
      });
      if (ok) {
        toast("Slip koreksi dibuat.");
        if (typeof ok === "number") location.hash = `#/payslip/${ok}`;
        else reload();
      }
    } else if (action === "slip-delete") {
      if (!window.confirm("Hapus slip ini?")) return;
      const ok = await guarded(el, () => call("hr.payslip", "unlink", { ids: [id] }));
      if (ok !== undefined) {
        toast("Slip dihapus.");
        location.hash = "#/payslip";
      }
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
