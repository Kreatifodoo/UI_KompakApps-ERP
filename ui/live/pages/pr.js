// Purchase Request (OCA purchase.request). Struktur form mengikuti view Odoo/OCA: tombol header menurut
// status dan hak manager, bilah status, tombol statistik, field yang hanya bisa diedit saat draft
// (is_editable), kolom barang, total estimasi, dan chatter.
import {
  PRODUCT_PAGE, searchProducts,
  INPUT, app, actionBar, badge, call, cell, chatterHtml, closeLookup, ctx, dateText, esc, fieldBlock, filterSelect, guarded, loadMessages,
  money, pageHeader, readOne, readonlyValue, registerLookup, rowLink, runLookup, scopeNote, searchRead, selectOptions, statTiles, statusbar, table,
  toast, today, referenceUsers,
} from "../common.js";
import { analyticCell, distributionChange, preloadAnalytic, readDistribution, registerAnalytic } from "../analyticpick.js";
import { printButton } from "../print.js";

const STATES = {
  draft: ["Draft", "muted"],
  to_approve: ["Menunggu Persetujuan", "warning"],
  approved: ["Disetujui", "success"],
  in_progress: ["Dalam Proses", "success"],
  done: ["Selesai", "success"],
  rejected: ["Ditolak", "danger"],
};
const FLOW = ["draft", "to_approve", "approved", "in_progress", "done"]; // urutan statusbar Odoo
const PURCHASE_STATES = {
  draft: ["RFQ", "muted"],
  sent: ["RFQ Terkirim", "info"],
  "to approve": ["Menunggu Persetujuan", "warning"],
  to_approve: ["Menunggu Persetujuan", "warning"],
  purchase: ["Purchase Order", "info"],
  done: ["Terkunci", "success"],
  cancel: ["Dibatalkan", "danger"],
  cancelled: ["Dibatalkan", "danger"],
};

/* Tombol header Odoo (view_purchase_request_form). Method null = ditangani khusus. */
const BUTTONS = [
  { action: "reset", label: "Reset ke Draft", method: "button_draft", states: ["to_approve", "approved", "rejected", "in_progress", "done"], manager: true },
  { action: "request", label: "Ajukan Persetujuan", method: "button_to_approve", states: ["draft"], kind: "primary" },
  { action: "approve", label: "Setujui", method: "button_approved", states: ["to_approve"], manager: true, kind: "primary" },
  { action: "progress", label: "Tandai Dalam Proses", method: "button_in_progress", states: ["approved"], manager: true },
  { action: "rfq", label: "Buat RFQ", method: null, states: ["approved", "in_progress"] },
  { action: "done", label: "Selesai", method: "button_done", states: ["approved", "in_progress"], manager: true, kind: "primary" },
  { action: "reject", label: "Tolak", method: "button_rejected", states: ["to_approve", "approved", "in_progress"], manager: true },
].map((b) => ({ ...b, show: (rec) => b.states.includes(rec.state) && (!b.manager || ctx.flags.prManager) }));
const DONE_MESSAGE = {
  request: "Purchase Request diajukan.",
  approve: "Purchase Request disetujui.",
  progress: "Ditandai dalam proses.",
  done: "Purchase Request selesai.",
  reject: "Purchase Request ditolak.",
  reset: "Dikembalikan ke draft.",
};

let form = null; // keadaan form yang sedang diedit (baru atau draft)
let vendorChoice = null; // pemasok yang dipilih untuk Buat RFQ
let pickingTypes = null;
let last = { sub: "", query: new URLSearchParams() };

export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

/* ---------- Kotak saran ---------- */

