// Pembayaran (account.payment). Struktur form mengikuti view Odoo: tombol Confirm, Validate, Reject,
// Reset to Draft, Cancel dengan syarat tampil yang sama; bilah status draft/in_process/paid; dan
// tombol statistik ke tagihan yang dilunasi.
import {
  actionBar, app, badge, call, cell, chatterHtml, dateText, esc, fieldBlock, filterSelect, guarded, journalHtml, loadJournalItems, loadMessages,
  money, pageHeader, readOne, readonlyValue, rowLink, searchRead, statTiles, statusbar, table, toast,
} from "../common.js";

const STATES = {
  draft: ["Draft", "muted"],
  in_process: ["Dalam Proses", "info"],
  paid: ["Dibayar", "success"],
  canceled: ["Dibatalkan", "danger"],
  rejected: ["Ditolak", "danger"],
};
const FLOW = ["draft", "in_process", "paid"];
const TYPES = { outbound: "Pembayaran Keluar", inbound: "Pembayaran Masuk" };

/* Syarat tampil tombol mengikuti view_account_payment_form Odoo. */
const BUTTONS = [
  { action: "post", label: "Konfirmasi", method: "action_post", kind: "primary", show: (p) => p.state === "draft" },
  { action: "validate", label: "Validasi", method: "action_validate", kind: "primary", show: (p) => p.state === "in_process" && !p.move_id },
  { action: "reject", label: "Tolak", method: "action_reject", show: (p) => p.state === "in_process" && p.is_sent },
  { action: "reset", label: "Kembalikan ke Draft", method: "action_draft", show: (p) => p.state !== "draft" },
  { action: "cancel", label: "Batalkan", method: "action_cancel", kind: "danger", show: (p) => p.state === "draft" || (p.state === "in_process" && p.is_sent) },
];
const DONE_MESSAGE = {
  post: "Pembayaran dikonfirmasi.",
  validate: "Pembayaran divalidasi.",
  reject: "Pembayaran ditolak.",
  reset: "Pembayaran dikembalikan ke draft.",
  cancel: "Pembayaran dibatalkan.",
};
const CONFIRM = { reject: "Tolak pembayaran ini?", reset: "Kembalikan pembayaran ke draft? Rekonsiliasi dengan tagihan akan dilepas.", cancel: "Batalkan pembayaran ini?" };

