// Pemilih dokumen sumber untuk tagihan vendor dan faktur pelanggan (D48): pilih mitra, lalu centang SATU atau BEBERAPA
// Purchase Order (atau Sales Order) milik mitra itu yang masih punya jumlah untuk ditagih. Pratinjau menampilkan jumlah
// per dokumen dan per baris yang akan ditagih. Hasilnya satu dokumen draf (tagihan atau faktur) untuk semua dokumen terpilih,
// atau, bila dibuka dari draf yang ada, baris-baris dokumen itu ditambahkan ke draf tersebut.
import { INPUT, call, closeModal, dateText, esc, guarded, money, openModal, registerLookup, runLookup, searchRead, toast } from "./common.js";

const KINDS = {
  po: {
    model: "purchase.order", lineModel: "purchase.order.line", label: "Purchase Order", short: "PO", partnerLabel: "Pemasok", moveType: "in_invoice",
    states: ["purchase", "done"], link: "purchase_line_id", billWord: "tagihan", dateField: "date_order",
    receiveHint: "Untuk produk berkebijakan tagihan menurut jumlah diterima, terima barangnya dulu di Receipt; PO yang sudah seluruhnya ditagih tidak ditampilkan.",
    headerFields: ["name", "date_order", "amount_untaxed", "amount_total", "currency_id", "invoice_status", "payment_term_id", "fiscal_position_id", "partner_ref"],
  },
  so: {
    model: "sale.order", lineModel: "sale.order.line", label: "Sales Order", short: "SO", partnerLabel: "Pelanggan", moveType: "out_invoice",
    states: ["sale"], link: "sale_line_ids", billWord: "faktur", dateField: "date_order",
    receiveHint: "Untuk produk berkebijakan faktur menurut jumlah terkirim, kirim barangnya dulu di Delivery; SO yang sudah seluruhnya difakturkan tidak ditampilkan.",
    headerFields: ["name", "date_order", "amount_untaxed", "amount_total", "currency_id", "invoice_status", "payment_term_id", "fiscal_position_id", "client_order_ref"],
  },
};

const LINE_FIELDS = ["order_id", "product_id", "name", "qty_to_invoice", "product_uom_id", "price_unit", "discount", "tax_ids", "price_subtotal", "is_downpayment", "sequence"];

/** Subtotal sebelum pajak untuk jumlah yang akan ditagih pada satu baris dokumen. */
export const lineAmount = (l) => Math.round(l.qty_to_invoice * l.price_unit * (1 - (l.discount || 0) / 100) * 100) / 100;

/** Nilai baris tagihan/faktur dari baris dokumen (padanan _prepare_account_move_line / _prepare_invoice_line di Odoo). */
export function moveLineValues(kind, l) {
  const def = KINDS[kind];
  return {
    display_type: "product",
    name: l.name,
    product_id: l.product_id?.[0] || false,
    product_uom_id: l.product_uom_id?.[0] || false,
    quantity: l.qty_to_invoice,
    discount: l.discount || 0,
    price_unit: l.price_unit,
    tax_ids: [[6, 0, l.tax_ids]],
    [def.link]: kind === "so" ? [[4, l.id]] : l.id,
    ...(l.is_downpayment ? { is_downpayment: true } : {}),
  };
}

