// Perbandingan beberapa BoM sebuah produk berdampingan (Q34, D63): komponen x BoM dengan jumlah per satu unit barang jadi, perbedaan disorot, biaya komponen per
// unit tiap BoM dari harga pokok produk, selisih terhadap BoM pertama, dan ringkasan operasi. Dibuka dari daftar BoM (kolom Banding atau tombol Bandingkan).
import { app, esc, money, pageHeader, searchRead } from "../common.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });
const TYPES = { normal: "Produksi", phantom: "Kit", subcontract: "Subcontracting" };
const MAX_BOMS = 6;
let onlyDiff = false;

export const bomLabel = (b) => b.code || `BoM #${b.id}`;

export async function renderCompare(query, back) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const product = Number(query.get("product")) || null;
  const picked = (query.get("ids") ?? "").split(",").map(Number).filter(Boolean);
  if (!product && !picked.length) {
    app.innerHTML = `${pageHeader("Bandingkan BoM")}<p class="text-sm text-gray-600">Pilih produk dari daftar BoM, lalu klik <b>Bandingkan</b> pada produk yang punya lebih dari satu BoM.</p><p class="mt-3"><a href="#/bom" class="text-indigo-700 hover:underline">Kembali ke daftar BoM</a></p>`;
    return;
  }
  const first = picked.length ? (await searchRead("mrp.bom", [["id", "in", picked]], ["product_tmpl_id"], { limit: 1 }))[0] : null;
  const tmpl = product ?? first?.product_tmpl_id?.[0];
  const all = await searchRead("mrp.bom", [["product_tmpl_id", "=", tmpl]], ["code", "product_tmpl_id", "product_id", "product_qty", "product_uom_id", "type", "bom_line_ids", "operation_ids", "sequence"], { order: "sequence, id", limit: 30 });
  if (!all.length) {
    app.innerHTML = `${pageHeader("Bandingkan BoM")}<p class="text-sm text-rose-600">Produk ini belum punya BoM.</p><p class="mt-3"><a href="#/bom" class="text-indigo-700 hover:underline">Kembali ke daftar BoM</a></p>`;
    return;
  }
  const chosen = (picked.length ? all.filter((b) => picked.includes(b.id)) : all).slice(0, MAX_BOMS);
  const lineIds = chosen.flatMap((b) => b.bom_line_ids);
  const opIds = chosen.flatMap((b) => b.operation_ids);
  const [lines, ops] = await Promise.all([
    lineIds.length ? searchRead("mrp.bom.line", [["id", "in", lineIds]], ["bom_id", "product_id", "product_qty", "product_uom_id"], { order: "sequence, id", limit: 500 }) : [],
    opIds.length ? searchRead("mrp.routing.workcenter", [["id", "in", opIds]], ["bom_id", "name", "workcenter_id", "time_cycle_manual"], { limit: 200 }) : [],
  ]);
  const productIds = [...new Set(lines.map((l) => l.product_id[0]))];
  const products = productIds.length ? await searchRead("product.product", [["id", "in", productIds]], ["display_name", "standard_price", "uom_id"], { limit: 500 }) : [];
  const productOf = new Map(products.map((p) => [p.id, p]));

  // jumlah per satu unit barang jadi (dibagi jumlah dasar BoM), per komponen dan BoM
  const per = new Map(); // product id -> Map(bom id -> { qty, uom, uomId })
  for (const l of lines) {
    const bom = chosen.find((b) => b.id === l.bom_id[0]);
    if (!bom || !bom.product_qty) continue;
    const row = per.get(l.product_id[0]) ?? new Map();
    const prev = row.get(bom.id);
    row.set(bom.id, { qty: (prev?.qty ?? 0) + l.product_qty / bom.product_qty, uom: l.product_uom_id?.[1] ?? "", uomId: l.product_uom_id?.[0] });
    per.set(l.product_id[0], row);
  }
  const differs = (row) => {
    const values = chosen.map((b) => row.get(b.id)?.qty ?? null);
    return values.some((v) => (v === null) !== (values[0] === null) || (v !== null && Math.abs(v - values[0]) > 1e-9));
  };
  const rowsAll = [...per.entries()].sort((a, b) => productOf.get(a[0])?.display_name.localeCompare(productOf.get(b[0])?.display_name ?? "", "id") ?? 0);
  const rows = onlyDiff ? rowsAll.filter(([, row]) => differs(row)) : rowsAll;

  // biaya komponen per unit tiap BoM; komponen dengan satuan baris berbeda dari satuan produk tidak dihitung
  const cost = new Map(chosen.map((b) => [b.id, 0]));
  const skipped = new Set();
  for (const [pid, row] of per) {
    const p = productOf.get(pid);
    for (const [bomId, v] of row) {
      if (p?.uom_id?.[0] !== v.uomId) {
        skipped.add(p?.display_name ?? pid);
        continue;
      }
      cost.set(bomId, cost.get(bomId) + v.qty * (p?.standard_price ?? 0));
    }
  }
  const base = cost.get(chosen[0].id);
  const head = chosen
    .map((b, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase text-right align-bottom"><a href="#/bom/${b.id}" class="text-indigo-700 hover:underline normal-case text-sm font-semibold">${esc(bomLabel(b))}</a>
      <div class="font-normal normal-case text-gray-500">${esc(TYPES[b.type] ?? b.type)}${i === 0 ? " · pembanding" : ""}</div><div class="font-normal normal-case text-gray-500">dasar ${esc(nf.format(b.product_qty))} ${esc(b.product_uom_id?.[1] ?? "")}</div></th>`)
    .join("");
  const body = rows
    .map(([pid, row]) => {
      const diff = differs(row);
      const cells = chosen
        .map((b, i) => {
          const v = row.get(b.id);
          const changed = i > 0 && ((v?.qty ?? null) !== (row.get(chosen[0].id)?.qty ?? null) && Math.abs((v?.qty ?? 0) - (row.get(chosen[0].id)?.qty ?? 0)) > 1e-9);
          const text = v ? `${nf.format(v.qty)} <span class="text-xs text-gray-500">${esc(v.uom)}</span>` : '<span class="text-gray-300">tidak dipakai</span>';
          return `<td class="py-2 px-4 text-sm text-right tabular-nums ${changed ? "bg-amber-50 text-amber-900 font-medium" : ""}">${text}</td>`;
        })
        .join("");
      return `<tr class="${diff ? "" : "text-gray-500"}"><td class="py-2 px-4 text-sm">${esc(productOf.get(pid)?.display_name ?? `#${pid}`)}${diff ? ' <span class="ml-1 px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-800">beda</span>' : ""}</td>${cells}</tr>`;
    })
    .join("");
  const costCells = chosen.map((b) => `<td class="py-2 px-4 text-sm text-right tabular-nums font-semibold">${esc(money(cost.get(b.id)))}</td>`).join("");
  const diffCells = chosen
    .map((b, i) => {
      if (i === 0) return '<td class="py-2 px-4 text-sm text-right text-gray-400">-</td>';
      const d = cost.get(b.id) - base;
      const pct = base ? (d / base) * 100 : null;
      const tone = d < -0.005 ? "text-emerald-700" : d > 0.005 ? "text-rose-700" : "text-gray-500";
      return `<td class="py-2 px-4 text-sm text-right tabular-nums ${tone}">${d > 0 ? "+" : ""}${esc(money(d))}${pct === null ? "" : ` (${d > 0 ? "+" : ""}${nf.format(Math.round(pct * 10) / 10)}%)`}</td>`;
    })
    .join("");
  const opSummary = chosen
    .map((b) => {
      const mine = ops.filter((o) => o.bom_id?.[0] === b.id);
      const minutes = mine.reduce((acc, o) => acc + (o.time_cycle_manual ?? 0), 0);
      return `<td class="py-2 px-4 text-sm text-right tabular-nums">${mine.length ? `${mine.length} operasi, ${esc(nf.format(minutes))} menit per batch` : '<span class="text-gray-300">tanpa operasi</span>'}</td>`;
    })
    .join("");
  const finished = chosen[0].product_tmpl_id[1];
  const picker = all.length > 1
    ? `<div class="flex flex-wrap gap-3 items-center mb-3 text-sm">${all.map((b) => `<label class="flex items-center gap-1.5"><input type="checkbox" data-bom-pick value="${b.id}" ${chosen.some((c) => c.id === b.id) ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> ${esc(bomLabel(b))}</label>`).join("")}
        <button type="button" data-action="bom-compare-apply" data-product="${tmpl}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">Terapkan</button>
        <label class="flex items-center gap-1.5 ml-auto"><input type="checkbox" data-bom-diff ${onlyDiff ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> Hanya yang beda</label></div>`
    : '<p class="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 mb-3">Produk ini baru punya satu BoM. Tambahkan BoM kedua (mis. versi ekonomis) lalu bandingkan di sini.</p>';
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="${esc(back ?? "#/bom")}" class="hover:text-indigo-600">Bill of Material</a> / Bandingkan</div>
    ${pageHeader(`Bandingkan BoM: ${finished}`, `<a href="#/bom?product=${tmpl}" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Daftar BoM produk ini</a>`)}
    ${picker}
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
      <table class="w-full text-left" data-list="off"><thead class="bg-gray-50 border-b border-gray-200"><tr><th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase align-bottom">Komponen per 1 unit barang jadi</th>${head}</tr></thead>
        <tbody class="divide-y divide-gray-100">${body || `<tr><td colspan="${chosen.length + 1}" class="py-8 text-center text-sm text-gray-500">${onlyDiff ? "Semua komponen sama di BoM yang dipilih." : "BoM ini belum punya komponen."}</td></tr>`}</tbody>
        <tfoot class="bg-gray-50"><tr><td class="py-2 px-4 text-sm font-semibold">Biaya komponen per unit</td>${costCells}</tr>
          <tr><td class="py-2 px-4 text-sm">Selisih terhadap ${esc(bomLabel(chosen[0]))}</td>${diffCells}</tr>
          <tr><td class="py-2 px-4 text-sm">Operasi</td>${opSummary}</tr></tfoot></table>
    </section>
    <p class="text-xs text-gray-500 mt-3">Jumlah komponen dibagi jumlah dasar tiap BoM sehingga sama-sama per satu unit barang jadi. Biaya memakai harga pokok produk komponen saat ini (belum termasuk biaya operasi).${skipped.size ? ` Satuan baris berbeda dari satuan produk sehingga tidak dihitung: ${esc([...skipped].join(", "))}.` : ""} Sel kuning berbeda dari BoM pembanding (kolom pertama).</p>`;
}

/** Aksi halaman banding: terapkan pilihan BoM, atau sembunyikan komponen yang sama. Mengembalikan true bila aksinya milik halaman ini. */
export function compareAction(action, el) {
  if (action !== "bom-compare-apply") return false;
  const ids = [...document.querySelectorAll("[data-bom-pick]:checked")].map((c) => c.value);
  if (ids.length < 2) {
    alert("Pilih minimal dua BoM untuk dibandingkan.");
    return true;
  }
  location.hash = `#/bom/compare?product=${el.dataset.product}&ids=${ids.join(",")}`;
  return true;
}

export function compareChange(el, reload) {
  if (el.dataset.bomDiff === undefined) return false;
  onlyDiff = el.checked;
  reload();
  return true;
}

export const compareBadge = (count, tmpl) =>
  count > 1 ? `<span data-action="goto" data-href="#/bom/compare?product=${tmpl}" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-indigo-50 text-indigo-700 hover:bg-indigo-100 cursor-pointer"><i class="fas fa-code-compare"></i>Bandingkan ${count}</span>` : "";
