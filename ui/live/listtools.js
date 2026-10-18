// Kelompokkan (group by) dan Filter untuk setiap tabel daftar (semua yang dibuat lewat table() di common.js), tanpa mengubah halaman satu per satu.
// Bilah di atas tabel punya tombol Kelompokkan (satu atau beberapa kolom, bertingkat; kolom tanggal dikelompokkan per bulan; kolom angka dijumlahkan
// pada baris kelompok) dan Filter (pilih kolom lalu satu nilai atau lebih). Pengolahan terjadi pada baris yang sudah dimuat halaman, di samping
// pencarian dan pilihan status dari server. Pilihan pengelompokan diingat per jenis tabel di peramban; filter berlaku untuk tampilan ini saja.
// Tabel yang tidak ingin ikut diberi atribut data-list="off".
const STORAGE_KEY = "kompakapps.listgroups";
const MONTHS = Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat("id-ID", { month: "short" }).format(new Date(2026, i, 1)).replace(".", ""));
const DATE_RE = /^(\d{1,2}) ([A-Za-z]+)\.? (\d{4})/;
const EMPTY = "(Kosong)";

const readSaved = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
};
const writeSaved = (all) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* penyimpanan boleh gagal; pengelompokan tetap berlaku untuk tampilan ini */
  }
};

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pageKey = () => (location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[0] || "home");
const clean = (el) => el.textContent.trim().replace(/\s+/g, " ");
const tableKey = (table) => `${pageKey()}::${[...table.tHead.rows[0].cells].map(clean).join("|")}`;

const css = document.createElement("style");
css.textContent = `
  .lt-bar { position: sticky; left: 0; display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .5rem .75rem; border-bottom: 1px solid #e5e7eb; font-size: .8125rem; }
  .lt-btn { display: inline-flex; align-items: center; gap: .375rem; padding: .25rem .625rem; border: 1px solid #d1d5db; border-radius: .5rem; background: #fff; color: #374151; cursor: pointer; }
  .lt-btn:hover { background: #f9fafb; }
  .lt-btn.on { border-color: #0FA6C4; color: #0A6B80; background: #ECFBFE; }
  .lt-chip { display: inline-flex; align-items: center; gap: .375rem; padding: .125rem .5rem; border-radius: 9999px; background: #ECFBFE; color: #08404A; }
  .lt-chip button { color: #0FA6C4; cursor: pointer; line-height: 1; }
  .lt-group td { background: #f3f4f6; font-weight: 600; color: #111827; cursor: pointer; }
  .lt-group:hover td { background: #e5e7eb; }
  #lt-menu { position: fixed; z-index: 60; min-width: 14rem; max-width: 22rem; max-height: 22rem; overflow: auto; background: #fff; border: 1px solid #d1d5db; border-radius: .75rem; box-shadow: 0 10px 25px rgba(0,0,0,.15); padding: .375rem; font-size: .8125rem; }
  #lt-menu .lt-item { display: flex; align-items: center; justify-content: space-between; gap: .75rem; width: 100%; text-align: left; padding: .375rem .625rem; border-radius: .5rem; color: #374151; cursor: pointer; }
  #lt-menu .lt-item:hover { background: #f3f4f6; }
  #lt-menu .lt-head { padding: .375rem .625rem; font-weight: 600; color: #6b7280; text-transform: uppercase; font-size: .6875rem; letter-spacing: .04em; }
  #lt-menu .lt-sep { border-top: 1px solid #e5e7eb; margin: .25rem 0; }
`;
document.head.append(css);

const menu = document.createElement("div");
menu.id = "lt-menu";
menu.className = "hidden";
document.body.append(menu);
let menuOwner = null; // { table, kind, column }

const closeMenu = () => {
  menu.classList.add("hidden");
  menuOwner = null;
};

/* ---------- Data tabel ---------- */

