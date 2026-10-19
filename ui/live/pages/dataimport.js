// Impor Data (CSV, Excel .xlsx dan .xls, LibreOffice .ods): memasukkan data master dan saldo awal dari berkas lewat mesin impor bawaan Odoo (model base_import.import).
// Alurnya sama dengan impor Odoo: baca berkas dan petakan kolom (parse_preview), uji tanpa menyimpan (execute_import dengan dryrun),
// lalu impor sungguhan. Uji tanpa simpan dan impor memakai pemetaan yang sama, dan galat apa pun membatalkan seluruh impor.
// CSV dikirim sebagai teks UTF-8. Excel (.xlsx) dikirim sebagai base64 lewat kompakapps_create_from_file (addons/kompakapps_base/models/base_import.py)
// karena JSON-2 tidak membawa byte mentah; pembacaan lembar, angka, dan tanggal dikerjakan pembaca xlsx Odoo (openpyxl), D36.
import { INPUT, app, call, esc, guarded, pageHeader, toast } from "../common.js";
import { buildXlsx } from "../xlsx.js";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_XLSX_BYTES = 3 * 1024 * 1024; // base64 menambah sepertiga dan nginx membatasi badan permintaan 5 MB
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// Excel lama (.xls) dan LibreOffice (.ods) dibaca server oleh pembaca bawaan Odoo (xlrd dan odfpy) lewat kompakapps_create_from_file seperti .xlsx (D74)
const EXCEL_TYPES = { xlsx: XLSX_TYPE, xls: "application/vnd.ms-excel", ods: "application/vnd.oasis.opendocument.spreadsheet" };
const excelExt = (name) => String(name ?? "").match(/\.(xlsx|xls|ods)$/i)?.[1].toLowerCase() ?? "";

