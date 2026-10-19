// Lokasi gudang (stock.location): hierarki lokasi internal di dalam gudang (rak, zona), dengan tipe, induk, dan arsip. Lokasi bertipe Inventory Loss
// (opname dan scrap) dan Produksi punya Akun Loss atau Akun Produksi: akun lawan dari akun Persediaan pada Product Category saat stok masuk atau keluar
// lewat lokasi itu (D69, D73).
import {
  ACCOUNT_TYPE_LABELS, INPUT, REMOVAL_HELP, app, call, cell, closeLookup, esc, fieldBlock, filterSelect, guarded, pageHeader, readOne, registerLookup, referenceRemovals, removalSelect, rowLink, runLookup,
  searchAccounts, searchBox, searchRead, table, toast, button,
} from "../common.js";

const USAGE = { internal: "Internal", view: "Virtual (induk)", supplier: "Pemasok", customer: "Pelanggan", inventory: "Inventory Loss", production: "Produksi", transit: "Transit" };
const FILTERS = [["internal", "Lokasi internal"], ["all", "Semua tipe"], ["archived", "Diarsipkan"]];
// Tipe yang punya akun valuasi lawan (`valuation_account_id`): selisih opname dan scrap, serta barang dalam proses.
const ACCOUNT_USAGE = {
  inventory: {
    label: "Akun Loss",
    types: ["expense", "expense_direct_cost", "expense_other", "income_other"],
    help: "Lawan akun Persediaan (dari Product Category) pada opname dan scrap yang lewat lokasi ini: stok berkurang = Dr Akun Loss, Cr Persediaan; stok bertambah = Dr Persediaan, Cr Akun Loss. Kosong = opname dan scrap lewat lokasi ini tidak dijurnal.",
  },
  production: {
    label: "Akun Produksi",
    types: ["asset_current", "asset_non_current", "expense", "expense_direct_cost"],
    help: "Barang Dalam Proses: komponen yang dipakai MO mendebit akun ini (Cr Persediaan), barang jadi yang masuk mengkreditnya (Dr Persediaan). Kosong = produksi tidak dijurnal.",
  },
};

let removals = [];
let form = null; // { id, values, initial }
const removalHelp = (id) => {
  const hit = removals.find((r) => r.id === id);
  return hit ? REMOVAL_HELP[hit.method] ?? "" : "Kosong: mengikuti lokasi induk, dan bila tidak ada memakai FIFO. Strategi pada kategori produk mengalahkan pengaturan lokasi.";
};
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
};
const reload = () => render(last.sub, last.query);

registerLookup("location-account", {
  search: (q) => searchAccounts(q, ACCOUNT_USAGE[form?.values.usage]?.types ?? null),
  sub: (r) => ACCOUNT_TYPE_LABELS[r.account_type] ?? "",
  isChosen: (input) => form?.values.account?.display_name === input.value,
  choose: (input, item) => {
    form.values.account = item;
    form.pendingAccount = false;
    input.value = item.display_name;
  },
});

registerLookup("location-parent", {
  search: (q) => searchRead("stock.location", [["usage", "in", ["internal", "view"]], ...(q ? [["complete_name", "ilike", q]] : [])], ["display_name"], { limit: 10, order: "complete_name" }),
  isChosen: (input) => form?.values.parent?.display_name === input.value,
  choose: (input, item) => {
    form.values.parent = item;
    input.value = item.display_name;
  },
});

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub));
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  const filter = query.get("state") || "internal";
  const text = query.get("q") ?? "";
  const warehouse = Number(query.get("warehouse")) || null;
  const domain = [];
  if (filter === "internal") domain.push(["usage", "=", "internal"]);
  else if (filter === "archived") domain.push(["active", "=", false]);
  if (warehouse) domain.push(["warehouse_id", "=", warehouse]);
  if (text) domain.push(["complete_name", "ilike", text]);
  const rows = await searchRead("stock.location", domain, ["complete_name", "usage", "warehouse_id", "location_id"], { order: "complete_name", limit: 300, context: { active_test: filter !== "archived" } });
  const body = rows.map((r) => rowLink(`#/location/${r.id}`, [cell(r.complete_name, { strong: true }), cell(USAGE[r.usage] ?? r.usage), cell(r.warehouse_id?.[1] ?? "-")])).join("");
  app.innerHTML =
    pageHeader(
      "Lokasi Gudang",
      `${searchBox(text, "Cari lokasi")}${filterSelect(FILTERS, filter)}
       <a href="#/warehouse" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Gudang</a>
       <a href="#/location/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Lokasi Baru</a>`,
    ) + table([{ label: "Lokasi" }, { label: "Tipe" }, { label: "Gudang" }], body, "Tidak ada lokasi yang cocok.");
}

