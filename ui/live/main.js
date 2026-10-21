// Router dan penyalur acara UI KompakApps. Setiap halaman (pages/*.js) mengekspor:
//   render(sub, query), onClick(event, el), onInput(event, el), onChange(event, el),
//   onSubmit(event, form, kind, button), leave().
import {
  OdooError, activeCompany, app, auth, closeLookup, closeModal, ctx, esc, loadSession, modalOpen, renderConnect, renderSession,
  resetReferences, setReroute, toast, guarded,
} from "./common.js";
import {
  closeMobile, goFirstMatch, goLeaf, openMobile, renderSidebar, resolveActive, setSearch, setVersion, toggleBranch,
} from "./sidebar.js";
import { initColumnResize } from "./colresize.js";
import { initListTools } from "./listtools.js";
import { handleActivityAction } from "./activity.js";
import { handleAttachmentAction, handleAttachmentChange, postNoteWithFiles } from "./attachments.js";
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
import * as companies from "./pages/companies.js";
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
import * as routes from "./pages/route.js";
import * as rules from "./pages/rule.js";
import * as employee from "./pages/employee.js";
import * as department from "./pages/department.js";
import * as job from "./pages/job.js";
import * as attendance from "./pages/attendance.js";
import * as timeoff from "./pages/timeoff.js";
import * as leavealloc from "./pages/leavealloc.js";
import * as leavetype from "./pages/leavetype.js";
import * as leavebalance from "./pages/leavebalance.js";
import * as expense from "./pages/expense.js";
import * as contract from "./pages/contract.js";
import * as salarystruct from "./pages/salarystruct.js";
import * as salaryrule from "./pages/salaryrule.js";
import * as rulecategory from "./pages/rulecategory.js";
import * as contribreg from "./pages/contribreg.js";
import * as payslip from "./pages/payslip.js";
import * as payslipbatch from "./pages/payslipbatch.js";

const PAGES = { pr, po, receipt, bill, payment, vendor, pricelist, product, category, journal, customer, sale, invoice, delivery, creditnote, debitnote, report, aging, ledger, bank, stock, moves, count, scrap, orderpoint, replenish, warehouse, location: location_, uom, putaway, lot, bom, workcenter, mo, schedule, production, lead, opportunity, crmsetting, crmreport, posconfig, possession, posorder, kasir, salespricelist, acctreport, dashboard, account, tax, currency, analytic, analyticplan, assetprofile, asset, journalmaster, analysis, modsetting, users, company, companies, dataimport, auditlog, budgetplan, budget, budgetreport, transfer, soon };
Object.assign(PAGES, { loyalty });
Object.assign(PAGES, { valuation });
Object.assign(PAGES, { route: routes, rule: rules });
Object.assign(PAGES, { employee, department, job, attendance, timeoff, leavealloc, leavetype, leavebalance, expense, contract });
Object.assign(PAGES, { salarystruct, salaryrule, rulecategory, contribreg, payslip, payslipbatch });
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
    if (error instanceof OdooError && error.status === 403) {
      app.innerHTML = `<section class="max-w-2xl bg-amber-50 border border-amber-200 rounded-xl p-6"><div class="font-semibold text-amber-900"><i class="fas fa-lock mr-2"></i>Akses ditolak</div>
        <p class="text-sm text-amber-900 mt-2">Akun Anda belum punya hak akses untuk halaman ini. Minta administrator memberi peran yang sesuai di General Setting &gt; Users &amp; Access (mis. Human Resources untuk menu SDM).</p>
        <p class="text-xs text-amber-800 mt-2">Rincian: ${esc(error.message)}</p></section>`;
      return;
    }
    toast(error.message, "error");
  }
}

/** Status koneksi untuk footer sidebar. */
async function showVersion() {
  setVersion("Terhubung");
}

// Permintaan render diserialkan agar hashchange dan pemuatan ulang tidak saling menimpa.
let queue = Promise.resolve();
export function route() {
  queue = queue.then(doRoute, doRoute);
  return queue;
}
setReroute(route);
// Semua tabel (baris pesanan, daftar, laporan) bisa diubah lebar kolomnya dengan menarik tepi judul kolom.
initColumnResize(document.querySelector("#app"), document.querySelector("#modal"));
initListTools(document.querySelector("#app"), document.querySelector("#modal"));

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
  } else if (action.startsWith("act-") && (await handleActivityAction(action, el))) {
    /* aktivitas terjadwal ditangani activity.js */
  } else if (action.startsWith("att-") && (await handleAttachmentAction(action, el))) {
    /* lampiran ditangani attachments.js */
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
  if (el.matches?.("[data-att-file], [data-note-file]")) {
    handleAttachmentChange(el);
    return;
  }
  if (el.dataset.change === "company") {
    // ganti perusahaan aktif: semua halaman dimuat ulang dengan perusahaan baru, kembali ke daftar modul yang sedang dibuka
    activeCompany.set(Number(el.value));
    const base = location.hash.replace(/^#\/?/, "").split("?")[0].split("/")[0];
    location.hash = base ? `#/${base}` : "";
    location.reload();
    return;
  }
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
    await postNoteWithFiles(form, button);
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