/** f = nama field Odoo (judul kolom CSV), req = wajib, ex = isi contoh pada baris-baris template. */
export const TARGETS = {
  product: {
    title: "Produk",
    model: "product.template",
    link: "#/product",
    about: "Barang dan jasa yang dijual atau dibeli.",
    columns: [
      { f: "name", label: "Nama produk", req: true },
      { f: "default_code", label: "Kode produk (SKU)" },
      { f: "barcode", label: "Barcode" },
      { f: "categ_id", label: "Kategori (nama kategori yang sudah ada)" },
      { f: "type", label: "Jenis: consu (barang) atau service (jasa)" },
      { f: "is_storable", label: "Stok dilacak: 1 atau 0 (hanya untuk barang)" },
      { f: "list_price", label: "Harga jual" },
      { f: "standard_price", label: "Harga pokok" },
      { f: "uom_id", label: "Satuan (nama satuan yang sudah ada)" },
      { f: "sale_ok", label: "Bisa dijual: 1 atau 0" },
      { f: "purchase_ok", label: "Bisa dibeli: 1 atau 0" },
    ],
    rows: [
      ["Kopi Arabika 250 g", "KOPI-250", "8991234500011", "Goods", "consu", "1", "65000", "42000", "Units", "1", "1"],
      ["Jasa Pengiriman", "JASA-KIRIM", "", "Goods", "service", "0", "15000", "0", "Units", "1", "0"],
    ],
    notes: ["Mengimpor berkas yang sama dua kali membuat produk ganda. Untuk memperbarui produk yang sudah ada, tambahkan kolom id berisi ID eksternal."],
  },
  partner: {
    title: "Pelanggan dan Pemasok",
    model: "res.partner",
    link: "#/customer",
    about: "Kontak pelanggan dan pemasok beserta alamatnya.",
    columns: [
      { f: "name", label: "Nama", req: true },
      { f: "is_company", label: "Perusahaan: 1 atau 0" },
      { f: "vat", label: "NPWP (16 digit)" },
      { f: "phone", label: "Telepon" },
      { f: "email", label: "Email" },
      { f: "street", label: "Alamat" },
      { f: "city", label: "Kota" },
      { f: "zip", label: "Kode pos" },
      { f: "country_id", label: "Negara" },
      { f: "customer_rank", label: "Pelanggan: 1 bila pelanggan" },
      { f: "supplier_rank", label: "Pemasok: 1 bila pemasok" },
    ],
    rows: [
      ["PT Sumber Rasa", "1", "", "0215550101", "pembelian@sumberrasa.example", "Jl. Industri No. 8", "Bekasi", "17530", "Indonesia", "1", "0"],
      ["CV Tani Makmur", "1", "", "0227771234", "sales@tanimakmur.example", "Jl. Raya Lembang 45", "Bandung", "40391", "Indonesia", "0", "1"],
    ],
    notes: ["NPWP diperiksa Odoo saat impor; kosongkan bila belum ada."],
  },
  category: {
    title: "Kategori Produk",
    model: "product.category",
    link: "#/category",
    about: "Pohon kategori produk, termasuk akun dan metode valuasi bawaan Odoo.",
    columns: [
      { f: "name", label: "Nama kategori", req: true },
      { f: "parent_id", label: "Kategori induk (nama yang sudah ada)" },
    ],
    rows: [["Minuman", "Goods"], ["Bahan Baku", "Goods"]],
    notes: [],
  },
  supplierinfo: {
    title: "Harga Vendor",
    model: "product.supplierinfo",
    link: "#/pricelist",
    about: "Harga beli per pemasok dan produk; dipakai saat membuat RFQ dan PO.",
    columns: [
      { f: "partner_id", label: "Pemasok (nama yang sudah ada)", req: true },
      { f: "product_tmpl_id", label: "Produk (nama yang sudah ada)" },
      { f: "min_qty", label: "Jumlah minimum" },
      { f: "price", label: "Harga satuan" },
      { f: "delay", label: "Lead time (hari)" },
    ],
    rows: [["CV Tani Makmur", "Kopi Arabika 250 g", "10", "42000", "3"]],
    notes: ["Pemasok dan produk harus sudah ada; impor Pelanggan dan Pemasok serta Produk lebih dulu."],
  },
  account: {
    title: "Chart of Account",
    model: "account.account",
    link: "#/account",
    about: "Akun-akun tambahan pada bagan akun.",
    columns: [
      { f: "code", label: "Kode akun", req: true },
      { f: "name", label: "Nama akun", req: true },
      { f: "account_type", label: "Jenis akun (nilai teknis, lihat catatan)", req: true },
      { f: "kompakapps_report_group", label: "Pos Laporan (opsional; kosongkan agar terisi otomatis)" },
    ],
    rows: [["61101099", "Beban Lain-lain", "expense", ""], ["11210099", "Piutang Karyawan", "asset_current", "Neraca: Piutang Usaha"]],
    notes: [
      "Pos Laporan menentukan baris Laba Rugi, Neraca, dan Arus Kas tempat akun muncul. Tulis labelnya persis seperti di Chart of Account (mis. Laba Rugi: Penjualan, Neraca: Persediaan, atau Tidak dilaporkan); kosongkan agar terisi otomatis menurut kode dan jenis akun.",
      "Jenis akun: asset_receivable, asset_cash, asset_current, asset_non_current, asset_prepayments, asset_fixed, liability_payable, liability_current, liability_non_current, equity, income, income_other, expense, expense_depreciation, expense_direct_cost.",
    ],
  },
  stock: {
    title: "Stok Awal",
    model: "stock.quant",
    link: "#/stock",
    about: "Jumlah stok awal per produk dan lokasi. Setelah impor, stok langsung diterapkan.",
    columns: [
      { f: "product_id", label: "Produk (kode atau nama yang sudah ada)", req: true },
      { f: "location_id", label: "Lokasi (mis. WH/Stock)", req: true },
      { f: "inventory_quantity", label: "Jumlah stok awal", req: true },
    ],
    rows: [["KOPI-250", "WH/Stock", "120"]],
    context: { inventory_mode: true },
    after: (ids) => call("stock.quant", "action_apply_inventory", { ids }),
    notes: [
      "Produk harus berjenis barang dengan stok dilacak. Stok diterapkan sebagai penyesuaian persediaan dan jurnal valuasinya mengikuti harga pokok produk.",
      "Gunakan hanya untuk saldo awal; untuk koreksi rutin pakai menu Physical Count.",
    ],
  },
  journal: {
    title: "Jurnal Saldo Awal",
    model: "account.move",
    link: "#/journal",
    expand: ["line_ids"],
    about: "Jurnal umum dengan banyak baris (mis. saldo awal akuntansi). Jurnal masuk sebagai Draft untuk diperiksa lalu diposting.",
    columns: [
      { f: "ref", label: "Referensi jurnal (isi pada baris pertama jurnal)" },
      { f: "date", label: "Tanggal (YYYY-MM-DD)", req: true },
      { f: "journal_id", label: "Jurnal (nama jurnal yang sudah ada)", req: true },
      { f: "line_ids/account_id", label: "Kode atau nama akun", req: true },
      { f: "line_ids/name", label: "Keterangan baris" },
      { f: "line_ids/partner_id", label: "Mitra (opsional)" },
      { f: "line_ids/debit", label: "Debit" },
      { f: "line_ids/credit", label: "Kredit" },
    ],
    rows: [
      ["Saldo awal 1 Jan 2026", "2026-01-01", "Miscellaneous Operations", "11110001", "Kas", "", "5000000", "0"],
      ["", "", "", "31100020", "Modal disetor", "", "0", "5000000"],
    ],
    notes: [
      "Satu jurnal terdiri atas beberapa baris: kolom jurnal (referensi, tanggal, jurnal) hanya diisi pada baris pertama, baris berikutnya dikosongkan.",
      "Jumlah debit dan kredit tiap jurnal harus sama; jurnal yang tidak seimbang ditolak saat uji impor.",
    ],
  },
  bom: {
    title: "Bill of Material",
    model: "mrp.bom",
    link: "#/bom",
    expand: ["bom_line_ids"],
    about: "Resep produksi: produk jadi dan komponennya, banyak baris per BoM.",
    columns: [
      { f: "product_tmpl_id", label: "Produk jadi (nama yang sudah ada)", req: true },
      { f: "product_qty", label: "Jumlah yang dihasilkan" },
      { f: "type", label: "Jenis BoM: normal atau phantom" },
      { f: "bom_line_ids/product_id", label: "Komponen (nama yang sudah ada)", req: true },
      { f: "bom_line_ids/product_qty", label: "Jumlah komponen" },
    ],
    rows: [
      ["Kopi Arabika 250 g", "1", "normal", "Biji Kopi Hijau", "0.3"],
      ["", "", "", "Kemasan 250 g", "1"],
    ],
    notes: ["Kolom produk jadi hanya diisi pada baris pertama tiap BoM; baris berikutnya hanya berisi komponen. Produk dan komponen harus sudah ada."],
  },
};