registerLookup("pr-product", {
  pageSize: PRODUCT_PAGE,
  search: (q, _input, page) => searchProducts(q, page, { domain: [["purchase_ok", "=", true]], fields: ["display_name", "uom_id", "description_purchase"] }),
  sub: (r) => r.uom_id?.[1] ?? "",
  isChosen: (input) => {
    const line = form?.lines[Number(input.dataset.line)];
    return Boolean(line?.product_id) && line.productText === input.value;
  },
  choose: (input, item) => {
    const i = Number(input.dataset.line);
    const line = form.lines[i];
    Object.assign(line, {
      text: item.display_name, productText: item.display_name, product_id: item.id,
      product_uom_id: item.uom_id[0], uom_label: item.uom_id[1],
    });
    if (!line.name || line.name === line.lastAutoName) line.name = item.description_purchase || item.display_name;
    line.lastAutoName = line.name;
    document.querySelector("#lines-box").innerHTML = linesTable();
    document.querySelector(`[data-line="${i}"][data-field="product_qty"]`)?.focus();
  },
});
registerLookup("pr-vendor", {
  search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: "name" }),
  isChosen: (input) => vendorChoice?.display_name === input.value,
  choose: (input, item) => {
    vendorChoice = item;
    input.value = item.display_name;
  },
});

/* ---------- Render ---------- */

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") ?? "";
  const rows = await searchRead(
    "purchase.request",
    filter ? [["state", "=", filter]] : [],
    ["name", "date_start", "requested_by", "origin", "estimated_cost", "currency_id", "state"],
    { order: "id desc", limit: 80 },
  );
  const options = [["", "Semua status"], ...Object.entries(STATES).map(([k, v]) => [k, v[0]])];
  const body = rows
    .map((r) =>
      rowLink(`#/pr/${r.id}`, [
        cell(r.name, { strong: r.state !== "rejected" }),
        cell(dateText(r.date_start)),
        cell(r.requested_by?.[1] ?? ""),
        cell(r.origin || "-"),
        cell(money(r.estimated_cost, r.currency_id?.[1]), { right: true }),
        cell(badge(STATES, r.state), { raw: true }),
      ]),
    )
    .join("");
  app.innerHTML =
    pageHeader(
      "Purchase Request",
      `${filterSelect(options, filter)}
       <button data-action="refresh" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50" aria-label="Muat ulang"><i class="fas fa-rotate"></i></button>
       <a href="#/pr/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Buat Baru</a>`,
    ) +
    (await scopeNote("purchase")) +
    table(
      [{ label: "Nomor" }, { label: "Tanggal Mulai" }, { label: "Diminta oleh" }, { label: "Dokumen Sumber" }, { label: "Estimasi Biaya", right: true }, { label: "Status" }],
      body,
      "Belum ada Purchase Request.",
    );
}

registerAnalytic("pr", {
  get: (i) => form?.lines[Number(i)]?.analytic ?? {},
  set: (i, dist) => {
    form.lines[Number(i)].analytic = dist;
    document.querySelector("#lines-box").innerHTML = linesTable();
  },
  label: (i) => form?.lines[Number(i)]?.text ?? "",
});

const emptyLine = () => ({
  id: null, text: "", product_id: null, productText: "", name: "", product_qty: 1,
  product_uom_id: null, uom_label: "", date_required: today(), estimated_cost: 0, analytic: undefined, // undefined = tidak disentuh
});

function linesTable() {
  const rows = form.lines
    .map(
      (l, i) => `<tr class="align-top">
        <td class="py-2 pr-2 min-w-48"><input data-lookup="pr-product" autocomplete="off" role="combobox" aria-autocomplete="list" data-line="${i}" data-field="text" value="${esc(l.text)}" placeholder="Cari atau pilih produk..." class="${INPUT}"></td>
        <td class="py-2 px-2 min-w-40"><input data-line="${i}" data-field="name" value="${esc(l.name)}" class="${INPUT}"></td>
        <td class="py-2 px-2 w-24"><input type="number" min="0" step="any" data-line="${i}" data-field="product_qty" value="${esc(l.product_qty)}" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 w-24 text-sm text-gray-600">${esc(l.uom_label || "-")}</td>
        <td class="py-2 px-2 w-40"><input type="date" data-line="${i}" data-field="date_required" value="${esc(l.date_required)}" class="${INPUT}"></td>
        <td class="py-2 px-2 w-36"><input type="number" min="0" step="any" data-line="${i}" data-field="estimated_cost" value="${esc(l.estimated_cost)}" class="${INPUT} text-right"></td>
        <td class="py-2 px-2 w-48">${analyticCell("pr", i, l.analytic)}</td>
        <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="remove-line" data-line="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus baris"><i class="fas fa-trash-alt"></i></button></td>
      </tr>`,
    )
    .join("");
  return `<table class="w-full text-left">
      <thead><tr>${["Produk", "Deskripsi", "Jumlah", "Satuan", "Tanggal Diminta", "Estimasi Biaya", "Analitik", ""]
        .map((h, i) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase ${i === 2 || i === 5 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody>${rows}</tbody></table>
    <button type="button" data-action="add-line" class="mt-2 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah baris</button>`;
}

