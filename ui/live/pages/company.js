// Company Setting (res.company): identitas perusahaan yang tercetak pada dokumen dan dipakai laporan: nama, NPWP (Tax ID), alamat, kontak,
// logo, tagline, dan footer dokumen. Mata uang perusahaan dan akun dibawa oleh data akuntansi dan tidak diubah di sini.
import { INPUT, app, call, ctx, esc, fieldBlock, guarded, pageHeader, plain, readOne, readonlyValue, referenceCountries, resetReferences, toast } from "../common.js";

const KEYS = ["name", "vat", "company_registry", "street", "street2", "city", "zip", "country_id", "phone", "email", "website", "report_header", "report_footer"];
let form = null; // { values, initial, logo }

export const leave = () => {
  form = null;
};

export async function render() {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [company, countries] = await Promise.all([readOne("res.company", ctx.company.id, [...KEYS, "currency_id", "logo", "uses_default_logo", "account_fiscal_country_id"]), referenceCountries()]);
  const values = Object.fromEntries(KEYS.map((k) => [k, k === "country_id" ? (company.country_id?.[0] ?? null) : k.startsWith("report_") ? plain(company[k]) : company[k] || ""]));
  form = { values, initial: { ...values }, logo: undefined };
  const input = (key, extra = "") => `<input data-co="${key}" value="${esc(values[key])}" ${extra} class="${INPUT}">`;
  app.innerHTML =
    pageHeader("Company Setting") +
    `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama Perusahaan", input("name"))}
      ${fieldBlock("NPWP / Tax ID", `${input("vat", 'placeholder="16 digit, mis. 0123456789012345"')}<div class="text-xs text-gray-500 mt-1">Format NPWP 16 digit; Odoo memeriksa panjangnya saat disimpan.</div>`)}
      ${fieldBlock("Nomor Induk Berusaha (NIB) / Registrasi", input("company_registry"))}
      ${fieldBlock("Mata Uang Perusahaan", readonlyValue(company.currency_id?.[1]))}
      ${fieldBlock("Alamat", input("street"))}
      ${fieldBlock("Alamat (baris 2)", input("street2"))}
      ${fieldBlock("Kota", input("city"))}
      ${fieldBlock("Kode Pos", input("zip"))}
      ${fieldBlock("Negara", `<select data-co="country_id" data-kind="id" class="${INPUT}"><option value="">-</option>${countries.map((c) => `<option value="${c.id}" ${c.id === values.country_id ? "selected" : ""}>${esc(c.display_name)}</option>`).join("")}</select>`)}
      ${fieldBlock("Telepon", input("phone"))}
      ${fieldBlock("Email", input("email", 'type="email"'))}
      ${fieldBlock("Situs Web", input("website"))}
      ${fieldBlock("Tagline Dokumen", input("report_header"))}
      ${fieldBlock("Footer Dokumen", `<textarea data-co="report_footer" rows="2" class="${INPUT}">${esc(values.report_footer)}</textarea>`)}
      <div class="md:col-span-2">${fieldBlock("Logo", `<div class="mt-1 flex items-center gap-4">
        <img id="logo-preview" alt="Logo perusahaan" src="${company.logo ? `data:image/png;base64,${company.logo}` : ""}" class="h-16 max-w-48 object-contain border border-gray-200 rounded bg-white ${company.logo ? "" : "hidden"}">
        <input type="file" accept="image/png,image/jpeg,image/svg+xml" data-logo class="text-sm">
        ${company.logo && !company.uses_default_logo ? '<button type="button" data-action="logo-remove" class="text-sm text-rose-600 hover:underline">Hapus logo</button>' : ""}</div>
        <div class="text-xs text-gray-500 mt-1">Dipakai pada dokumen cetak. PNG atau JPG, maksimal 2 MB.</div>`)}</div>
    </section>
    <div class="flex gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button></div>
    <p class="mt-3 text-xs text-gray-500">Mata uang, tahun fiskal, dan kunci periode diatur di Accounting Setting.</p>`;
}

export function onInput(event, el) {
  if (!form || !el.dataset.co) return;
  form.values[el.dataset.co] = el.dataset.kind === "id" ? (el.value ? Number(el.value) : null) : el.value;
}

export function onChange(event, el) {
  if (!form || el.dataset.logo === undefined) return;
  const file = el.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    toast("Logo maksimal 2 MB.", "error");
    el.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    form.logo = String(reader.result).split(",")[1];
    const preview = document.querySelector("#logo-preview");
    preview.src = reader.result;
    preview.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "logo-remove") {
    if (!window.confirm("Hapus logo perusahaan?")) return;
    const ok = await guarded(el, () => call("res.company", "write", { ids: [ctx.company.id], vals: { logo: false } }));
    if (ok !== undefined) {
      toast("Logo dihapus.");
      render();
    }
  } else if (action === "save") {
    const ok = await guarded(el, async () => {
      const v = form.values;
      if (!String(v.name).trim()) throw new Error("Nama perusahaan wajib diisi.");
      const vals = {};
      for (const k of KEYS) {
        if (v[k] === form.initial[k]) continue;
        vals[k] = k === "country_id" ? v[k] || false : k.startsWith("report_") ? (String(v[k]).trim() ? `<p>${esc(String(v[k]).trim())}</p>` : false) : String(v[k]).trim() || false;
      }
      if (form.logo !== undefined) vals.logo = form.logo;
      if (!Object.keys(vals).length) throw new Error("Belum ada perubahan.");
      await call("res.company", "write", { ids: [ctx.company.id], vals });
      return vals.name ?? true;
    });
    if (ok) {
      if (typeof ok === "string") ctx.company = { ...ctx.company, name: ok };
      resetReferences();
      toast("Data perusahaan disimpan.");
      render();
    }
  }
}
