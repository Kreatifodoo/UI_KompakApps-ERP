// Payslip Batches (hr.payslip.run): penggajian satu periode untuk banyak karyawan. Batch membuat slip draf untuk semua karyawan berkontrak pada periode (atau yang dipilih),
// menghitung semua, mengonfirmasi semua, lalu ditutup. Karyawan yang gagal (kontrak tanpa struktur gaji, slip kembar) dilewati dan dilaporkan tanpa membatalkan yang lain.
// Hanya Manager payroll yang mengelola batch (aturan akses OCA payroll, D85).
import { badge, button, call, closeModal, dateText, esc, guarded, money, openModal, searchRead, toast, today } from "../common.js";
import { RUN_STATES, SLIP_STATES, monthBounds } from "../payroll.js";
import { hrRefs } from "./employee.js";
import { createMasterPage } from "./masters.js";

let employeesCache = [];

const pickEmployeesModal = (runId) => {
  const rows = employeesCache
    .map((e) => `<label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-pick-employee value="${e.id}" class="rounded border-gray-300 text-indigo-600"> ${esc(e.display_name)}</label>`)
    .join("");
  openModal(
    "Pilih Karyawan",
    `<p class="text-xs text-gray-500">Slip dibuat untuk karyawan yang dicentang. Karyawan yang sudah punya slip di batch ini dilewati.</p>
     <div class="border border-gray-200 rounded-lg p-2 max-h-72 overflow-y-auto space-y-1">${rows || '<div class="text-sm text-gray-400">Belum ada karyawan.</div>'}</div>`,
    `${button("modal-close", "Batal")}${button("batch-generate-picked", "Buat Slip", "primary", { id: runId })}`,
  );
};

const reportModal = (result) => {
  const skipped = result.skipped
    .map((s) => `<li><strong>${esc(s.employee)}</strong>: ${esc(s.reason)}</li>`)
    .join("");
  openModal(
    "Hasil Pembuatan Slip",
    `<p class="text-sm text-gray-700">${result.created.length} slip dibuat${result.skipped.length ? `, ${result.skipped.length} karyawan dilewati` : ""}${result.ineligible ? `; ${result.ineligible} karyawan tanpa kontrak berjalan pada periode tidak diikutkan` : ""}.</p>
     ${skipped ? `<ul class="list-disc pl-5 text-sm text-rose-700 space-y-1">${skipped}</ul>` : ""}`,
    button("modal-close", "Tutup", "primary"),
  );
};

const emailReport = (result) => {
  const failed = result.failed.map((f) => `<li><strong>${esc(f.employee)}</strong>: ${esc(f.message)}</li>`).join("");
  openModal(
    "Hasil Kirim Email Slip",
    `<p class="text-sm text-gray-700">${result.sent} slip terkirim${result.failed.length ? `, ${result.failed.length} gagal` : ""}${result.skipped ? `; ${result.skipped} slip belum selesai dan tidak dikirim` : ""}.</p>
     ${failed ? `<ul class="list-disc pl-5 text-sm text-rose-700 space-y-1">${failed}</ul><p class="text-xs text-gray-500">Setiap hasil juga dicatat di chatter slip yang bersangkutan.</p>` : ""}`,
    button("modal-close", "Tutup", "primary"),
  );
};