function readonlyLinesTable(lines, currency) {
  const rows = lines
    .map(
      (l) => `<tr class="${l.cancelled ? "text-gray-400" : ""}">
        <td class="py-2 px-4 text-sm">${esc(l.product_id?.[1])}</td>
        <td class="py-2 px-4 text-sm">${esc(l.name)}</td>
        <td class="py-2 px-4 text-sm text-right">${esc(l.product_qty)}</td>
        <td class="py-2 px-4 text-sm">${esc(l.product_uom_id?.[1])}</td>
        <td class="py-2 px-4 text-sm">${dateText(l.date_required)}</td>
        <td class="py-2 px-4 text-sm text-right">${money(l.estimated_cost, currency)}</td>
        <td class="py-2 px-4 text-sm">${analyticCell("pr", l.id, l.analytic_distribution, false)}</td>
        <td class="py-2 px-4 text-sm text-right">${esc(l.purchased_qty)}</td>
        <td class="py-2 px-4 text-sm">${l.purchase_state ? badge(PURCHASE_STATES, l.purchase_state) : ""}</td>
      </tr>`,
    )
    .join("");
  return `<table class="w-full text-left">
      <thead class="bg-gray-50"><tr>${["Produk", "Deskripsi", "Jumlah", "Satuan", "Tanggal Diminta", "Estimasi Biaya", "Analitik", "Dipesan", "Status Pembelian"]
        .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${[2, 5, 7].includes(i) ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${rows}</tbody></table>`;
}