/** Nilai sel sebagai angka beserta awalan dan akhiran (mis. "Rp " dan " Units"); null bila bukan angka. Format Indonesia: titik ribuan, koma desimal. */
function parseNumber(text) {
  const m = /-?\d[\d.]*(?:,\d+)?/.exec(text);
  if (!m) return null;
  const value = Number(m[0].replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(value)) return null;
  return { value, prefix: text.slice(0, m.index), suffix: text.slice(m.index + m[0].length), decimals: (m[0].split(",")[1] ?? "").length };
}

function analyze(table) {
  const heads = [...table.tHead.rows[0].cells];
  const isData = (r) => r.cells.length === heads.length && !r.querySelector("td[colspan]");
  const all = [...table.tBodies[0].rows];
  const rows = all.filter(isData);
  // baris non-data (saldo awal, total) hanya boleh di awal atau akhir tabel; di tengah berarti tabel bukan daftar rata
  const first = all.findIndex(isData);
  const last = all.length - 1 - [...all].reverse().findIndex(isData);
  if (!rows.length || all.slice(first, last + 1).some((r) => !isData(r))) return { rows: [], texts: [], columns: heads.map(() => ({})), head: [], tail: [] };
  const head = all.slice(0, first);
  const tail = all.slice(last + 1);
  const texts = rows.map((r) => [...r.cells].map(clean));
  const columns = heads.map((th, i) => {
    const label = clean(th);
    const values = texts.map((t) => t[i]).filter((v) => v && v !== "-");
    const dates = values.filter((v) => DATE_RE.test(v));
    const right = th.classList.contains("text-right");
    const numbers = values.map(parseNumber).filter(Boolean);
    const kind = !values.length ? "empty" : dates.length >= values.length * 0.8 ? "date" : right && numbers.length >= values.length * 0.8 ? "number" : "text";
    const distinct = new Set(texts.map((t) => keyOf(kind, t[i]))).size;
    const sum = kind === "number" && !/harga|price|persen|%|probab/i.test(label);
    return { index: i, label, kind, right, distinct, sum, format: numbers[0] ?? null,
      groupable: Boolean(label) && (kind === "text" || kind === "date") && distinct > 1 && (distinct < rows.length || rows.length <= 5),
      filterable: Boolean(label) && (kind === "text" || kind === "date") && distinct > 1 && distinct <= 200 };
  });
  return { rows, texts, columns, head, tail };
}

/** Kunci pengelompokan satu sel: tanggal menjadi "Okt 2026", teks apa adanya, kosong menjadi "(Kosong)". */
function keyOf(kind, text) {
  if (!text || text === "-") return EMPTY;
  if (kind === "date") {
    const m = DATE_RE.exec(text);
    if (m) {
      const month = MONTHS.findIndex((name) => name.toLowerCase() === m[2].toLowerCase().slice(0, name.length));
      return month >= 0 ? `${m[3]}-${String(month + 1).padStart(2, "0")}` : text;
    }
  }
  return text;
}
const labelOfKey = (kind, key) => {
  if (key === EMPTY) return key;
  const m = kind === "date" ? /^(\d{4})-(\d{2})$/.exec(key) : null;
  return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : key;
};

function formatSum(total, format) {
  const body = new Intl.NumberFormat("id-ID", { minimumFractionDigits: format.decimals, maximumFractionDigits: Math.max(format.decimals, 3) }).format(total);
  return `${format.prefix.includes("-") ? format.prefix.replace("-", "") : format.prefix}${body}${format.suffix}`;
}

/* ---------- Keadaan per tabel ---------- */

const states = new Map(); // kunci tabel -> { group: [indeks kolom], filters: Map(indeks -> Set(kunci)), collapsed: Set(jalur) }

function stateFor(table) {
  const key = table._lt.key;
  if (!states.has(key)) {
    const saved = readSaved()[key] ?? [];
    const group = saved.map((label) => table._lt.columns.find((c) => c.label === label && c.groupable)?.index).filter((i) => i !== undefined);
    states.set(key, { group, filters: new Map(), collapsed: new Set() });
  }
  return states.get(key);
}

function saveGroup(table) {
  const st = stateFor(table);
  const all = readSaved();
  if (st.group.length) all[table._lt.key] = st.group.map((i) => table._lt.columns[i].label);
  else delete all[table._lt.key];
  writeSaved(all);
}

