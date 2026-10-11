// Setting per modul (menu Setting di Purchase Request, Purchase, Inventory, Manufacture, POS, Sales, Accounting). Pengaturan dibaca dari
// res.config.settings (create lalu read memberi nilai saat ini, termasuk kolom yang terhubung ke perusahaan) dan diterapkan dengan create
// lalu execute, hanya untuk nilai yang diubah. Kunci periode akuntansi ditulis langsung ke perusahaan. Pengaturan yang memasang modul
// baru sengaja tidak ditawarkan di sini.
import { INPUT, app, call, ctx, esc, fieldBlock, guarded, pageHeader, readOne, resetReferences, toast } from "../common.js";

const MONTHS = { 1: "Januari", 2: "Februari", 3: "Maret", 4: "April", 5: "Mei", 6: "Juni", 7: "Juli", 8: "Agustus", 9: "September", 10: "Oktober", 11: "November", 12: "Desember" };
const monthOptions = Object.entries(MONTHS).map(([k, l]) => [String(k), l]);

/** kind: bool | select | number | integer. options menimpa label bawaan Odoo bila ada. */
const MODULES = {
  pr: {
    title: "Purchase Request Setting",
    intro: "Alur Purchase Request: Draft, Menunggu Persetujuan, Disetujui, Dalam Proses, Selesai. Penyetuju dan pembuat ditentukan oleh peran pengguna.",
    sections: [],
    links: [["Atur peran pengguna di Users & Access", "#/users"]],
  },
  purchase: {
    title: "Purchase Setting",
    sections: [
      {
        title: "Persetujuan dan Penguncian",
        items: [
          { key: "po_order_approval", label: "Persetujuan Purchase Order", kind: "bool", about: "Purchase Order di atas nominal tertentu harus disetujui manajer pembelian sebelum dikonfirmasi." },
          { key: "po_double_validation_amount", label: "Nominal batas persetujuan", kind: "number", about: "Pesanan dengan total lebih besar dari ini menunggu persetujuan." },
          { key: "po_lock", label: "Perubahan setelah konfirmasi", kind: "select", options: [["edit", "Boleh diubah"], ["lock", "Terkunci"]] },
        ],
      },
      {
        title: "Pengadaan",
        items: [
          { key: "days_to_purchase", label: "Hari persiapan pembelian", kind: "number", about: "Tambahan hari pada lead time pemasok saat menjadwalkan pengadaan." },
          { key: "group_send_reminder", label: "Pengingat penerimaan", kind: "bool", about: "Kirim pengingat ke pemasok sebelum tanggal penerimaan." },
          { key: "group_warning_purchase", label: "Peringatan pembelian", kind: "bool", about: "Peringatan atau blokir pada pemasok dan produk tertentu." },
          { key: "group_product_variant", label: "Varian produk", kind: "bool" },
        ],
      },
    ],
  },
  inventory: {
    title: "Inventory Setting",
    sections: [
      {
        title: "Gudang",
        items: [
          { key: "group_stock_multi_locations", label: "Storage Locations", kind: "bool", about: "Lokasi di dalam gudang dan transfer internal." },
          { key: "group_stock_adv_location", label: "Multi-Step Routes", kind: "bool", about: "Penerimaan dan pengiriman lebih dari satu langkah, serta rute khusus." },
          { key: "group_stock_tracking_lot", label: "Kemasan (packages)", kind: "bool" },
          { key: "group_stock_tracking_owner", label: "Konsinyasi (pemilik stok)", kind: "bool" },
          { key: "group_uom", label: "Satuan ukuran dan kemasan", kind: "bool" },
        ],
      },
      {
        title: "Lot, Seri, dan Kedaluwarsa",
        items: [
          { key: "group_stock_production_lot", label: "Lots & Serial Numbers", kind: "bool", about: "Melacak lot atau nomor seri produk." },
          { key: "group_lot_on_delivery_slip", label: "Tampilkan lot di surat jalan", kind: "bool" },
          { key: "group_expiry_date_on_delivery_slip", label: "Tampilkan tanggal kedaluwarsa di surat jalan", kind: "bool" },
        ],
      },
      {
        title: "Operasi",
        items: [
          { key: "group_stock_reception_report", label: "Laporan penerimaan", kind: "bool", about: "Alokasikan barang yang diterima ke pesanan yang menunggu." },
          { key: "group_stock_sign_delivery", label: "Tanda tangan pada pengiriman", kind: "bool" },
          { key: "group_warning_stock", label: "Peringatan stok", kind: "bool" },
          { key: "stock_move_email_validation", label: "Email konfirmasi pengiriman", kind: "bool" },
          { key: "annual_inventory_month", label: "Bulan stok opname tahunan", kind: "select", options: monthOptions },
          { key: "annual_inventory_day", label: "Tanggal stok opname tahunan", kind: "integer", min: 1, max: 31 },
          { key: "group_product_variant", label: "Varian produk", kind: "bool" },
        ],
      },
    ],
  },
  manufacture: {
    title: "Manufacture Setting",
    sections: [
      {
        title: "Produksi",
        items: [
          { key: "group_mrp_routings", label: "Work Orders", kind: "bool", about: "Operasi per work center pada BoM, work order, dan pelacakan waktu." },
          { key: "group_mrp_workorder_dependencies", label: "Ketergantungan work order", kind: "bool", about: "Operasi bisa menunggu operasi lain selesai." },
          { key: "group_mrp_byproducts", label: "By-Products", kind: "bool", about: "Produk sampingan pada BoM dengan porsi biaya." },
          { key: "group_unlocked_by_default", label: "MO terbuka secara bawaan", kind: "bool", about: "Manufacturing Order yang sudah dikonfirmasi tetap bisa diubah." },
          { key: "group_mrp_reception_report", label: "Laporan alokasi MO", kind: "bool" },
        ],
      },
    ],
  },
  sales: {
    title: "Sales Setting",
    sections: [
      {
        title: "Penawaran dan Pesanan",
        items: [
          { key: "group_discount_per_so_line", label: "Diskon per baris", kind: "bool" },
          { key: "group_product_pricelist", label: "Daftar harga", kind: "bool", about: "Harga jual per pelanggan lewat Pricelist Master." },
          { key: "group_sale_order_template", label: "Templat quotation", kind: "bool" },
          { key: "group_proforma_sales", label: "Faktur pro forma", kind: "bool" },
          { key: "group_sale_delivery_address", label: "Alamat pengiriman pelanggan", kind: "bool" },
          { key: "group_warning_sale", label: "Peringatan penjualan", kind: "bool" },
          { key: "group_auto_done_setting", label: "Kunci Sales Order yang dikonfirmasi", kind: "bool" },
          { key: "quotation_validity_days", label: "Masa berlaku quotation (hari)", kind: "integer", min: 0 },
        ],
      },
      {
        title: "Penagihan",
        items: [
          { key: "default_invoice_policy", label: "Kebijakan penagihan bawaan", kind: "select", options: [["order", "Sesuai jumlah dipesan"], ["delivery", "Sesuai jumlah dikirim"]] },
          { key: "automatic_invoice", label: "Faktur otomatis setelah pembayaran online", kind: "bool" },
          { key: "account_use_credit_limit", label: "Batas kredit pelanggan", kind: "bool", about: "Peringatan saat pesanan melewati batas kredit pelanggan." },
        ],
      },
    ],
  },
  accounting: {
    title: "Accounting Setting",
    sections: [
      {
        title: "Akuntansi",
        items: [
          { key: "group_analytic_accounting", label: "Analytic Accounting", kind: "bool", about: "Distribusi analitik pada baris faktur, tagihan, dan jurnal." },
          { key: "group_multi_currency", label: "Multi-mata uang", kind: "bool" },
          { key: "group_cash_rounding", label: "Pembulatan kas", kind: "bool" },
          { key: "autopost_bills", label: "Posting otomatis tagihan vendor", kind: "bool", about: "Tagihan dari vendor yang sudah dikenal diposting otomatis." },
          { key: "restrictive_audit_trail", label: "Audit trail terbatas", kind: "bool", about: "Jurnal terposting tidak bisa dihapus dan perubahannya tercatat." },
          { key: "fiscalyear_last_month", label: "Bulan akhir tahun fiskal", kind: "select", options: monthOptions },
          { key: "fiscalyear_last_day", label: "Tanggal akhir tahun fiskal", kind: "integer", min: 1, max: 31 },
        ],
      },
      {
        title: "Pajak",
        items: [
          { key: "tax_calculation_rounding_method", label: "Pembulatan pajak", kind: "select", options: [["round_per_line", "Bulatkan per baris"], ["round_globally", "Bulatkan total"]] },
          { key: "account_price_include", label: "Harga jual bawaan", kind: "select", options: [["tax_excluded", "Belum termasuk pajak"], ["tax_included", "Termasuk pajak"]] },
          { key: "tax_exigibility", label: "Pajak basis kas", kind: "bool" },
        ],
      },
    ],
    lockDates: true,
  },
  pos: {
    title: "POS Setting",
    intro: "Pengaturan kasir dibuat per stasiun: metode pembayaran, kontrol kas, dan daftar harga ada di form POS Station. Produk yang dijual di kasir ditandai pada Product Master.",
    sections: [{ title: "Umum", items: [{ key: "group_product_pricelist", label: "Daftar harga", kind: "bool", about: "Dipakai juga oleh Sales Order; atur aturannya di Pricelist Master." }] }],
    links: [["Buka POS Station", "#/posconfig"]],
  },
};