const SEPARATORS = [["auto", "Otomatis"], [",", "Koma ( , )"], [";", "Titik koma ( ; )"], ["\t", "Tab"]];
const ENCODINGS = [["utf-8", "UTF-8 (disarankan)"], ["windows-1252", "Windows-1252 (Excel lama)"]];
const NUMBERS = [["auto", "Otomatis"], ["us", "1,234.56 (koma ribuan, titik desimal)"], ["id", "1.234,56 (titik ribuan, koma desimal)"]];
const DATES = [["", "Otomatis (YYYY-MM-DD atau format bahasa pengguna)"], ["%Y-%m-%d", "YYYY-MM-DD"], ["%d/%m/%Y", "DD/MM/YYYY"], ["%d-%m-%Y", "DD-MM-YYYY"], ["%m/%d/%Y", "MM/DD/YYYY"]];

const fresh = (key = "product") => ({
  key,
  bytes: null,
  fileName: "",
  size: 0,
  sep: "auto",
  enc: "utf-8",
  num: "auto",
  date: "",
  sheets: [], // lembar Excel: daftar nama dan yang dipilih
  sheet: "",
  importId: null,
  options: null,
  preview: null, // { headers, samples, rows, fields }
  map: [],
  dry: null, // { ok, count, messages }
  done: null, // { count, note }
});
let st = null;

export const leave = () => {
  st = null;
};

export async function render() {
  st = st || fresh();
  draw();
}

/* ---------- Pembantu ---------- */