/* ---------- Gambar ulang tabel ---------- */

function passes(table, rowIndex) {
  const { texts, columns } = table._lt;
  const { filters } = stateFor(table);
  for (const [col, allowed] of filters) {
    if (allowed.size && !allowed.has(keyOf(columns[col].kind, texts[rowIndex][col]))) return false;
  }
  return true;
}

function groupHeader(table, depth, path, label, members, collapsed) {
  const { texts, columns } = table._lt;
  const tr = document.createElement("tr");
  tr.className = "lt-group";
  tr.dataset.lt = "toggle";
  tr.dataset.ltPath = path;
  tr.dataset.ltDepth = String(depth);
  columns.forEach((col, i) => {
    const td = document.createElement("td");
    td.className = `py-2 px-4 text-sm ${col.right ? "text-right" : ""}`;
    if (i === 0) {
      td.style.paddingLeft = `${16 + depth * 20}px`;
      td.innerHTML = `<i class="fas ${collapsed ? "fa-chevron-right" : "fa-chevron-down"} text-xs text-gray-500 mr-2"></i>${esc(label)} <span class="font-normal text-gray-500">(${members.length})</span>`;
    } else if (col.sum && col.format) {
      const total = members.reduce((acc, r) => acc + (parseNumber(texts[r][i])?.value ?? 0), 0);
      td.textContent = formatSum(total, col.format);
    }
    tr.append(td);
  });
  return tr;
}