/** Pembuat pemilih untuk satu halaman. def: { kind: "po" | "so", route, onCreated(ids), onAdded() }. */
export function createDocPicker(def) {
  const k = KINDS[def.kind];
  const lookupKind = `${def.route}-docpartner`;
  let st = null; // { partner, fixed, move, docs: [], selected: Set, hidden: n, loading }

  registerLookup(lookupKind, {
    search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: `${def.kind === "po" ? "supplier_rank" : "customer_rank"} desc, name` }),
    isChosen: () => Boolean(st?.partner),
    choose: async (input, item) => {
      input.value = item.display_name;
      await loadFor(item);
    },
  });

  async function loadFor(partner) {
    st.partner = partner;
    st.docs = [];
    st.selected = new Set();
    st.hidden = 0;
    st.loading = true;
    paint();
    const stateDomain = ["state", "in", k.states];
    try {
      const docs = await searchRead(k.model, [["partner_id", "=", partner.id], stateDomain, ["invoice_status", "=", "to invoice"]], k.headerFields, { order: `${k.dateField}, id` });
      const lines = docs.length
        ? await searchRead(k.lineModel, [["order_id", "in", docs.map((d) => d.id)], ["display_type", "=", false], ["qty_to_invoice", "!=", 0]], LINE_FIELDS, { order: "order_id, sequence, id" })
        : [];
      for (const d of docs) d.lines = lines.filter((l) => l.order_id[0] === d.id);
      st.docs = docs.filter((d) => d.lines.length);
      st.hidden = await call(k.model, "search_count", { domain: [["partner_id", "=", partner.id], stateDomain, ["invoice_status", "=", "no"]] });
    } catch (error) {
      toast(error.message, "error");
    }
    st.loading = false;
    paint();
  }

  const selectedDocs = () => st.docs.filter((d) => st.selected.has(d.id));
  const docTotal = (d) => d.lines.reduce((sum, l) => sum + lineAmount(l), 0);
  const currencyNames = () => [...new Set(selectedDocs().map((d) => d.currency_id[1]))];

  /** Alasan penolakan (teks Indonesia) atau null bila pilihan boleh diproses. */
  function problem() {
    if (!st.partner) return `Pilih ${k.partnerLabel.toLowerCase()} lebih dulu.`;
    const chosen = selectedDocs();
    if (!chosen.length) return `Centang minimal satu ${k.label}.`;
    const currencies = currencyNames();
    if (currencies.length > 1) return `Mata uang berbeda (${currencies.join(", ")}): satu ${k.billWord} hanya boleh satu mata uang. Hapus centang salah satunya.`;
    if (st.move && currencies[0] !== st.move.currency_id?.[1]) return `Mata uang ${k.label} (${currencies[0]}) berbeda dari ${k.billWord} ini (${st.move.currency_id?.[1]}).`;
    return null;
  }

  function docHtml(d) {
    const rows = d.lines
      .map(
        (l) => `<tr>
          <td class="py-1 pr-3 text-sm">${esc(l.product_id?.[1] ?? l.name)}</td>
          <td class="py-1 px-2 text-sm text-right">${esc(l.qty_to_invoice)}</td>
          <td class="py-1 px-2 text-sm">${esc(l.product_uom_id?.[1] ?? "")}</td>
          <td class="py-1 px-2 text-sm text-right">${money(l.price_unit, d.currency_id[1])}</td>
          <td class="py-1 px-2 text-sm text-right">${l.discount ? `${esc(l.discount)}%` : "-"}</td>
          <td class="py-1 pl-2 text-sm text-right">${money(lineAmount(l), d.currency_id[1])}</td>
        </tr>`,
      )
      .join("");
    const ref = d.partner_ref || d.client_order_ref;
    return `<label class="flex items-start gap-3 border border-gray-200 rounded-lg p-3 cursor-pointer hover:bg-gray-50 ${st.selected.has(d.id) ? "bg-indigo-50 border-indigo-300" : ""}">
      <input type="checkbox" data-dp-doc="${d.id}" ${st.selected.has(d.id) ? "checked" : ""} class="mt-1 rounded border-gray-300 text-indigo-600" aria-label="Pilih ${esc(d.name)}">
      <div class="flex-1 min-w-0">
        <div class="flex flex-wrap justify-between gap-2">
          <div class="text-sm"><span class="font-semibold text-gray-900">${esc(d.name)}</span><span class="text-gray-500"> · ${dateText(d.date_order)}${ref ? ` · ${esc(ref)}` : ""}</span></div>
          <div class="text-sm text-gray-600">Total dokumen ${money(d.amount_total, d.currency_id[1])} · <span class="font-semibold text-gray-900">Ditagih sekarang ${money(docTotal(d), d.currency_id[1])}</span> <span class="text-xs text-gray-500">(sebelum pajak)</span></div>
        </div>
        <table class="mt-2 w-full text-left"><thead><tr>${["Produk", "Jumlah", "Satuan", "Harga", "Diskon", "Subtotal"]
          .map((h, i) => `<th class="pb-1 text-xs font-semibold text-gray-500 uppercase ${[1, 3, 4, 5].includes(i) ? "text-right px-2" : ""}">${h}</th>`)
          .join("")}</tr></thead><tbody>${rows}</tbody></table>
      </div></label>`;
  }

  function emptyHtml() {
    const who = esc(st.partner.display_name);
    const extra = st.hidden ? ` Ada ${st.hidden} ${k.short} terkonfirmasi yang belum punya jumlah untuk ditagih.` : "";
    return `<div class="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm p-3">Tidak ada ${k.label} milik ${who} yang bisa ditagih.${extra} ${esc(k.receiveHint)}</div>`;
  }

  function paint() {
    const box = document.querySelector("#dp-docs");
    const foot = document.querySelector("#dp-foot");
    if (!box || !st) return;
    if (!st.partner) box.innerHTML = `<p class="text-sm text-gray-500">Pilih ${k.partnerLabel.toLowerCase()} untuk melihat ${k.label} yang bisa ditagih.</p>`;
    else if (st.loading) box.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    else if (!st.docs.length) box.innerHTML = emptyHtml();
    else box.innerHTML = `<div class="space-y-2">${st.docs.map(docHtml).join("")}</div>`;
    if (!foot) return;
    const chosen = selectedDocs();
    const why = st.partner && !st.loading && st.docs.length ? problem() : null;
    const sum = chosen.reduce((t, d) => t + docTotal(d), 0);
    const cur = chosen[0]?.currency_id[1];
    foot.innerHTML = `<div class="flex-1 text-sm ${why && chosen.length ? "text-rose-600" : "text-gray-600"}">${
      chosen.length ? (why ? esc(why) : `${chosen.length} ${k.short} dipilih · sebelum pajak <span class="font-semibold text-gray-900">${money(sum, cur)}</span>`) : esc(st.docs.length ? `Centang ${k.label} yang akan ditagih.` : "")
    }</div>
      <button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
      <button data-action="docs-confirm" ${chosen.length && !why ? "" : "disabled"} class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">${st.move ? `Tambahkan ke ${k.billWord} ini` : `Buat ${k.billWord[0].toUpperCase()}${k.billWord.slice(1)}`}</button>`;
  }

  /** Membuka dialog. partner: mitra tetap (mis. dari draf yang ada); move: draf tujuan penambahan ({ id, currency_id }). */
  async function open({ partner = null, move = null } = {}) {
    st = { partner: null, fixed: Boolean(partner), move, docs: [], selected: new Set(), hidden: 0, loading: false };
    const partnerField = partner
      ? `<div><div class="text-xs font-medium text-gray-500 uppercase tracking-wide">${k.partnerLabel}</div><div class="py-2 text-sm font-medium text-gray-900">${esc(partner.display_name)}</div></div>`
      : `<div><div class="text-xs font-medium text-gray-500 uppercase tracking-wide">${k.partnerLabel}</div>
           <input data-lookup="${lookupKind}" autocomplete="off" role="combobox" aria-autocomplete="list" placeholder="Cari atau pilih ${k.partnerLabel.toLowerCase()}..." class="${INPUT}"></div>`;
    openModal(
      move ? `Tambah dari ${k.label}` : `Buat ${k.billWord[0].toUpperCase()}${k.billWord.slice(1)} dari ${k.label}`,
      `${partnerField}
       <p class="text-xs text-gray-500">Centang satu atau beberapa ${k.label} milik ${k.partnerLabel.toLowerCase()} yang sama; semuanya digabung menjadi satu ${k.billWord} draf. Mitra dan mata uang harus sama.</p>
       <div id="dp-docs"></div>`,
      '<div id="dp-foot" class="contents"></div>',
      () => {
        st = null;
      },
      { wide: true },
    );
    paint();
    if (partner) await loadFor(partner);
  }

  async function confirm(button) {
    const why = problem();
    if (why) {
      toast(why, "error");
      return;
    }
    const chosen = selectedDocs();
    const { move } = st;
    const result = await guarded(button, async () => (move ? addToMove(chosen, move) : create(chosen)));
    if (result === undefined) return;
    closeModal();
    if (move) {
      toast(`${chosen.length} ${k.short} ditambahkan ke ${k.billWord} ini.`);
      def.onAdded?.();
    } else {
      toast(result.length > 1 ? `Odoo membuat ${result.length} ${k.billWord} karena alamat atau posisi fiskal dokumen berbeda.` : `${k.billWord[0].toUpperCase()}${k.billWord.slice(1)} dibuat (draft) dari ${chosen.map((d) => d.name).join(", ")}.`);
      def.onCreated(result);
    }
  }

  async function create(chosen) {
    if (def.kind === "po") {
      // Odoo (action_create_invoice) menggabungkan PO satu vendor dan satu mata uang, tetapi ikut membawa baris berjumlah 0;
      // pratinjau di dialog ini hanya memuat baris yang punya jumlah, jadi tagihan dibuat dari baris yang sama persis.
      const first = chosen[0];
      const [moveId] = await call("account.move", "create", {
        vals_list: [{
          move_type: k.moveType, partner_id: st.partner.id, currency_id: first.currency_id[0], invoice_origin: chosen.map((d) => d.name).join(", "),
          ...(first.payment_term_id ? { invoice_payment_term_id: first.payment_term_id[0] } : {}),
          ...(first.fiscal_position_id ? { fiscal_position_id: first.fiscal_position_id[0] } : {}),
          invoice_line_ids: chosen.flatMap((d) => d.lines.map((l) => [0, 0, moveLineValues("po", l)])),
        }],
      });
      return [moveId];
    }
    // Faktur: wizard resmi Odoo (sale.advance.payment.inv); beberapa SO satu pelanggan digabung menjadi satu faktur.
    const ids = chosen.map((d) => d.id);
    const before = await invoiceIds(ids);
    const context = { active_model: "sale.order", active_ids: ids, active_id: ids[0] };
    const [wizard] = await call("sale.advance.payment.inv", "create", { vals_list: [{ advance_payment_method: "delivered" }], context });
    await call("sale.advance.payment.inv", "create_invoices", { ids: [wizard], context });
    const made = (await invoiceIds(ids)).filter((id) => !before.includes(id));
    if (!made.length) throw new Error("Odoo tidak membuat faktur. Periksa Sales Order di Odoo.");
    return made;
  }

  const invoiceIds = async (orderIds) => [...new Set((await call("sale.order", "read", { ids: orderIds, fields: ["invoice_ids"] })).flatMap((o) => o.invoice_ids))];

  async function addToMove(chosen, move) {
    const [current] = await call("account.move", "read", { ids: [move.id], fields: ["invoice_origin", "state"] });
    if (current.state !== "draft") throw new Error("Hanya draf yang bisa ditambah baris dari dokumen.");
    const origins = [...new Set([...(current.invoice_origin || "").split(",").map((s) => s.trim()).filter(Boolean), ...chosen.map((d) => d.name)])];
    await call("account.move", "write", {
      ids: [move.id],
      vals: {
        invoice_line_ids: chosen.flatMap((d) => d.lines.filter((l) => !(def.kind === "so" && l.is_downpayment)).map((l) => [0, 0, moveLineValues(def.kind, l)])),
        invoice_origin: origins.join(", "),
      },
    });
    return true;
  }

  function onClick(el) {
    if (el.dataset.action === "docs-confirm") {
      confirm(el);
      return true;
    }
    return false;
  }

  /** Mengetik di kotak mitra membatalkan pilihan lama sampai memilih lagi dari kotak saran. */
  function onInput(el) {
    if (el.dataset.lookup !== lookupKind || !st) return false;
    st.partner = null;
    st.docs = [];
    st.selected = new Set();
    paint();
    runLookup(el, 250);
    return true;
  }

  function onChange(el) {
    if (!el.dataset.dpDoc || !st) return false;
    const id = Number(el.dataset.dpDoc);
    if (el.checked) st.selected.add(id);
    else st.selected.delete(id);
    paint();
    return true;
  }

  return { open, onClick, onInput, onChange };
}
