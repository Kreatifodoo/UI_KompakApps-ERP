// Faktur: tagihan vendor (account.move, in_invoice) dan faktur pelanggan (out_invoice) memakai satu kerangka,
// dibedakan oleh konfigurasi. Struktur form mengikuti view Odoo: tombol Confirm, Pay, Cancel, Reset to Draft;
// bilah status draft/posted; status pembayaran; total, sisa; item jurnal; dan dialog "Register Payment"
// yang memakai wizard account.payment.register (arah pembayaran mengikuti jenis faktur).
import {
  PRODUCT_PAGE, searchProducts,
  ACCOUNT_TYPE_LABELS, INPUT, actionBar, app, badge, call, cell, attachmentsPendingHtml, chatterHtml, closeLookup, closeModal, ctx, dateText, esc, fieldBlock, filterSelect, guarded,
  journalHtml, loadJournalItems, loadMessages, money, openModal, pageHeader, plain, readOne, readonlyValue, referenceAssetProfiles, referenceCurrencies,
  referenceJournals, referenceSelection, referenceTerms, registerLookup, rowLink, runLookup, searchAccounts, searchRead, selectOptions, statTiles, statusbar,
  table, toast, today,
} from "../common.js";
import { loadTaxNames, productDefaultTaxes, registerTaxes, taxCell, taxChange, taxList } from "../taxpick.js";
import { analyticCell, distributionChange, preloadAnalytic, readDistribution, registerAnalytic } from "../analyticpick.js";
import { printButton } from "../print.js";
import { createDocPicker } from "../docbill.js";

const STATES = {
  draft: ["Draft", "muted"],
  posted: ["Terposting", "success"],
  cancel: ["Dibatalkan", "danger"],
};
const FLOW = ["draft", "posted"];
const PAYMENT_STATES = {
  not_paid: ["Belum Dibayar", "warning"],
  in_payment: ["Dalam Pembayaran", "info"],
  paid: ["Dibayar", "success"],
  partial: ["Dibayar Sebagian", "warning"],
  reversed: ["Dibalik", "muted"],
  invoicing_legacy: ["Sistem Lama", "muted"],
};
const WIZARD_FIELDS = ["journal_id", "payment_method_line_id", "amount", "currency_id", "payment_date", "communication", "available_journal_ids", "available_payment_method_line_ids"];

export const BILL = {
  route: "bill", moveType: "in_invoice", title: "Tagihan Vendor", noun: "Tagihan", partner: "Pemasok", partnerFilter: "per pemasok",
  refLabel: "Referensi Tagihan", dateLabel: "Tanggal Tagihan", residualLabel: "Sisa Tagihan", linesTitle: "Baris Tagihan", payLabel: "Bayar",
  origin: { model: "purchase.order", route: "po", label: "Purchase Order", icon: "fa-shopping-cart" },
  assets: true, kodeTransaksi: false, reverse: { label: "Nota Debit", route: "debitnote", title: "Buat Nota Debit Vendor", success: "Nota debit vendor dibuat (draft)." },
  create: { doc: "po", docLabel: "Purchase Order", journalType: "purchase", newTitle: "Tagihan Vendor Baru" },
  empty: "Belum ada tagihan vendor. Buat dengan tombol Buat (berdiri sendiri atau dari Purchase Order).",
};
export const INVOICE = {
  route: "invoice", moveType: "out_invoice", title: "Faktur Pelanggan", noun: "Faktur", partner: "Pelanggan", partnerFilter: "per pelanggan",
  refLabel: "Referensi Pelanggan", dateLabel: "Tanggal Faktur", residualLabel: "Sisa Faktur", linesTitle: "Baris Faktur", payLabel: "Terima Pembayaran",
  origin: { model: "sale.order", route: "sale", label: "Sales Order", icon: "fa-cart-shopping" },
  assets: false, kodeTransaksi: true, reverse: { label: "Nota Kredit", route: "creditnote", title: "Buat Nota Kredit Pelanggan", success: "Nota kredit pelanggan dibuat (draft)." },
  create: { doc: "so", docLabel: "Sales Order", journalType: "sale", newTitle: "Faktur Pelanggan Baru" },
  empty: "Belum ada faktur pelanggan. Buat dengan tombol Buat (berdiri sendiri atau dari Sales Order).",
};
export const CREDIT_NOTE = {
  route: "creditnote", moveType: "out_refund", title: "Nota Kredit Pelanggan", noun: "Nota kredit", partner: "Pelanggan", partnerFilter: "per pelanggan",
  refLabel: "Referensi", dateLabel: "Tanggal Nota", residualLabel: "Sisa Nota", linesTitle: "Baris Nota Kredit", payLabel: "Kembalikan Dana",
  origin: { model: "sale.order", route: "sale", label: "Sales Order", icon: "fa-cart-shopping" },
  assets: false, kodeTransaksi: true, reversedFrom: { route: "invoice", label: "Faktur Asal" },
  empty: "Belum ada nota kredit. Buat dari faktur pelanggan terposting dengan tombol Nota Kredit.",
};
export const DEBIT_NOTE = {
  route: "debitnote", moveType: "in_refund", title: "Nota Debit Vendor", noun: "Nota debit", partner: "Pemasok", partnerFilter: "per pemasok",
  refLabel: "Referensi", dateLabel: "Tanggal Nota", residualLabel: "Sisa Nota", linesTitle: "Baris Nota Debit", payLabel: "Terima Dana",
  origin: { model: "purchase.order", route: "po", label: "Purchase Order", icon: "fa-shopping-cart" },
  assets: false, kodeTransaksi: false, reversedFrom: { route: "bill", label: "Tagihan Asal" },
  empty: "Belum ada nota debit. Buat dari tagihan vendor terposting dengan tombol Nota Debit.",
};

