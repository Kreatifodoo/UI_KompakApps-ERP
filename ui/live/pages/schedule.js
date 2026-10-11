// Schedule Production: Manufacturing Order yang belum selesai, dikelompokkan per hari mulai. Menunjukkan ketersediaan
// komponen dan MO yang terlambat; perubahan jadwal dilakukan di form MO.
import { app, badge, dateText, esc, filterSelect, pageHeader, parseOdooDate, searchRead } from "../common.js";

const STATES = {
  draft: ["Draft", "muted"],
  confirmed: ["Dikonfirmasi", "info"],
  progress: ["Diproduksi", "warning"],
  to_close: ["Siap Ditutup", "warning"],
};
const AVAILABILITY = { available: ["Tersedia", "success"], expected: ["Diharapkan", "info"], late: ["Terlambat", "warning"], unavailable: ["Tidak tersedia", "danger"] };
const FILTERS = [["", "Semua yang belum selesai"], ["late", "Terlambat"], ["today", "Hari ini"], ["week", "7 hari ke depan"]];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 3 });

let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {};

const utc = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:00`;

export async function render(sub, query) {
  last = { sub, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat jadwal...</p>';
  const filter = query.get("state") ?? "";
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const domain = [["state", "in", Object.keys(STATES)]];
  if (filter === "late") domain.push(["date_start", "<", utc(now)], ["state", "in", ["draft", "confirmed"]]);
  else if (filter === "today") domain.push(["date_start", ">=", utc(startOfDay)], ["date_start", "<", utc(new Date(startOfDay.getTime() + 86400000))]);
  else if (filter === "week") domain.push(["date_start", ">=", utc(startOfDay)], ["date_start", "<", utc(new Date(startOfDay.getTime() + 7 * 86400000))]);
  const rows = await searchRead("mrp.production", domain, ["name", "product_id", "product_qty", "product_uom_id", "date_start", "date_finished", "state", "components_availability_state", "user_id", "duration_expected"], {
    order: "date_start, id", limit: 200,
  });
  const groups = new Map();
  for (const r of rows) {
    const key = dateText(r.date_start);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const time = (v) => (v ? parseOdooDate(v).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" }) : "");
  const late = (r) => ["draft", "confirmed"].includes(r.state) && parseOdooDate(r.date_start) < now;
  const body = [...groups.entries()]
    .map(
      ([day, list]) => `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4 overflow-x-auto">
        <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">${esc(day)} <span class="font-normal text-gray-500">· ${list.length} MO</span></div>
        <table class="w-full text-left"><tbody class="divide-y divide-gray-100">${list
          .map(
            (r) => `<tr class="hover:bg-gray-50 cursor-pointer" data-action="goto" data-href="#/mo/${r.id}">
              <td class="py-3 px-4 text-sm text-gray-600 w-32">${esc(time(r.date_start))}${r.date_finished ? ` – ${esc(time(r.date_finished))}` : ""}</td>
              <td class="py-3 px-4 text-sm font-medium text-indigo-700">${esc(r.name)}</td>
              <td class="py-3 px-4 text-sm text-gray-700">${esc(r.product_id[1])}</td>
              <td class="py-3 px-4 text-sm text-right tabular-nums">${esc(nf.format(r.product_qty))} ${esc(r.product_uom_id?.[1] ?? "")}</td>
              <td class="py-3 px-4 text-sm text-gray-600">${esc(r.user_id?.[1] ?? "")}</td>
              <td class="py-3 px-4 text-sm">${r.components_availability_state ? badge(AVAILABILITY, r.components_availability_state) : ""}</td>
              <td class="py-3 px-4 text-sm">${late(r) ? '<span class="px-2 py-1 rounded-full text-xs font-medium bg-rose-100 text-rose-700">Terlambat</span> ' : ""}${badge(STATES, r.state)}</td></tr>`,
          )
          .join("")}</tbody></table></section>`,
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Schedule Production",
      `${filterSelect(FILTERS, filter)}
       <a href="#/mo/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>MO Baru</a>`,
    ) +
    (body || '<div class="bg-white rounded-xl shadow-sm border border-gray-200 py-10 text-center text-sm text-gray-500">Tidak ada Manufacturing Order terjadwal.</div>') +
    `<p class="text-xs text-gray-500 mt-3">Urut menurut waktu mulai. Klik baris untuk membuka MO dan mengubah jadwal, penanggung jawab, atau memulai produksi.${rows.length >= 200 ? " Menampilkan 200 pertama." : ""}</p>`;
}