const LOCK_FIELDS = [
  ["fiscalyear_lock_date", "Kunci semua pengguna", "Tidak ada yang bisa memposting atau mengubah jurnal sampai tanggal ini, kecuali Advisor."],
  ["tax_lock_date", "Kunci pajak", "Jurnal yang memengaruhi pajak tidak bisa diubah sampai tanggal ini (setelah SPT dilaporkan)."],
  ["sale_lock_date", "Kunci penjualan", "Faktur pelanggan dan nota kredit tidak bisa diubah sampai tanggal ini."],
  ["purchase_lock_date", "Kunci pembelian", "Tagihan vendor dan nota debit tidak bisa diubah sampai tanggal ini."],
  ["hard_lock_date", "Kunci permanen", "Tidak bisa dibatalkan atau dimajukan mundur oleh siapa pun, termasuk Advisor."],
];

let state = null; // { key, values, initial, meta, lock, lockInitial }
let last = { sub: "purchase", query: new URLSearchParams() };
export const leave = () => {
  state = null;
};

const optionsOf = (item, meta) => item.options ?? (meta[item.key]?.selection ?? []);

export async function render(sub, query) {
  const key = MODULES[sub] ? sub : "purchase";
  last = { sub: key, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat pengaturan...</p>';
  const def = MODULES[key];
  const keys = def.sections.flatMap((s) => s.items.map((i) => i.key));
  const meta = keys.length ? await call("res.config.settings", "fields_get", { allfields: keys, attributes: ["type", "string", "selection", "readonly"] }) : {};
  let values = {};
  if (keys.length) {
    const [id] = await call("res.config.settings", "create", { vals_list: [{}] });
    [values] = await call("res.config.settings", "read", { ids: [id], fields: Object.keys(meta) });
    delete values.id;
  }
  let lock = null;
  if (def.lockDates) {
    const company = await readOne("res.company", ctx.company.id, LOCK_FIELDS.map(([k]) => k));
    lock = Object.fromEntries(LOCK_FIELDS.map(([k]) => [k, company[k] || ""]));
  }
  state = { key, values: { ...values }, initial: { ...values }, meta, lock, lockInitial: lock ? { ...lock } : null };
  const control = (item) => {
    if (!meta[item.key] || meta[item.key].readonly) return "";
    const v = state.values[item.key];
    const data = `data-set="${esc(item.key)}"`;
    if (item.kind === "bool") return `<label class="flex items-start gap-3 text-sm"><input type="checkbox" ${data} ${v ? "checked" : ""} class="mt-1 rounded border-gray-300 text-indigo-600"><span><span class="font-medium text-gray-900">${esc(item.label)}</span>${item.about ? `<span class="block text-gray-500">${esc(item.about)}</span>` : ""}</span></label>`;
    if (item.kind === "select") return fieldBlock(item.label, `<select ${data} class="${INPUT}">${optionsOf(item, meta).map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>${item.about ? `<div class="text-xs text-gray-500 mt-1">${esc(item.about)}</div>` : ""}`);
    return fieldBlock(item.label, `<input type="number" ${item.min !== undefined ? `min="${item.min}"` : ""} ${item.max !== undefined ? `max="${item.max}"` : ""} step="${item.kind === "integer" ? 1 : "any"}" ${data} data-kind="${item.kind}" value="${esc(v)}" class="${INPUT} text-right">${item.about ? `<div class="text-xs text-gray-500 mt-1">${esc(item.about)}</div>` : ""}`);
  };
  const sections = def.sections
    .map((s) => {
      const body = s.items.map(control).filter(Boolean).join("");
      return body ? `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-4"><div class="text-sm font-semibold mb-3">${esc(s.title)}</div><div class="grid md:grid-cols-2 gap-x-8 gap-y-4">${body}</div></section>` : "";
    })
    .join("");
  const lockHtml = lock
    ? `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-4"><div class="text-sm font-semibold mb-1">Kunci Periode</div>
        <p class="text-xs text-gray-500 mb-3">Mencegah perubahan pada periode yang sudah ditutup. Kosongkan tanggal untuk membuka kunci (tidak berlaku untuk kunci permanen).</p>
        <div class="grid md:grid-cols-2 gap-x-8 gap-y-4">${LOCK_FIELDS.map(([k, label, about]) => fieldBlock(label, `<input type="date" data-lock="${k}" value="${esc(lock[k])}" ${k === "hard_lock_date" && lock[k] ? "disabled" : ""} class="${INPUT}"><div class="text-xs text-gray-500 mt-1">${esc(about)}</div>`)).join("")}</div></section>`
    : "";
  const links = (def.links ?? []).map(([label, href]) => `<a href="${esc(href)}" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">${esc(label)}</a>`).join("");
  app.innerHTML =
    pageHeader(def.title, links) +
    (def.intro ? `<p class="mb-4 text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3">${esc(def.intro)}</p>` : "") +
    sections + lockHtml +
    (keys.length || lock ? '<div class="mt-2"><button data-action="apply" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan Pengaturan</button></div>' : "") +
    '<p class="mt-3 text-xs text-gray-500">Pengaturan berlaku untuk seluruh perusahaan. Fitur yang diaktifkan menambah menu dan kolom terkait di modulnya.</p>';
}

export function onInput(event, el) {
  if (!state) return;
  if (el.dataset.set) {
    const key = el.dataset.set;
    state.values[key] = el.type === "checkbox" ? el.checked : el.dataset.kind === "number" ? Number(el.value) : el.dataset.kind === "integer" ? Math.trunc(Number(el.value)) : el.value;
  } else if (el.dataset.lock) state.lock[el.dataset.lock] = el.value;
}

export async function onClick(event, el) {
  if (el.dataset.action !== "apply" || !state) return;
  const ok = await guarded(el, async () => {
    const changed = {};
    for (const [k, v] of Object.entries(state.values)) if (v !== state.initial[k] && state.meta[k] && !state.meta[k].readonly) changed[k] = v;
    for (const item of MODULES[state.key].sections.flatMap((s) => s.items)) {
      if (item.kind === "integer" && item.key in changed) {
        const n = changed[item.key];
        if (!Number.isInteger(n) || (item.min !== undefined && n < item.min) || (item.max !== undefined && n > item.max)) throw new Error(`${item.label}: isi bilangan bulat${item.min !== undefined ? ` antara ${item.min} dan ${item.max ?? "tak terbatas"}` : ""}.`);
      }
    }
    const lockChanges = {};
    if (state.lock) {
      for (const [k] of LOCK_FIELDS) if (state.lock[k] !== state.lockInitial[k]) lockChanges[k] = state.lock[k] || false;
      if (lockChanges.hard_lock_date && !window.confirm("Kunci permanen tidak bisa dibatalkan atau dimundurkan oleh siapa pun. Lanjutkan?")) return false;
      if (lockChanges.hard_lock_date === false) throw new Error("Kunci permanen tidak bisa dibuka.");
    }
    if (!Object.keys(changed).length && !Object.keys(lockChanges).length) throw new Error("Belum ada perubahan.");
    if (Object.keys(changed).length) {
      const [id] = await call("res.config.settings", "create", { vals_list: [changed] });
      await call("res.config.settings", "execute", { ids: [id] });
    }
    if (Object.keys(lockChanges).length) await call("res.company", "write", { ids: [ctx.company.id], vals: lockChanges });
    return true;
  });
  if (ok) {
    resetReferences();
    toast("Pengaturan disimpan.");
    render(last.sub, last.query);
  }
}