const csvCell = (v) => (/[",\n\r]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function templateCsv(target) {
  const lines = [target.columns.map((c) => c.f), ...target.rows].map((row) => row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** Template Excel: lembar "Data" (judul kolom dan contoh, yang dibaca saat impor) dan lembar "Petunjuk" (arti tiap kolom). */
export function templateXlsx(target) {
  return buildXlsx([
    { name: "Data", rows: [target.columns.map((c) => c.f), ...target.rows], widths: target.columns.map((c) => Math.max(14, c.f.length + 4)) },
    { name: "Petunjuk", rows: [["Judul kolom", "Isi", "Status"], ...target.columns.map((c) => [c.f, c.label, c.req ? "Wajib" : "Opsional"])], widths: [24, 60, 10] },
  ]);
}

function downloadTemplate(target, kind = "csv") {
  const blob = kind === "xlsx" ? new Blob([templateXlsx(target)], { type: XLSX_TYPE }) : new Blob([templateCsv(target)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: `template-impor-${st.key}.${kind}` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const isExcel = () => Boolean(excelExt(st.fileName));

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function decodeText() {
  const text = new TextDecoder(st.enc).decode(st.bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function detectSeparator(text) {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t"].map((s) => [s, first.split(s).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] ? counts[0][0] : ",";
}

function buildOptions(separator, sheet = "") {
  const options = { quoting: '"', separator, encoding: "utf-8", has_headers: true, date_format: st.date, datetime_format: st.date ? `${st.date} %H:%M:%S` : "" };
  if (sheet) options.sheet = sheet;
  if (isExcel()) return options; // angka dan tanggal sel Excel dibaca apa adanya oleh Odoo; format angka CSV tidak berlaku
  if (st.num === "us") Object.assign(options, { float_thousand_separator: ",", float_decimal_separator: "." });
  if (st.num === "id") Object.assign(options, { float_thousand_separator: ".", float_decimal_separator: "," });
  return options;
}

/** Daftar field yang bisa dipetakan: field biasa dan relasi (dicocokkan lewat nama), serta kolom anak untuk baris detail yang dibuka (expand). */
function flattenFields(nodes, expand, prefix = [], labels = []) {
  const out = [];
  for (const node of nodes) {
    if (node.name === ".id") continue;
    if (prefix.length && node.name === "id") continue;
    const path = [...prefix, node.name];
    const label = [...labels, node.string];
    if (node.type === "one2many") {
      if (!prefix.length && expand.includes(node.name)) out.push(...flattenFields(node.fields ?? [], expand, path, label));
    } else out.push({ path: path.join("/"), label: label.join(" / ") });
  }
  return out;
}

const FRIENDLY = [
  [/No matching record found for name '(.*?)' in field '(.*?)'/s, (m) => `Data "${m[1]}" tidak ditemukan untuk ${m[2]}. Pastikan namanya persis sama dengan data yang sudah ada.`],
  [/'(.*?)' does not seem to be a number for field '(.*?)'/s, (m) => `"${m[1]}" bukan angka yang valid untuk ${m[2]}. Periksa format angka (pemisah ribuan dan desimal).`],
  [/'(.*?)' does not seem to be an integer for field '(.*?)'/s, (m) => `"${m[1]}" bukan bilangan bulat untuk ${m[2]}.`],
  [/Column (.*) contains incorrect values \(value: (.*)\)/s, (m) => `Kolom ${m[1]} berisi nilai yang tidak valid: "${m[2]}".`],
  [/Missing required value for the field '(.*?)'(?: \((\w+)\))?[.\s]/s, (m) => `Kolom wajib "${m[1]}" kosong.`],
  [/Found multiple matches for field '(.*?)' \((\d+) matches\)/s, (m) => `Ada ${m[2]} data yang cocok untuk ${m[1]}; gunakan nama yang lebih spesifik atau ID eksternal.`],
  [/The entry is not balanced/i, () => "Jurnal tidak seimbang: total debit harus sama dengan total kredit."],
  [/Invalid date/i, () => "Tanggal tidak valid. Periksa format tanggal yang dipilih."],
  [/list index out of range|Import file has no content or is corrupt/i, () => "Lembar atau berkas ini kosong atau hanya berisi judul kolom. Pilih lembar lain atau isi datanya."],
  [/Unable to read file .* as '(xlsx|xls|ods)'/s, () => "Berkas spreadsheet tidak bisa dibaca. Pastikan formatnya .xlsx, .xls, atau .ods dan tidak dilindungi kata sandi."],
  [/Invalid cell value at row (\d+), column (\d+): (.*)/s, (m) => `Sel baris ${m[1]} kolom ${m[2]} berisi galat Excel (${m[3]}). Perbaiki rumusnya lalu simpan ulang.`],
  [/Invalid cell format at row (\d+), column (\d+)/s, (m) => `Format sel baris ${m[1]} kolom ${m[2]} tidak didukung. Ubah menjadi format Tanggal atau Teks.`],
];

function friendly(message) {
  for (const [re, fn] of FRIENDLY) {
    const m = String(message).match(re);
    if (m) return fn(m);
  }
  return String(message);
}

const rowsLabel = (rows) => (rows ? (rows.from === rows.to ? `Baris ${rows.from + 2}` : `Baris ${rows.from + 2} sampai ${rows.to + 2}`) : "Berkas");

/* ---------- Tampilan ---------- */

const card = (title, body) =>
  `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-5 mb-4"><h2 class="text-base font-semibold text-gray-900 mb-3">${esc(title)}</h2>${body}</section>`;
const select = (attr, rows, value) =>
  `<select ${attr} class="${INPUT}">${rows.map(([k, label]) => `<option value="${esc(k)}" ${k === value ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`;
const labelled = (label, content) => `<label class="block"><span class="text-xs font-medium text-gray-500 uppercase tracking-wide">${esc(label)}</span>${content}</label>`;
const primary = (action, label, disabled = false) =>
  `<button data-action="${action}" ${disabled ? "disabled" : ""} class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">${esc(label)}</button>`;
const plainBtn = (action, label) =>
  `<button data-action="${action}" class="px-4 py-2 border border-gray-300 bg-white text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50">${esc(label)}</button>`;

function targetCard() {
  const target = TARGETS[st.key];
  const choices = Object.entries(TARGETS)
    .map(([key, t]) => {
      const on = key === st.key;
      return `<button data-action="imp-target" data-key="${key}" class="text-left rounded-lg border p-3 ${on ? "border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500" : "border-gray-200 hover:bg-gray-50"}">
        <div class="text-sm font-semibold ${on ? "text-indigo-700" : "text-gray-900"}">${esc(t.title)}</div><div class="text-xs text-gray-500 mt-1">${esc(t.about)}</div></button>`;
    })
    .join("");
  const guide = target.columns
    .map(
      (c) => `<tr><td class="py-2 px-3 text-sm font-mono text-gray-900">${esc(c.f)}</td><td class="py-2 px-3 text-sm text-gray-700">${esc(c.label)}</td>
        <td class="py-2 px-3 text-sm text-gray-700">${c.req ? '<span class="text-rose-600 font-medium">Wajib</span>' : "Opsional"}</td></tr>`,
    )
    .join("");
  return card(
    "1. Pilih jenis data",
    `<div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">${choices}</div>
     <div class="mt-4 flex flex-wrap items-center gap-3"><div class="text-sm font-medium text-gray-900">Format kolom ${esc(target.title)}</div>${plainBtn("imp-template-xlsx", "Unduh template Excel (.xlsx)")}${plainBtn("imp-template", "Unduh template CSV")}</div>
     <div class="mt-2 overflow-x-auto border border-gray-200 rounded-lg"><table class="w-full text-left"><thead class="bg-gray-50"><tr>
       <th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase">Judul kolom</th><th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase">Isi</th><th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase">Status</th>
     </tr></thead><tbody class="divide-y divide-gray-100">${guide}</tbody></table></div>
     <ul class="mt-3 text-xs text-gray-500 list-disc pl-5 space-y-1"><li>Judul kolom boleh memakai nama teknis (seperti di tabel) atau label field Odoo; kolom yang tidak dikenali bisa dipetakan manual pada langkah 3.</li>
       ${target.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`,
  );
}

function fileCard() {
  const excel = isExcel();
  const fileInfo = st.bytes ? `<div class="text-sm text-gray-700 mt-2">${esc(st.fileName)} <span class="text-gray-400">(${kb(st.size)}${excel ? ", Excel" : ", CSV"})</span></div>` : "";
  const options = [
    ...(excel ? [] : [labelled("Pemisah kolom", select('data-imp-opt="sep"', SEPARATORS, st.sep)), labelled("Encoding", select('data-imp-opt="enc"', ENCODINGS, st.enc)), labelled("Format angka", select('data-imp-opt="num"', NUMBERS, st.num))]),
    labelled("Format tanggal", select('data-imp-opt="date"', DATES, st.date)),
    ...(excel && st.sheets.length > 1 ? [labelled("Lembar Excel", select("data-imp-sheet", st.sheets.map((name) => [name, name]), st.sheet))] : []),
  ];
  const hint = excel
    ? `Baris pertama lembar berisi judul kolom. Angka dan tanggal diambil dari nilai sel (rumus memakai hasil hitung terakhir yang tersimpan di berkas), dan baris yang sepenuhnya kosong dilewati. Maksimal ${kb(MAX_XLSX_BYTES)} untuk Excel dan 5.000 baris per lembar.`
    : `Dari Excel: Simpan Sebagai, pilih CSV UTF-8, atau pilih berkas .xlsx, .xls, atau .ods langsung. Maksimal ${kb(MAX_BYTES)} untuk CSV dan 5.000 baris per berkas.`;
  return card(
    "2. Pilih berkas CSV atau Excel",
    `<input type="file" accept=".csv,.txt,.xlsx,.xls,.ods,text/csv,${XLSX_TYPE},${EXCEL_TYPES.xls},${EXCEL_TYPES.ods}" data-imp-file class="text-sm">${fileInfo}
     <div class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-4">${options.join("")}</div>
     <div class="text-xs text-gray-500 mt-2">${hint}</div>
     <div class="mt-4">${primary("imp-read", st.preview ? "Baca ulang berkas" : "Baca berkas dan cocokkan kolom", !st.bytes)}</div>`,
  );
}

function mappingCard() {
  const { headers, samples, fields } = st.preview;
  const rows = headers
    .map((header, i) => {
      const chosen = st.map[i] || "";
      const options = [`<option value="">- abaikan kolom -</option>`, ...fields.map((f) => `<option value="${esc(f.path)}" ${f.path === chosen ? "selected" : ""}>${esc(f.label)} (${esc(f.path)})</option>`)].join("");
      return `<tr><td class="py-2 px-3 text-sm font-medium text-gray-900">${esc(header)}</td>
        <td class="py-2 px-3 text-sm text-gray-600 max-w-xs truncate">${esc((samples[i] ?? []).slice(0, 3).join(" · "))}</td>
        <td class="py-2 px-3"><select data-imp-map="${i}" class="${INPUT} ${chosen ? "" : "border-amber-400"}">${options}</select></td></tr>`;
    })
    .join("");
  const ignored = st.map.filter((m) => !m).length;
  return card(
    `3. Cocokkan kolom (${st.preview.rows} baris data)`,
    `<div class="overflow-x-auto border border-gray-200 rounded-lg"><table class="w-full text-left"><thead class="bg-gray-50"><tr>
       <th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase">Kolom di berkas</th><th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase">Contoh isi</th><th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase">Masuk ke field</th>
     </tr></thead><tbody class="divide-y divide-gray-100">${rows}</tbody></table></div>
     ${ignored ? `<div class="text-xs text-amber-700 mt-2">${ignored} kolom tidak dipetakan dan akan diabaikan.</div>` : ""}
     <div class="mt-4 flex flex-wrap gap-2">${primary("imp-dry", "Uji impor (tidak menyimpan)")}</div>`,
  );
}

function resultCard() {
  if (st.done) {
    const target = TARGETS[st.key];
    return card(
      "4. Hasil",
      `<div class="rounded-lg bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-800">Impor berhasil: ${st.done.count} data masuk ke ${esc(target.title)}.${st.done.note ? ` ${esc(st.done.note)}` : ""}</div>
       <div class="mt-4 flex gap-2"><a href="${target.link}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Buka ${esc(target.title)}</a>${plainBtn("imp-reset", "Impor berkas lain")}</div>`,
    );
  }
  if (!st.dry) return "";
  const errors = st.dry.messages.filter((m) => m.type === "error");
  const warnings = st.dry.messages.filter((m) => m.type !== "error");
  const list = (rows, tone) =>
    `<ul class="mt-3 space-y-2">${rows
      .slice(0, 50)
      .map((m) => `<li class="text-sm rounded-lg border ${tone} p-3"><span class="font-medium">${esc(rowsLabel(m.rows))}${m.field_name || m.field_path ? ` · ${esc(m.field_name || m.field_path.join("/"))}` : ""}:</span> ${esc(friendly(m.message))}</li>`)
      .join("")}${rows.length > 50 ? `<li class="text-xs text-gray-500">Dan ${rows.length - 50} masalah lain.</li>` : ""}</ul>`;
  if (st.dry.ok) {
    return card(
      "4. Hasil uji",
      `<div class="rounded-lg bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-800">Uji lulus: ${st.dry.count} data siap diimpor. Belum ada data yang disimpan.</div>
       ${warnings.length ? list(warnings, "border-amber-200 bg-amber-50 text-amber-800") : ""}
       <div class="mt-4 flex flex-wrap gap-2">${primary("imp-run", `Impor ${st.dry.count} data sekarang`)}</div>`,
    );
  }
  return card(
    "4. Hasil uji",
    `<div class="rounded-lg bg-rose-50 border border-rose-200 p-4 text-sm text-rose-800">Uji gagal: ${errors.length} masalah ditemukan. Tidak ada data yang disimpan. Perbaiki berkas atau pemetaan, lalu uji lagi.</div>
     ${list(errors, "border-rose-200 bg-rose-50 text-rose-800")}`,
  );
}

function draw() {
  app.innerHTML =
    pageHeader("Import Data") +
    `<p class="text-sm text-gray-600 mb-4 max-w-3xl">Masukkan data master dan saldo awal dari CSV, Excel (.xlsx atau .xls), atau LibreOffice (.ods). Setiap berkas diuji dulu tanpa menyimpan; bila ada satu galat saja, tidak ada data yang masuk.</p>` +
    targetCard() +
    fileCard() +
    (st.preview && !st.done ? mappingCard() : "") +
    resultCard();
}

/* ---------- Aksi ---------- */

const resetPreview = () => Object.assign(st, { importId: null, options: null, preview: null, map: [], dry: null, done: null });

/** Menyimpan hasil parse_preview ke state; mengembalikan false (dan menampilkan pesan) bila berkas tidak terbaca. */
function applyPreview(id, preview, target) {
  Object.assign(st, { importId: id, options: null, preview: null, map: [], dry: null, done: null });
  if (preview.error || !preview.headers) {
    toast(friendly(preview.error || "Berkas tidak bisa dibaca."), "error");
    draw();
    return;
  }
  if (preview.num_rows - 1 > 5000) {
    toast("Berkas lebih dari 5.000 baris. Pecah menjadi beberapa berkas.", "error");
    draw();
    return;
  }
  const matches = preview.matches ?? {};
  Object.assign(st, {
    options: preview.options,
    preview: { headers: preview.headers, samples: preview.preview, rows: preview.num_rows - 1, fields: flattenFields(preview.fields, target.expand ?? []).sort((a, b) => a.label.localeCompare(b.label)) },
    map: preview.headers.map((_, i) => (matches[String(i)] ?? []).join("/")),
  });
  draw();
}

async function readFile(btn) {
  const target = TARGETS[st.key];
  const excel = isExcel();
  let text = "";
  let separator = ",";
  if (!excel) {
    text = decodeText();
    if (text.includes("�")) toast("Ada karakter yang tidak terbaca. Bila teks tampak rusak, ganti Encoding ke Windows-1252.", "error");
    separator = st.sep === "auto" ? detectSeparator(text) : st.sep;
  }
  const result = await guarded(btn, async () => {
    let id;
    let sheets = [];
    if (excel) {
      ({ id, sheets } = await call("base_import.import", "kompakapps_create_from_file", { res_model: target.model, file_name: st.fileName, file_type: EXCEL_TYPES[excelExt(st.fileName)], data: toBase64(st.bytes) }));
    } else {
      [id] = await call("base_import.import", "create", { vals_list: [{ res_model: target.model, file: text, file_type: "text/csv", file_name: st.fileName || "impor.csv" }] });
    }
    const sheet = excel && sheets.length ? (sheets.includes(st.sheet) ? st.sheet : sheets[0]) : "";
    const preview = await call("base_import.import", "parse_preview", { ids: [id], options: buildOptions(separator, sheet), count: 5 });
    return { id, preview, sheets, sheet };
  });
  if (!result) return;
  Object.assign(st, { sheets: result.sheets, sheet: result.sheet });
  applyPreview(result.id, result.preview, target);
}

/** Ganti lembar Excel: sesi impor yang sudah ada dibaca ulang pada lembar lain tanpa mengunggah berkas lagi. */
async function changeSheet(sheet) {
  st.sheet = sheet;
  if (!st.importId) return;
  const target = TARGETS[st.key];
  const preview = await guarded(null, () => call("base_import.import", "parse_preview", { ids: [st.importId], options: buildOptions(",", sheet), count: 5 }));
  if (preview) applyPreview(st.importId, preview, target);
}

/** Menjalankan execute_import; dryrun=true hanya menguji dan membatalkan semua perubahan. */
function execute(dryrun) {
  const target = TARGETS[st.key];
  const params = { ids: [st.importId], fields: st.map.map((m) => m || false), columns: st.preview.headers, options: st.options, dryrun };
  if (target.context) params.context = target.context;
  return call("base_import.import", "execute_import", params);
}

async function dryRun(btn) {
  if (!st.map.some(Boolean)) {
    toast("Petakan sedikitnya satu kolom ke field.", "error");
    return;
  }
  const res = await guarded(btn, () => execute(true));
  if (!res) return;
  const messages = res.messages ?? [];
  st.dry = { ok: !messages.some((m) => m.type === "error") && Array.isArray(res.ids), count: Array.isArray(res.ids) ? res.ids.length : 0, messages };
  draw();
}

async function runImport(btn) {
  const target = TARGETS[st.key];
  const res = await guarded(btn, () => execute(false));
  if (!res) return;
  const messages = res.messages ?? [];
  if (messages.some((m) => m.type === "error") || !Array.isArray(res.ids)) {
    st.dry = { ok: false, count: 0, messages };
    toast("Impor dibatalkan karena ada galat; tidak ada data yang masuk.", "error");
    draw();
    return;
  }
  let note = "";
  if (target.after) {
    try {
      await target.after(res.ids);
      note = "Stok sudah diterapkan.";
    } catch (error) {
      note = `Data tersimpan tetapi penerapan gagal: ${error.message}`;
    }
  }
  st.done = { count: res.ids.length, note };
  st.importId = null;
  toast(`${res.ids.length} data diimpor.`);
  draw();
}

export function onChange(event, el) {
  if (!st) return;
  if (el.dataset.impFile !== undefined) {
    const file = el.files?.[0];
    if (!file) return;
    const limit = excelExt(file.name) ? MAX_XLSX_BYTES : MAX_BYTES;
    if (file.size > limit) {
      toast(`Berkas maksimal ${kb(limit)}.`, "error");
      el.value = "";
      return;
    }
    file.arrayBuffer().then((bytes) => {
      resetPreview();
      Object.assign(st, { bytes, fileName: file.name, size: file.size, sheets: [], sheet: "" });
      draw();
    });
  } else if (el.dataset.impSheet !== undefined) {
    changeSheet(el.value);
  } else if (el.dataset.impOpt) {
    st[el.dataset.impOpt] = el.value;
    if (st.preview) {
      resetPreview();
      draw();
    }
  } else if (el.dataset.impMap !== undefined) {
    st.map[Number(el.dataset.impMap)] = el.value;
    st.dry = null;
    draw();
  }
}

export async function onClick(event, el) {
  if (!st) return;
  const { action } = el.dataset;
  if (action === "imp-target") {
    if (st.key !== el.dataset.key) {
      Object.assign(st, { key: el.dataset.key });
      resetPreview();
      draw();
    }
  } else if (action === "imp-template") downloadTemplate(TARGETS[st.key]);
  else if (action === "imp-template-xlsx") downloadTemplate(TARGETS[st.key], "xlsx");
  else if (action === "imp-read") await readFile(el);
  else if (action === "imp-dry") await dryRun(el);
  else if (action === "imp-run") await runImport(el);
  else if (action === "imp-reset") {
    st = fresh(st.key);
    draw();
  }
}
