// Pemilih tagihan vendor / faktur pelanggan untuk pembayaran (D49): pilih mitra, lalu centang SATU atau BEBERAPA dokumen
// terbuka milik mitra itu. Dua mode:
//  - "create": satu pembayaran untuk total pilihan (atau jumlah lebih kecil: pelunasan sebagian menurut urutan jatuh tempo)
//    lewat wizard account.payment.register (group_payment), dengan pratinjau alokasi per dokumen;
//  - "allocate": pembayaran berdiri sendiri yang sudah diposting dicocokkan ke dokumen terpilih (rekonsiliasi baris
//    hutang/piutang pembayaran dengan baris dokumen) menurut urutan jatuh tempo.
import { INPUT, call, closeModal, dateText, esc, guarded, money, openModal, registerLookup, runLookup, searchRead, toast, today } from "./common.js";

const KINDS = {
  outbound: {
    moveType: "in_invoice", label: "Tagihan Vendor", noun: "tagihan", partnerLabel: "Pemasok", rank: "supplier_rank", title: "Bayar dari Tagihan Vendor", confirm: "Buat Pembayaran",
  },
  inbound: {
    moveType: "out_invoice", label: "Faktur Pelanggan", noun: "faktur", partnerLabel: "Pelanggan", rank: "customer_rank", title: "Terima Pembayaran dari Faktur Pelanggan", confirm: "Buat Penerimaan",
  },
};

const DOC_FIELDS = ["name", "ref", "invoice_date", "invoice_date_due", "amount_total", "amount_residual", "currency_id", "invoice_origin"];
const round2 = (n) => Math.round(n * 100) / 100;

/** Urutan alokasi seperti rekonsiliasi Odoo: jatuh tempo, lalu jumlah (tagihan: terbesar dulu; faktur: terkecil dulu), lalu id. */
export function sortForAllocation(docs, type) {
  const sign = type === "outbound" ? -1 : 1;
  return [...docs].sort((a, b) => {
    const da = a.invoice_date_due || a.invoice_date || "9999-12-31";
    const db = b.invoice_date_due || b.invoice_date || "9999-12-31";
    return da.localeCompare(db) || sign * (a.amount_total - b.amount_total) || a.id - b.id;
  });
}

/** Membagi jumlah ke dokumen menurut urutan; hasil per dokumen { doc, alloc, rest } dan sisa jumlah yang tidak terpakai. */
export function planAllocation(docs, type, amount) {
  let left = round2(amount);
  const rows = sortForAllocation(docs, type).map((doc) => {
    const alloc = Math.max(0, Math.min(round2(doc.amount_residual), left));
    left = round2(left - alloc);
    return { doc, alloc, rest: round2(doc.amount_residual - alloc) };
  });
  return { rows, unused: left };
}