async function renderForm(id) {
  vendorChoice = null;
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const users = await referenceUsers();
  await preloadAnalytic();
  pickingTypes ??= await searchRead("stock.picking.type", [["code", "=", "incoming"]], ["display_name"], { limit: 50 });
  let pr = null;
  let lines = [];
  let rfqs = [];
  if (id) {
    pr = await readOne("purchase.request", id, [
      "name", "state", "requested_by", "assigned_to", "origin", "description", "date_start", "picking_type_id", "company_id",
      "is_editable", "line_count", "purchase_count", "move_count", "estimated_cost", "currency_id",
    ]);
    if (!pr) {
      app.innerHTML = '<p class="text-sm text-rose-600">Purchase Request tidak ditemukan.</p>';
      return;
    }
    [lines, rfqs] = await Promise.all([
      searchRead("purchase.request.line", [["request_id", "=", id]],
        ["product_id", "name", "product_qty", "product_uom_id", "date_required", "estimated_cost", "purchased_qty", "purchase_state", "cancelled", "analytic_distribution"], { order: "id" }),
      searchRead("purchase.order", [["order_line.purchase_request_lines.request_id", "=", id]],
        ["name", "partner_id", "state", "amount_untaxed", "amount_tax", "amount_total", "currency_id"]),
    ]);
  }
  const editable = !pr || pr.is_editable;
  const currency = pr?.currency_id?.[1] ?? ctx.company.currency_id?.[1] ?? "IDR";

  if (editable && (!form || form.id !== (pr?.id ?? null))) {
    form = pr
      ? {
          id: pr.id,
          values: {
            requested_by: pr.requested_by?.[0] ?? null, assigned_to: pr.assigned_to?.[0] ?? null, origin: pr.origin || "",
            description: pr.description || "", date_start: pr.date_start || "", picking_type_id: pr.picking_type_id?.[0] ?? null,
          },
          lines: lines.map((l) => ({
            id: l.id, text: l.product_id?.[1] ?? "", productText: l.product_id?.[1] ?? "", product_id: l.product_id?.[0] ?? null,
            name: l.name || "", product_qty: l.product_qty, product_uom_id: l.product_uom_id?.[0] ?? null,
            uom_label: l.product_uom_id?.[1] ?? "", date_required: l.date_required || "", estimated_cost: l.estimated_cost,
            analytic: readDistribution(l.analytic_distribution), analytic0: readDistribution(l.analytic_distribution),
          })),
          removed: [],
        }
      : {
          id: null,
          values: { requested_by: ctx.user.id, assigned_to: null, origin: "", description: "", date_start: today(), picking_type_id: pickingTypes[0]?.id ?? null },
          lines: [emptyLine()],
          removed: [],
        };
  }

  const v = form?.values;
  const title = pr ? esc(pr.name) : "Baru";
  const fields = editable
    ? `${fieldBlock("Diminta oleh", `<select data-value="requested_by" class="${INPUT}">${selectOptions(users, v.requested_by)}</select>`)}
       ${fieldBlock("Penyetuju", `<select data-value="assigned_to" class="${INPUT}">${selectOptions(users, v.assigned_to, "-")}</select>`)}
       ${fieldBlock("Dokumen Sumber", `<input data-value="origin" value="${esc(v.origin)}" class="${INPUT}">`)}
       ${fieldBlock("Deskripsi", `<input data-value="description" value="${esc(v.description)}" class="${INPUT}">`)}
       ${fieldBlock("Tanggal Mulai", `<input type="date" data-value="date_start" value="${esc(v.date_start)}" class="${INPUT}">`)}
       ${fieldBlock("Tipe Penerimaan", `<select data-value="picking_type_id" class="${INPUT}">${selectOptions(pickingTypes, v.picking_type_id)}</select>`)}`
    : `${fieldBlock("Diminta oleh", readonlyValue(pr.requested_by?.[1]))}
       ${fieldBlock("Penyetuju", readonlyValue(pr.assigned_to?.[1]))}
       ${fieldBlock("Dokumen Sumber", readonlyValue(pr.origin))}
       ${fieldBlock("Deskripsi", readonlyValue(pr.description))}
       ${fieldBlock("Tanggal Mulai", readonlyValue(pr.date_start ? dateText(pr.date_start) : ""))}
       ${fieldBlock("Tipe Penerimaan", readonlyValue(pr.picking_type_id?.[1]))}`;
  const company = ctx.multiCompany && pr ? fieldBlock("Perusahaan", readonlyValue(pr.company_id?.[1])) : "";

  const rfqRows = rfqs
    .map(
      (o) => `<tr>
        <td class="py-2 px-4 text-sm font-medium"><a href="#/po/${o.id}" class="text-indigo-700 hover:underline">${esc(o.name)}</a></td>
        <td class="py-2 px-4 text-sm">${esc(o.partner_id?.[1])}</td>
        <td class="py-2 px-4 text-sm text-right">${money(o.amount_untaxed, o.currency_id?.[1])}</td>
        <td class="py-2 px-4 text-sm text-right">${money(o.amount_tax, o.currency_id?.[1])}</td>
        <td class="py-2 px-4 text-sm text-right font-semibold">${money(o.amount_total, o.currency_id?.[1])}</td>
        <td class="py-2 px-4 text-sm">${badge(PURCHASE_STATES, o.state)}</td>
        <td class="py-2 px-4 text-sm text-right">${["draft", "sent"].includes(o.state)
          ? `<button data-action="confirm-po" data-id="${o.id}" class="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700">Konfirmasi PO</button>` : ""}</td>
      </tr>`,
    )
    .join("");
  const rfqPanel = `
    <div id="rfq-create" class="${pr && ["approved", "in_progress"].includes(pr.state) ? "" : "hidden"} mt-4 flex flex-col sm:flex-row gap-2 sm:items-end">
      <div class="flex-1">
        <label class="block text-sm font-medium text-gray-700 mb-1" for="vendor">Pemasok</label>
        <input id="vendor" data-lookup="pr-vendor" autocomplete="off" role="combobox" aria-autocomplete="list" placeholder="Cari atau pilih pemasok..." class="${INPUT}">
      </div>
      <button data-action="make-rfq" data-id="${pr?.id ?? ""}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Buat RFQ</button>
    </div>`;

  const total = editable ? form.lines.reduce((sum, l) => sum + Number(l.estimated_cost || 0), 0) : pr.estimated_cost;
  const saveBar = editable
    ? `<div class="flex gap-2 mt-4">
         <button data-action="save" data-id="${pr?.id ?? ""}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
         <a href="#/pr" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
       </div>` : "";

  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/pr" class="hover:text-indigo-600">Purchase Request</a> / ${title}</div>
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
      <div class="flex flex-wrap gap-2">${pr ? actionBar(BUTTONS, pr) + printButton("purchase.request", pr.id) : ""}</div>
      ${statusbar(FLOW, STATES, pr?.state ?? "draft")}
    </div>
    ${pr ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
      { count: pr.line_count, label: "Baris", icon: "fa-list", target: "section-lines" },
      { count: pr.purchase_count, label: "Purchase Order", icon: "fa-shopping-cart", target: "section-rfq" },
      { count: pr.move_count, label: "Penerimaan", icon: "fa-truck" },
    ])}</div>` : ""}
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${title}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">${fields}${company}</section>
    <section id="section-lines" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto">
      <div class="text-sm font-semibold mb-3">Barang yang diminta</div>
      <div id="lines-box">${editable ? linesTable() : readonlyLinesTable(lines, currency)}</div>
      <div class="flex justify-end mt-3 text-sm"><span class="text-gray-500 mr-3">Estimasi Biaya</span><span id="total" class="font-semibold">${money(total, currency)}</span></div>
      ${saveBar}
    </section>
    ${pr ? `<section id="section-rfq" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 p-4 overflow-x-auto">
      <div class="text-sm font-semibold">RFQ / Purchase Order</div>
      ${rfqs.length ? `<table class="w-full text-left mt-2"><thead class="bg-gray-50"><tr>${["Nomor", "Pemasok", "Sebelum pajak", "Pajak", "Total", "Status", ""]
        .map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i >= 2 && i <= 4 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
        <tbody class="divide-y divide-gray-100">${rfqRows}</tbody></table>` : '<p class="text-sm text-gray-500 mt-2">Belum ada RFQ.</p>'}
      ${rfqPanel}
    </section>${chatterHtml("purchase.request", pr.id)}` : ""}`;
  if (pr) loadMessages("purchase.request", pr.id);
}

