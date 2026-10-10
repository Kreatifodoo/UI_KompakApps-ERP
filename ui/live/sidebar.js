// Sidebar Nusara: mengikuti desain prototipe (index.html): panel gelap slate-900 lebar 288px, modul
// bertingkat sebagai accordion, warna aktif indigo, dan pencarian menu. Menu yang sudah terhubung ke Odoo
// diberi titik hijau kecil.
import { LEAVES, MENU, findLeaf } from "./menu.js";
import { esc } from "./common.js";

const nav = document.querySelector("#sidebar-nav");
const panel = document.querySelector("#sidebar");
const overlay = document.querySelector("#sidebar-overlay");
const versionBox = document.querySelector("#sidebar-version");
const PAD = ["px-4", "pl-10 pr-4", "pl-14 pr-4"];

const open = new Set();
let activeKey = null;
let clickedKey = null; // menu yang baru diklik; diutamakan sekali bila satu halaman melayani beberapa menu
let lastActive = null; // menu aktif terakhir; dipakai untuk halaman detail yang tidak membawa filter
let search = "";

const ancestors = (key) => key.split(".").map((_, i, parts) => parts.slice(0, i + 1).join("."));

function visible(item, q) {
  if (!q) return true;
  if (item.items) return item.items.some((c) => visible(c, q));
  const leaf = LEAVES.find((l) => l.key === item.key);
  return (leaf?.path ?? [item.title]).join(" ").toLowerCase().includes(q);
}

function renderItem(item, level, q) {
  if (!visible(item, q)) return "";
  const hasChildren = Boolean(item.items);
  const isOpen = q ? true : open.has(item.key);
  const onPath = activeKey && (activeKey === item.key || activeKey.startsWith(`${item.key}.`));
  const cls = !hasChildren && item.key === activeKey
    ? "bg-indigo-600 text-white"
    : onPath && hasChildren ? "bg-slate-800 text-indigo-400" : "text-slate-300 hover:bg-slate-800 hover:text-white";
  const icon = item.icon
    ? `<i class="${item.icon} w-6 text-center mr-2 text-sm"></i>`
    : level > 0 ? '<div class="w-1.5 h-1.5 rounded-full bg-current mr-3 opacity-50"></div>' : "";
  const live = !hasChildren && item.route
    ? '<span class="ml-2 w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" title="Terhubung ke Odoo" aria-label="Terhubung ke Odoo"></span>'
    : "";
  const chevron = hasChildren
    ? `<i class="fas fa-chevron-down text-xs transition-transform duration-300 ${isOpen ? "rotate-180" : ""}"></i>`
    : "";
  const children = hasChildren
    ? `<div class="overflow-hidden transition-all duration-300 ${isOpen ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0"}">
         <div class="bg-slate-900 border-l border-slate-700 ml-5 my-1">${item.items.map((c) => renderItem(c, level + 1, q)).join("")}</div></div>`
    : "";
  return `<div class="flex flex-col">
    <button data-action="${hasChildren ? "menu-toggle" : "menu-go"}" data-key="${item.key}" ${hasChildren ? `aria-expanded="${isOpen}"` : ""}
      class="flex items-center justify-between py-3 ${PAD[level] ?? PAD[2]} transition-colors duration-200 w-full text-left ${cls}">
      <span class="flex items-center min-w-0">${icon}<span class="${level === 0 ? "font-medium" : "font-normal"} text-sm truncate">${esc(item.title)}</span>${live}</span>
      ${chevron}
    </button>${children}</div>`;
}

function paint() {
  const q = search.trim().toLowerCase();
  const html = MENU.map((m) => renderItem(m, 0, q)).join("");
  nav.innerHTML = `<div class="px-4 pb-2 mb-2"><p class="text-xs font-semibold text-slate-500 uppercase tracking-wider">Main Modules</p></div>${
    html || '<p class="px-4 py-3 text-sm text-slate-500">Menu tidak ditemukan.</p>'}`;
}

/** Menentukan menu aktif untuk halaman yang sedang dibuka. */
export function resolveActive(pageId, sub, query) {
  if (pageId === "soon") return sub;
  const candidates = LEAVES.filter((l) => l.mod === pageId);
  if (!candidates.length) return null;
  // Beberapa menu bisa menuju halaman yang sama (mis. Product Master di tiap modul): prioritaskan yang cocok
  // dengan filter di URL, lalu menu yang baru diklik, lalu menu aktif sebelumnya.
  const wanted = ["state", "type", "returns"].map((key) => query.get(key) && `${key}=${query.get(key)}`).filter(Boolean);
  const byState = wanted.length ? candidates.filter((c) => wanted.some((w) => c.route.includes(w))) : [];
  const pool = byState.length ? byState : candidates;
  const clicked = clickedKey && pool.find((c) => c.key === clickedKey);
  clickedKey = null;
  if (clicked) return clicked.key;
  const previous = lastActive && pool.find((c) => c.key === lastActive);
  if (previous) return previous.key;
  return (pool.find((c) => c.route === pageId) ?? pool[0]).key;
}

export function renderSidebar(key) {
  activeKey = key;
  if (key) lastActive = key;
  if (key) ancestors(key).forEach((k) => open.add(k));
  paint();
}

export function toggleBranch(key) {
  if (open.has(key)) open.delete(key);
  else open.add(key);
  paint();
}

export function goLeaf(key) {
  const leaf = findLeaf(key);
  if (!leaf) return;
  clickedKey = key;
  const target = leaf.route ? `#/${leaf.route}` : `#/soon/${leaf.key}`;
  if (location.hash === target) location.hash = ""; // paksa render ulang bila menu yang sama diklik lagi
  location.hash = target;
  closeMobile();
}

export function setSearch(value) {
  search = value;
  paint();
}
export function goFirstMatch() {
  const q = search.trim().toLowerCase();
  const hit = q && LEAVES.find((l) => l.path.join(" ").toLowerCase().includes(q));
  if (hit) goLeaf(hit.key);
}

export function openMobile() {
  panel.classList.remove("-translate-x-full");
  overlay.classList.remove("hidden");
}
export function closeMobile() {
  panel.classList.add("-translate-x-full");
  overlay.classList.add("hidden");
}
export const setVersion = (text) => {
  versionBox.textContent = text;
};
