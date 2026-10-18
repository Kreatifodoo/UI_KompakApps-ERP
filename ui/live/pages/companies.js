// Perusahaan (res.company): daftar semua perusahaan yang boleh diakses pengguna, pembuatan perusahaan baru (nama, NPWP, alamat) dengan setup Indonesia
// otomatis (mata uang IDR, COA l10n_id, pajak PPN, valuasi perpetual), penerapan setup Indonesia pada perusahaan yang belum punya COA, dan ganti perusahaan
// aktif. Identitas lengkap (logo, tagline, footer dokumen) diedit di Company Setting setelah perusahaan itu diaktifkan. Pemilih perusahaan di header
// dan hak perusahaan per pengguna (Users & Access) memakai data yang sama (D62).
import { activeCompany, call, ctx, esc, guarded, loadSession, referenceCountries, renderSession, resetReferences, searchRead, toast } from "../common.js";
import { createMasterPage } from "./masters.js";

const coaText = (r) => (r.chart_template === "id" ? "Indonesia" : r.chart_template || "Belum disiapkan");

/** Perusahaan baru sudah tertaut ke pengguna pembuatnya; konteks menunjuk perusahaan itu agar urutan dan default mengikutinya. */
const companyContext = (id) => ({ allowed_company_ids: [id, ...activeCompany.allowed.filter((x) => x !== id)] });

/** COA Indonesia, pajak, dan valuasi, lalu gudang utama (Odoo hanya membuat gudang otomatis untuk perusahaan pertama). */
async function setupIndonesia(id) {
  await call("res.company", "kompakapps_setup_indonesia", { ids: [id], context: companyContext(id) });
  await call("res.company", "kompakapps_setup_warehouse", { ids: [id], context: companyContext(id) });
}

const page = createMasterPage({
  route: "companies", title: "Perusahaan", noun: "Perusahaan", model: "res.company", newLabel: "Perusahaan Baru", order: "name", chatter: false,
  empty: "Belum ada perusahaan.",
  listFields: ["name", "vat", "city", "currency_id", "chart_template"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "NPWP", value: (r) => r.vat || "" },
    { label: "Kota", value: (r) => r.city || "" },
    { label: "Mata Uang", value: (r) => r.currency_id?.[1] ?? "" },
    { label: "COA", value: (r) => coaText(r) },
    { label: "Status", value: (r) => (r.id === ctx.company.id ? "Perusahaan aktif" : "") },
  ],
  search: ["name", "vat"],
  fields: [
    { key: "name", label: "Nama Perusahaan", type: "text", required: true },
    { key: "vat", label: "NPWP / Tax ID", type: "text", placeholder: "16 digit, mis. 0123456789012345" },
    { key: "street", label: "Alamat", type: "text" },
    { key: "city", label: "Kota", type: "text" },
    { key: "zip", label: "Kode Pos", type: "text" },
    { key: "country_id", label: "Negara", type: "m2o", optionsOf: (refs) => refs.countries ?? [] },
    {
      key: "setup_id", label: "Setup Indonesia", type: "check", virtual: true, show: (v, record) => !record,
      checkLabel: "Terapkan setup Indonesia: mata uang IDR, COA Indonesia, pajak PPN, dan valuasi persediaan perpetual",
    },
  ],
  loadRefs: async () => ({ countries: await referenceCountries() }),
  readFields: ["chart_template", "currency_id"],
  newValues: () => ({ setup_id: true }),
  afterSave: async (id, v, isNew) => {
    if (isNew && v.setup_id) await setupIndonesia(id);
  },
  onSaved: async () => {
    resetReferences();
    await loadSession(); // perusahaan baru langsung muncul di pemilih header
    renderSession();
  },
  extra: async (record) => {
    const active = record.id === ctx.company.id;
    const needsSetup = record.chart_template !== "id";
    const warehouses = await searchRead("stock.warehouse", [["company_id", "=", record.id]], ["display_name"], { context: { active_test: false, ...companyContext(record.id) } });
    return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4">
      <div class="text-sm font-semibold mb-2">Status perusahaan</div>
      <ul class="text-sm text-gray-700 space-y-1 mb-3">
        <li>Mata uang: <b>${esc(record.currency_id?.[1] ?? "-")}</b></li>
        <li>COA: <b>${esc(coaText(record))}</b>${needsSetup ? " (belum ada akun, jurnal, dan pajak)" : ""}</li>
        <li>Gudang: <b>${warehouses.length ? esc(warehouses.map((w) => w.display_name).join(", ")) : "belum ada"}</b>${warehouses.length ? "" : " (belum bisa menerima atau mengirim barang)"}</li>
        <li>${active ? "Perusahaan ini sedang <b>aktif</b>: dokumen dan laporan yang Anda buka memakai perusahaan ini." : "Perusahaan ini belum aktif di tampilan Anda."}</li>
      </ul>
      <div class="flex flex-wrap gap-2">
        ${active ? '<a href="#/company" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Edit identitas dan logo (Company Setting)</a>'
          : `<button type="button" data-action="company-switch" data-id="${record.id}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Pakai perusahaan ini</button>`}
        ${needsSetup ? `<button type="button" data-action="company-setup" data-id="${record.id}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Terapkan setup Indonesia</button>` : ""}
        ${warehouses.length ? "" : `<button type="button" data-action="company-warehouse" data-id="${record.id}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buat gudang utama</button>`}
      </div>
      <p class="text-xs text-gray-500 mt-3">Setup Indonesia ditolak bila perusahaan sudah punya transaksi akuntansi, karena memuat COA baru menghapus COA lama. Hak pengguna atas perusahaan diatur di Users &amp; Access.</p>
    </section>`;
  },
  onAction: async (action, el, { reload }) => {
    const id = Number(el.dataset.id);
    if (action === "company-switch") {
      activeCompany.set(id);
      location.hash = "#/companies";
      location.reload();
    } else if (action === "company-warehouse") {
      const ok = await guarded(el, () => call("res.company", "kompakapps_setup_warehouse", { ids: [id], context: companyContext(id) }));
      if (ok !== undefined) {
        toast("Gudang utama dibuat.");
        resetReferences();
        reload();
      }
    } else if (action === "company-setup") {
      if (!window.confirm("Terapkan setup Indonesia (mata uang IDR, COA, pajak, valuasi) pada perusahaan ini? Proses ini bisa memakan waktu satu menit.")) return;
      const ok = await guarded(el, () => setupIndonesia(id));
      if (ok !== undefined) {
        toast("Setup Indonesia selesai.");
        resetReferences();
        reload();
      }
    }
  },
  formNote: "Perusahaan baru otomatis ditambahkan ke akses Anda dan mendapat gudang utama. Pindah perusahaan lewat pemilih di pojok kanan atas; setiap perusahaan punya COA, pajak, gudang, dan nomor dokumennya sendiri, sedangkan mitra dan produk dipakai bersama.",
});

export const render = (sub, query) => {
  activeCompany.scope = "all"; // daftar ini harus memperlihatkan semua perusahaan yang diizinkan, bukan hanya yang aktif
  return page.render(sub, query);
};
export const leave = () => {
  activeCompany.scope = "one";
  page.leave();
};
export const { onClick, onInput, onChange } = page;