const page = createMasterPage({
  route: "payslipbatch", title: "Payslip Batches", noun: "Batch Slip", model: "hr.payslip.run", newLabel: "Batch Baru", order: "date_start desc, id desc", limit: 200,
  empty: "Belum ada batch. Buat batch untuk penggajian satu periode.",
  listFields: ["name", "date_start", "date_end", "struct_id", "slip_ids", "state"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Periode", value: (r) => `${dateText(r.date_start)} - ${dateText(r.date_end)}` },
    { label: "Struktur", value: (r) => r.struct_id?.[1] ?? "Ikuti kontrak" },
    { label: "Slip", value: (r) => (r.slip_ids ?? []).length, right: true },
    { label: "Status", value: (r) => badge(RUN_STATES, r.state), raw: true },
  ],
  search: ["name"],
  filters: [{ key: "status", label: "Semua status", options: Object.entries(RUN_STATES).map(([k, v]) => [k, v[0]]), domain: (v) => [["state", "=", v]] }],
  loadRefs: async () => ({ structures: await searchRead("hr.payroll.structure", [], ["display_name"], { order: "name", limit: 100 }) }),
  newValues: () => {
    const [from, to] = monthBounds(today());
    return { date_start: from, date_end: to, name: `Gaji ${new Date().toLocaleDateString("id-ID", { month: "long", year: "numeric" })}` };
  },
  fields: [
    { key: "name", label: "Nama Batch", type: "text", required: true, span2: true },
    { key: "date_start", label: "Periode Dari", type: "date", required: true, readonly: (r) => Boolean(r) && (r.state !== "draft" || (r.slip_ids ?? []).length > 0) },
    { key: "date_end", label: "Periode Sampai", type: "date", required: true, readonly: (r) => Boolean(r) && (r.state !== "draft" || (r.slip_ids ?? []).length > 0) },
    { key: "struct_id", label: "Struktur Gaji", type: "m2o", optionsOf: (refs) => refs.structures, blank: "Ikuti kontrak karyawan", readonly: (r) => Boolean(r) && (r.state !== "draft" || (r.slip_ids ?? []).length > 0), hint: "Kosong berarti tiap slip memakai struktur dari kontrak karyawan." },
  ],
  readFields: ["state", "slip_ids"],
  titleOf: (r) => r.name,
  validate: (v) => {
    if (v.date_end && v.date_start && v.date_end < v.date_start) throw new Error("Akhir periode tidak boleh sebelum awal periode.");
  },
  tiles: (r) => [{ count: (r.slip_ids ?? []).length, label: "Slip", icon: "fa-file-invoice-dollar", always: true, href: `#/payslip?run=${r.id}` }],
  actions: (r) => {
    const parts = [];
    if (r.state === "draft") {
      parts.push(button("batch-generate-all", "Buat Slip Semua Karyawan", "primary", { id: r.id }), button("batch-pick", "Pilih Karyawan...", "plain", { id: r.id }));
      if ((r.slip_ids ?? []).length) parts.push(button("batch-compute", "Hitung Semua", "plain", { id: r.id }), button("batch-confirm", "Konfirmasi Semua", "success", { id: r.id }), button("batch-close", "Tutup Batch", "plain", { id: r.id }));
      else parts.push(button("batch-delete", "Hapus", "danger", { id: r.id }));
    } else parts.push(button("batch-reopen", "Kembali ke Draf", "plain", { id: r.id }));
    if ((r.slip_ids ?? []).length) parts.push(button("batch-email", "Kirim Slip Lewat Email", "plain", { id: r.id }));
    return parts.join("");
  },
  formNote: "Alur: Buat Slip, Hitung Semua, periksa tiap slip, Konfirmasi Semua, lalu Tutup Batch. Slip dibuat dari kontrak yang berjalan pada periode; karyawan tanpa struktur gaji dilaporkan dan dilewati.",
  extra: async (record) => {
    const slips = record.slip_ids?.length
      ? await searchRead("hr.payslip", [["id", "in", record.slip_ids]], ["number", "employee_id", "state"], { order: "employee_id, id", limit: 1000 })
      : [];
    if (!slips.length) return "";
    const nets = new Map(
      (await searchRead("hr.payslip.line", [["slip_id", "in", slips.map((s) => s.id)], ["code", "=", "NET"]], ["slip_id", "total"], { limit: 2000 })).map((l) => [l.slip_id[0], l.total]),
    );
    const total = slips.filter((s) => s.state !== "cancel").reduce((sum, s) => sum + (nets.get(s.id) ?? 0), 0);
    const rows = slips
      .map(
        (s) => `<tr class="border-t border-gray-100"><td class="py-2 pr-3"><a class="text-indigo-600 hover:underline" href="#/payslip/${s.id}">${esc(s.employee_id?.[1] ?? "-")}</a></td><td class="py-2 pr-3">${esc(s.number || "-")}</td>
          <td class="py-2 pr-3">${badge(SLIP_STATES, s.state)}</td><td class="py-2 text-right">${nets.has(s.id) ? esc(money(nets.get(s.id))) : "-"}</td></tr>`,
      )
      .join("");
    return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 mt-6"><h2 class="font-semibold text-gray-900 mb-2">Slip dalam Batch</h2>
      <table class="w-full text-sm"><thead><tr class="text-left text-xs uppercase text-gray-500"><th class="pb-2 pr-3">Karyawan</th><th class="pb-2 pr-3">Nomor</th><th class="pb-2 pr-3">Status</th><th class="pb-2 text-right">Gaji Bersih</th></tr></thead>
      <tbody>${rows}</tbody><tfoot><tr class="border-t border-gray-300 font-semibold"><td class="pt-2" colspan="3">Total gaji bersih (tanpa slip dibatalkan)</td><td class="pt-2 text-right">${esc(money(total))}</td></tr></tfoot></table></section>`;
  },
  onAction: async (action, el, { reload }) => {
    const id = Number(el.dataset.id);
    const run = async (work, doneText) => {
      const ok = await guarded(el, work);
      if (ok !== undefined) {
        if (doneText) toast(typeof doneText === "function" ? doneText(ok) : doneText);
        reload();
      }
      return ok;
    };
    const generate = async (employeeIds) => {
      const result = await guarded(el, () => call("hr.payslip.run", "kompakapps_generate_slips", { ids: [id], employee_ids: employeeIds }));
      if (result) {
        closeModal();
        reportModal(result);
        reload();
      }
    };
    if (action === "batch-email") {
      if (!window.confirm("Kirim slip yang sudah selesai di batch ini ke email kerja masing-masing karyawan?")) return;
      const result = await guarded(el, () => call("hr.payslip.run", "kompakapps_send_emails", { ids: [id] }));
      if (result) emailReport(result);
    } else if (action === "batch-generate-all") await generate(false);
    else if (action === "batch-pick") {
      employeesCache = (await hrRefs()).employees;
      pickEmployeesModal(id);
    } else if (action === "batch-generate-picked") {
      const picked = [...document.querySelectorAll("[data-pick-employee]:checked")].map((b) => Number(b.value));
      if (!picked.length) {
        toast("Centang minimal satu karyawan.");
        return;
      }
      await generate(picked);
    } else if (action === "batch-compute") await run(() => call("hr.payslip.run", "kompakapps_compute_all", { ids: [id] }), (n) => `${n} slip dihitung.`);
    else if (action === "batch-confirm") {
      if (!window.confirm("Konfirmasi semua slip yang sudah dihitung? Slip yang selesai tidak dapat diubah.")) return;
      await run(() => call("hr.payslip.run", "kompakapps_confirm_all", { ids: [id] }), (r) => `${r.confirmed} slip dikonfirmasi${r.no_journal ? `; ${r.no_journal} tanpa jurnal (pengaturan akun gaji belum lengkap)` : ""}${r.pending ? `; ${r.pending} slip draf belum dihitung dilewati` : ""}.`);
    } else if (action === "batch-close") {
      const open = await searchRead("hr.payslip", [["payslip_run_id", "=", id], ["state", "in", ["draft", "verify"]]], ["id"], { limit: 1 });
      const text = open.length ? "Masih ada slip yang belum dikonfirmasi. Tutup batch tetap?" : "Tutup batch ini?";
      if (!window.confirm(text)) return;
      await run(() => call("hr.payslip.run", "close_payslip_run", { ids: [id] }), "Batch ditutup.");
    } else if (action === "batch-reopen") await run(() => call("hr.payslip.run", "draft_payslip_run", { ids: [id] }), "Batch dikembalikan ke draf.");
    else if (action === "batch-delete") {
      if (!window.confirm("Hapus batch ini?")) return;
      const ok = await guarded(el, () => call("hr.payslip.run", "unlink", { ids: [id] }));
      if (ok !== undefined) {
        toast("Batch dihapus.");
        location.hash = "#/payslipbatch";
      }
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
