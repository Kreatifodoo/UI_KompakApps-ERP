// Saldo Cuti: sisa jatah tiap karyawan per jenis cuti yang butuh jatah. Angka dihitung Odoo (jatah disetujui dikurangi cuti terpakai dan yang masih diajukan).
import { app, esc, pageHeader, searchRead, searchBox, table } from "../common.js";
import { leaveBalance } from "./timeoff.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

export async function render(sub, query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const text = query.get("q") ?? "";
  const domain = text ? [["name", "ilike", text]] : [];
  const employees = await searchRead("hr.employee", domain, ["name"], { order: "name", limit: 100 });
  const rows = await Promise.all(employees.map(async (e) => ({ e, balance: await leaveBalance(e.id) })));
  const types = rows[0]?.balance ?? (await searchRead("hr.leave.type", [["requires_allocation", "=", true]], ["name", "request_unit"], { order: "sequence, name" }));
  const body = rows
    .map(({ e, balance }) => `<tr class="hover:bg-gray-50"><td class="py-3 px-4 text-sm font-medium text-indigo-700"><a href="#/timeoff?employee=${e.id}">${esc(e.name)}</a></td>${balance
      .map((t) => `<td class="py-3 px-4 text-sm text-right ${t.virtual_remaining_leaves < 0 ? "text-rose-700" : "text-gray-700"}">${nf.format(t.virtual_remaining_leaves)} <span class="text-xs text-gray-400">/ ${nf.format(t.max_leaves)}</span></td>`)
      .join("")}</tr>`)
    .join("");
  app.innerHTML =
    pageHeader("Saldo Cuti", searchBox(text, "Cari karyawan")) +
    table([{ label: "Karyawan" }, ...types.map((t) => ({ label: t.name, right: true }))], body, "Belum ada karyawan.") +
    '<p class="text-xs text-gray-500 mt-3">Tiap sel: sisa / jatah (hari, atau jam untuk jenis berunit jam). Jatah yang belum disetujui belum dihitung.</p>';
}
export const leave = () => {};
