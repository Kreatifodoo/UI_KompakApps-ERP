// POS Session (pos.session): daftar sesi, ringkasan pembayaran per metode, kas (awal, diterima, diharapkan, dihitung, selisih),
// pesanan, tutup sesi dengan hitung kas, dan jurnal yang tercipta saat sesi ditutup (penjualan, pembayaran, selisih kas).
import {
  INPUT, app, badge, button, call, cell, closeModal, ctx, dateTimeText, esc, fieldBlock, filterSelect, guarded, journalHtml, loadJournalItems, money,
  openModal, pageHeader, readOne, readonlyValue, rowLink, searchBox, searchRead, statTiles, table, toast, chatterHtml, loadMessages,
} from "../common.js";

const STATES = {
  opening_control: ["Kontrol Pembukaan", "warning"],
  opened: ["Berjalan", "success"],
  closing_control: ["Kontrol Penutupan", "warning"],
  closed: ["Ditutup", "muted"],
};
const ORDER_STATES = { draft: ["Baru", "muted"], paid: ["Dibayar", "info"], done: ["Selesai", "success"], invoiced: ["Difaktur", "success"], cancel: ["Dibatalkan", "danger"] };

let last = { sub: "", query: new URLSearchParams() };
let current = null; // sesi yang sedang dibuka, untuk dialog
export const leave = () => {
  current = null;
};
const reload = () => render(last.sub, last.query);

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const text = query.get("q") ?? "";
  const config = Number(query.get("config")) || null;
  const domain = [];
  if (filter) domain.push(["state", "=", filter]);
  if (config) domain.push(["config_id", "=", config]);
  if (text) domain.push("|", ["name", "ilike", text], ["user_id.name", "ilike", text]);
  const rows = await searchRead("pos.session", domain, ["name", "config_id", "user_id", "start_at", "stop_at", "order_count", "total_payments_amount", "state"], { order: "id desc", limit: 100 });
  const body = rows
    .map((r) =>
      rowLink(`#/possession/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(r.config_id[1]),
        cell(r.user_id?.[1] ?? ""),
        cell(r.start_at ? dateTimeText(r.start_at) : "-"),
        cell(r.stop_at ? dateTimeText(r.stop_at) : "-"),
        cell(String(r.order_count), { right: true }),
        cell(money(r.total_payments_amount), { right: true }),
        cell(badge(STATES, r.state), { raw: true }),
      ]),
    )
    .join("");
  const options = [["", "Semua status"], ...Object.entries(STATES).map(([k, v]) => [k, v[0]])];
  app.innerHTML =
    pageHeader("POS Session", `${searchBox(text, "Cari sesi atau kasir")}${filterSelect(options, filter)}`) +
    table(
      [{ label: "Sesi" }, { label: "Stasiun" }, { label: "Kasir" }, { label: "Mulai" }, { label: "Selesai" }, { label: "Pesanan", right: true }, { label: "Pembayaran", right: true }, { label: "Status" }],
      body,
      "Belum ada sesi. Buka sesi dari halaman POS Station.",
    );
}

const FIELDS = [
  "name", "config_id", "user_id", "state", "start_at", "stop_at", "opening_notes", "closing_notes", "cash_control", "cash_register_balance_start", "cash_register_balance_end",
  "cash_register_balance_end_real", "cash_register_difference", "order_count", "total_payments_amount", "move_id", "statement_line_ids", "bank_payment_ids", "picking_ids", "payment_method_ids",
];

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const session = await readOne("pos.session", id, FIELDS);
  if (!session) {
    app.innerHTML = '<p class="text-sm text-rose-600">Sesi tidak ditemukan.</p>';
    return;
  }
  current = session;
  const currency = ctx.company?.currency_id?.[1];
  const [byMethod, orders, methods] = await Promise.all([
    call("pos.payment", "formatted_read_group", { domain: [["session_id", "=", id]], groupby: ["payment_method_id"], aggregates: ["__count", "amount:sum"] }),
    searchRead("pos.order", [["session_id", "=", id]], ["name", "pos_reference", "date_order", "partner_id", "amount_total", "state"], { order: "id desc", limit: 50 }),
    searchRead("pos.payment.method", [["id", "in", session.payment_method_ids]], ["name", "is_cash_count", "type"], { context: { active_test: false } }),
  ]);
  const cashIds = new Set(methods.filter((m) => m.is_cash_count).map((m) => m.id));
  const methodRows = byMethod
    .map((g) => `<tr><td class="py-2 px-4 text-sm">${esc(g.payment_method_id[1])}${cashIds.has(g.payment_method_id[0]) ? ' <span class="ml-1 px-2 py-0.5 rounded-full text-xs bg-emerald-50 text-emerald-700">tunai</span>' : ""}</td>
      <td class="py-2 px-4 text-sm text-right tabular-nums">${g.__count}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(g["amount:sum"], currency))}</td></tr>`)
    .join("");
  const cashPayments = byMethod.filter((g) => cashIds.has(g.payment_method_id[0])).reduce((s, g) => s + g["amount:sum"], 0);
  const cashCard = session.cash_control
    ? `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-5"><div class="text-sm font-semibold mb-3">Kas Laci</div>
        <div class="grid md:grid-cols-5 gap-4">
          ${statCell("Kas awal", money(session.cash_register_balance_start, currency))}
          ${statCell("Penerimaan tunai", money(cashPayments, currency))}
          ${statCell("Diharapkan", money(session.cash_register_balance_end, currency))}
          ${statCell("Dihitung", session.state === "closed" ? money(session.cash_register_balance_end_real, currency) : "-")}
          ${statCell("Selisih", session.state === "closed" ? money(session.cash_register_difference, currency) : "-", session.state === "closed" && Math.abs(session.cash_register_difference) > 0.5 ? "text-rose-700" : "")}
        </div></section>`
    : "";
  const orderRows = orders
    .map((o) => rowLink(`#/posorder/${o.id}`, [cell(o.pos_reference || o.name, { strong: true }), cell(dateTimeText(o.date_order)), cell(o.partner_id?.[1] ?? "-"), cell(money(o.amount_total, currency), { right: true }), cell(badge(ORDER_STATES, o.state), { raw: true })]))
    .join("");
  let journals = "";
  if (session.state === "closed") {
    const lines = session.statement_line_ids.length ? await searchRead("account.bank.statement.line", [["id", "in", session.statement_line_ids]], ["move_id"], { order: "id" }) : [];
    const payments = session.bank_payment_ids.length ? await searchRead("account.payment", [["id", "in", session.bank_payment_ids]], ["move_id"], { order: "id" }) : [];
    const moveIds = [...new Set([session.move_id?.[0], ...lines.map((l) => l.move_id?.[0]), ...payments.map((p) => p.move_id?.[0])].filter(Boolean))];
    const entries = moveIds.length ? await searchRead("account.move", [["id", "in", moveIds]], ["name", "journal_id", "state"], { order: "id" }) : [];
    const sections = await Promise.all(entries.map(async (e) => journalHtml(await loadJournalItems(e.id), currency, { title: e.name, journal: e.journal_id?.[1], state: e.state })));
    journals = `<h2 class="text-lg font-semibold text-gray-900 mt-6">Jurnal Sesi</h2>${sections.join("")}
      <p class="mt-3 text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3">Jurnal tercipta saat sesi ditutup: penjualan dan pajak dikreditkan, pembayaran masuk ke Piutang POS, lalu dipindahkan ke akun kas atau bank metode pembayarannya. Untuk barang yang dilacak stoknya dengan valuasi perpetual, harga pokok didebit dan persediaan dikreditkan pada jurnal yang sama. Selisih hitung kas dijurnal terpisah.</p>`;
  }
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/possession" class="hover:text-indigo-600">POS Session</a> / ${esc(session.name)}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      ${session.state === "opened" ? `<a href="#/kasir?config=${session.config_id[0]}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Lanjutkan Kasir</a>${button("close-session", "Tutup Sesi", "plain", { id: session.id })}` : ""}
      ${session.state === "opening_control" ? button("open-session", "Buka Sesi", "primary", { id: session.id }) : ""}
    </div>
    <div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: session.order_count, label: "Pesanan", icon: "fa-receipt", target: "section-orders" },
      { count: session.picking_ids.length, label: "Pengiriman Stok", icon: "fa-truck", href: `#/delivery?ids=${session.picking_ids.join(",")}` },
    ])}</div>
    <div class="mb-3 flex flex-wrap items-center gap-3"><h1 class="text-2xl font-bold text-gray-900">${esc(session.name)}</h1>${badge(STATES, session.state)}</div>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Stasiun", `<div class="mt-1 py-2 text-sm"><a href="#/posconfig/${session.config_id[0]}" class="text-indigo-700 hover:underline">${esc(session.config_id[1])}</a></div>`)}
      ${fieldBlock("Kasir", readonlyValue(session.user_id?.[1]))}
      ${fieldBlock("Mulai", readonlyValue(session.start_at ? dateTimeText(session.start_at) : ""))}
      ${fieldBlock("Selesai", readonlyValue(session.stop_at ? dateTimeText(session.stop_at) : ""))}
      ${session.opening_notes ? fieldBlock("Catatan Pembukaan", readonlyValue(session.opening_notes)) : ""}
      ${session.closing_notes ? fieldBlock("Catatan Penutupan", readonlyValue(session.closing_notes)) : ""}
    </section>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
      <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Pembayaran per Metode <span class="font-normal text-gray-500">· total ${esc(money(session.total_payments_amount, currency))}</span></div>
      <table class="w-full text-left"><thead class="bg-gray-50"><tr>${["Metode", "Transaksi", "Jumlah"].map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        <tbody class="divide-y divide-gray-100">${methodRows || '<tr><td colspan="3" class="py-6 text-center text-sm text-gray-500">Belum ada pembayaran.</td></tr>'}</tbody></table></section>
    ${cashCard}
    <section id="section-orders" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto">
      <div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Pesanan</div>
      <table class="w-full text-left"><thead class="bg-gray-50"><tr>${["Referensi", "Waktu", "Pelanggan", "Total", "Status"].map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i === 3 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        <tbody class="divide-y divide-gray-100">${orderRows || '<tr><td colspan="5" class="py-6 text-center text-sm text-gray-500">Belum ada pesanan pada sesi ini.</td></tr>'}</tbody></table></section>
    ${journals}
    ${chatterHtml("pos.session", session.id)}`;
  loadMessages("pos.session", session.id);
}

const statCell = (label, value, tone = "") => `<div><div class="text-xs font-medium text-gray-500 uppercase">${esc(label)}</div><div class="text-lg font-semibold mt-1 ${tone}">${esc(value)}</div></div>`;

/* ---------- Tutup sesi ---------- */

async function closeDialog(button) {
  const data = await guarded(button, () => call("pos.session", "get_closing_control_data", { ids: [current.id] }));
  if (!data) return;
  const cash = data.default_cash_details;
  const others = (data.non_cash_payment_methods ?? []).filter((m) => m.number || m.amount);
  openModal(
    "Tutup Sesi",
    `<form data-form="close" class="space-y-3">
       <p class="text-sm text-gray-700">${esc(String(data.orders_details?.quantity ?? 0))} pesanan, total ${esc(money(data.orders_details?.amount ?? 0))}.</p>
       ${cash
         ? `<div class="text-sm text-gray-700">Kas yang seharusnya ada di laci: <b>${esc(money(cash.amount))}</b> (kas awal ${esc(money(cash.opening))} + penerimaan tunai ${esc(money(cash.payment_amount))}).</div>
            ${fieldBlock("Kas yang dihitung", `<input type="number" min="0" step="any" data-close="counted" value="${esc(cash.amount)}" class="${INPUT} text-right">`)}`
         : ""}
       ${others.length ? `<div class="text-sm text-gray-600">Non-tunai: ${others.map((m) => `${esc(m.name)} ${esc(money(m.amount))}`).join(", ")}</div>` : ""}
       ${fieldBlock("Catatan penutupan", `<input data-close="notes" class="${INPUT}" placeholder="opsional">`)}
       <p class="text-xs text-gray-500">Menutup sesi membuat jurnal penjualan dan pembayaran, dan tidak bisa dibatalkan.</p></form>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="close-confirm" data-cash="${cash ? 1 : 0}" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Tutup Sesi</button>`,
  );
}

async function closeSession(button) {
  const hasCash = button.dataset.cash === "1";
  const ok = await guarded(button, async () => {
    if (hasCash) {
      const counted = Number(document.querySelector('[data-close="counted"]').value);
      if (!(counted >= 0)) throw new Error("Kas yang dihitung tidak boleh negatif.");
      const result = await call("pos.session", "post_closing_cash_details", { ids: [current.id], counted_cash: counted });
      if (result && result.successful === false) throw new Error(result.message || "Odoo menolak hitung kas.");
    }
    await call("pos.session", "update_closing_control_state_session", { ids: [current.id], notes: document.querySelector('[data-close="notes"]').value.trim() });
    const closed = await call("pos.session", "close_session_from_ui", { ids: [current.id], bank_payment_method_diff_pairs: [] });
    if (closed && closed.successful === false) throw new Error(closed.message || "Sesi tidak bisa ditutup.");
    return true;
  });
  if (ok) {
    closeModal();
    toast("Sesi ditutup. Jurnal tercatat.");
    reload();
  }
}

async function openSession(button) {
  openModal(
    "Buka Sesi",
    `<form data-form="open" class="space-y-3">${fieldBlock("Kas awal (uang di laci)", `<input type="number" min="0" step="any" data-open="cash" value="0" class="${INPUT} text-right">`)}
       ${fieldBlock("Catatan pembukaan", `<input data-open="notes" class="${INPUT}" placeholder="opsional">`)}</form>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="open-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Buka Sesi</button>`,
  );
  return button;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "close-session") await closeDialog(el);
  else if (action === "close-confirm") await closeSession(el);
  else if (action === "open-session") await openSession(el);
  else if (action === "open-confirm") {
    const ok = await guarded(el, async () => {
      await call("pos.session", "set_opening_control", { ids: [current.id], cashbox_value: Number(document.querySelector('[data-open="cash"]').value || 0), notes: document.querySelector('[data-open="notes"]').value.trim() });
      return true;
    });
    if (ok) {
      closeModal();
      toast("Sesi dibuka.");
      reload();
    }
  }
}