/* ---------- Simpan, aksi, RFQ ---------- */

function resolveLine(l) {
  const text = l.text.trim();
  if (!text) return null;
  if (l.product_id && text === l.productText) return l;
  throw new Error(`Produk "${text}" belum dipilih dari daftar. Klik produk pada kotak saran.`);
}

function lineValues(l) {
  const qty = Number(l.product_qty);
  if (!(qty > 0)) throw new Error(`Jumlah untuk "${l.text}" harus lebih dari 0.`);
  const analytic = distributionChange(l.analytic, l.analytic0);
  return {
    product_id: l.product_id, name: l.name, product_qty: qty, product_uom_id: l.product_uom_id,
    ...(l.date_required ? { date_required: l.date_required } : {}), estimated_cost: Number(l.estimated_cost || 0),
    ...(analytic !== undefined ? { analytic_distribution: analytic } : {}),
  };
}

async function persist() {
  const resolved = form.lines.map(resolveLine).filter(Boolean);
  if (!resolved.length) throw new Error("Tambahkan minimal satu barang.");
  const v = form.values;
  const header = {
    requested_by: Number(v.requested_by) || false, assigned_to: Number(v.assigned_to) || false, origin: v.origin,
    description: v.description, date_start: v.date_start || false, picking_type_id: Number(v.picking_type_id) || false,
  };
  if (!form.id) {
    const [id] = await call("purchase.request", "create", {
      vals_list: [{ ...header, line_ids: resolved.map((l) => [0, 0, lineValues(l)]) }],
    });
    return id;
  }
  const commands = [
    ...resolved.map((l) => (l.id ? [1, l.id, lineValues(l)] : [0, 0, lineValues(l)])),
    ...form.removed.map((lineId) => [2, lineId, 0]),
  ];
  await call("purchase.request", "write", { ids: [form.id], vals: { ...header, line_ids: commands } });
  return form.id;
}

