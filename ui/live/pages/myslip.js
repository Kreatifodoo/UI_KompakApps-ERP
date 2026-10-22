// Slip Saya: karyawan membaca dan mencetak slip gajinya sendiri yang sudah Selesai (D86 irisan 4). Server membatasi (aturan record hr.payslip dan
// hr.payslip.line untuk semua pengguna internal): hanya slip dengan karyawan = pengguna ini dan status Selesai yang terbaca; halaman ini tidak membaca
// field karyawan atau kontrak (itu hak HR) dan memakai urutan eksplisit karena urutan bawaan baris slip memuat kontrak.
import { app, button, call, cell, dateText, esc, guarded, money, openModal, pageHeader, searchRead, table } from "../common.js";
import { printButton } from "../print.js";
import { nf } from "../payroll.js";

const row = (name, amount, strong = false) =>
  `<tr class="${strong ? "font-semibold border-t border-gray-300" : "border-t border-gray-100"}"><td class="py-1.5 pr-3">${esc(name)}</td><td class="py-1.5 text-right whitespace-nowrap">${esc(money(amount))}</td></tr>`;
const block = (title, items, sign = 1, total = null, totalLabel = "") =>
  items.length
    ? `<div><div class="text-xs font-semibold uppercase text-gray-500 mb-1">${esc(title)}</div><table class="w-full text-sm"><tbody>${items.map((i) => row(i.name, sign * i.amount)).join("")}${total === null ? "" : row(totalLabel, total, true)}</tbody></table></div>`
    : "";

const detailHtml = (s) => `<div class="space-y-4">
  <div class="text-sm text-gray-600">${esc(s.employee.name)}${s.employee.job ? ` · ${esc(s.employee.job)}` : ""} · ${esc(dateText(s.date_from))} - ${esc(dateText(s.date_to))}${s.credit_note ? " · Slip koreksi" : ""}</div>
  ${block("Penghasilan", s.earnings, 1, s.total_earnings, "Total penghasilan")}
  ${block("Potongan", [...s.deductions, ...s.tax], -1, -s.total_deductions, "Total potongan")}
  <div class="flex justify-between items-center rounded-lg bg-indigo-50 text-indigo-900 px-4 py-3 font-semibold"><span>Gaji Bersih</span><span>${esc(money(s.net))}</span></div>
  ${block("Iuran dibayar perusahaan (tidak mengurangi gaji bersih)", s.employer)}
  ${s.ytd ? `<p class="text-xs text-gray-600">PPh 21 yang sudah dipotong sejak Januari sampai periode ini: <strong>${esc(money(s.ytd.pph21))}</strong>.</p>` : ""}
  ${s.worked.length ? `<div><div class="text-xs font-semibold uppercase text-gray-500 mb-1">Kehadiran</div><table class="w-full text-sm"><tbody>${s.worked.map((d) => `<tr class="border-t border-gray-100"><td class="py-1.5 pr-3">${esc(d.name)}</td><td class="py-1.5 text-right">${esc(nf.format(d.days))} hari</td><td class="py-1.5 text-right">${esc(nf.format(d.hours))} jam</td></tr>`).join("")}</tbody></table></div>` : ""}
</div>`;

export async function render() {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const me = await call("hr.payslip", "kompakapps_my_employee", {});
  if (!me) {
    app.innerHTML = `${pageHeader("Slip Saya")}<section class="max-w-2xl bg-amber-50 border border-amber-200 rounded-xl p-6 text-sm text-amber-900"><div class="font-semibold mb-1"><i class="fas fa-circle-info mr-2"></i>Akun Anda belum ditautkan ke data karyawan</div>
      Minta bagian HR menautkan akun ini pada kolom Pengguna di halaman Employees agar slip gaji Anda tampil di sini.</section>`;
    return;
  }
  const slips = await searchRead("hr.payslip", [["state", "=", "done"]], ["number", "name", "date_from", "date_to", "credit_note"], { order: "date_from desc, id desc", limit: 200 });
  const nets = slips.length
    ? new Map((await searchRead("hr.payslip.line", [["slip_id", "in", slips.map((s) => s.id)], ["code", "=", "NET"]], ["slip_id", "total"], { order: "id", limit: 500 })).map((l) => [l.slip_id[0], l.total]))
    : new Map();
  const body = slips
    .map(
      (s) => `<tr class="hover:bg-gray-50">${cell(s.number || s.name)}${cell(`${dateText(s.date_from)} - ${dateText(s.date_to)}`)}${cell(s.credit_note ? "Koreksi" : "Slip")}
        ${cell(nets.has(s.id) ? money(s.credit_note ? -nets.get(s.id) : nets.get(s.id)) : "-", { right: true })}
        <td class="py-3 px-4 text-right whitespace-nowrap">${button("myslip-view", "Lihat", "plain", { id: s.id })} ${printButton("hr.payslip", s.id, "Cetak")}</td></tr>`,
    )
    .join("");
  app.innerHTML =
    pageHeader("Slip Saya") +
    `<p class="text-sm text-gray-600 mb-3">Slip gaji ${esc(me.name)} yang sudah dikonfirmasi payroll. Slip yang masih diproses belum tampil.</p>` +
    table([{ label: "Nomor" }, { label: "Periode" }, { label: "Jenis" }, { label: "Gaji Bersih", right: true }, { label: "" }], body, "Belum ada slip gaji yang selesai.");
}

export async function onClick(event, el) {
  if (el.dataset.action !== "myslip-view") return;
  const [slip] = (await guarded(el, () => call("hr.payslip", "kompakapps_slip_data", { ids: [Number(el.dataset.id)] }))) ?? [];
  if (!slip) return;
  openModal(`Slip Gaji ${slip.number || slip.name}`, detailHtml(slip), `${button("modal-close", "Tutup")}${printButton("hr.payslip", slip.id, "Cetak")}`);
}

export const onInput = () => {};
export const onChange = () => {};
export const leave = () => {};