/** Pembuat pemilih untuk satu halaman. def: { type, onCreated(paymentId), onAllocated() }. */
export function createPayPicker(def) {
  const k = KINDS[def.type];
  const lookupKind = `payment-${def.type}-docpartner`;
  let st = null;
  // st: { mode, partner, fixed, payment, docs, selected:Set, hidden, loading, journals, methods, form:{amount,date,journal,method,memo,touched} }

  registerLookup(lookupKind, {
    search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: `${k.rank} desc, name` }),
    isChosen: () => Boolean(st?.partner),
    choose: async (input, item) => {
      input.value = item.display_name;
      await loadFor(item);
    },
  });

  const allocating = () => st?.mode === "allocate";
  const selectedDocs = () => st.docs.filter((d) => st.selected.has(d.id));
  const totalOf = (docs) => round2(docs.reduce((t, d) => t + d.amount_residual, 0));
  const currencyNames = () => [...new Set(selectedDocs().map((d) => d.currency_id[1]))];
  const amountNumber = () => (String(st.form.amount).trim() === "" ? 0 : Number(st.form.amount));
  const budget = () => (allocating() ? st.payment.residual : amountNumber());

  async function loadFor(partner) {
    st.partner = partner;
    st.docs = [];
    st.selected = new Set();
    st.hidden = 0;
    st.loading = true;
    paint();
    const base = [["partner_id", "=", partner.id], ["move_type", "=", k.moveType], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]], ["amount_residual", ">", 0]];
    try {
      const sameCurrency = allocating() ? [["currency_id", "=", st.payment.currencyId]] : [];
      st.docs = await searchRead("account.move", [...base, ...sameCurrency], DOC_FIELDS, { order: "invoice_date_due, id" });
      if (allocating()) st.hidden = await call("account.move", "search_count", { domain: [...base, ["currency_id", "!=", st.payment.currencyId]] });
    } catch (error) {
      toast(error.message, "error");
    }
    st.loading = false;
    syncAmount();
    paint();
  }

  /** Jumlah otomatis = total terbuka dokumen terpilih, selama pengguna belum mengetiknya sendiri. */
  function syncAmount() {
    if (allocating() || st.form.touched) return;
    const total = totalOf(selectedDocs());
    st.form.amount = total > 0 ? String(total) : "";
    const input = document.querySelector('[data-pd="amount"]');
    if (input) input.value = st.form.amount;
  }

  /** Alasan penolakan (teks Indonesia) atau null bila pilihan boleh diproses. */
  function problem() {
    if (!st.partner) return `Pilih ${k.partnerLabel.toLowerCase()} lebih dulu.`;
    const chosen = selectedDocs();
    if (!chosen.length) return `Centang minimal satu ${k.label.toLowerCase()}.`;
    const currencies = currencyNames();
    if (currencies.length > 1) return `Mata uang berbeda (${currencies.join(", ")}): satu pembayaran hanya boleh satu mata uang. Hapus centang salah satunya.`;
    if (allocating()) return null;
    const amount = amountNumber();
    if (!(amount > 0)) return "Jumlah pembayaran harus lebih dari 0.";
    const total = totalOf(chosen);
    if (amount > total + 0.004) return `Jumlah ${money(amount, currencies[0])} melebihi total terbuka ${money(total, currencies[0])}. Untuk membayar lebih, buat pembayaran berdiri sendiri lalu alokasikan.`;
    if (!st.form.journal) return "Pilih jurnal bank atau kas.";
    if (!st.form.method) return "Pilih metode pembayaran.";
    if (!st.form.date) return "Isi tanggal pembayaran.";
    return null;
  }

  const plan = () => planAllocation(selectedDocs(), def.type, budget());

  function docsHtml() {
    const allocRows = new Map(currencyNames().length > 1 ? [] : plan().rows.map((r) => [r.doc.id, r])); // campuran mata uang: tanpa pratinjau
    const allChecked = st.docs.length > 0 && st.docs.every((d) => st.selected.has(d.id));
    const th = (text, right) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-500 uppercase ${right ? "text-right" : ""}">${text}</th>`;
    const head = [
      th(`<label class="flex items-center gap-2 cursor-pointer"><input type="checkbox" data-pd-all ${allChecked ? "checked" : ""} class="rounded border-gray-300 text-indigo-600" aria-label="Pilih semua"> Nomor</label>`),
      th("Tanggal"), th("Jatuh Tempo"), th("Total", true), th("Sisa Terbuka", true), th("Dibayar", true), th("Sisa Setelah", true),
    ].join("");
    const rows = st.docs
      .map((d) => {
        const on = st.selected.has(d.id);
        const row = allocRows.get(d.id);
        const overdue = d.invoice_date_due && d.invoice_date_due < today();
        const cur = d.currency_id[1];
        let paid = "-";
        let rest = "-";
        if (on && row) {
          paid = row.alloc > 0 ? `<span class="font-semibold text-gray-900">${money(row.alloc, cur)}</span>` : '<span class="text-amber-700">tidak ikut dibayar</span>';
          rest = row.alloc > 0 ? (row.rest > 0.004 ? `<span class="text-amber-700">${money(row.rest, cur)} (sebagian)</span>` : '<span class="text-emerald-700">Lunas</span>') : money(d.amount_residual, cur);
        }
        return `<tr class="${on ? "bg-indigo-50" : "hover:bg-gray-50"}">
          <td class="py-2 px-2 text-sm"><label class="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" data-pd-doc="${d.id}" ${on ? "checked" : ""} class="rounded border-gray-300 text-indigo-600" aria-label="Pilih ${esc(d.name)}">
            <span><span class="font-medium text-gray-900">${esc(d.name)}</span>${d.ref ? `<span class="block text-xs text-gray-500">${esc(d.ref)}</span>` : ""}</span></label></td>
          <td class="py-2 px-2 text-sm text-gray-600 whitespace-nowrap">${dateText(d.invoice_date)}</td>
          <td class="py-2 px-2 text-sm whitespace-nowrap ${overdue ? "text-rose-600 font-medium" : "text-gray-600"}">${dateText(d.invoice_date_due)}${overdue ? " (lewat)" : ""}</td>
          <td class="py-2 px-2 text-sm text-right text-gray-600 whitespace-nowrap">${money(d.amount_total, cur)}</td>
          <td class="py-2 px-2 text-sm text-right text-gray-900 whitespace-nowrap">${money(d.amount_residual, cur)}</td>
          <td class="py-2 px-2 text-sm text-right whitespace-nowrap">${paid}</td>
          <td class="py-2 px-2 text-sm text-right whitespace-nowrap">${rest}</td>
        </tr>`;
      })
      .join("");
    return `<div class="overflow-x-auto"><table class="w-full text-left"><thead><tr>${head}</tr></thead><tbody class="divide-y divide-gray-100">${rows}</tbody></table></div>${
      st.hidden ? `<p class="mt-2 text-xs text-gray-500">Ada ${st.hidden} ${k.noun} terbuka dengan mata uang lain yang tidak ditampilkan.</p>` : ""
    }`;
  }

  function emptyHtml() {
    const who = esc(st.partner.display_name);
    const extra = st.hidden ? ` Ada ${st.hidden} ${k.noun} terbuka dengan mata uang lain yang tidak ditampilkan.` : "";
    return `<div class="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 text-sm p-3">Tidak ada ${k.label.toLowerCase()} terbuka milik ${who}.${extra} Hanya dokumen yang sudah diposting dan masih punya sisa yang ditampilkan.</div>`;
  }

  function previewHtml() {
    if (!st.partner || st.loading || !st.docs.length) return "";
    const chosen = selectedDocs();
    if (!chosen.length || currencyNames().length > 1) return "";
    const cur = chosen[0].currency_id[1];
    const { rows, unused } = plan();
    const total = totalOf(chosen);
    const paidNow = round2(rows.reduce((t, r) => t + r.alloc, 0));
    const skipped = rows.filter((r) => r.alloc === 0).length;
    const bits = [
      `Total terbuka dokumen terpilih <span class="font-semibold text-gray-900">${money(total, cur)}</span>`,
      allocating() ? `Pembayaran belum dialokasikan <span class="font-semibold text-gray-900">${money(st.payment.residual, cur)}</span>` : `Dibayar sekarang <span class="font-semibold text-gray-900">${money(paidNow, cur)}</span>`,
      `Sisa terbuka setelahnya <span class="font-semibold text-gray-900">${money(round2(total - paidNow), cur)}</span>`,
    ];
    if (allocating() && unused > 0.004) bits.push(`Tetap belum dialokasikan <span class="font-semibold text-gray-900">${money(unused, cur)}</span>`);
    const note = skipped
      ? `<p class="mt-1 text-xs text-amber-800">${skipped} ${k.noun} dengan jatuh tempo paling akhir tidak kebagian dan tidak ikut diproses; pelunasan sebagian mengikuti urutan jatuh tempo.</p>`
      : "";
    return `<div class="rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-600 p-3">${bits.join(" · ")}${note}</div>`;
  }

  function fieldsHtml() {
    if (allocating()) return "";
    const options = (rows, selected) => rows.map((r) => `<option value="${r.id}" ${r.id === selected ? "selected" : ""}>${esc(r.display_name)}</option>`).join("");
    const label = (text, body) => `<label class="block"><span class="block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">${text}</span>${body}</label>`;
    return `<div class="grid sm:grid-cols-2 gap-3">
      ${label("Jumlah dibayar", `<input type="number" min="0" step="any" data-pd="amount" value="${esc(st.form.amount)}" placeholder="Otomatis dari pilihan" class="${INPUT} text-right">`)}
      ${label("Tanggal pembayaran", `<input type="date" data-pd="date" value="${esc(st.form.date)}" class="${INPUT}">`)}
      ${label("Jurnal", `<select data-pd="journal" class="${INPUT}">${options(st.journals, st.form.journal)}</select>`)}
      ${label("Metode pembayaran", `<select data-pd="method" id="pd-method" class="${INPUT}">${options(st.methods, st.form.method)}</select>`)}
      <div class="sm:col-span-2">${label("Memo", `<input data-pd="memo" value="${esc(st.form.memo)}" placeholder="Kosong = otomatis dari referensi ${k.noun}" class="${INPUT}">`)}</div>
    </div>
    <p class="text-xs text-gray-500">Jumlah lebih kecil dari total melunasi dokumen menurut urutan jatuh tempo; sisanya tetap terbuka.</p>`;
  }

  function paint() {
    const box = document.querySelector("#pd-docs");
    const foot = document.querySelector("#pd-foot");
    if (!box || !st) return;
    if (!st.partner) box.innerHTML = `<p class="text-sm text-gray-500">Pilih ${k.partnerLabel.toLowerCase()} untuk melihat ${k.label.toLowerCase()} yang masih terbuka.</p>`;
    else if (st.loading) box.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    else if (!st.docs.length) box.innerHTML = emptyHtml();
    else box.innerHTML = docsHtml();
    const preview = document.querySelector("#pd-preview");
    if (preview) preview.innerHTML = previewHtml();
    if (!foot) return;
    const chosen = selectedDocs();
    const why = st.partner && !st.loading && st.docs.length ? problem() : null;
    foot.innerHTML = `<div class="flex-1 text-sm ${why && chosen.length ? "text-rose-600" : "text-gray-600"}">${
      chosen.length ? (why ? esc(why) : `${chosen.length} ${k.noun} dipilih`) : esc(st.docs.length ? `Centang ${k.label.toLowerCase()} yang akan dibayar.` : "")
    }</div>
      <button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
      <button data-action="pd-confirm" ${chosen.length && !why ? "" : "disabled"} class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">${allocating() ? "Alokasikan" : k.confirm}</button>`;
  }

  async function loadMethods() {
    st.methods = st.form.journal
      ? await searchRead("account.payment.method.line", [["journal_id", "=", Number(st.form.journal)], ["payment_type", "=", def.type]], ["display_name"], { order: "sequence, id" })
      : [];
    st.form.method = st.methods[0]?.id ?? "";
  }

  /** Membuka dialog. Mode "create" dari daftar; mode "allocate" dari pembayaran (payment: { id, name, partner, lineId, residual, currencyId, currencyName }). */
  async function open({ payment = null } = {}) {
    st = { mode: payment ? "allocate" : "create", partner: null, fixed: Boolean(payment), payment, docs: [], selected: new Set(), hidden: 0, loading: false, journals: [], methods: [], form: { amount: "", date: today(), journal: "", method: "", memo: "", touched: false } };
    const ok = await guarded(null, async () => {
      if (!payment) {
        const direction = `${def.type}_payment_method_line_ids`;
        st.journals = await searchRead("account.journal", [["type", "in", ["bank", "cash", "credit"]], [direction, "!=", false]], ["display_name", "currency_id"], { order: "sequence, code" });
        st.form.journal = st.journals[0]?.id ?? "";
        await loadMethods();
      }
      return true;
    });
    if (!ok) {
      st = null;
      return;
    }
    const partnerField = payment
      ? `<div><div class="text-xs font-medium text-gray-500 uppercase tracking-wide">${k.partnerLabel}</div><div class="py-2 text-sm font-medium text-gray-900">${esc(payment.partner.display_name)}</div></div>`
      : `<div><div class="text-xs font-medium text-gray-500 uppercase tracking-wide">${k.partnerLabel}</div>
           <input data-lookup="${lookupKind}" autocomplete="off" role="combobox" aria-autocomplete="list" placeholder="Cari atau pilih ${k.partnerLabel.toLowerCase()}..." class="${INPUT}"></div>`;
    openModal(
      payment ? `Alokasikan ${payment.name} ke ${k.label}` : k.title,
      `${partnerField}
       <p class="text-xs text-gray-500">Centang satu atau beberapa ${k.label.toLowerCase()} milik ${k.partnerLabel.toLowerCase()} yang sama; semuanya dibayar dengan satu ${allocating() ? "alokasi" : "pembayaran"}. Mata uang harus sama.</p>
       ${allocating() ? `<div class="rounded-lg bg-indigo-50 border border-indigo-200 text-sm text-indigo-900 p-3">Pembayaran <span class="font-semibold">${esc(payment.name)}</span> belum dialokasikan sebesar <span class="font-semibold">${money(payment.residual, payment.currencyName)}</span>. Centang ${k.label.toLowerCase()} yang akan dilunasi; jumlah dibagi menurut urutan jatuh tempo.</div>` : ""}
       <div id="pd-docs"></div><div id="pd-preview"></div>${fieldsHtml()}`,
      '<div id="pd-foot" class="contents"></div>',
      () => {
        st = null;
      },
      { wide: true },
    );
    paint();
    if (payment) await loadFor(payment.partner);
  }

  async function confirm(button) {
    const why = problem();
    if (why) {
      toast(why, "error");
      return;
    }
    const { rows } = plan();
    const used = rows.filter((r) => r.alloc > 0).map((r) => r.doc);
    const { mode, payment, form } = st;
    const result = await guarded(button, async () => (mode === "allocate" ? allocate(payment, used) : pay(used, form)));
    if (result === undefined) return;
    closeModal();
    if (mode === "allocate") {
      toast(`Pembayaran dialokasikan ke ${used.length} ${k.noun}.`);
      def.onAllocated?.();
    } else {
      toast(`Pembayaran dibuat untuk ${used.length} ${k.noun}.`);
      def.onCreated(result);
    }
  }

  /** Wizard resmi Odoo: satu pembayaran (group_payment) untuk semua dokumen yang kebagian. Mengembalikan id pembayaran. */
  async function pay(used, form) {
    const context = { active_model: "account.move", active_ids: used.map((d) => d.id) };
    const vals = {
      group_payment: true,
      journal_id: Number(form.journal),
      payment_method_line_id: Number(form.method),
      payment_date: form.date,
      amount: round2(amountNumber()),
      ...(form.memo.trim() ? { communication: form.memo.trim() } : {}),
    };
    const [wizard] = await call("account.payment.register", "create", { vals_list: [vals], context });
    const [info] = await call("account.payment.register", "read", { ids: [wizard], fields: ["can_edit_wizard"], context });
    if (!info.can_edit_wizard) throw new Error(`${k.label} terpilih punya rekening bank atau mata uang berbeda sehingga tidak bisa digabung menjadi satu pembayaran. Pilih yang sama atau bayar satu per satu.`);
    const action = await call("account.payment.register", "action_create_payments", { ids: [wizard], context });
    if (!action?.res_id) throw new Error("Odoo membuat lebih dari satu pembayaran atau tidak mengembalikan pembayaran. Periksa di daftar pembayaran.");
    return action.res_id;
  }

  /** Rekonsiliasi baris hutang/piutang pembayaran dengan baris dokumen, satu dokumen per langkah menurut urutan jatuh tempo. */
  async function allocate(payment, used) {
    for (const doc of used) {
      const lines = await searchRead("account.move.line", [["move_id", "=", doc.id], ["account_type", "in", ["asset_receivable", "liability_payable"]], ["reconciled", "=", false]], ["id"]);
      if (!lines.length) continue;
      await call("account.move.line", "reconcile", { ids: [payment.lineId, ...lines.map((l) => l.id)] });
    }
    return true;
  }

  function onClick(el) {
    if (st && el.dataset.action === "pd-confirm") {
      confirm(el);
      return true;
    }
    return false;
  }

  /** Mengetik di kotak mitra membatalkan pilihan lama; kolom jumlah dan memo dicatat tanpa menggambar ulang kolomnya. */
  function onInput(el) {
    if (!st) return false;
    if (el.dataset.lookup === lookupKind) {
      st.partner = null;
      st.docs = [];
      st.selected = new Set();
      st.form.touched = false;
      paint();
      runLookup(el, 250);
      return true;
    }
    if (el.dataset.pd === "amount") {
      st.form.amount = el.value;
      st.form.touched = true;
      paint();
      return true;
    }
    if (el.dataset.pd === "memo") {
      st.form.memo = el.value;
      return true;
    }
    return false;
  }

  async function onChange(el) {
    if (!st) return false;
    if (el.dataset.pdDoc) {
      const id = Number(el.dataset.pdDoc);
      if (el.checked) st.selected.add(id);
      else st.selected.delete(id);
      syncAmount();
      paint();
      return true;
    }
    if (el.dataset.pdAll !== undefined) {
      st.selected = el.checked ? new Set(st.docs.map((d) => d.id)) : new Set();
      syncAmount();
      paint();
      return true;
    }
    if (el.dataset.pd === "date") {
      st.form.date = el.value;
      paint();
      return true;
    }
    if (el.dataset.pd === "method") {
      st.form.method = Number(el.value) || "";
      paint();
      return true;
    }
    if (el.dataset.pd === "journal") {
      st.form.journal = Number(el.value) || "";
      await guarded(null, loadMethods);
      const select = document.querySelector("#pd-method");
      if (select) select.innerHTML = st.methods.map((r) => `<option value="${r.id}" ${r.id === st.form.method ? "selected" : ""}>${esc(r.display_name)}</option>`).join("");
      paint();
      return true;
    }
    return false;
  }

  return { open, onClick, onInput, onChange };
}