export function createInvoicePage(config) {
  const lookupKind = `${config.route}-account`;
  const productKind = `${config.route}-product`;
  const partnerKind = `${config.route}-partner`;
  const purchaseSide = config.moveType.startsWith("in_");
  const BUTTONS = [
    { action: "post", label: "Konfirmasi", method: "action_post", kind: "primary", show: (b) => b.state === "draft" },
    { action: "pay", label: config.payLabel, method: null, kind: "primary", show: (b) => b.state === "posted" && ["not_paid", "partial", "in_payment"].includes(b.payment_state) },
    ...(config.reverse ? [{ action: "reverse", label: config.reverse.label, method: null, show: (b) => b.state === "posted" }] : []),
    { action: "cancel", label: "Batalkan", method: "button_cancel", kind: "danger", show: (b) => b.state === "draft" },
    { action: "reset", label: "Kembalikan ke Draft", method: "button_draft", show: (b) => b.show_reset_to_draft_button },
  ];
  const DONE_MESSAGE = {
    post: `${config.noun} dikonfirmasi.`, cancel: `${config.noun} dibatalkan.`, reset: `${config.noun} dikembalikan ke draft.`,
  };

  // form: { id (null = baru), partner, ref, invoice_date, date, invoice_date_due, kode, term, journal, currency, narration, initial, lines: [baris], removed: [id] }
  let form = null;
  let refs = { profiles: null, kodeOptions: [], terms: [], journals: [], currencies: [] };
  let pay = null; // { id wizard, context, billId }
  let reversing = null; // { id, journalId }
  let last = { sub: "", query: new URLSearchParams() };
  const reload = () => render(last.sub, last.query);
  const leave = () => {
    form = null;
    pay = null;
    reversing = null;
  };

  /* Pembuat tagihan/faktur dari dokumen sumber (D48): beberapa PO atau SO satu mitra menjadi satu dokumen. */
  const docs = config.create
    ? createDocPicker({
        kind: config.create.doc,
        route: config.route,
        onCreated: (ids) => {
          form = null;
          location.hash = ids.length === 1 ? `#/${config.route}/${ids[0]}` : `#/${config.route}?ids=${ids.join(",")}`;
        },
        onAdded: () => {
          form = null;
          reload();
        },
      })
    : null;

  const emptyLine = () => ({
    id: null, text: "", productText: "", product_id: null, name: "", lastAutoName: "", quantity: 1, uom_label: "", price_unit: "", price_unit0: null, discount: "",
    account: null, account0: null, profile: null, profile0: null, analytic: undefined, analytic0: undefined, taxes: [], taxes0: undefined, taxTouched: false,
    subtotal: null, initial: null,
  });
  const lineFromRow = (l, taxName) => {
    const account = l.account_id ? { id: l.account_id[0], display_name: l.account_id[1] } : null;
    const analytic = readDistribution(l.analytic_distribution);
    return {
      id: l.id, text: l.product_id?.[1] ?? "", productText: l.product_id?.[1] ?? "", product_id: l.product_id?.[0] ?? null, name: l.name || "", lastAutoName: l.name || "",
      quantity: l.quantity, uom_label: l.product_uom_id?.[1] ?? "", price_unit: l.price_unit, price_unit0: l.price_unit, discount: l.discount || "",
      account, account0: account?.id ?? null, profile: l.asset_profile_id?.[0] ?? null, profile0: l.asset_profile_id?.[0] ?? null,
      analytic, analytic0: analytic, taxes: taxList(l.tax_ids, taxName), taxes0: l.tax_ids, taxTouched: false, subtotal: l.price_subtotal,
      initial: { product_id: l.product_id?.[0] ?? null, name: l.name || "", quantity: l.quantity, discount: l.discount || 0 },
    };
  };
  const lineAt = (input) => form?.lines?.[Number(input.dataset.line)];
  const linesBox = () => document.querySelector("#lines-box");
  const redrawLines = () => {
    const box = linesBox();
    if (box && form) box.innerHTML = linesTable();
  };

  // Akun baris bisa diganti saat draft (mis. ke akun Aset Tetap agar profil aset dan aset terbentuk); kosong = otomatis (akun produk atau jurnal).
  registerLookup(lookupKind, {
    search: (q) => searchAccounts(q),
    sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
    isChosen: (input) => lineAt(input)?.account?.display_name === input.value,
    choose: (input, item) => {
      lineAt(input).account = item;
      input.value = item.display_name;
    },
  });

  registerLookup(productKind, {
    pageSize: PRODUCT_PAGE,
    search: (q, _input, page) =>
      searchProducts(q, page, {
        domain: [[purchaseSide ? "purchase_ok" : "sale_ok", "=", true]],
        fields: ["display_name", "uom_id", purchaseSide ? "description_purchase" : "description_sale"],
      }),
    sub: (r) => r.uom_id?.[1] ?? "",
    isChosen: (input) => {
      const line = lineAt(input);
      return Boolean(line?.product_id) && line.productText === input.value;
    },
    choose: (input, item) => {
      const i = Number(input.dataset.line);
      const line = form.lines[i];
      Object.assign(line, { text: item.display_name, productText: item.display_name, product_id: item.id, uom_label: item.uom_id?.[1] ?? "" });
      const description = (purchaseSide ? item.description_purchase : item.description_sale) || item.display_name;
      if (!line.name || line.name === line.lastAutoName) line.name = description;
      line.lastAutoName = description;
      // Ganti produk pada baris yang ada: harga dan akun dihitung ulang Odoo dari produk baru kecuali diubah pengguna sesudahnya.
      if (line.id) {
        line.price_unit = "";
        line.account = null;
      }
      redrawLines();
      document.querySelector(`[data-line="${i}"][data-field="quantity"]`)?.focus();
      applyProductTaxes(line, item.id).catch((error) => toast(error.message, "error"));
    },
  });

  registerLookup(partnerKind, {
    search: (q) =>
      searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: `${purchaseSide ? "supplier_rank" : "customer_rank"} desc, name` }),
    isChosen: (input) => form?.partner?.display_name === input.value,
    choose: (input, item) => {
      form.partner = item;
      input.value = item.display_name;
      refreshNewLineTaxes().catch((error) => toast(error.message, "error"));
    },
  });

  // Distribusi analitik baris: disimpan di status form, lalu hanya sel yang bersangkutan digambar ulang.
  registerAnalytic(config.route, {
    get: (lineIndex) => form?.lines?.[Number(lineIndex)]?.analytic ?? {},
    set: (lineIndex, dist) => {
      const edit = form?.lines?.[Number(lineIndex)];
      if (!edit) return;
      edit.analytic = dist;
      const button = document.querySelector(`[data-an-open="${config.route}"][data-an-key="${lineIndex}"]`);
      if (button) button.outerHTML = analyticCell(config.route, lineIndex, dist);
    },
    label: (lineIndex) => form?.lines?.[Number(lineIndex)]?.name || form?.lines?.[Number(lineIndex)]?.text || "",
  });

  // Pajak baris: daftar tag per baris di status form; hanya sel yang bersangkutan digambar ulang.
  registerTaxes(config.route, {
    use: purchaseSide ? "purchase" : "sale",
    get: (lineIndex) => form?.lines?.[Number(lineIndex)]?.taxes ?? [],
    set: (lineIndex, taxes) => {
      const edit = form?.lines?.[Number(lineIndex)];
      if (!edit) return;
      edit.taxes = taxes;
      edit.taxTouched = true;
      const cell = document.querySelector(`[data-tx-cell="${lineIndex}"]`);
      if (cell) cell.innerHTML = taxCell(config.route, lineIndex, taxes);
    },
  });

  const taxDoc = () => ({ model: "account.move", partnerId: form?.partner?.id ?? null, values: { move_type: config.moveType } });

  /** Pajak bawaan baris baru mengikuti posisi fiskal mitra; saat mitra diganti, baris baru yang pajaknya belum disentuh dihitung ulang (baris tersimpan tetap). */
  async function refreshNewLineTaxes() {
    const current = form;
    const lines = current?.lines.filter((l) => l.product_id && !l.taxTouched && l.taxes0 === undefined) ?? [];
    if (!lines.length) return;
    const results = await Promise.all(lines.map((l) => productDefaultTaxes(l.product_id, purchaseSide ? "purchase" : "sale", taxDoc())));
    if (form !== current) return;
    lines.forEach((l, i) => {
      l.taxes = results[i];
    });
    redrawLines();
  }


  /** Mengganti produk menerapkan pajak bawaan produk baru; pilihan manual sebelumnya ditimpa dan penggunanya diberi tahu. */
  async function applyProductTaxes(line, productId) {
    const defaults = await productDefaultTaxes(productId, purchaseSide ? "purchase" : "sale", taxDoc());
    if (line.product_id !== productId) return;
    const before = line.taxes.map((t) => t.id).sort().join();
    if (line.taxTouched && before !== defaults.map((t) => t.id).sort().join()) toast("Pajak baris diganti dengan pajak bawaan produk baru.");
    line.taxes = defaults;
    line.taxTouched = false;
    redrawLines();
  }

  async function render(sub, query) {
    last = { sub, query };
    if (sub === "") return renderList(query);
    if (sub === "new" && config.create) return renderForm(null);
    return renderForm(Number(sub));
  }

  async function renderList(query) {
    form = null;
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    const filter = query.get("state") ?? "";
    const ids = (query.get("ids") ?? "").split(",").map(Number).filter(Boolean);
    const domain = [["move_type", "=", config.moveType]];
    if (filter === "unpaid") domain.push(["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]);
    else if (filter === "paid") domain.push(["payment_state", "in", ["paid", "in_payment"]]);
    else if (filter) domain.push(["state", "=", filter]);
    if (ids.length) domain.push(["id", "in", ids]);
    const partner = Number(query.get("partner")) || null;
    if (partner) domain.push(["partner_id", "=", partner]);
    const rows = await searchRead(
      "account.move",
      domain,
      ["name", "partner_id", "invoice_date", "invoice_date_due", "invoice_origin", "amount_total", "amount_residual", "currency_id", "state", "payment_state"],
      { order: "id desc", limit: 80 },
    );
    const options = [["", "Semua"], ["draft", "Draft"], ["posted", "Terposting"], ["unpaid", "Belum dibayar"], ["paid", "Sudah dibayar"], ["cancel", "Dibatalkan"]];
    const body = rows
      .map((r) =>
        rowLink(`#/${config.route}/${r.id}`, [
          cell(r.name || "Draft", { strong: true }),
          cell(r.partner_id?.[1] ?? ""),
          cell(dateText(r.invoice_date)),
          cell(dateText(r.invoice_date_due)),
          cell(r.invoice_origin || "-"),
          cell(money(r.amount_total, r.currency_id?.[1]), { right: true }),
          cell(money(r.amount_residual, r.currency_id?.[1]), { right: true }),
          cell(badge(STATES, r.state), { raw: true }),
          cell(r.state === "posted" ? badge(PAYMENT_STATES, r.payment_state) : "", { raw: true }),
        ]),
      )
      .join("");
    const createMenu = config.create
      ? `<div class="relative">
           <button data-action="create-menu" aria-haspopup="menu" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-1"></i>Buat <i class="fas fa-caret-down ml-1"></i></button>
           <div id="create-menu" role="menu" class="hidden absolute right-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-30 py-1 text-sm">
             <a href="#/${config.route}/new" role="menuitem" class="block px-4 py-2 hover:bg-indigo-50">Berdiri sendiri</a>
             <button data-action="from-docs" role="menuitem" class="block w-full text-left px-4 py-2 hover:bg-indigo-50">Dari ${esc(config.create.docLabel)}</button>
           </div>
         </div>`
      : "";
    app.innerHTML =
      pageHeader(
        config.title,
        `${filterSelect(options, filter)}
         <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
         ${createMenu}`,
      ) +
      (partner
        ? `<p class="text-sm text-gray-500 mb-3">Difilter ${config.partnerFilter}. <a href="#/${config.route}" class="text-indigo-600 hover:underline">Tampilkan semua</a></p>`
        : "") +
      table(
        [{ label: "Nomor" }, { label: config.partner }, { label: config.dateLabel }, { label: "Jatuh Tempo" }, { label: "Dokumen Sumber" }, { label: "Total", right: true }, { label: "Sisa", right: true }, { label: "Status" }, { label: "Pembayaran" }],
        body,
        config.empty,
      );
  }

  /* ---------- Tabel baris (draf dan baru) ---------- */

  const subtotalOf = (l) => {
    if (String(l.price_unit).trim() === "") return l.id ? l.subtotal : null;
    return Math.round(Number(l.quantity || 0) * Number(l.price_unit) * (1 - Number(l.discount || 0) / 100) * 100) / 100;
  };

  function linesTable() {
    const profiles = refs.profiles;
    const rows = form.lines
      .map(
        (l, i) => `<tr class="align-top">
          <td class="py-2 pr-2 min-w-44"><input data-lookup="${productKind}" autocomplete="off" role="combobox" aria-autocomplete="list" data-line="${i}" data-field="text" value="${esc(l.text)}" placeholder="Produk (boleh kosong)" class="${INPUT}" aria-label="Produk baris ${i + 1}"></td>
          <td class="py-2 px-2 min-w-40"><input data-line="${i}" data-field="name" value="${esc(l.name)}" placeholder="Label" class="${INPUT}" aria-label="Label baris ${i + 1}"></td>
          <td class="py-2 px-2 min-w-48"><input data-lookup="${lookupKind}" data-line="${i}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(l.account?.display_name ?? "")}" placeholder="Otomatis" class="${INPUT}" aria-label="Akun baris ${i + 1}"></td>
          ${profiles ? `<td class="py-2 px-2 min-w-40"><select data-line-profile="${i}" class="${INPUT}" aria-label="Profil aset baris ${i + 1}">${selectOptions(profiles, l.profile ?? null, "-")}</select></td>` : ""}
          <td class="py-2 px-2 min-w-48">${analyticCell(config.route, i, l.analytic)}</td>
          <td class="py-2 px-2 w-24"><input type="number" step="any" data-line="${i}" data-field="quantity" value="${esc(l.quantity)}" class="${INPUT} text-right" aria-label="Jumlah baris ${i + 1}"></td>
          <td class="py-2 px-2 w-20 text-sm text-gray-600">${esc(l.uom_label || "-")}</td>
          <td class="py-2 px-2 w-36"><input type="number" step="any" data-line="${i}" data-field="price_unit" value="${esc(l.price_unit)}" placeholder="otomatis" class="${INPUT} text-right" aria-label="Harga baris ${i + 1}"></td>
          <td class="py-2 px-2 w-20"><input type="number" min="0" max="100" step="any" data-line="${i}" data-field="discount" value="${esc(l.discount)}" placeholder="0" class="${INPUT} text-right" aria-label="Diskon baris ${i + 1}"></td>
          <td class="py-2 px-2 min-w-48" data-tx-cell="${i}">${taxCell(config.route, i, l.taxes)}</td>
          <td class="py-2 px-2 w-32 text-sm text-right text-gray-700" id="sub-${i}">${subtotalOf(l) === null ? "-" : money(subtotalOf(l), form.currencyName)}</td>
          <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="remove-line" data-line="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris ${i + 1}"><i class="fas fa-trash-alt"></i></button></td>
        </tr>`,
      )
      .join("");
    const heads = ["Produk", "Label", "Akun", ...(profiles ? ["Profil Aset"] : []), "Analitik", "Jumlah", "Satuan", "Harga", "Diskon %", "Pajak", "Subtotal", ""];
    const right = new Set(["Jumlah", "Harga", "Diskon %", "Subtotal"]);
    return `<table class="w-full text-left">
        <thead><tr>${heads.map((h) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${right.has(h) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        <tbody>${rows}</tbody></table>
      <p class="text-xs text-gray-500 mt-2">Kosongkan harga untuk memakai harga produk, dan kosongkan akun untuk memakai akun produk atau akun bawaan jurnal. Baris boleh tanpa produk (isi label, akun, dan harga).</p>
      <div class="flex flex-wrap gap-4 mt-1">
        <button type="button" data-action="add-line" class="text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>
        ${docs && form.id ? `<button type="button" data-action="add-docs" class="text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-file-import mr-1"></i>Tambah dari ${esc(config.create.docLabel)}</button>` : ""}
      </div>`;
  }

  function readonlyLinesTable(lines, bill, taxName, showDiscount) {
    const currency = bill.currency_id?.[1];
    const profiles = refs.profiles;
    const rows = lines
      .map(
        (l) => `<tr class="align-top">
          <td class="py-2 px-4 text-sm">${esc(l.product_id?.[1])}</td>
          <td class="py-2 px-4 text-sm">${esc(l.name)}</td>
          <td class="py-2 px-4 text-sm min-w-56">${esc(l.account_id?.[1])}</td>
          ${profiles ? `<td class="py-2 px-4 text-sm min-w-40">${esc(l.asset_profile_id?.[1] ?? "-")}</td>` : ""}
          <td class="py-2 px-4 text-sm min-w-48">${analyticCell(config.route, l.id, l.analytic_distribution, false)}</td>
          <td class="py-2 px-4 text-sm text-right">${esc(l.quantity)}</td>
          <td class="py-2 px-4 text-sm">${esc(l.product_uom_id?.[1])}</td>
          <td class="py-2 px-4 text-sm text-right">${money(l.price_unit, currency)}</td>
          ${showDiscount ? `<td class="py-2 px-4 text-sm text-right">${l.discount ? `${esc(l.discount)}%` : "-"}</td>` : ""}
          <td class="py-2 px-4 text-sm min-w-48" data-tx-cell="${l.id}">${taxCell(config.route, l.id, taxList(l.tax_ids, taxName), false)}</td>
          <td class="py-2 px-4 text-sm text-right">${money(l.price_subtotal, currency)}</td>
        </tr>`,
      )
      .join("");
    const columns = ["Produk", "Label", "Akun", ...(profiles ? ["Profil Aset"] : []), "Analitik", "Jumlah", "Satuan", "Harga", ...(showDiscount ? ["Diskon"] : []), "Pajak", "Subtotal"];
    const rightAligned = columns.filter((c) => ["Jumlah", "Harga", "Diskon", "Subtotal"].includes(c));
    return `<table class="w-full text-left"><thead class="bg-gray-50"><tr>${columns
      .map((h) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${rightAligned.includes(h) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${rows}</tbody></table>`;
  }

  async function renderForm(id) {
    closeLookup();
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    await preloadAnalytic();
    const profiles = config.assets ? await referenceAssetProfiles() : null; // null bila modul aset tidak terpasang
    const kodeOptions = config.kodeTransaksi ? await referenceSelection("account.move", "l10n_id_kode_transaksi") : [];
    const creating = id === null;
    const [terms, journals, currencies] = creating
      ? await Promise.all([referenceTerms(), referenceJournals(config.create.journalType), referenceCurrencies()])
      : [[], [], []];
    refs = { profiles, kodeOptions, terms, journals, currencies };
    const bill = creating
      ? null
      : await readOne("account.move", id, [
          "name", "state", "payment_state", "move_type", "partner_id", "ref", "invoice_date", "date", "invoice_date_due", "invoice_payment_term_id", "narration",
          "journal_id", "currency_id", "invoice_origin", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "matched_payment_ids",
          "show_reset_to_draft_button", ...(profiles ? ["asset_count"] : []),
          ...(config.kodeTransaksi ? ["l10n_id_kode_transaksi", "l10n_id_coretax_document", "invoice_user_id"] : []),
          "reversed_entry_id", "reversal_move_ids",
        ]);
    if (!creating && (!bill || bill.move_type !== config.moveType)) {
      app.innerHTML = `<p class="text-sm text-rose-600">${config.noun} tidak ditemukan.</p>`;
      return;
    }
    const lines = creating
      ? []
      : await searchRead(
          "account.move.line",
          [["move_id", "=", id], ["display_type", "=", "product"]],
          ["product_id", "name", "account_id", "quantity", "product_uom_id", "price_unit", "discount", "tax_ids", "price_subtotal", "analytic_distribution", ...(profiles ? ["asset_profile_id"] : [])],
          { order: "sequence, id" },
        );
    const items = creating ? [] : await loadJournalItems(id);
    const taxName = await loadTaxNames(lines.flatMap((l) => l.tax_ids));
    const origins = (bill?.invoice_origin || "").split(",").map((s) => s.trim()).filter(Boolean);
    const orders = origins.length ? await searchRead(config.origin.model, [["name", "in", origins]], ["id"]) : [];

    const editable = creating || bill.state === "draft";
    const currency = creating ? null : bill.currency_id?.[1];
    if (editable && form?.id !== id) {
      if (creating) {
        const currencyId = ctx.company?.currency_id?.[0] ?? null;
        const values = { ref: "", invoice_date: today(), date: "", invoice_date_due: "", kode: "", narration: "" };
        form = {
          id: null, partner: null, ...values, term: "", journal: journals[0]?.id ?? "", currency: currencyId ?? "", initial: { ...values },
          currencyName: currencies.find((c) => c.id === currencyId)?.display_name ?? ctx.company?.currency_id?.[1], lines: [emptyLine()], removed: [],
        };
      } else {
        const values = {
          ref: bill.ref || "", invoice_date: bill.invoice_date || "", date: bill.date || "", invoice_date_due: bill.invoice_date_due || "",
          kode: bill.l10n_id_kode_transaksi || "", narration: plain(bill.narration || ""),
        };
        form = {
          id, partner: bill.partner_id ? { id: bill.partner_id[0], display_name: bill.partner_id[1] } : null, ...values, initial: { ...values },
          currency: bill.currency_id?.[0], currencyName: currency, currencyRef: bill.currency_id, lines: lines.map((l) => lineFromRow(l, taxName)), removed: [],
        };
      }
    }
    if (editable && creating) form.currencyName = currencies.find((c) => c.id === Number(form.currency))?.display_name ?? form.currencyName;

    const dateInput = (key, label, extra = "") => fieldBlock(label, `<input type="date" data-value="${key}" value="${esc(form[key])}" ${extra} class="${INPUT}">`);
    const kodeField = !config.kodeTransaksi
      ? ""
      : editable
        ? fieldBlock("Kode Transaksi Faktur Pajak", `<select data-value="kode" class="${INPUT}"><option value="">-</option>${kodeOptions.map(([k, label]) => `<option value="${esc(k)}" ${k === form.kode ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`)
        : fieldBlock("Kode Transaksi Faktur Pajak", readonlyValue(kodeOptions.find(([k]) => k === bill.l10n_id_kode_transaksi)?.[1] ?? bill.l10n_id_kode_transaksi));
    const coretax = config.kodeTransaksi && bill?.l10n_id_coretax_document ? fieldBlock("Dokumen e-Faktur (Coretax)", readonlyValue(bill.l10n_id_coretax_document[1])) : "";
    const salesperson = config.kodeTransaksi && bill ? fieldBlock("Salesperson", readonlyValue(bill.invoice_user_id?.[1])) : "";
    const narrationField = (value) => fieldBlock("Catatan", `<textarea data-value="narration" rows="2" class="${INPUT}">${esc(value)}</textarea>`);
    const fields = creating
      ? `${fieldBlock(config.partner, `<input data-lookup="${partnerKind}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(form.partner?.display_name ?? "")}" placeholder="Cari atau pilih ${config.partner.toLowerCase()}..." class="${INPUT}">`)}
         ${fieldBlock(config.refLabel, `<input data-value="ref" value="${esc(form.ref)}" class="${INPUT}">`)}
         ${dateInput("invoice_date", config.dateLabel)}
         ${fieldBlock("Syarat Pembayaran", `<select data-value="term" class="${INPUT}">${selectOptions(terms, Number(form.term) || null, "Tanpa syarat (isi jatuh tempo)")}</select>`)}
         ${dateInput("invoice_date_due", "Jatuh Tempo", form.term ? "disabled" : "")}
         ${fieldBlock("Jurnal", `<select data-value="journal" class="${INPUT}">${selectOptions(journals, Number(form.journal) || null)}</select>`)}
         ${fieldBlock("Mata Uang", `<select data-value="currency" class="${INPUT}">${selectOptions(currencies, Number(form.currency) || null)}</select>`)}
         ${kodeField}
         ${narrationField(form.narration)}`
      : editable
        ? `${fieldBlock(config.partner, readonlyValue(bill.partner_id?.[1]))}
           ${fieldBlock(config.refLabel, `<input data-value="ref" value="${esc(form.ref)}" class="${INPUT}">`)}
           ${dateInput("invoice_date", config.dateLabel)}
           ${dateInput("date", "Tanggal Akuntansi")}
           ${dateInput("invoice_date_due", "Jatuh Tempo")}
           ${fieldBlock("Jurnal", readonlyValue(bill.journal_id?.[1]))}
           ${salesperson}${kodeField}${coretax}
           ${narrationField(form.narration)}`
        : `${fieldBlock(config.partner, readonlyValue(bill.partner_id?.[1]))}
           ${fieldBlock(config.refLabel, readonlyValue(bill.ref))}
           ${fieldBlock(config.dateLabel, readonlyValue(bill.invoice_date ? dateText(bill.invoice_date) : ""))}
           ${fieldBlock("Tanggal Akuntansi", readonlyValue(dateText(bill.date)))}
           ${fieldBlock("Jatuh Tempo", readonlyValue(bill.invoice_date_due ? dateText(bill.invoice_date_due) : ""))}
           ${fieldBlock("Jurnal", readonlyValue(bill.journal_id?.[1]))}
           ${salesperson}${kodeField}${coretax}
           ${bill.narration ? fieldBlock("Catatan", readonlyValue(plain(bill.narration))) : ""}`;

    const showDiscount = lines.some((l) => l.discount);
    const saveBar = editable
      ? `<div class="flex gap-2 mt-4">
           <button data-action="save" data-id="${id ?? ""}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
           ${creating ? `<a href="#/${config.route}" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>` : ""}
         </div>` : "";
    const totals = creating
      ? '<p class="text-xs text-gray-500 mt-3">Pajak dan total dihitung Odoo setelah disimpan sebagai draf; konfirmasi dilakukan dari halaman draf.</p>'
      : `<div class="mt-4 ml-auto w-full max-w-xs text-sm space-y-1">
          <div class="flex justify-between"><span class="text-gray-500">Sebelum Pajak</span><span>${money(bill.amount_untaxed, currency)}</span></div>
          <div class="flex justify-between"><span class="text-gray-500">Pajak</span><span>${money(bill.amount_tax, currency)}</span></div>
          <div class="flex justify-between border-t border-gray-200 pt-1 font-semibold"><span>Total</span><span>${money(bill.amount_total, currency)}</span></div>
          ${bill.state === "posted" ? `<div class="flex justify-between"><span class="text-gray-500">${config.residualLabel}</span><span id="residual" class="font-semibold">${money(bill.amount_residual, currency)}</span></div>` : ""}
        </div>`;
    const title = creating ? config.create.newTitle : bill.name || "Draft";

    app.innerHTML = `
      <div class="text-sm text-gray-500 mb-2"><a href="#/${config.route}" class="hover:text-indigo-600">${config.title}</a> / ${esc(creating ? "Baru" : bill.name || "Draft")}</div>
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
        <div class="flex flex-wrap gap-2">${creating ? "" : actionBar(BUTTONS, bill) + printButton("account.move", bill.id)}</div>
        ${statusbar(FLOW, STATES, creating ? "draft" : bill.state)}
      </div>
      ${creating ? "" : `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
        { count: orders.length, label: `${config.origin.label} ${origins.join(", ")}`, icon: config.origin.icon, href: orders.length === 1 ? `#/${config.origin.route}/${orders[0].id}` : `#/${config.origin.route}?ids=${orders.map((o) => o.id).join(",")}` },
        { count: bill.matched_payment_ids.length, label: "Pembayaran", icon: "fa-money-bill", href: `#/payment?ids=${bill.matched_payment_ids.join(",")}` },
        { count: bill.asset_count ?? 0, label: "Aset", icon: "fa-building" },
        ...(config.reversedFrom
          ? [{ count: bill.reversed_entry_id ? 1 : 0, label: `${config.reversedFrom.label} ${bill.reversed_entry_id?.[1] ?? ""}`, icon: "fa-rotate-left", href: `#/${config.reversedFrom.route}/${bill.reversed_entry_id?.[0]}` }]
          : []),
        ...(config.reverse
          ? [{ count: bill.reversal_move_ids.length, label: config.reverse.label, icon: "fa-rotate-left", href: `#/${config.reverse.route}?ids=${bill.reversal_move_ids.join(",")}` }]
          : []),
        { count: items.length, label: "Item Jurnal", icon: "fa-book", target: "journal-items" },
      ])}</div>`}
      <div class="mb-3"><div class="text-sm text-gray-500">${config.title}</div>
        <h1 class="text-2xl font-bold text-gray-900">${esc(title)}</h1>
        ${!creating && bill.state === "posted" ? `<div class="mt-2">${badge(PAYMENT_STATES, bill.payment_state)}</div>` : ""}</div>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">${fields}</section>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto">
        <div class="text-sm font-semibold mb-3">${config.linesTitle}</div>
        <div id="lines-box">${editable ? linesTable() : readonlyLinesTable(lines, bill, taxName, showDiscount)}</div>
        ${totals}
        ${saveBar}
      </section>
      ${creating ? "" : journalHtml(items, currency, { journal: bill.journal_id?.[1], state: bill.state })}
      ${creating ? attachmentsPendingHtml() : chatterHtml("account.move", id)}`;
    if (!creating) loadMessages("account.move", id);
  }

  /* ---------- Dialog Register Payment (wizard account.payment.register) ---------- */

  async function paymentDialog() {
    const [w] = await call("account.payment.register", "read", { ids: [pay.id], fields: WIZARD_FIELDS, context: pay.context });
    const [journals, methods] = await Promise.all([
      searchRead("account.journal", [["id", "in", w.available_journal_ids]], ["display_name"]),
      searchRead("account.payment.method.line", [["id", "in", w.available_payment_method_line_ids]], ["display_name"]),
    ]);
    const options = (rows, selected) => rows.map((r) => `<option value="${r.id}" ${r.id === selected ? "selected" : ""}>${esc(r.display_name)}</option>`).join("");
    openModal(
      "Daftarkan Pembayaran",
      `<form data-form="pay" class="space-y-4" id="pay-form">
         ${fieldBlock("Jurnal", `<select data-pay="journal_id" class="${INPUT}">${options(journals, w.journal_id?.[0])}</select>`)}
         ${fieldBlock("Metode Pembayaran", `<select data-pay="payment_method_line_id" class="${INPUT}">${options(methods, w.payment_method_line_id?.[0])}</select>`)}
         ${fieldBlock(`Jumlah (${w.currency_id?.[1] ?? ""})`, `<input type="number" min="0" step="any" data-pay="amount" value="${esc(w.amount)}" class="${INPUT} text-right">`)}
         ${fieldBlock("Tanggal Pembayaran", `<input type="date" data-pay="payment_date" value="${esc(w.payment_date || today())}" class="${INPUT}">`)}
         ${fieldBlock("Memo", `<input data-pay="communication" value="${esc(w.communication || "")}" class="${INPUT}">`)}
       </form>`,
      `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
       <button data-action="pay-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Buat Pembayaran</button>`,
      () => {
        pay = null;
      },
    );
  }

  function wizardValues() {
    const get = (key) => document.querySelector(`[data-pay="${key}"]`)?.value;
    return {
      journal_id: Number(get("journal_id")) || false,
      payment_method_line_id: Number(get("payment_method_line_id")) || false,
      amount: Number(get("amount")),
      payment_date: get("payment_date") || false,
      communication: get("communication") ?? "",
    };
  }

  async function openPay(button, billId) {
    const context = { active_model: "account.move", active_ids: [billId] };
    const ok = await guarded(button, async () => {
      const [wizardId] = await call("account.payment.register", "create", { vals_list: [{}], context });
      pay = { id: wizardId, context, billId };
      await paymentDialog();
      return true;
    });
    if (!ok) pay = null;
  }

  async function confirmPay(button) {
    const done = await guarded(button, async () => {
      const vals = wizardValues();
      if (!(vals.amount > 0)) throw new Error("Jumlah pembayaran harus lebih dari 0.");
      await call("account.payment.register", "write", { ids: [pay.id], vals, context: pay.context });
      return call("account.payment.register", "action_create_payments", { ids: [pay.id], context: pay.context });
    });
    if (done === undefined) return;
    const target = done?.res_id;
    closeModal();
    toast("Pembayaran dibuat.");
    if (target) location.hash = `#/payment/${target}`;
    else reload();
  }

  /* ---------- Dialog Nota Kredit/Debit (wizard account.move.reversal) ---------- */

  function openReverse(bill) {
    reversing = { id: bill.id, journalId: bill.journal_id?.[0] };
    openModal(
      config.reverse.title,
      `<form data-form="reverse" class="space-y-4">
         ${fieldBlock("Alasan", `<input data-reverse="reason" value="" placeholder="mis. retur barang" class="${INPUT}">`)}
         ${fieldBlock("Tanggal", `<input type="date" data-reverse="date" value="${esc(today())}" class="${INPUT}">`)}
         <p class="text-xs text-gray-500">Nota dibuat sebagai draft dari faktur ini; periksa lalu konfirmasi. Barang fisik yang dikembalikan diproses terpisah lewat retur pengiriman atau penerimaan.</p>
       </form>`,
      `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
       <button data-action="reverse-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">${esc(config.reverse.label)}</button>`,
      () => {
        reversing = null;
      },
    );
  }

  async function confirmReverse(button) {
    const { id, journalId } = reversing;
    const reason = document.querySelector('[data-reverse="reason"]').value.trim();
    const date = document.querySelector('[data-reverse="date"]').value;
    const context = { active_model: "account.move", active_ids: [id] };
    const created = await guarded(button, async () => {
      const vals = { journal_id: journalId, move_ids: [[6, 0, [id]]], ...(reason ? { reason } : {}), ...(date ? { date } : {}) };
      const [wizard] = await call("account.move.reversal", "create", { vals_list: [vals], context });
      const result = await call("account.move.reversal", "refund_moves", { ids: [wizard], context });
      if (!result?.res_id) throw new Error("Odoo tidak mengembalikan nota yang dibuat. Periksa di Odoo.");
      return result.res_id;
    });
    if (!created) return;
    closeModal();
    toast(config.reverse.success);
    location.hash = `#/${config.reverse.route}/${created}`;
  }

  /* ---------- Simpan dan aksi ---------- */

  const toHtml = (text) => `<p>${esc(text.trim()).replace(/\n/g, "<br>")}</p>`;
  const hasPrice = (l) => String(l.price_unit).trim() !== "";
  const labelOf = (l) => l.name.trim() || l.text.trim() || "baris";

  /** Baris yang dikirim: baris baru yang kosong dilewati, produk harus dipilih dari kotak saran, jumlah harus valid. */
  function resolveLines() {
    const out = [];
    form.lines.forEach((l, i) => {
      const text = l.text.trim();
      if (!l.id && !text && !l.name.trim() && !hasPrice(l)) return; // baris baru yang kosong
      if (text && !(l.product_id && text === l.productText)) throw new Error(`Produk "${text}" belum dipilih dari daftar. Klik produk pada kotak saran.`);
      if (!text) l.product_id = null;
      if (!l.product_id && !l.name.trim()) throw new Error(`Baris ${i + 1}: isi label atau pilih produk.`);
      const quantity = Number(l.quantity);
      if ((!l.id || quantity !== l.initial.quantity) && !(quantity > 0)) throw new Error(`Jumlah untuk "${labelOf(l)}" harus lebih dari 0.`);
      const discount = Number(l.discount || 0);
      if (!(discount >= 0 && discount <= 100)) throw new Error(`Diskon untuk "${labelOf(l)}" harus antara 0 dan 100.`);
      if (l.id && !l.account && l.product_id === l.initial.product_id) throw new Error("Pilih akun dari kotak saran untuk setiap baris.");
      out.push(l);
    });
    return out;
  }

  function newLineValues(l) {
    const vals = { quantity: Number(l.quantity) };
    if (l.product_id) vals.product_id = l.product_id;
    if (l.name.trim()) vals.name = l.name.trim();
    if (hasPrice(l)) vals.price_unit = Number(l.price_unit);
    if (Number(l.discount || 0)) vals.discount = Number(l.discount);
    if (l.account) vals.account_id = l.account.id;
    if (l.profile) vals.asset_profile_id = l.profile;
    const analytic = distributionChange(l.analytic, undefined);
    if (analytic !== undefined) vals.analytic_distribution = analytic;
    const tax = taxChange(l.taxes, undefined, l.taxTouched);
    if (tax !== undefined) vals.tax_ids = tax;
    return vals;
  }

  function changedLineValues(l) {
    const before = l.initial;
    const vals = {};
    if ((l.product_id ?? null) !== before.product_id) vals.product_id = l.product_id || false;
    if (l.name !== before.name) vals.name = l.name;
    if (Number(l.quantity) !== before.quantity) vals.quantity = Number(l.quantity);
    if (Number(l.discount || 0) !== before.discount) vals.discount = Number(l.discount || 0);
    if (hasPrice(l) && Number(l.price_unit) !== Number(l.price_unit0)) vals.price_unit = Number(l.price_unit);
    if (l.account && l.account.id !== l.account0) vals.account_id = l.account.id;
    // Profil aset dihitung dari akun; tulis hanya bila pengguna memilih profil yang berbeda dari isian awal.
    if (l.profile !== l.profile0) vals.asset_profile_id = l.profile || false;
    const analytic = distributionChange(l.analytic, l.analytic0);
    if (analytic !== undefined) vals.analytic_distribution = analytic;
    const tax = taxChange(l.taxes, l.taxes0, l.taxTouched);
    if (tax !== undefined) vals.tax_ids = tax;
    return vals;
  }

  /** Membuat draf baru; mengembalikan id. */
  async function createMove() {
    if (!form.partner) throw new Error(`Pilih ${config.partner.toLowerCase()} dari kotak saran.`);
    const resolved = resolveLines();
    if (!resolved.length) throw new Error("Tambahkan minimal satu baris.");
    const vals = { move_type: config.moveType, partner_id: form.partner.id, invoice_line_ids: resolved.map((l) => [0, 0, newLineValues(l)]) };
    if (Number(form.journal)) vals.journal_id = Number(form.journal);
    if (Number(form.currency)) vals.currency_id = Number(form.currency);
    if (form.ref.trim()) vals.ref = form.ref.trim();
    if (form.invoice_date) vals.invoice_date = form.invoice_date;
    if (Number(form.term)) vals.invoice_payment_term_id = Number(form.term);
    else if (form.invoice_date_due) vals.invoice_date_due = form.invoice_date_due;
    if (form.narration.trim()) vals.narration = toHtml(form.narration);
    if (config.kodeTransaksi && form.kode) vals.l10n_id_kode_transaksi = form.kode;
    const [id] = await call("account.move", "create", { vals_list: [vals] });
    return id;
  }

  /* Hanya field yang berubah yang dikirim: menulis ulang tanggal yang sama dapat memicu Odoo menghitung
   * ulang jatuh tempo dari syarat pembayaran. Baris dikirim sebagai perintah invoice_line_ids. */
  async function persist() {
    const resolved = resolveLines();
    const commands = [];
    for (const l of resolved) {
      if (!l.id) commands.push([0, 0, newLineValues(l)]);
      else {
        const vals = changedLineValues(l);
        if (Object.keys(vals).length) commands.push([1, l.id, vals]);
      }
    }
    commands.push(...form.removed.map((lineId) => [2, lineId, 0]));
    const vals = {};
    for (const key of ["ref", "invoice_date", "date", "invoice_date_due"]) {
      if (form[key] !== form.initial[key]) vals[key] = form[key] || false;
    }
    if (config.kodeTransaksi && form.kode !== form.initial.kode) vals.l10n_id_kode_transaksi = form.kode || false;
    if (form.narration !== form.initial.narration) vals.narration = form.narration.trim() ? toHtml(form.narration) : false;
    if (commands.length) vals.invoice_line_ids = commands;
    if (Object.keys(vals).length) await call("account.move", "write", { ids: [form.id], vals });
  }

  async function onClick(event, el) {
    if (docs?.onClick(el)) return;
    const { action } = el.dataset;
    const id = Number(el.dataset.id) || null;
    const def = BUTTONS.find((b) => b.action === action);

    if (action === "refresh") reload();
    else if (action === "create-menu") document.querySelector("#create-menu")?.classList.toggle("hidden");
    else if (action === "from-docs") {
      document.querySelector("#create-menu")?.classList.add("hidden");
      await docs.open({});
    } else if (action === "discard") form = null;
    else if (action === "add-line") {
      form.lines.push(emptyLine());
      redrawLines();
      document.querySelector(`[data-line="${form.lines.length - 1}"][data-field="text"]`)?.focus();
    } else if (action === "remove-line") {
      const i = Number(el.dataset.line);
      const [gone] = form.lines.splice(i, 1);
      if (gone?.id) form.removed.push(gone.id);
      redrawLines();
    } else if (action === "add-docs") {
      // simpan isian dulu dan muat ulang agar baris dari dokumen ditambahkan ke draf yang sama dengan yang tampil
      const target = { partner: form.partner, move: { id: form.id, currency_id: form.currencyRef } };
      const ok = await guarded(el, async () => {
        await persist();
        return true;
      });
      if (ok) {
        form = null;
        await reload();
        await docs.open(target);
      }
    } else if (action === "save") {
      const saved = await guarded(el, async () => (form.id ? (await persist(), form.id) : createMove()));
      if (saved) {
        const created = !form.id;
        form = null;
        toast(created ? `${config.noun} disimpan sebagai draft.` : "Perubahan disimpan.");
        if (created) location.hash = `#/${config.route}/${saved}`;
        else reload();
      }
    } else if (action === "pay") await openPay(el, id);
    else if (action === "pay-confirm") await confirmPay(el);
    else if (action === "reverse") {
      const bill = await guarded(el, () => readOne("account.move", id, ["journal_id"]));
      if (bill) openReverse({ id, journal_id: bill.journal_id });
    } else if (action === "reverse-confirm") await confirmReverse(el);
    else if (action === "cancel" && !window.confirm(`Batalkan ${config.noun.toLowerCase()} ini?`)) {
      /* dibatalkan pengguna */
    } else if (action === "reset" && !window.confirm(`Kembalikan ${config.noun.toLowerCase()} ke draft?`)) {
      /* dibatalkan pengguna */
    } else if (def?.method) {
      const ok = await guarded(el, async () => {
        if (form?.id === id) {
          if (action === "post" && purchaseSide && !form.invoice_date) throw new Error(`Isi ${config.dateLabel} dulu sebelum konfirmasi.`);
          await persist(); // simpan referensi, tanggal, dan baris sebelum konfirmasi
        }
        return call("account.move", def.method, { ids: [id] });
      });
      if (ok !== undefined) {
        form = null;
        toast(DONE_MESSAGE[action]);
        reload();
      }
    }
  }

  function onInput(event, el) {
    if (docs?.onInput(el)) return;
    if (el.dataset.line !== undefined && el.dataset.field && form) {
      const line = form.lines[Number(el.dataset.line)];
      if (!line) return;
      line[el.dataset.field] = el.value;
      if (el.dataset.field === "text") runLookup(el, 250);
      else if (["quantity", "price_unit", "discount"].includes(el.dataset.field)) {
        const sub = subtotalOf(line);
        const target = document.querySelector(`#sub-${el.dataset.line}`);
        if (target) target.textContent = sub === null ? "-" : money(sub, form.currencyName);
      }
    } else if (el.dataset.value && form) form[el.dataset.value] = el.value;
    else if (el.dataset.lookup === lookupKind && form) {
      const edit = lineAt(el);
      if (edit) edit.account = null; // teks diubah: pilihan lama tidak berlaku sampai memilih dari kotak saran
      runLookup(el, 250);
    } else if (el.dataset.lookup === partnerKind && form) {
      form.partner = null;
      runLookup(el, 250);
    }
  }

  async function onChange(event, el) {
    if (docs?.onChange(el)) return;
    if (el.dataset.value && form) {
      form[el.dataset.value] = el.value;
      if (el.dataset.value === "term") document.querySelector('[data-value="invoice_date_due"]')?.toggleAttribute("disabled", Boolean(el.value));
      if (el.dataset.value === "currency") {
        form.currencyName = refs.currencies.find((c) => c.id === Number(el.value))?.display_name ?? form.currencyName;
        redrawLines();
      }
      return;
    }
    if (el.dataset.lineProfile && form) {
      const edit = form.lines[Number(el.dataset.lineProfile)];
      if (edit) edit.profile = el.value ? Number(el.value) : null;
      return;
    }
    // Mengganti jurnal mengubah metode pembayaran yang tersedia: simpan isian ke wizard lalu muat ulang dialog.
    if (el.dataset.pay === "journal_id" && pay) {
      const { id, context } = pay;
      const vals = wizardValues();
      await guarded(null, async () => {
        await call("account.payment.register", "write", { ids: [id], vals: { journal_id: vals.journal_id, payment_date: vals.payment_date, communication: vals.communication }, context });
        await paymentDialog();
      });
    }
  }

  async function onSubmit(event, formEl, kind) {
    if (kind === "pay") await confirmPay(null);
    else if (kind === "reverse") await confirmReverse(null);
  }

  return { render, onClick, onInput, onChange, onSubmit, leave };
}