async function renderForm(id) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  removals = await referenceRemovals();
  let loc = null;
  if (id) {
    loc = await readOne("stock.location", id, ["name", "complete_name", "usage", "location_id", "warehouse_id", "active", "removal_strategy_id", "valuation_account_id"]);
    if (!loc) {
      app.innerHTML = '<p class="text-sm text-rose-600">Lokasi tidak ditemukan.</p>';
      return;
    }
  }
  if (!form || form.id !== (loc?.id ?? null)) {
    const values = loc
      ? {
          name: loc.name, usage: loc.usage, removal: loc.removal_strategy_id?.[0] ?? null, parent: loc.location_id ? { id: loc.location_id[0], display_name: loc.location_id[1] } : null,
          account: loc.valuation_account_id ? { id: loc.valuation_account_id[0], display_name: loc.valuation_account_id[1] } : null,
        }
      : { name: "", usage: "internal", removal: null, parent: null, account: null };
    form = { id: loc?.id ?? null, values, pendingAccount: false, initial: loc ? { name: values.name, usage: values.usage, removal: values.removal, parent: values.parent?.id ?? null, account: values.account?.id ?? null } : null };
  }
  const v = form.values;
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/location" class="hover:text-indigo-600">Lokasi Gudang</a> / ${esc(loc?.complete_name ?? "Baru")}</div>
    <div class="flex flex-wrap gap-2 mb-3">${loc ? button("toggle-active", loc.active ? "Arsipkan" : "Aktifkan Kembali", loc.active ? "danger" : "primary", { id: loc.id }) : ""}</div>
    <h1 class="text-2xl font-bold text-gray-900 mb-3">${esc(loc?.complete_name ?? "Lokasi Baru")}</h1>
    <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock("Nama Lokasi", `<input data-loc="name" value="${esc(v.name)}" class="${INPUT}">`)}
      ${fieldBlock("Lokasi Induk", `<input data-lookup="location-parent" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(v.parent?.display_name ?? "")}" placeholder="mis. WH/Stock" class="${INPUT}">`)}
      ${fieldBlock("Tipe", `<select data-loc="usage" class="${INPUT}">${Object.entries(USAGE).map(([k, label]) => `<option value="${k}" ${k === v.usage ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`)}
      ${fieldBlock("Gudang", `<div class="py-2 text-sm font-medium text-gray-900">${esc(loc?.warehouse_id?.[1] ?? "Mengikuti lokasi induk")}</div>`)}
      ${fieldBlock("Strategi Pengeluaran", removalSelect(removals, v.removal, 'data-loc="removal"', "Mengikuti lokasi induk (bawaan: FIFO)"))}
      <p class="text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3 self-end" id="removal-note">${esc(removalHelp(v.removal))}</p>
      <div id="account-box" class="md:col-span-2">${accountBox(v)}</div>
    </section>
    <div class="flex gap-2 mt-4"><button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/location" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a></div>`;
}

/** Bagian "Informasi Akuntansi" untuk tipe Inventory Loss dan Produksi: Akun Loss atau Akun Produksi beserta penjelasan lawannya. */
function accountBox(v) {
  const cfg = ACCOUNT_USAGE[v.usage];
  if (!cfg) return "";
  return `<div class="border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700 mb-3">Informasi Akuntansi</div>
    <div class="grid md:grid-cols-2 gap-x-8 gap-y-4">
      ${fieldBlock(cfg.label, `<input data-lookup="location-account" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(v.account?.display_name ?? "")}" placeholder="Cari kode atau nama akun..." class="${INPUT}">`)}
      <p class="text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3 self-end">${esc(cfg.help)} Akun Persediaan tiap produk mengikuti <a href="#/category" class="underline">Product Category</a> produknya (terlihat juga di Product Master).</p>
    </div>`;
}

async function persist() {
  const v = form.values;
  if (!v.name.trim()) throw new Error("Nama lokasi wajib diisi.");
  if (form.pendingAccount) throw new Error("Pilih akun dari kotak saran, atau kosongkan isiannya.");
  const vals = { name: v.name.trim(), usage: v.usage, location_id: v.parent?.id ?? false };
  const removal = v.removal ?? null;
  const account = ACCOUNT_USAGE[v.usage] ? v.account?.id ?? null : null; // tipe lain tidak memakai akun ini; mengganti tipe mengosongkannya
  if (!form.id) {
    const [id] = await call("stock.location", "create", { vals_list: [{ ...vals, location_id: v.parent?.id ?? undefined, ...(removal ? { removal_strategy_id: removal } : {}), ...(account ? { valuation_account_id: account } : {}) }] });
    return id;
  }
  const changed = {};
  if (vals.name !== form.initial.name) changed.name = vals.name;
  if (vals.usage !== form.initial.usage) changed.usage = vals.usage;
  if ((v.parent?.id ?? null) !== form.initial.parent) changed.location_id = v.parent?.id ?? false;
  if (removal !== form.initial.removal) changed.removal_strategy_id = removal ?? false;
  if (account !== form.initial.account) changed.valuation_account_id = account ?? false;
  if (Object.keys(changed).length) await call("stock.location", "write", { ids: [form.id], vals: changed });
  return form.id;
}

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "Lokasi dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/location/${saved}`;
      else reload();
    }
  } else if (action === "toggle-active") {
    const archive = el.textContent.trim() === "Arsipkan";
    if (archive && !window.confirm("Arsipkan lokasi ini? Lokasi yang masih berisi stok tidak bisa diarsipkan.")) return;
    const ok = await guarded(el, () => call("stock.location", "write", { ids: [Number(el.dataset.id)], vals: { active: !archive } }));
    if (ok !== undefined) {
      form = null;
      toast(archive ? "Lokasi diarsipkan." : "Lokasi diaktifkan kembali.");
      reload();
    }
  }
}

export function onInput(event, el) {
  if (!form) return;
  if (el.dataset.loc === "removal") {
    form.values.removal = el.value ? Number(el.value) : null;
    document.querySelector("#removal-note").textContent = removalHelp(form.values.removal);
  } else if (el.dataset.loc) {
    form.values[el.dataset.loc] = el.value;
    if (el.dataset.loc === "usage") {
      closeLookup();
      document.querySelector("#account-box").innerHTML = accountBox(form.values); // Akun Loss atau Produksi hanya untuk tipe tertentu
    }
  } else if (el.dataset.lookup === "location-account") {
    form.values.account = null;
    form.pendingAccount = Boolean(el.value.trim());
    runLookup(el, 250);
  } else if (el.dataset.lookup === "location-parent") {
    form.values.parent = null;
    runLookup(el, 250);
  }
}
