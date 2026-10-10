// Faktur: tagihan vendor (account.move, in_invoice) dan faktur pelanggan (out_invoice) memakai satu kerangka,
// dibedakan oleh konfigurasi. Struktur form mengikuti view Odoo: tombol Confirm, Pay, Cancel, Reset to Draft;
// bilah status draft/posted; status pembayaran; total, sisa; item jurnal; dan dialog "Register Payment"
// yang memakai wizard account.payment.register (arah pembayaran mengikuti jenis faktur).
import {
  ACCOUNT_TYPE_LABELS, INPUT, actionBar, app, badge, call, cell, chatterHtml, closeLookup, closeModal, dateText, esc, fieldBlock, filterSelect, guarded,
  journalHtml, loadJournalItems, loadMessages, money, openModal, pageHeader, readOne, readonlyValue, referenceAssetProfiles, referenceSelection,
  registerLookup, rowLink, runLookup, searchAccounts, searchRead, selectOptions, statTiles, statusbar, table, toast, today,
} from "../common.js";

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
  empty: "Belum ada tagihan vendor. Buat dari Purchase Order dengan tombol Buat Tagihan.",
};
export const INVOICE = {
  route: "invoice", moveType: "out_invoice", title: "Faktur Pelanggan", noun: "Faktur", partner: "Pelanggan", partnerFilter: "per pelanggan",
  refLabel: "Referensi Pelanggan", dateLabel: "Tanggal Faktur", residualLabel: "Sisa Faktur", linesTitle: "Baris Faktur", payLabel: "Terima Pembayaran",
  origin: { model: "sale.order", route: "sale", label: "Sales Order", icon: "fa-cart-shopping" },
  assets: false, kodeTransaksi: true, reverse: { label: "Nota Kredit", route: "creditnote", title: "Buat Nota Kredit Pelanggan", success: "Nota kredit pelanggan dibuat (draft)." },
  empty: "Belum ada faktur pelanggan. Buat dari Sales Order dengan tombol Buat Faktur.",
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

  let form = null; // { id, ref, invoice_date, date, invoice_date_due, kode, lines: Map(id -> { account, profile }), initialLines }
  let pay = null; // { id wizard, context, billId }
  let reversing = null; // { id, journalId }
  let last = { sub: "", query: new URLSearchParams() };
  const reload = () => render(last.sub, last.query);
  const leave = () => {
    form = null;
    pay = null;
    reversing = null;
  };

  // Akun baris bisa diganti saat draft (mis. ke akun Aset Tetap agar profil aset dan aset terbentuk).
  const lineEdit = (input) => form?.lines?.get(Number(input.dataset.line));
  registerLookup(lookupKind, {
    search: (q) => searchAccounts(q),
    sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
    isChosen: (input) => lineEdit(input)?.account?.display_name === input.value,
    choose: (input, item) => {
      lineEdit(input).account = item;
      input.value = item.display_name;
    },
  });

  async function render(sub, query) {
    last = { sub, query };
    if (sub === "") return renderList(query);
    return renderForm(Number(sub));
  }

  async function renderList(query) {
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
    app.innerHTML =
      pageHeader(
        config.title,
        `${filterSelect(options, filter)}
         <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>`,
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

  async function renderForm(id) {
    closeLookup();
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    const profiles = config.assets ? await referenceAssetProfiles() : null; // null bila modul aset tidak terpasang
    const kodeOptions = config.kodeTransaksi ? await referenceSelection("account.move", "l10n_id_kode_transaksi") : [];
    const bill = await readOne("account.move", id, [
      "name", "state", "payment_state", "move_type", "partner_id", "ref", "invoice_date", "date", "invoice_date_due", "invoice_payment_term_id",
      "journal_id", "currency_id", "invoice_origin", "amount_untaxed", "amount_tax", "amount_total", "amount_residual", "matched_payment_ids",
      "show_reset_to_draft_button", ...(profiles ? ["asset_count"] : []),
      ...(config.kodeTransaksi ? ["l10n_id_kode_transaksi", "l10n_id_coretax_document", "invoice_user_id"] : []),
      "reversed_entry_id", "reversal_move_ids",
    ]);
    if (!bill || bill.move_type !== config.moveType) {
      app.innerHTML = `<p class="text-sm text-rose-600">${config.noun} tidak ditemukan.</p>`;
      return;
    }
    const lines = await searchRead(
      "account.move.line",
      [["move_id", "=", id], ["display_type", "=", "product"]],
      ["product_id", "name", "account_id", "quantity", "product_uom_id", "price_unit", "discount", "tax_ids", "price_subtotal", ...(profiles ? ["asset_profile_id"] : [])],
      { order: "sequence, id" },
    );
    const items = await loadJournalItems(id);
    const taxIds = [...new Set(lines.flatMap((l) => l.tax_ids))];
    const taxes = taxIds.length ? await searchRead("account.tax", [["id", "in", taxIds]], ["display_name"]) : [];
    const taxName = new Map(taxes.map((t) => [t.id, t.display_name]));
    const origins = (bill.invoice_origin ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const orders = origins.length ? await searchRead(config.origin.model, [["name", "in", origins]], ["id"]) : [];

    const editable = bill.state === "draft";
    const currency = bill.currency_id?.[1];
    if (editable && form?.id !== id) {
      const values = {
        ref: bill.ref || "", invoice_date: bill.invoice_date || "", date: bill.date || "", invoice_date_due: bill.invoice_date_due || "",
        kode: bill.l10n_id_kode_transaksi || "",
      };
      const edits = new Map(
        lines.map((l) => [l.id, { account: l.account_id ? { id: l.account_id[0], display_name: l.account_id[1] } : null, profile: l.asset_profile_id?.[0] ?? null }]),
      );
      form = { id, ...values, initial: { ...values }, lines: edits, initialLines: new Map([...edits].map(([k, v]) => [k, { ...v }])) };
    }
    const dateInput = (key, label) => fieldBlock(label, `<input type="date" data-value="${key}" value="${esc(form[key])}" class="${INPUT}">`);
    const kodeField = !config.kodeTransaksi
      ? ""
      : editable
        ? fieldBlock("Kode Transaksi Faktur Pajak", `<select data-value="kode" class="${INPUT}"><option value="">-</option>${kodeOptions.map(([k, label]) => `<option value="${esc(k)}" ${k === form.kode ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`)
        : fieldBlock("Kode Transaksi Faktur Pajak", readonlyValue(kodeOptions.find(([k]) => k === bill.l10n_id_kode_transaksi)?.[1] ?? bill.l10n_id_kode_transaksi));
    const coretax = config.kodeTransaksi && bill.l10n_id_coretax_document ? fieldBlock("Dokumen e-Faktur (Coretax)", readonlyValue(bill.l10n_id_coretax_document[1])) : "";
    const salesperson = config.kodeTransaksi ? fieldBlock("Salesperson", readonlyValue(bill.invoice_user_id?.[1])) : "";
    const fields = editable
      ? `${fieldBlock(config.partner, readonlyValue(bill.partner_id?.[1]))}
         ${fieldBlock(config.refLabel, `<input data-value="ref" value="${esc(form.ref)}" class="${INPUT}">`)}
         ${dateInput("invoice_date", config.dateLabel)}
         ${dateInput("date", "Tanggal Akuntansi")}
         ${dateInput("invoice_date_due", "Jatuh Tempo")}
         ${fieldBlock("Jurnal", readonlyValue(bill.journal_id?.[1]))}
         ${salesperson}${kodeField}${coretax}`
      : `${fieldBlock(config.partner, readonlyValue(bill.partner_id?.[1]))}
         ${fieldBlock(config.refLabel, readonlyValue(bill.ref))}
         ${fieldBlock(config.dateLabel, readonlyValue(bill.invoice_date ? dateText(bill.invoice_date) : ""))}
         ${fieldBlock("Tanggal Akuntansi", readonlyValue(dateText(bill.date)))}
         ${fieldBlock("Jatuh Tempo", readonlyValue(bill.invoice_date_due ? dateText(bill.invoice_date_due) : ""))}
         ${fieldBlock("Jurnal", readonlyValue(bill.journal_id?.[1]))}
         ${salesperson}${kodeField}${coretax}`;

    const accountCell = (l) =>
      editable
        ? `<input data-lookup="${lookupKind}" data-line="${l.id}" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(form.lines.get(l.id)?.account?.display_name ?? "")}" placeholder="Cari akun..." class="${INPUT}" aria-label="Akun untuk ${esc(l.name)}">`
        : esc(l.account_id?.[1]);
    const profileCell = (l) =>
      editable
        ? `<select data-line-profile="${l.id}" class="${INPUT}" aria-label="Profil aset untuk ${esc(l.name)}">${selectOptions(profiles, form.lines.get(l.id)?.profile ?? null, "-")}</select>`
        : esc(l.asset_profile_id?.[1] ?? "-");
    const showDiscount = lines.some((l) => l.discount);
    const rows = lines
      .map(
        (l) => `<tr class="align-top">
          <td class="py-2 px-4 text-sm">${esc(l.product_id?.[1])}</td>
          <td class="py-2 px-4 text-sm">${esc(l.name)}</td>
          <td class="py-2 px-4 text-sm min-w-56">${accountCell(l)}</td>
          ${profiles ? `<td class="py-2 px-4 text-sm min-w-40">${profileCell(l)}</td>` : ""}
          <td class="py-2 px-4 text-sm text-right">${esc(l.quantity)}</td>
          <td class="py-2 px-4 text-sm">${esc(l.product_uom_id?.[1])}</td>
          <td class="py-2 px-4 text-sm text-right">${money(l.price_unit, currency)}</td>
          ${showDiscount ? `<td class="py-2 px-4 text-sm text-right">${l.discount ? `${esc(l.discount)}%` : "-"}</td>` : ""}
          <td class="py-2 px-4 text-sm">${esc(l.tax_ids.map((t) => taxName.get(t)).filter(Boolean).join(", ") || "-")}</td>
          <td class="py-2 px-4 text-sm text-right">${money(l.price_subtotal, currency)}</td>
        </tr>`,
      )
      .join("");
    const columns = ["Produk", "Label", "Akun", ...(profiles ? ["Profil Aset"] : []), "Jumlah", "Satuan", "Harga", ...(showDiscount ? ["Diskon"] : []), "Pajak", "Subtotal"];
    const rightAligned = columns.filter((c) => ["Jumlah", "Harga", "Diskon", "Subtotal"].includes(c));
    const saveBar = editable
      ? `<div class="flex gap-2 mt-4">
           <button data-action="save" data-id="${id}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
         </div>` : "";

    app.innerHTML = `
      <div class="text-sm text-gray-500 mb-2"><a href="#/${config.route}" class="hover:text-indigo-600">${config.title}</a> / ${esc(bill.name || "Draft")}</div>
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
        <div class="flex flex-wrap gap-2">${actionBar(BUTTONS, bill)}</div>
        ${statusbar(FLOW, STATES, bill.state)}
      </div>
      <div class="flex flex-wrap gap-2 mb-4">${statTiles([
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
      ])}</div>
      <div class="mb-3"><div class="text-sm text-gray-500">${config.title}</div>
        <h1 class="text-2xl font-bold text-gray-900">${esc(bill.name || "Draft")}</h1>
        ${bill.state === "posted" ? `<div class="mt-2">${badge(PAYMENT_STATES, bill.payment_state)}</div>` : ""}</div>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">${fields}</section>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto">
        <div class="text-sm font-semibold mb-3">${config.linesTitle}</div>
        <table class="w-full text-left"><thead class="bg-gray-50"><tr>${columns
          .map((h) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${rightAligned.includes(h) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
          <tbody class="divide-y divide-gray-100">${rows}</tbody></table>
        <div class="mt-4 ml-auto w-full max-w-xs text-sm space-y-1">
          <div class="flex justify-between"><span class="text-gray-500">Sebelum Pajak</span><span>${money(bill.amount_untaxed, currency)}</span></div>
          <div class="flex justify-between"><span class="text-gray-500">Pajak</span><span>${money(bill.amount_tax, currency)}</span></div>
          <div class="flex justify-between border-t border-gray-200 pt-1 font-semibold"><span>Total</span><span>${money(bill.amount_total, currency)}</span></div>
          ${bill.state === "posted" ? `<div class="flex justify-between"><span class="text-gray-500">${config.residualLabel}</span><span id="residual" class="font-semibold">${money(bill.amount_residual, currency)}</span></div>` : ""}
        </div>
        ${saveBar}
      </section>
      ${journalHtml(items, currency, { journal: bill.journal_id?.[1], state: bill.state })}
      ${chatterHtml("account.move", id)}`;
    loadMessages("account.move", id);
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

  async function persistLines() {
    for (const [lineId, edit] of form.lines) {
      const before = form.initialLines.get(lineId);
      if (!edit.account) throw new Error("Pilih akun dari kotak saran untuk setiap baris.");
      if (edit.account.id !== before.account?.id) await call("account.move.line", "write", { ids: [lineId], vals: { account_id: edit.account.id } });
      // Profil aset dihitung dari akun; tulis hanya bila pengguna memilih profil yang berbeda dari isian awal.
      if (edit.profile !== before.profile) await call("account.move.line", "write", { ids: [lineId], vals: { asset_profile_id: edit.profile || false } });
    }
  }

  /* Hanya field yang berubah yang dikirim: menulis ulang tanggal yang sama dapat memicu Odoo menghitung
   * ulang jatuh tempo dari syarat pembayaran. */
  async function persist() {
    await persistLines();
    const vals = {};
    for (const key of ["ref", "invoice_date", "date", "invoice_date_due"]) {
      if (form[key] !== form.initial[key]) vals[key] = form[key] || false;
    }
    if (config.kodeTransaksi && form.kode !== form.initial.kode) vals.l10n_id_kode_transaksi = form.kode || false;
    if (Object.keys(vals).length) {
      await call("account.move", "write", { ids: [form.id], vals });
      Object.assign(form.initial, { ...Object.fromEntries(["ref", "invoice_date", "date", "invoice_date_due", "kode"].map((k) => [k, form[k]])) });
    }
  }

  async function onClick(event, el) {
    const { action } = el.dataset;
    const id = Number(el.dataset.id) || null;
    const def = BUTTONS.find((b) => b.action === action);

    if (action === "refresh") reload();
    else if (action === "save") {
      const ok = await guarded(el, async () => {
        await persist();
        return true;
      });
      if (ok) {
        form = null;
        toast("Perubahan disimpan.");
        reload();
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
        if (form?.id === id) await persist(); // simpan referensi dan tanggal sebelum konfirmasi
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
    if (el.dataset.value && form) form[el.dataset.value] = el.value;
    else if (el.dataset.lookup === lookupKind && form) {
      const edit = lineEdit(el);
      if (edit) edit.account = null; // teks diubah: pilihan lama tidak berlaku sampai memilih dari kotak saran
      runLookup(el, 250);
    }
  }

  async function onChange(event, el) {
    if (el.dataset.value && form) {
      form[el.dataset.value] = el.value;
      return;
    }
    if (el.dataset.lineProfile && form) {
      const edit = form.lines.get(Number(el.dataset.lineProfile));
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
