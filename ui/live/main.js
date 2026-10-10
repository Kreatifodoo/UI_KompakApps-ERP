// Router dan penyalur acara UI Nusara. Setiap halaman (pages/*.js) mengekspor:
//   render(sub, query), onClick(event, el), onInput(event, el), onChange(event, el),
//   onSubmit(event, form, kind, button), leave().
import {
  OdooError, auth, closeLookup, closeModal, ctx, loadSession, modalOpen, postNote, renderConnect, renderSession,
  resetReferences, searchRead, setReroute, toast, guarded,
} from "./common.js";
import {
  closeMobile, goFirstMatch, goLeaf, openMobile, renderSidebar, resolveActive, setSearch, setVersion, toggleBranch,
} from "./sidebar.js";
import * as pr from "./pages/pr.js";
import * as po from "./pages/po.js";
import * as receipt from "./pages/receipt.js";
import * as bill from "./pages/bill.js";
import * as payment from "./pages/payment.js";
import * as vendor from "./pages/vendor.js";
import * as pricelist from "./pages/pricelist.js";
import * as product from "./pages/product.js";
import * as category from "./pages/category.js";
import * as journal from "./pages/journal.js";
import * as customer from "./pages/customer.js";
import * as sale from "./pages/sale.js";
import * as invoice from "./pages/invoice.js";
import * as delivery from "./pages/delivery.js";
import * as creditnote from "./pages/creditnote.js";
import * as debitnote from "./pages/debitnote.js";
import * as soon from "./pages/soon.js";

const PAGES = { pr, po, receipt, bill, payment, vendor, pricelist, product, category, journal, customer, sale, invoice, delivery, creditnote, debitnote, soon };
let currentId = "pr";

function parseHash() {
  const [pathPart, queryPart = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const [mod, sub = ""] = pathPart.split("/");
  return { id: PAGES[mod] ? mod : "pr", sub, query: new URLSearchParams(queryPart) };
}

async function doRoute() {
  const { id, sub, query } = parseHash();
  if (id !== currentId) PAGES[currentId].leave?.();
  currentId = id;
  closeLookup();
  closeModal();
  renderSidebar(resolveActive(id, sub, query));
  if (!auth.key) {
    ctx.user = null;
    renderSession();
    renderConnect();
    return;
  }
  if (!ctx.user) {
    try {
      await loadSession();
    } catch (error) {
      auth.clear();
      renderSession();
      renderConnect();
      toast(error.message, "error");
      return;
    }
    showVersion();
  }
  renderSession();
  try {
    await PAGES[id].render(sub, query);
  } catch (error) {
    if (error instanceof OdooError && error.status === 401) {
      auth.clear();
      ctx.user = null;
      renderSession();
      renderConnect();
    }
    toast(error.message, "error");
  }
}

/** Versi server Odoo (dibaca dari modul base) untuk footer sidebar. */
async function showVersion() {
  try {
    const [base] = await searchRead("ir.module.module", [["name", "=", "base"]], ["latest_version"], { limit: 1 });
    const version = String(base?.latest_version ?? "").split(".").slice(0, 2).join(".");
    setVersion(version ? `Odoo ${version} · terhubung` : "Odoo · terhubung");
  } catch {
    setVersion("Odoo · terhubung");
  }
}

// Permintaan render diserialkan agar hashchange dan pemuatan ulang tidak saling menimpa.
let queue = Promise.resolve();
export function route() {
  queue = queue.then(doRoute, doRoute);
  return queue;
}
setReroute(route);

const page = () => PAGES[currentId];

/** Mengubah parameter daftar (state, q) sambil mempertahankan yang lain (mis. ids, partner). */
function navigateWith(changes) {
  const [path, queryText = ""] = location.hash.replace(/^#\/?/, "").split("?");
  const params = new URLSearchParams(queryText);
  for (const [key, value] of Object.entries(changes)) {
    if (value) params.set(key, value);
    else params.delete(key);
  }
  const qs = params.toString();
  location.hash = `#/${path}${qs ? `?${qs}` : ""}`;
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  if (!el) return;
  const { action } = el.dataset;
  if (action === "disconnect") {
    auth.clear();
    ctx.user = null;
    resetReferences();
    Object.values(PAGES).forEach((p) => p.leave?.());
    route();
  } else if (action === "goto") {
    location.hash = el.dataset.href;
  } else if (action === "scroll") {
    event.preventDefault();
    document.getElementById(el.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (action === "modal-close") {
    closeModal();
  } else if (action === "menu-toggle") {
    toggleBranch(el.dataset.key);
  } else if (action === "menu-go") {
    goLeaf(el.dataset.key);
  } else if (action === "sidebar-open") {
    openMobile();
  } else if (action === "sidebar-close") {
    closeMobile();
  } else {
    await page().onClick?.(event, el);
  }
});

document.addEventListener("input", (event) => {
  if (event.target.id === "menu-search") setSearch(event.target.value);
  else page().onInput?.(event, event.target);
});

document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.dataset.change === "filter" || el.dataset.change === "search") {
    navigateWith(el.dataset.change === "filter" ? { state: el.value } : { q: el.value.trim() });
    return;
  }
  page().onChange?.(event, el);
});

document.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const kind = form.dataset.form;
  const button = form.querySelector("button[type=submit], button:not([type])");
  if (kind === "connect") {
    const key = document.querySelector("#apikey").value.trim();
    if (!key) return;
    auth.set(key);
    await guarded(button, loadSession);
    if (ctx.user) showVersion();
    else auth.clear();
    route();
  } else if (kind === "note") {
    await postNote(form, button);
  } else {
    await page().onSubmit?.(event, form, kind, button);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && modalOpen()) closeModal();
  if (event.target.id === "menu-search" && event.key === "Enter") goFirstMatch();
});

window.addEventListener("hashchange", route);
route();