async function makeRfq(button, id) {
  const vendor = vendorChoice;
  if (!vendor || vendor.display_name !== document.querySelector('[data-lookup="pr-vendor"]')?.value) {
    toast("Pilih pemasok dari kotak saran.", "error");
    return;
  }
  const lines = await searchRead("purchase.request.line", [["request_id", "=", id], ["cancelled", "=", false]], ["id"]);
  const ids = lines.map((l) => l.id);
  const context = { active_model: "purchase.request.line", active_ids: ids, active_id: ids[0] };
  const done = await guarded(button, async () => {
    const wizard = await call("purchase.request.line.make.purchase.order", "create", { vals_list: [{ supplier_id: vendor.id }], context });
    await call("purchase.request.line.make.purchase.order", "make_purchase_order", { ids: wizard, context });
    return true;
  });
  if (done) {
    toast("RFQ dibuat.");
    reload();
  }
}

/* ---------- Acara ---------- */

export async function onClick(event, el) {
  const { action } = el.dataset;
  const id = Number(el.dataset.id) || null;
  const def = BUTTONS.find((b) => b.action === action);

  if (action === "refresh") reload();
  else if (action === "discard") form = null;
  else if (action === "add-line") {
    form.lines.push(emptyLine());
    document.querySelector("#lines-box").innerHTML = linesTable();
  } else if (action === "remove-line") {
    const [removed] = form.lines.splice(Number(el.dataset.line), 1);
    if (removed?.id) form.removed.push(removed.id);
    if (!form.lines.length) form.lines.push(emptyLine());
    document.querySelector("#lines-box").innerHTML = linesTable();
  } else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "Purchase Request dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/pr/${saved}`;
      else reload();
    }
  } else if (action === "confirm-po") {
    const ok = await guarded(el, () => call("purchase.order", "button_confirm", { ids: [id] }));
    if (ok !== undefined) {
      toast("Purchase Order dikonfirmasi.");
      reload();
    }
  } else if (action === "make-rfq") await makeRfq(el, id);
  else if (action === "rfq") document.querySelector("#rfq-create")?.scrollIntoView({ behavior: "smooth", block: "center" });
  else if (action === "reject" && !window.confirm("Tolak Purchase Request ini?")) {
    /* dibatalkan pengguna */
  } else if (def?.method) {
    const ok = await guarded(el, async () => {
      if (form?.id === id) await persist(); // simpan perubahan draft sebelum mengubah status, seperti autosave Odoo
      return call("purchase.request", def.method, { ids: [id] });
    });
    if (ok !== undefined) {
      form = null;
      toast(DONE_MESSAGE[action]);
      reload();
    }
  }
}

export function onInput(event, el) {
  if (el.dataset.value) form.values[el.dataset.value] = el.value;
  else if (el.dataset.line !== undefined) {
    form.lines[Number(el.dataset.line)][el.dataset.field] = el.value;
    if (el.dataset.field === "text") runLookup(el, 250);
    if (el.dataset.field === "estimated_cost") {
      const totalBox = document.querySelector("#total");
      if (totalBox) totalBox.textContent = money(form.lines.reduce((s, l) => s + Number(l.estimated_cost || 0), 0));
    }
  } else if (el.dataset.lookup === "pr-vendor") {
    vendorChoice = null;
    runLookup(el, 250);
  }
}
