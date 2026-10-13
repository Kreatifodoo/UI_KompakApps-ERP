// Pembayaran (account.payment). Struktur form mengikuti view Odoo: tombol Confirm, Validate, Reject,
// Reset to Draft, Cancel dengan syarat tampil yang sama; bilah status draft/in_process/paid; dan
// tombol statistik ke tagihan yang dilunasi.
import {
  INPUT, actionBar, app, badge, call, cell, chatterHtml, ctx, dateText, esc, fieldBlock, filterSelect, guarded, journalHtml, loadJournalItems, loadMessages,
  money, pageHeader, readOne, readonlyValue, referenceCurrencies, registerLookup, rowLink, runLookup, searchRead, selectOptions, statTiles, statusbar, table, toast, today,
} from "../common.js";
import { createPayPicker } from "../paydocs.js";
import { printButton } from "../print.js";

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

/* Pembayaran baru (D49): berdiri sendiri (form di halaman ini) atau dari tagihan vendor / faktur pelanggan terbuka (pemilih di paydocs.js). */
const NEW = {
  outbound: { title: "Pembayaran Vendor Baru", partner: "Pemasok", partnerType: "supplier", rank: "supplier_rank", docsLabel: "Tagihan Vendor", back: "Pembayaran Vendor" },
  inbound: { title: "Penerimaan Pembayaran Pelanggan Baru (Receipt)", partner: "Pelanggan", partnerType: "customer", rank: "customer_rank", docsLabel: "Faktur Pelanggan", back: "Pembayaran Pelanggan" },
};
const partnerKind = "payment-new-partner";
let form = null; // { type, partner, amount, date, journal, method, currency, memo, journals, methods, currencies }
let allocTarget = null; // pembayaran yang bisa dialokasikan pada form yang tampil
const pickers = Object.fromEntries(
  ["outbound", "inbound"].map((type) => [
    type,
    createPayPicker({
      type,
      onCreated: (id) => {
        location.hash = `#/payment/${id}`;
      },
      onAllocated: () => reload(),
    }),
  ]),
);

registerLookup(partnerKind, {
  search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: `${NEW[form?.type ?? "outbound"].rank} desc, name` }),
  isChosen: (input) => form?.partner?.display_name === input.value,
  choose: (input, item) => {
    form.partner = item;
    input.value = item.display_name;
  },
});

export function leave() {
  form = null;
  allocTarget = null;
}

export async function render(sub, query) {
  last = { sub, query };
  form = null;
  allocTarget = null;
  if (sub === "") return renderList(query);
  if (sub === "new" && NEW[query.get("type")]) return renderNew(query.get("type"));
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
  const createMenu = type
    ? `<div class="relative">
         <button data-action="create-menu" aria-haspopup="menu" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-1"></i>Buat <i class="fas fa-caret-down ml-1"></i></button>
         <div id="create-menu" role="menu" class="hidden absolute right-0 mt-1 w-60 bg-white border border-gray-200 rounded-lg shadow-lg z-30 py-1 text-sm">
           <a href="#/payment/new?type=${type}" role="menuitem" class="block px-4 py-2 hover:bg-indigo-50">Berdiri sendiri</a>
           <button data-action="from-docs" data-type="${type}" role="menuitem" class="block w-full text-left px-4 py-2 hover:bg-indigo-50">Dari ${esc(NEW[type].docsLabel)}</button>
         </div>
       </div>`
    : "";
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
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
       ${createMenu}`,
    ) +
    table(
      [{ label: "Nomor" }, { label: "Tanggal" }, { label: "Mitra" }, { label: "Jurnal" }, { label: "Metode" }, { label: "Tipe" }, { label: "Jumlah", right: true }, { label: "Status" }],
      body,
      type ? "Belum ada pembayaran. Klik Buat untuk membuat pembayaran berdiri sendiri atau dari dokumen." : "Belum ada pembayaran. Buat dari tagihan vendor atau faktur pelanggan dengan tombol Bayar.",
    );
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const pay = await readOne("account.payment", id, [
    "name", "state", "payment_type", "partner_id", "amount", "currency_id", "date", "memo", "journal_id", "payment_method_line_id",
    "partner_bank_id", "is_sent", "move_id", "reconciled_bill_ids", "reconciled_bills_count", "outstanding_account_id", "destination_account_id",
    "is_matched", "reconciled_invoice_ids", "reconciled_invoices_count", "partner_type",
  ]);
  if (!pay) {
    app.innerHTML = '<p class="text-sm text-rose-600">Pembayaran tidak ditemukan.</p>';
    return;
  }
  const currency = pay.currency_id?.[1];
  const items = await loadJournalItems(pay.move_id?.[0]);
  const unmatched = ["in_process", "paid"].includes(pay.state) && pay.move_id && !pay.is_matched;
  allocTarget = await loadAllocTarget(pay);
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/payment" class="hover:text-indigo-600">Pembayaran</a> / ${esc(pay.name || "Draft")}</div>
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
      <div class="flex flex-wrap gap-2">${actionBar(BUTTONS, pay)}${printButton("account.payment", pay.id)}</div>
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
    ${allocTarget
      ? `<div class="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-indigo-900 bg-indigo-50 border border-indigo-200 rounded-lg px-4 py-3">
           <span>Belum dialokasikan ke ${esc(NEW[pay.payment_type].docsLabel.toLowerCase())}: <span class="font-semibold">${money(allocTarget.residual, allocTarget.currencyName)}</span>. Alokasikan agar dokumen yang dibayar berstatus Dibayar atau Dibayar Sebagian.</span>
           <button data-action="allocate-open" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Alokasikan ke ${esc(NEW[pay.payment_type].docsLabel)}</button>
         </div>`
      : ""}
    ${journalHtml(items, currency, { journal: pay.journal_id?.[1] })}
    ${chatterHtml("account.payment", id)}`;
  loadMessages("account.payment", id);
}