function build(table, rowIdx, levels, depth, path, out) {
  const { rows, texts, columns } = table._lt;
  const st = stateFor(table);
  if (depth >= levels.length) {
    rowIdx.forEach((r) => out.push(rows[r]));
    return;
  }
  const col = columns[levels[depth]];
  const buckets = new Map();
  for (const r of rowIdx) {
    const key = keyOf(col.kind, texts[r][col.index]);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const keys = [...buckets.keys()].sort((a, b) => (a === EMPTY) - (b === EMPTY) || (col.kind === "date" ? b.localeCompare(a) : a.localeCompare(b, "id")));
  for (const key of keys) {
    const here = `${path}/${col.index}:${key}`;
    const collapsed = st.collapsed.has(here);
    out.push(groupHeader(table, depth, here, labelOfKey(col.kind, key), buckets.get(key), collapsed));
    if (!collapsed) build(table, buckets.get(key), levels, depth + 1, here, out);
  }
}

function paintBar(table, visible) {
  const { bar, columns, rows } = table._lt;
  const st = stateFor(table);
  const filterCount = [...st.filters.values()].filter((s) => s.size).length;
  const chips = [
    ...(st.group.length
      ? [`<span class="lt-chip">Kelompok: ${st.group.map((i) => esc(columns[i].label + (columns[i].kind === "date" ? " (bulan)" : ""))).join(" › ")}<button type="button" data-lt="ungroup" aria-label="Hapus pengelompokan">&times;</button></span>`]
      : []),
    ...[...st.filters].filter(([, s]) => s.size).map(([col, s]) =>
      `<span class="lt-chip">${esc(columns[col].label)}: ${esc([...s].map((k) => labelOfKey(columns[col].kind, k)).join(", "))}<button type="button" data-lt="unfilter" data-col="${col}" aria-label="Hapus filter">&times;</button></span>`),
  ];
  bar.innerHTML = `<button type="button" class="lt-btn ${st.group.length ? "on" : ""}" data-lt="group-menu"><i class="fas fa-layer-group"></i>Kelompokkan</button>
    <button type="button" class="lt-btn ${filterCount ? "on" : ""}" data-lt="filter-menu"><i class="fas fa-filter"></i>Filter</button>
    ${chips.join("")}
    <span class="ml-auto flex items-center gap-3 text-gray-500">${st.group.length ? '<button type="button" class="hover:text-indigo-700" data-lt="expand">Buka semua</button><button type="button" class="hover:text-indigo-700" data-lt="collapse">Ciutkan semua</button>' : ""}
      <span>${visible === rows.length ? `${rows.length} baris` : `${visible} dari ${rows.length} baris`}</span></span>`;
}

function paint(table) {
  const { rows } = table._lt;
  const st = stateFor(table);
  const tbody = table.tBodies[0];
  const keep = rows.map((_, i) => i).filter((i) => passes(table, i));
  const out = [];
  build(table, keep, st.group, 0, "", out);
  tbody.replaceChildren(...table._lt.head, ...out, ...table._lt.tail);
  if (!out.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="${table._lt.columns.length}" class="py-10 text-center text-sm text-gray-500">Tidak ada baris yang cocok dengan filter.</td>`;
    tbody.append(tr);
  }
  paintBar(table, keep.length);
}

/* ---------- Menu ---------- */

function openMenu(button, table, kind, column = null) {
  const { columns, texts } = table._lt;
  const st = stateFor(table);
  let html = "";
  if (kind === "group") {
    html = `<div class="lt-head">Kelompokkan menurut</div>${columns.filter((c) => c.groupable).map((c) => {
      const order = st.group.indexOf(c.index);
      return `<button type="button" class="lt-item" data-lt="group-col" data-col="${c.index}"><span>${esc(c.label)}${c.kind === "date" ? " (per bulan)" : ""}</span><span class="text-indigo-600">${order >= 0 ? `<i class="fas fa-check"></i> ${order + 1}` : ""}</span></button>`;
    }).join("") || '<div class="lt-head">Tidak ada kolom yang bisa dikelompokkan</div>'}
      ${st.group.length ? '<div class="lt-sep"></div><button type="button" class="lt-item" data-lt="ungroup">Hapus pengelompokan</button>' : ""}`;
  } else if (kind === "filter" && column === null) {
    html = `<div class="lt-head">Filter menurut kolom</div>${columns.filter((c) => c.filterable).map((c) => {
      const n = st.filters.get(c.index)?.size ?? 0;
      return `<button type="button" class="lt-item" data-lt="filter-col" data-col="${c.index}"><span>${esc(c.label)}</span><span class="text-indigo-600">${n ? `${n} dipilih` : ""}</span></button>`;
    }).join("") || '<div class="lt-head">Tidak ada kolom yang bisa difilter</div>'}
      ${[...st.filters.values()].some((s) => s.size) ? '<div class="lt-sep"></div><button type="button" class="lt-item" data-lt="unfilter-all">Hapus semua filter</button>' : ""}`;
  } else {
    const col = columns[column];
    const counts = new Map();
    texts.forEach((t) => counts.set(keyOf(col.kind, t[column]), (counts.get(keyOf(col.kind, t[column])) ?? 0) + 1));
    const chosen = st.filters.get(column) ?? new Set();
    const keys = [...counts.keys()].sort((a, b) => (a === EMPTY) - (b === EMPTY) || (col.kind === "date" ? b.localeCompare(a) : a.localeCompare(b, "id")));
    html = `<button type="button" class="lt-item" data-lt="filter-menu"><span><i class="fas fa-arrow-left mr-2"></i>Kolom</span><span class="font-semibold">${esc(col.label)}</span></button><div class="lt-sep"></div>
      ${keys.map((k, i) => `<label class="lt-item"><span class="flex items-center gap-2"><input type="checkbox" data-lt="filter-value" data-col="${column}" data-i="${i}" ${chosen.has(k) ? "checked" : ""}> ${esc(labelOfKey(col.kind, k))}</span><span class="text-gray-400">${counts.get(k)}</span></label>`).join("")}`;
    menu._keys = keys;
  }
  menu.innerHTML = html;
  menu.classList.remove("hidden");
  menuOwner = { table, kind, column, button };
  const box = button.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(box.left, window.innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.min(box.bottom + 4, window.innerHeight - 120)}px`;
}

/* ---------- Penanganan acara ---------- */

document.addEventListener("click", (event) => {
  const target = event.target.closest("[data-lt]");
  if (!target) {
    if (!event.target.closest("#lt-menu")) closeMenu();
    return;
  }
  const bar = target.closest("[data-lt-bar]");
  const table = bar?.parentElement?.querySelector("table") ?? target.closest("table") ?? menuOwner?.table;
  if (!table?._lt) return;
  const st = stateFor(table);
  const col = Number(target.dataset.col);
  switch (target.dataset.lt) {
    case "group-menu":
      if (menuOwner?.kind === "group" && menuOwner.button === target) closeMenu();
      else openMenu(target, table, "group");
      return;
    case "filter-menu":
      openMenu(bar ? target : (menuOwner?.button ?? target), table, "filter");
      return;
    case "group-col":
      st.group = st.group.includes(col) ? st.group.filter((i) => i !== col) : [...st.group, col];
      st.collapsed.clear();
      saveGroup(table);
      paint(table);
      openMenu(menuOwner.button, table, "group");
      return;
    case "ungroup":
      st.group = [];
      st.collapsed.clear();
      saveGroup(table);
      closeMenu();
      paint(table);
      return;
    case "filter-col":
      openMenu(menuOwner.button, table, "filter", col);
      return;
    case "unfilter":
      st.filters.delete(col);
      paint(table);
      return;
    case "unfilter-all":
      st.filters.clear();
      closeMenu();
      paint(table);
      return;
    case "toggle": {
      const path = target.dataset.ltPath;
      if (st.collapsed.has(path)) st.collapsed.delete(path);
      else st.collapsed.add(path);
      paint(table);
      return;
    }
    case "expand":
      st.collapsed.clear();
      paint(table);
      return;
    case "collapse":
      st.collapsed = new Set();
      paint(table);
      st.collapsed = new Set([...table.tBodies[0].querySelectorAll("tr.lt-group")].filter((tr) => tr.dataset.ltDepth === "0").map((tr) => tr.dataset.ltPath));
      paint(table);
      return;
    default:
  }
});

// perubahan di dalam menu ditangani di sini dan tidak boleh sampai ke penyalur acara halaman
document.addEventListener(
  "change",
  (event) => {
    if (!event.target.closest("#lt-menu")) return;
    event.stopPropagation();
    const el = event.target.closest("[data-lt='filter-value']");
    if (!el || !menuOwner) return;
    const { table } = menuOwner;
    const col = Number(el.dataset.col);
    const st = stateFor(table);
    const set = st.filters.get(col) ?? new Set();
    const key = menu._keys[Number(el.dataset.i)];
    if (el.checked) set.add(key);
    else set.delete(key);
    st.filters.set(col, set);
    paint(table);
  },
  true,
);
document.addEventListener("input", (event) => {
  if (event.target.closest("#lt-menu")) event.stopPropagation();
}, true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
window.addEventListener("hashchange", closeMenu);
window.addEventListener("scroll", (event) => {
  if (!menu.contains(event.target)) closeMenu();
}, true);

/* ---------- Pemasangan ---------- */

function enhance(table) {
  if (table._lt || table.dataset.list !== "on" || !table.tHead?.rows[0] || !table.tBodies[0] || !table.isConnected) return;
  const analysis = analyze(table);
  if (analysis.rows.length < 2 || analysis.columns.length < 2) return; // satu baris atau kurang tidak perlu pengelompokan
  const bar = document.createElement("div");
  bar.className = "lt-bar";
  bar.dataset.ltBar = "1";
  table.parentElement.insertBefore(bar, table);
  table._lt = { ...analysis, bar, key: tableKey(table) };
  paint(table);
}

/** Pasang bilah Kelompokkan dan Filter pada tabel daftar yang muncul di area halaman (juga setelah halaman menggambar ulang tabelnya). */
export function initListTools(...roots) {
  const targets = roots.filter(Boolean);
  let queued = false;
  const scan = () => {
    queued = false;
    targets.forEach((root) => root.querySelectorAll("table[data-list='on']").forEach(enhance));
  };
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(scan, 30);
  });
  targets.forEach((root) => observer.observe(root, { childList: true, subtree: true }));
  queued = true;
  setTimeout(scan, 30);
}
