// Asset (account.asset, OCA account_asset_management): aset tetap dari awal sampai habis disusutkan. Konfirmasi membuat jadwal
// penyusutan; setiap baris penyusutan diposting menjadi jurnal (Dr Beban Penyusutan, Cr Akumulasi Penyusutan).
import { badge, button, call, dateText, esc, guarded, money, referenceAssetProfiles, resetReferences, toast, searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

const STATES = { draft: ["Draft", "muted"], open: ["Berjalan", "success"], close: ["Selesai", "info"], removed: ["Dihapus", "danger"] };

const page = createMasterPage({
  route: "asset", title: "Asset", noun: "Aset", model: "account.asset", newLabel: "Aset Baru", order: "date_start desc, id desc", archive: false,
  empty: "Belum ada aset. Buat dengan tombol Aset Baru, pilih model aset, lalu konfirmasi untuk membuat jadwal penyusutan.",
  listFields: ["code", "name", "profile_id", "date_start", "purchase_value", "salvage_value", "value_residual", "state"],
  columns: [
    { label: "Kode", value: (r) => r.code || "-" },
    { label: "Nama", value: (r) => r.name },
    { label: "Model", value: (r) => r.profile_id?.[1] ?? "-" },
    { label: "Mulai", value: (r) => dateText(r.date_start) },
    { label: "Perolehan", value: (r) => money(r.purchase_value), right: true },
    { label: "Nilai Buku", value: (r) => money(r.value_residual + r.salvage_value), right: true },
    { label: "Status", value: (r) => badge(STATES, r.state), raw: true },
  ],
  search: ["name", "code"],
  filters: [{ key: "status", label: "Semua status", options: Object.entries(STATES).map(([k, v]) => [k, v[0]]), domain: (v) => [["state", "=", v]] }],
  headerExtra: '<a href="#/assetprofile" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-layer-group mr-2"></i>Model Aset</a>',
  fields: [
    { key: "name", label: "Nama Aset", type: "text", required: true, readonly: (_r, v) => v.state === "close" || v.state === "removed" },
    { key: "code", label: "Kode", type: "text" },
    { key: "profile_id", label: "Model Aset", type: "m2o", optionsOf: (r) => r.profiles, required: true, blank: "Pilih model...", readonly: (_r, v) => Boolean(v.state) && v.state !== "draft" },
    { key: "date_start", label: "Tanggal Mulai Penyusutan", type: "date", required: true, readonly: (_r, v) => Boolean(v.state) && v.state !== "draft" },
    { key: "purchase_value", label: "Nilai Perolehan", type: "number", min: 0, required: true, readonly: (_r, v) => Boolean(v.state) && v.state !== "draft" },
    { key: "salvage_value", label: "Nilai Sisa", type: "number", min: 0, readonly: (_r, v) => Boolean(v.state) && v.state !== "draft" },
    { key: "note", label: "Catatan", type: "textarea", span2: true },
  ],
  loadRefs: async () => ({ profiles: await referenceAssetProfiles() }),
  newValues: (r) => ({ profile_id: r.profiles[0]?.id ?? null, date_start: new Date().toISOString().slice(0, 10) }),
  readFields: ["state", "value_residual", "value_depreciated", "depreciation_line_ids", "salvage_value"],
  virtualValues: (record) => ({ state: record.state }),
  titleOf: (r) => r.name,
  tiles: (r) => [
    { count: r.value_depreciated ? 1 : 0, label: `Disusutkan ${money(r.value_depreciated)}`, icon: "fa-arrow-trend-down" },
    { count: r.state === "draft" ? 0 : 1, label: `Nilai buku ${money(r.value_residual + r.salvage_value)}`, icon: "fa-scale-balanced" },
  ],
  actions: (r) =>
    [
      r.state === "draft" ? button("asset-validate", "Konfirmasi", "primary", { id: r.id }) : "",
      r.state === "draft" ? button("asset-board", "Hitung Ulang Jadwal", "plain", { id: r.id }) : "",
      r.state === "open" ? button("asset-draft", "Kembalikan ke Draft", "plain", { id: r.id }) : "",
      r.state === "open" ? button("asset-post-due", "Posting yang Jatuh Tempo", "plain", { id: r.id }) : "",
    ].join(""),
  extra: async (record) => {
    if (!record.depreciation_line_ids.length) return "";
    const lines = await searchRead("account.asset.line", [["id", "in", record.depreciation_line_ids]], ["name", "type", "line_date", "amount", "remaining_value", "depreciated_value", "move_id", "move_check"], { order: "line_date, id" });
    const today = new Date().toISOString().slice(0, 10);
    const rows = lines
      .map((l) => {
        const base = l.type === "create";
        const posted = Boolean(l.move_id);
        return `<tr class="${base ? "bg-gray-50" : ""}"><td class="py-2 px-4 text-sm">${esc(dateText(l.line_date))}</td><td class="py-2 px-4 text-sm">${esc(base ? "Nilai perolehan" : l.type === "remove" ? "Penghapusan" : "Penyusutan")}</td>
          <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(l.amount))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${base ? "" : esc(money(l.remaining_value))}</td>
          <td class="py-2 px-4 text-sm">${posted ? esc(l.move_id[1]) : base ? "" : l.line_date <= today ? '<span class="text-amber-700">jatuh tempo</span>' : '<span class="text-gray-400">terjadwal</span>'}</td>
          <td class="py-2 px-4 text-right">${!posted && l.type === "depreciate" && record.state === "open" ? `<button type="button" data-action="asset-post" data-id="${l.id}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Posting</button>` : ""}</td></tr>`;
      })
      .join("");
    return `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">Jadwal Penyusutan</div>
      <table class="w-full text-left"><thead class="bg-gray-50"><tr>${["Tanggal", "Jenis", "Jumlah", "Nilai Sisa", "Jurnal", ""].map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${i === 2 || i === 3 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
      <tbody class="divide-y divide-gray-100">${rows}</tbody></table></section>
      <p class="mt-3 text-sm text-sky-900 bg-sky-50 border border-sky-200 rounded-lg px-4 py-3">Posting satu baris membuat jurnal penyusutan: Dr Beban Penyusutan dan Cr Akumulasi Penyusutan sesuai model aset. Posting harus berurutan dari baris tertua.</p>`;
  },
  onAction: async (action, el, { reload }) => {
    const id = Number(el.dataset.id) || null;
    const run = async (task, message) => {
      const ok = await guarded(el, task);
      if (ok !== undefined) {
        toast(message);
        resetReferences();
        reload();
      }
    };
    if (action === "asset-validate") await run(() => call("account.asset", "validate", { ids: [id] }), "Aset dikonfirmasi. Jadwal penyusutan dibuat.");
    else if (action === "asset-board") await run(() => call("account.asset", "compute_depreciation_board", { ids: [id] }), "Jadwal penyusutan dihitung ulang.");
    else if (action === "asset-draft") {
      if (!window.confirm("Kembalikan aset ke draft? Hanya bisa bila belum ada penyusutan yang diposting.")) return;
      await run(() => call("account.asset", "set_to_draft", { ids: [id] }), "Aset dikembalikan ke draft.");
    } else if (action === "asset-post") await run(() => call("account.asset.line", "create_move", { ids: [id] }), "Penyusutan diposting.");
    else if (action === "asset-post-due") {
      await run(async () => {
        const today = new Date().toISOString().slice(0, 10);
        const [asset] = await call("account.asset", "read", { ids: [id], fields: ["depreciation_line_ids"] });
        const due = await searchRead("account.asset.line", [["id", "in", asset.depreciation_line_ids], ["type", "=", "depreciate"], ["move_id", "=", false], ["line_date", "<=", today]], ["id"], { order: "line_date, id" });
        if (!due.length) throw new Error("Tidak ada baris penyusutan yang jatuh tempo.");
        for (const l of due) await call("account.asset.line", "create_move", { ids: [l.id] });
        return true;
      }, "Penyusutan yang jatuh tempo diposting.");
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