let last = { sub: "", query: new URLSearchParams() };
const reload = () => render(last.sub, last.query);

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const ids = (query.get("ids") ?? "").split(",").map(Number).filter(Boolean);
  const type = ["inbound", "outbound"].includes(query.get("type")) ? query.get("type") : "";
  const domain = [];
  if (type) domain.push(["payment_type", "=", type]);
  if (filter) domain.push(["state", "=", filter]);
  if (ids.length) domain.push(["id", "in", ids]);
  const rows = await searchRead(
    "account.payment",
    domain,
    ["name", "date", "partner_id", "journal_id", "payment_method_line_id", "amount", "currency_id", "state", "payment_type"],
    { order: "id desc", limit: 80 },
  );
  const options = [["", "Semua status"], ...Object.entries(STATES).map(([k, v]) => [k, v[0]])];
  const body = rows
    .map((r) =>
      rowLink(`#/payment/${r.id}`, [
        cell(r.name || "Draft", { strong: true }),
        cell(dateText(r.date)),
        cell(r.partner_id?.[1] ?? ""),
        cell(r.journal_id?.[1] ?? ""),
        cell(r.payment_method_line_id?.[1] ?? ""),
        cell(TYPES[r.payment_type] ?? r.payment_type),
        cell(money(r.amount, r.currency_id?.[1]), { right: true }),
        cell(badge(STATES, r.state), { raw: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      type === "inbound" ? "Pembayaran Pelanggan" : type === "outbound" ? "Pembayaran Vendor" : "Pembayaran",
      `${filterSelect(options, filter)}
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>`,
    ) +
    table(
      [{ label: "Nomor" }, { label: "Tanggal" }, { label: "Mitra" }, { label: "Jurnal" }, { label: "Metode" }, { label: "Tipe" }, { label: "Jumlah", right: true }, { label: "Status" }],
      body,
      "Belum ada pembayaran. Buat dari tagihan vendor atau faktur pelanggan dengan tombol Bayar.",
    );
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const pay = await readOne("account.payment", id, [
    "name", "state", "payment_type", "partner_id", "amount", "currency_id", "date", "memo", "journal_id", "payment_method_line_id",
    "partner_bank_id", "is_sent", "move_id", "reconciled_bill_ids", "reconciled_bills_count", "outstanding_account_id", "destination_account_id",
    "is_matched", "reconciled_invoice_ids", "reconciled_invoices_count",
  ]);
  if (!pay) {
    app.innerHTML = '<p class="text-sm text-rose-600">Pembayaran tidak ditemukan.</p>';
    return;
  }
  const currency = pay.currency_id?.[1];
  const items = await loadJournalItems(pay.move_id?.[0]);
  const unmatched = ["in_process", "paid"].includes(pay.state) && pay.move_id && !pay.is_matched;
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/payment" class="hover:text-indigo-600">Pembayaran</a> / ${esc(pay.name || "Draft")}</div>
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
      <div class="flex flex-wrap gap-2">${actionBar(BUTTONS, pay)}</div>
      ${statusbar(FLOW, STATES, pay.state)}
    </div>
    <div class="flex flex-wrap gap-2 mb-4">${statTiles([
      pay.payment_type === "inbound"
        ? { count: pay.reconciled_invoices_count, label: "Faktur Pelanggan", icon: "fa-file-invoice-dollar", href: `#/invoice?ids=${pay.reconciled_invoice_ids.join(",")}` }
        : { count: pay.reconciled_bills_count, label: "Tagihan Vendor", icon: "fa-file-invoice", href: `#/bill?ids=${pay.reconciled_bill_ids.join(",")}` },
      { count: items.length, label: "Item Jurnal", icon: "fa-book", target: "journal-items" },
    ])}</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(pay.name || "Draft")}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Tipe Pembayaran", readonlyValue(TYPES[pay.payment_type] ?? pay.payment_type))}
      ${fieldBlock(pay.payment_type === "outbound" ? "Pemasok" : "Pelanggan", readonlyValue(pay.partner_id?.[1]))}
      ${fieldBlock("Jumlah", readonlyValue(money(pay.amount, currency)))}
      ${fieldBlock("Tanggal", readonlyValue(dateText(pay.date)))}
      ${fieldBlock("Memo", readonlyValue(pay.memo))}
      ${fieldBlock("Jurnal", readonlyValue(pay.journal_id?.[1]))}
      ${fieldBlock("Metode Pembayaran", readonlyValue(pay.payment_method_line_id?.[1]))}
      ${fieldBlock("Rekening Bank Mitra", readonlyValue(pay.partner_bank_id?.[1]))}
      ${fieldBlock(pay.payment_type === "outbound" ? "Akun Hutang" : "Akun Piutang", readonlyValue(pay.destination_account_id?.[1]))}
      ${fieldBlock("Akun Pembayaran Tertunda", readonlyValue(pay.outstanding_account_id?.[1]))}
    </section>
    ${unmatched
      ? `<p class="mt-3 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">Pembayaran ini belum dicocokkan dengan mutasi bank. Sampai direkonsiliasi, nilainya tercatat di akun pembayaran tertunda, bukan di akun bank.</p>`
      : ""}
    ${journalHtml(items, currency, { journal: pay.journal_id?.[1] })}
    ${chatterHtml("account.payment", id)}`;
  loadMessages("account.payment", id);
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  const def = BUTTONS.find((b) => b.action === action);

  if (action === "refresh") reload();
  else if (CONFIRM[action] && !window.confirm(CONFIRM[action])) {
    /* dibatalkan pengguna */
  } else if (def?.method) {
    const ok = await guarded(el, () => call("account.payment", def.method, { ids: [id] }));
    if (ok !== undefined) {
      toast(DONE_MESSAGE[action]);
      reload();
    }
  }
}
