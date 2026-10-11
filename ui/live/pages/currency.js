// Currencies (res.currency): mata uang dan kurs. Kurs dicatat per tanggal sebagai nilai 1 unit mata uang dalam mata uang perusahaan
// (mis. 1 USD = 16.000 IDR). Faktur dan jurnal dalam mata uang asing memakai kurs terakhir pada atau sebelum tanggal dokumen.
import { INPUT, call, ctx, esc, guarded, resetReferences, searchRead, toast, today } from "../common.js";
import { createMasterPage } from "./masters.js";

const POSITION = { after: "Setelah angka (100 Rp)", before: "Sebelum angka (Rp 100)" };
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 6 });

let rates = []; // { id, date, value, initial }
let currencyId = null;

const ratesSection = () =>
  `<section id="rates" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto"><div class="text-sm font-semibold mb-2">Kurs terhadap ${esc(ctx.company?.currency_id?.[1] ?? "mata uang perusahaan")}</div>
    <table class="w-full text-left"><thead><tr>${["Tanggal", "1 unit sama dengan", ""].map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${i === 1 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
    <tbody>${rates
      .map(
        (r, i) => `<tr><td class="py-1 px-2 w-48"><input type="date" data-rate="${i}" data-f="date" value="${esc(r.date)}" class="${INPUT}" aria-label="Tanggal kurs"></td>
          <td class="py-1 px-2"><input type="number" min="0" step="any" data-rate="${i}" data-f="value" value="${esc(r.value)}" class="${INPUT} text-right" aria-label="Nilai kurs"></td>
          <td class="py-1 px-2 w-10 text-center"><button type="button" data-action="rate-remove" data-i="${i}" class="text-gray-400 hover:text-rose-600" aria-label="Hapus kurs"><i class="fas fa-trash-alt"></i></button></td></tr>`,
      )
      .join("") || '<tr><td colspan="3" class="py-4 text-center text-sm text-gray-500">Belum ada kurs.</td></tr>'}</tbody></table>
    <div class="mt-2 flex gap-2"><button type="button" data-action="rate-add" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-plus mr-1"></i>Tambah kurs</button>
      <button type="button" data-action="rate-save" class="px-3 py-1 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">Simpan Kurs</button></div></section>`;

const page = createMasterPage({
  route: "currency", title: "Currencies", noun: "Mata Uang", model: "res.currency", newLabel: "Mata Uang Baru", order: "name", archive: true,
  empty: "Belum ada mata uang yang cocok.",
  listFields: ["name", "full_name", "symbol", "inverse_rate", "active"],
  columns: [
    { label: "Kode", value: (r) => r.name },
    { label: "Nama", value: (r) => r.full_name || "-" },
    { label: "Simbol", value: (r) => r.symbol },
    { label: "Kurs Terakhir", value: (r) => (r.inverse_rate ? nf.format(r.inverse_rate) : "-"), right: true },
  ],
  search: ["name", "full_name"],
  listNote: "Mata uang nonaktif muncul di filter Diarsipkan. Aktifkan mata uang asing sebelum dipakai pada faktur, lalu isi kursnya.",
  fields: [
    { key: "name", label: "Kode (3 huruf)", type: "text", required: true, maxlength: 3 },
    { key: "full_name", label: "Nama Lengkap", type: "text" },
    { key: "symbol", label: "Simbol", type: "text", required: true },
    { key: "position", label: "Posisi Simbol", type: "select", options: Object.entries(POSITION) },
    { key: "rounding", label: "Pembulatan", type: "number", min: 0, step: "any", hint: "mis. 0,01 untuk dua desimal, 1 tanpa desimal." },
  ],
  newValues: () => ({ position: "before", rounding: 0.01 }),
  readFields: ["rate_ids", "is_current_company_currency"],
  tiles: (r) => [{ count: r.is_current_company_currency ? 1 : 0, label: "Mata uang perusahaan", icon: "fa-building" }],
  extra: async (record) => {
    currencyId = record.id;
    if (record.is_current_company_currency) return "";
    const rows = record.rate_ids.length ? await searchRead("res.currency.rate", [["id", "in", record.rate_ids]], ["name", "inverse_company_rate"], { order: "name desc", limit: 100 }) : [];
    rates = rows.map((r) => {
      const value = Math.round(r.inverse_company_rate * 1e6) / 1e6; // Odoo menghitung dari kebalikan kurs: buang derau pecahan
      return { id: r.id, date: r.name, value, initial: { date: r.name, value } };
    });
    return ratesSection();
  },
  onSaved: resetReferences,
  onInputExtra: (event, el) => {
    if (el.dataset.rate === undefined) return false;
    rates[Number(el.dataset.rate)][el.dataset.f] = el.value;
    return true;
  },
  onAction: async (action, el, { reload }) => {
    if (action === "rate-add") {
      rates.unshift({ id: null, date: today(), value: "", initial: null });
      document.querySelector("#rates").outerHTML = ratesSection();
    } else if (action === "rate-remove") {
      const [removed] = rates.splice(Number(el.dataset.i), 1);
      if (removed?.id && !window.confirm("Hapus kurs ini?")) {
        rates.splice(Number(el.dataset.i), 0, removed);
        return;
      }
      if (removed?.id) await guarded(null, () => call("res.currency.rate", "unlink", { ids: [removed.id] }));
      document.querySelector("#rates").outerHTML = ratesSection();
    } else if (action === "rate-save") {
      const ok = await guarded(el, async () => {
        for (const r of rates) {
          if (!r.date) throw new Error("Isi tanggal setiap kurs.");
          if (!(Number(r.value) > 0)) throw new Error("Nilai kurs harus lebih dari 0.");
        }
        if (new Set(rates.map((r) => r.date)).size !== rates.length) throw new Error("Satu tanggal hanya boleh punya satu kurs.");
        for (const r of rates) {
          if (!r.id) await call("res.currency.rate", "create", { vals_list: [{ name: r.date, inverse_company_rate: Number(r.value), currency_id: currencyId }] });
          else if (r.date !== r.initial.date || Number(r.value) !== r.initial.value) await call("res.currency.rate", "write", { ids: [r.id], vals: { name: r.date, inverse_company_rate: Number(r.value) } });
        }
        return true;
      });
      if (ok) {
        resetReferences();
        toast("Kurs disimpan.");
        reload();
      }
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
