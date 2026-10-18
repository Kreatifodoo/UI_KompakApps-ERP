// Lebar kolom tabel bisa diubah dengan menarik garis di tepi kanan judul kolom (baris pesanan, daftar, laporan). Lebar disimpan per jenis
// tabel (halaman dan judul kolomnya) di browser; klik ganda pada garis mengembalikan lebar bawaan. Berlaku otomatis untuk semua tabel
// yang punya judul kolom, juga setelah halaman menggambar ulang tabelnya. Tabel yang tidak ingin ikut diberi atribut data-resizable="off".
const STORAGE_KEY = "nusara.colwidths";
const MIN_WIDTH = 56;

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
};
const write = (all) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* penyimpanan boleh gagal; lebar tetap berlaku untuk tampilan ini */
  }
};

const css = document.createElement("style");
css.textContent = `
  .cr-handle { position: absolute; top: 0; right: 0; bottom: 0; width: 8px; cursor: col-resize; z-index: 2; touch-action: none; user-select: none; }
  .cr-handle::after { content: ""; position: absolute; top: 22%; bottom: 22%; left: 3px; width: 2px; border-radius: 1px; background: currentColor; opacity: 0; transition: opacity .12s; }
  th:hover > .cr-handle::after, .cr-handle:hover::after, .cr-active::after { opacity: .35; }
  .cr-active::after { opacity: .7 !important; background: #0C87A0; }
  table[data-cr] th { position: relative; overflow: hidden; text-overflow: ellipsis; }
  body.cr-dragging, body.cr-dragging * { cursor: col-resize !important; user-select: none !important; }
`;
document.head.append(css);

const pageKey = () => (location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[0] || "home");
const tableKey = (table) => `${pageKey()}::${[...table.tHead.rows[0].cells].map((c) => c.textContent.trim().replace(/\s+/g, " ")).join("|")}`;

function applyWidths(table, widths) {
  const cols = table.querySelectorAll(":scope > colgroup > col");
  widths.forEach((w, i) => {
    if (cols[i]) cols[i].style.width = `${Math.round(w)}px`;
  });
  table.style.width = `${Math.round(widths.reduce((a, b) => a + b, 0))}px`;
}

function reset(table) {
  const all = read();
  delete all[table._crKey];
  write(all);
  table.querySelector(":scope > colgroup")?.remove();
  table.querySelectorAll(".cr-handle").forEach((h) => h.remove());
  table.style.tableLayout = "";
  table.style.width = "";
  table.style.minWidth = "";
  delete table.dataset.cr;
  table._cr = false;
  setTimeout(() => enhance(table), 0);
}

function enhance(table) {
  if (table._cr || table.dataset.resizable === "off" || !table.tHead?.rows[0] || !table.isConnected) return;
  const heads = [...table.tHead.rows[0].cells];
  if (heads.length < 2 || heads.some((c) => c.colSpan > 1) || !table.offsetWidth) return;
  table._cr = true;
  table._crKey = tableKey(table);
  const measured = heads.map((c) => c.getBoundingClientRect().width);
  const saved = read()[table._crKey];
  const widths = Array.isArray(saved) && saved.length === heads.length ? saved.map((w, i) => Math.max(MIN_WIDTH, Number(w) || measured[i])) : measured;
  const group = document.createElement("colgroup");
  heads.forEach(() => group.append(document.createElement("col")));
  table.insertBefore(group, table.firstChild);
  table.dataset.cr = "1";
  table.style.tableLayout = "fixed";
  table.style.minWidth = "100%";
  applyWidths(table, widths);
  heads.forEach((th, i) => {
    const handle = document.createElement("span");
    handle.className = "cr-handle";
    handle.setAttribute("aria-hidden", "true");
    handle.title = "Tarik untuk mengubah lebar kolom; klik ganda untuk mengembalikan";
    th.append(handle);
    handle.addEventListener("click", (e) => e.stopPropagation());
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      reset(table);
    });
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture?.(e.pointerId);
      const startX = e.clientX;
      const current = [...table.querySelectorAll(":scope > colgroup > col")].map((c, k) => parseFloat(c.style.width) || heads[k].getBoundingClientRect().width);
      handle.classList.add("cr-active");
      document.body.classList.add("cr-dragging");
      const move = (ev) => {
        const next = current.slice();
        next[i] = Math.max(MIN_WIDTH, current[i] + (ev.clientX - startX));
        applyWidths(table, next);
      };
      const stop = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", stop);
        handle.removeEventListener("pointercancel", stop);
        handle.classList.remove("cr-active");
        document.body.classList.remove("cr-dragging");
        const all = read();
        all[table._crKey] = [...table.querySelectorAll(":scope > colgroup > col")].map((c) => Math.round(parseFloat(c.style.width) || MIN_WIDTH));
        write(all);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
    });
  });
}

/** Mulai memantau area halaman dan dialog: tabel baru yang muncul (juga setelah render ulang) ikut bisa digeser kolomnya. */
export function initColumnResize(...roots) {
  const targets = roots.filter(Boolean);
  let queued = false;
  const scan = () => {
    queued = false;
    targets.forEach((root) => root.querySelectorAll("table").forEach(enhance));
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    setTimeout(scan, 30);
  };
  const observer = new MutationObserver(schedule);
  targets.forEach((root) => observer.observe(root, { childList: true, subtree: true }));
  schedule();
}