/** Pembayaran diposting dengan mitra (pemasok untuk keluar, pelanggan untuk masuk) yang baris hutang/piutangnya belum direkonsiliasi penuh. */
async function loadAllocTarget(pay) {
  const fits = (pay.payment_type === "outbound" && pay.partner_type === "supplier") || (pay.payment_type === "inbound" && pay.partner_type === "customer");
  if (!fits || !pay.partner_id || !pay.move_id || !["in_process", "paid"].includes(pay.state)) return null;
  const [line] = await searchRead(
    "account.move.line",
    [["move_id", "=", pay.move_id[0]], ["account_type", "in", ["asset_receivable", "liability_payable"]], ["reconciled", "=", false]],
    ["amount_residual", "amount_residual_currency", "currency_id"],
  );
  if (!line) return null;
  const local = !line.currency_id || line.currency_id[0] === ctx.company?.currency_id?.[0];
  const residual = Math.round(Math.abs(local ? line.amount_residual : line.amount_residual_currency) * 100) / 100;
  if (residual < 0.005) return null;
  return {
    id: pay.id, type: pay.payment_type, name: pay.name, partner: { id: pay.partner_id[0], display_name: pay.partner_id[1] }, lineId: line.id, residual,
    currencyId: line.currency_id?.[0] ?? pay.currency_id?.[0], currencyName: line.currency_id?.[1] ?? pay.currency_id?.[1],
  };
}

/* ---------- Pembayaran berdiri sendiri (form baru) ---------- */

async function loadMethods() {
  form.methods = form.journal
    ? await searchRead("account.payment.method.line", [["journal_id", "=", Number(form.journal)], ["payment_type", "=", form.type]], ["display_name"], { order: "sequence, id" })
    : [];
  form.method = form.methods[0]?.id ?? "";
}

