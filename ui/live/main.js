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
import * as report from "./pages/report.js";
import * as aging from "./pages/aging.js";
import * as ledger from "./pages/ledger.js";
import * as bank from "./pages/bank.js";
import * as stock from "./pages/stock.js";
import * as moves from "./pages/moves.js";
import * as count from "./pages/count.js";
import * as scrap from "./pages/scrap.js";
import * as orderpoint from "./pages/orderpoint.js";
import * as replenish from "./pages/replenish.js";
import * as warehouse from "./pages/warehouse.js";
import * as location_ from "./pages/location.js";
import * as uom from "./pages/uom.js";
import * as putaway from "./pages/putaway.js";
import * as lot from "./pages/lot.js";
import * as bom from "./pages/bom.js";
import * as workcenter from "./pages/workcenter.js";
import * as mo from "./pages/mo.js";
import * as schedule from "./pages/schedule.js";
import * as production from "./pages/production.js";
import * as lead from "./pages/lead.js";
import * as opportunity from "./pages/opportunity.js";
import * as crmsetting from "./pages/crmsetting.js";
import * as crmreport from "./pages/crmreport.js";
import * as posconfig from "./pages/pos.js";
import * as possession from "./pages/possession.js";
import * as posorder from "./pages/posorder.js";
import * as kasir from "./pages/kasir.js";
import * as salespricelist from "./pages/salespricelist.js";
import * as acctreport from "./pages/acctreport.js";
import * as dashboard from "./pages/dashboard.js";
import * as account from "./pages/account.js";
import * as tax from "./pages/tax.js";
import * as currency from "./pages/currency.js";
import * as analytic from "./pages/analytic.js";
import * as analyticplan from "./pages/analyticplan.js";
import * as assetprofile from "./pages/assetprofile.js";
import * as asset from "./pages/asset.js";
import * as journalmaster from "./pages/journalmaster.js";
import * as analysis from "./pages/analysis.js";
import * as modsetting from "./pages/modsetting.js";
import * as users from "./pages/users.js";
import * as company from "./pages/company.js";
import * as dataimport from "./pages/dataimport.js";
import * as auditlog from "./pages/auditlog.js";
import * as budgetplan from "./pages/budgetplan.js";
import * as budget from "./pages/budget.js";
import * as budgetreport from "./pages/budgetreport.js";
import * as transfer from "./pages/transfer.js";
import * as soon from "./pages/soon.js";
import { printDocument, printNow, printVariant } from "./print.js";
import * as loyalty from "./pages/loyalty.js";
import * as valuation from "./pages/valuation.js";

const PAGES = { pr, po, receipt, bill, payment, vendor, pricelist, product, category, journal, customer, sale, invoice, delivery, creditnote, debitnote, report, aging, ledger, bank, stock, moves, count, scrap, orderpoint, replenish, warehouse, location: location_, uom, putaway, lot, bom, workcenter, mo, schedule, production, lead, opportunity, crmsetting, crmreport, posconfig, possession, posorder, kasir, salespricelist, acctreport, dashboard, account, tax, currency, analytic, analyticplan, assetprofile, asset, journalmaster, analysis, modsetting, users, company, dataimport, auditlog, budgetplan, budget, budgetreport, transfer, soon };
Object.assign(PAGES, { loyalty });
Object.assign(PAGES, { valuation });
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
  } else if (action === "print-doc") {
    await printDocument(el.dataset.model, Number(el.dataset.id), el);
  } else if (action === "print-now") {
    printNow();
  } else if (action === "print-variant") {
    printVariant(el.dataset.variant);
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