async function renderNew(type) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const [journals, currencies] = await Promise.all([
    searchRead("account.journal", [["type", "in", ["bank", "cash", "credit"]], [`${type}_payment_method_line_ids`, "!=", false]], ["display_name"], { order: "sequence, code" }),
    referenceCurrencies(),
  ]);
  form = { type, partner: null, amount: "", date: today(), journal: journals[0]?.id ?? "", method: "", currency: "", memo: "", journals, methods: [], currencies };
  await loadMethods();
  const def = NEW[type];
  const methodOptions = () => selectOptions(form.methods, Number(form.method) || null);
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/payment?type=${type}" class="hover:text-indigo-600">${def.back}</a> / Baru</div>
    <div class="mb-3"><h1 class="text-2xl font-bold text-gray-900">${def.title}</h1></div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock(def.partner, `<input data-lookup="${partnerKind}" autocomplete="off" role="combobox" aria-autocomplete="list" placeholder="Cari atau pilih ${def.partner.toLowerCase()}..." class="${INPUT}">`)}
      ${fieldBlock("Jumlah", `<input type="number" min="0" step="any" data-value="amount" value="" class="${INPUT} text-right">`)}
      ${fieldBlock("Tanggal", `<input type="date" data-value="date" value="${esc(form.date)}" class="${INPUT}">`)}
      ${fieldBlock("Jurnal", `<select data-value="journal" class="${INPUT}">${selectOptions(journals, Number(form.journal) || null)}</select>`)}
      ${fieldBlock("Metode Pembayaran", `<select data-value="method" id="pay-method" class="${INPUT}">${methodOptions()}</select>`)}
      ${fieldBlock("Mata Uang", `<select data-value="currency" class="${INPUT}">${selectOptions(currencies, null, `Mengikuti jurnal (${ctx.company?.currency_id?.[1] ?? ""})`)}</select>`)}
      <div class="md:col-span-2">${fieldBlock("Memo", `<input data-value="memo" value="" placeholder="mis. uang muka, pelunasan, nomor kuitansi" class="${INPUT}">`)}</div>
    </section>
    <p class="text-xs text-gray-500 mt-3">Pembayaran berdiri sendiri tidak langsung melunasi dokumen. Setelah dikonfirmasi, gunakan tombol Alokasikan di halaman pembayaran (atau Bank Transaction) untuk mencocokkannya ke ${esc(def.docsLabel.toLowerCase())}.</p>
    <div class="flex gap-2 mt-4">
      <button data-action="save-draft" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium hover:bg-gray-50">Simpan Draf</button>
      <button data-action="save-post" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan dan Konfirmasi</button>
      <a href="#/payment?type=${type}" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
    </div>`;
}

/** Alasan penolakan (teks Indonesia) atau null bila isian boleh disimpan. */
function formProblem() {
  const def = NEW[form.type];
  if (!form.partner) return `Pilih ${def.partner.toLowerCase()} dari kotak saran.`;
  if (!(Number(form.amount) > 0)) return "Jumlah pembayaran harus lebih dari 0.";
  if (!form.date) return "Isi tanggal pembayaran.";
  if (!form.journal) return "Pilih jurnal bank atau kas.";
  if (!form.method) return "Pilih metode pembayaran.";
  return null;
}

async function savePayment(button, post) {
  const why = formProblem();
  if (why) {
    toast(why, "error");
    return;
  }
  const def = NEW[form.type];
  let postError = null;
  const id = await guarded(button, async () => {
    const [created] = await call("account.payment", "create", {
      vals_list: [{
        payment_type: form.type, partner_type: def.partnerType, partner_id: form.partner.id, amount: Number(form.amount), date: form.date,
        journal_id: Number(form.journal), payment_method_line_id: Number(form.method),
        ...(form.currency ? { currency_id: Number(form.currency) } : {}), ...(form.memo.trim() ? { memo: form.memo.trim() } : {}),
      }],
    });
    if (post) {
      try {
        await call("account.payment", "action_post", { ids: [created] });
      } catch (error) {
        postError = error;
      }
    }
    return created;
  });
  if (!id) return;
  form = null;
  if (postError) toast(`Draf tersimpan, tetapi konfirmasi gagal: ${postError.message}`, "error");
  else toast(post ? "Pembayaran dibuat dan dikonfirmasi." : "Pembayaran disimpan sebagai draf.");
  location.hash = `#/payment/${id}`;
}

export async function onClick(event, el) {
  if (pickers.outbound.onClick(el) || pickers.inbound.onClick(el)) return;
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  const def = BUTTONS.find((b) => b.action === action);

  if (action === "refresh") reload();
  else if (action === "create-menu") document.querySelector("#create-menu")?.classList.toggle("hidden");
  else if (action === "from-docs") {
    document.querySelector("#create-menu")?.classList.add("hidden");
    await pickers[el.dataset.type].open();
  } else if (action === "allocate-open") {
    if (allocTarget) await pickers[allocTarget.type].open({ payment: allocTarget });
  } else if (action === "save-draft") await savePayment(el, false);
  else if (action === "save-post") await savePayment(el, true);
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

export function onInput(event, el) {
  if (pickers.outbound.onInput(el) || pickers.inbound.onInput(el)) return;
  if (!form) return;
  if (el.dataset.lookup === partnerKind) {
    form.partner = null; // teks diubah: pilihan lama tidak berlaku sampai memilih dari kotak saran
    runLookup(el, 250);
  } else if (el.dataset.value) form[el.dataset.value] = el.value;
}

export async function onChange(event, el) {
  if (await pickers.outbound.onChange(el)) return;
  if (await pickers.inbound.onChange(el)) return;
  if (!form || !el.dataset.value) return;
  form[el.dataset.value] = el.value;
  if (el.dataset.value === "journal") {
    await guarded(null, loadMethods);
    const select = document.querySelector("#pay-method");
    if (select) select.innerHTML = selectOptions(form.methods, Number(form.method) || null);
  }
}
