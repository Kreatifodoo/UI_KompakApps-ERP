// Laporan CRM dari crm.lead dan mail.activity: Forecast (pendapatan diharapkan per bulan tenggat dan tahap), Pipeline
// (per tahap dan per sales, menang dan kalah), Leads (asal, konversi, dan kalah), dan Activities (aktivitas terjadwal).
import {
  INPUT, app, badge, call, dateText, esc, guarded, money, pageHeader, referenceUsers, searchRead, selectOptions, toast, dayBoundary,} from "../common.js";

const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 1 });
const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const pad = (n) => String(n).padStart(2, "0");
const todayText = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const monthLabel = (key) => (key ? `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}` : "Tanpa tenggat");
const ACTIVITY_STATES = { overdue: ["Lewat tenggat", "danger"], today: ["Hari ini", "warning"], planned: ["Terjadwal", "info"] };

let last = { sub: "forecast", query: new URLSearchParams() };
export const leave = () => {};

const TITLES = { forecast: "Forecast", pipeline: "Pipeline", leads: "Leads", activities: "Activities" };

const card = (label, value, hint = "") =>
  `<div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">${esc(label)}</div><div class="text-xl font-semibold mt-1">${esc(value)}</div>${hint ? `<div class="text-xs text-gray-500 mt-1">${esc(hint)}</div>` : ""}</div>`;
const head = (labels, right = []) => `<thead class="bg-gray-50"><tr>${labels.map((h, i) => `<th class="py-2 px-4 text-xs font-semibold text-gray-600 uppercase ${right.includes(i) ? "text-right" : ""}">${esc(h)}</th>`).join("")}</tr></thead>`;
const section = (title, inner) => `<section class="bg-white rounded-xl shadow-sm border border-gray-200 mb-4 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 text-sm font-semibold">${esc(title)}</div>${inner}</section>`;
const group = (domain, groupby, aggregates, context = {}) => call("crm.lead", "formatted_read_group", { domain, groupby, aggregates, context });

export async function render(sub, query) {
  const kind = TITLES[sub] ? sub : "forecast";
  last = { sub: kind, query };
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat laporan...</p>';
  const users = await referenceUsers();
  const user = Number(query.get("user")) || null;
  const userFilter = `<select data-crm="user" class="${INPUT} w-48"><option value="">Semua sales</option>${selectOptions(users, user)}</select>`;
  const body = await { forecast, pipeline, leads, activities }[kind](query, user, users);
  app.innerHTML = pageHeader(TITLES[kind], `${body.controls ?? ""}${userFilter}`) + body.html;
}

/* ---------- Forecast ---------- */

async function forecast(query, user) {
  const measure = query.get("measure") === "weighted" ? "prorated_revenue:sum" : "expected_revenue:sum";
  const domain = [["type", "=", "opportunity"], ["active", "=", true], ["won_status", "=", "pending"]];
  if (user) domain.push(["user_id", "=", user]);
  const [rows, stages] = await Promise.all([
    group(domain, ["date_deadline:month", "stage_id"], ["__count", "expected_revenue:sum", "prorated_revenue:sum"]),
    searchRead("crm.stage", [["is_won", "=", false]], ["name"], { order: "sequence, id" }),
  ]);
  const months = new Map();
  for (const r of rows) {
    const key = r["date_deadline:month"] ? r["date_deadline:month"][0].slice(0, 7) : "";
    if (!months.has(key)) months.set(key, new Map());
    months.get(key).set(r.stage_id[0], r);
  }
  const keys = [...months.keys()].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a < b ? -1 : 1));
  const thisMonth = todayText().slice(0, 7);
  const totals = new Map();
  const bodyRows = keys
    .map((key) => {
      const cells = stages.map((st) => {
        const r = months.get(key).get(st.id);
        const value = r?.[measure] ?? 0;
        totals.set(st.id, (totals.get(st.id) ?? 0) + value);
        return `<td class="py-2 px-4 text-sm text-right tabular-nums">${r ? `${esc(money(value))}<div class="text-xs text-gray-400">${r.__count} peluang</div>` : '<span class="text-gray-300">-</span>'}</td>`;
      });
      const rowTotal = [...months.get(key).values()].reduce((s, r) => s + (r[measure] ?? 0), 0);
      const late = key && key < thisMonth;
      return `<tr><td class="py-2 px-4 text-sm ${late ? "text-rose-700 font-medium" : ""}">${esc(monthLabel(key))}${late ? " (lewat)" : ""}</td>${cells.join("")}<td class="py-2 px-4 text-sm text-right tabular-nums font-medium">${esc(money(rowTotal))}</td></tr>`;
    })
    .join("");
  const grand = [...totals.values()].reduce((s, v) => s + v, 0);
  const count = rows.reduce((s, r) => s + r.__count, 0);
  return {
    controls: `<select data-crm="measure" class="${INPUT} w-56"><option value="expected" ${measure.startsWith("expected") ? "selected" : ""}>Pendapatan diharapkan</option><option value="weighted" ${measure.startsWith("prorated") ? "selected" : ""}>Berbobot probabilitas</option></select>`,
    html: `<div class="grid md:grid-cols-3 gap-4 mb-4">${card("Peluang berjalan", String(count))}${card(measure.startsWith("expected") ? "Pendapatan diharapkan" : "Pendapatan berbobot", money(grand))}${card("Bulan dengan tenggat", String(keys.filter(Boolean).length))}</div>` +
      section("Per Bulan Tenggat dan Tahap", `<table class="w-full text-left">${head(["Bulan", ...stages.map((s) => s.name), "Total"], stages.map((_, i) => i + 1).concat([stages.length + 1]))}<tbody class="divide-y divide-gray-100">${bodyRows || `<tr><td colspan="${stages.length + 2}" class="py-8 text-center text-sm text-gray-500">Belum ada opportunity berjalan.</td></tr>`}</tbody>
        ${keys.length ? `<tfoot class="bg-gray-50"><tr><td class="py-2 px-4 text-sm font-semibold">Total</td>${stages.map((s) => `<td class="py-2 px-4 text-sm text-right tabular-nums font-semibold">${esc(money(totals.get(s.id) ?? 0))}</td>`).join("")}<td class="py-2 px-4 text-sm text-right tabular-nums font-semibold">${esc(money(grand))}</td></tr></tfoot>` : ""}</table>`) +
      '<p class="text-xs text-gray-500">Hanya opportunity yang masih berjalan. Bulan yang sudah lewat berwarna merah: tenggatnya perlu diperbarui atau opportunity ditutup.</p>',
  };
}

/* ---------- Pipeline ---------- */

async function pipeline(query, user) {
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  const open = [["type", "=", "opportunity"], ["active", "=", true], ["won_status", "=", "pending"]];
  const closed = (status) => {
    const d = [["type", "=", "opportunity"], ["won_status", "=", status]];
    if (from) d.push(["date_closed", ">=", dayBoundary(from)]);
    if (to) d.push(["date_closed", "<=", dayBoundary(to, true)]);
    return d;
  };
  const withUser = (d) => (user ? [...d, ["user_id", "=", user]] : d);
  const aggregates = ["__count", "expected_revenue:sum", "prorated_revenue:sum", "probability:avg"];
  const [byStage, bySales, won, lost, stages] = await Promise.all([
    group(withUser(open), ["stage_id"], aggregates),
    group(withUser(open), ["user_id"], aggregates),
    group(withUser(closed("won")), [], ["__count", "expected_revenue:sum"]),
    group(withUser(closed("lost")), [], ["__count", "expected_revenue:sum"], { active_test: false }),
    searchRead("crm.stage", [], ["name"], { order: "sequence, id" }),
  ]);
  const order = new Map(stages.map((s, i) => [s.id, i]));
  byStage.sort((a, b) => order.get(a.stage_id[0]) - order.get(b.stage_id[0]));
  const maxRevenue = Math.max(1, ...byStage.map((r) => r["expected_revenue:sum"]));
  const total = byStage.reduce((s, r) => s + r["expected_revenue:sum"], 0);
  const weighted = byStage.reduce((s, r) => s + r["prorated_revenue:sum"], 0);
  const wonRow = won[0] ?? { __count: 0, "expected_revenue:sum": 0 };
  const lostRow = lost[0] ?? { __count: 0, "expected_revenue:sum": 0 };
  const decided = wonRow.__count + lostRow.__count;
  const stageRows = byStage
    .map(
      (r) => `<tr><td class="py-2 px-4 text-sm">${esc(r.stage_id[1])}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${r.__count}</td>
        <td class="py-2 px-4 text-sm w-1/3"><div class="h-3 bg-gray-100 rounded"><div class="h-3 bg-indigo-500 rounded" style="width:${Math.round((r["expected_revenue:sum"] / maxRevenue) * 100)}%"></div></div></td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(r["expected_revenue:sum"]))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(r["prorated_revenue:sum"]))}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${nf.format(r["probability:avg"])}%</td></tr>`,
    )
    .join("");
  const salesRows = bySales
    .map(
      (r) => `<tr><td class="py-2 px-4 text-sm">${esc(r.user_id?.[1] ?? "Tanpa sales")}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${r.__count}</td>
        <td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(r["expected_revenue:sum"]))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${esc(money(r["prorated_revenue:sum"]))}</td></tr>`,
    )
    .join("");
  return {
    controls: `<label class="text-xs font-medium text-gray-500 uppercase">Selesai dari<input type="date" data-crm="from" value="${esc(from)}" class="${INPUT} mt-1 w-40"></label>
      <label class="text-xs font-medium text-gray-500 uppercase">Sampai<input type="date" data-crm="to" value="${esc(to)}" class="${INPUT} mt-1 w-40"></label>`,
    html: `<div class="grid md:grid-cols-4 gap-4 mb-4">
        ${card("Pendapatan diharapkan", money(total), `${byStage.reduce((s, r) => s + r.__count, 0)} peluang berjalan`)}
        ${card("Berbobot probabilitas", money(weighted))}
        ${card("Menang", `${wonRow.__count} · ${money(wonRow["expected_revenue:sum"])}`, from || to ? "pada rentang tanggal tutup" : "semua waktu")}
        ${card("Kalah", `${lostRow.__count} · ${money(lostRow["expected_revenue:sum"])}`, decided ? `tingkat menang ${nf.format((wonRow.__count / decided) * 100)}%` : "belum ada yang ditutup")}</div>` +
      section("Per Tahap", `<table class="w-full text-left">${head(["Tahap", "Peluang", "", "Pendapatan", "Berbobot", "Rata-rata Prob."], [1, 3, 4, 5])}<tbody class="divide-y divide-gray-100">${stageRows || '<tr><td colspan="6" class="py-8 text-center text-sm text-gray-500">Belum ada opportunity berjalan.</td></tr>'}</tbody></table>`) +
      section("Per Sales", `<table class="w-full text-left">${head(["Sales", "Peluang", "Pendapatan", "Berbobot"], [1, 2, 3])}<tbody class="divide-y divide-gray-100">${salesRows || '<tr><td colspan="4" class="py-8 text-center text-sm text-gray-500">Belum ada data.</td></tr>'}</tbody></table>`),
  };
}

/* ---------- Leads ---------- */

async function leads(query, user) {
  const from = query.get("from") ?? "";
  const to = query.get("to") ?? "";
  // Semua kontak yang pernah menjadi lead: yang masih lead atau sudah dikonversi (date_conversion terisi).
  const origin = ["|", ["type", "=", "lead"], ["date_conversion", "!=", false]];
  const base = [...origin];
  if (from) base.push(["create_date", ">=", dayBoundary(from)]);
  if (to) base.push(["create_date", "<=", dayBoundary(to, true)]);
  if (user) base.push(["user_id", "=", user]);
  const converted = [...base, ["date_conversion", "!=", false]];
  const lost = [...base, ["active", "=", false], ["probability", "=", 0]];
  const ctxAll = { active_test: false };
  const [totalBySource, convBySource, lostBySource, totalBySales, convBySales, byMonth] = await Promise.all([
    group(base, ["source_id"], ["__count"], ctxAll), group(converted, ["source_id"], ["__count"], ctxAll), group(lost, ["source_id"], ["__count"], ctxAll),
    group(base, ["user_id"], ["__count"], ctxAll), group(converted, ["user_id"], ["__count"], ctxAll), group(base, ["create_date:month"], ["__count"], ctxAll),
  ]);
  const count = (rows, field, id) => rows.find((r) => (r[field]?.[0] ?? false) === id)?.__count ?? 0;
  const table = (rows, convRows, lostRows, field, empty, label) => {
    const body = rows
      .map((r) => {
        const id = r[field]?.[0] ?? false;
        const conv = count(convRows, field, id);
        const l = lostRows ? count(lostRows, field, id) : null;
        return `<tr><td class="py-2 px-4 text-sm">${esc(r[field]?.[1] ?? empty)}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${r.__count}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${conv}</td>
          ${l === null ? "" : `<td class="py-2 px-4 text-sm text-right tabular-nums">${l}</td>`}<td class="py-2 px-4 text-sm text-right tabular-nums">${r.__count ? nf.format((conv / r.__count) * 100) : 0}%</td></tr>`;
      })
      .join("");
    return `<table class="w-full text-left">${head([label, "Lead masuk", "Dikonversi", ...(lostRows ? ["Kalah"] : []), "Tingkat konversi"], lostRows ? [1, 2, 3, 4] : [1, 2, 3])}<tbody class="divide-y divide-gray-100">${body || '<tr><td colspan="5" class="py-8 text-center text-sm text-gray-500">Belum ada lead pada rentang ini.</td></tr>'}</tbody></table>`;
  };
  const totalLeads = totalBySource.reduce((s, r) => s + r.__count, 0);
  const totalConv = convBySource.reduce((s, r) => s + r.__count, 0);
  const totalLost = lostBySource.reduce((s, r) => s + r.__count, 0);
  const monthRows = byMonth
    .sort((a, b) => (a["create_date:month"][0] < b["create_date:month"][0] ? 1 : -1))
    .map((r) => `<tr><td class="py-2 px-4 text-sm">${esc(monthLabel(r["create_date:month"][0].slice(0, 7)))}</td><td class="py-2 px-4 text-sm text-right tabular-nums">${r.__count}</td></tr>`)
    .join("");
  return {
    controls: `<label class="text-xs font-medium text-gray-500 uppercase">Dibuat dari<input type="date" data-crm="from" value="${esc(from)}" class="${INPUT} mt-1 w-40"></label>
      <label class="text-xs font-medium text-gray-500 uppercase">Sampai<input type="date" data-crm="to" value="${esc(to)}" class="${INPUT} mt-1 w-40"></label>`,
    html: `<div class="grid md:grid-cols-4 gap-4 mb-4">${card("Lead masuk", String(totalLeads))}${card("Dikonversi", String(totalConv))}${card("Kalah", String(totalLost))}${card("Tingkat konversi", `${totalLeads ? nf.format((totalConv / totalLeads) * 100) : 0}%`)}</div>` +
      section("Per Sumber", table(totalBySource, convBySource, lostBySource, "source_id", "Tanpa sumber", "Sumber")) +
      section("Per Sales", table(totalBySales, convBySales, null, "user_id", "Tanpa sales", "Sales")) +
      section("Per Bulan Dibuat", `<table class="w-full text-left">${head(["Bulan", "Lead masuk"], [1])}<tbody class="divide-y divide-gray-100">${monthRows || '<tr><td colspan="2" class="py-8 text-center text-sm text-gray-500">Belum ada data.</td></tr>'}</tbody></table>`) +
      '<p class="text-xs text-gray-500">Lead yang sudah dikonversi menjadi opportunity tetap dihitung sebagai lead masuk. Sumber diisi dari kampanye atau formulir; lead yang dibuat manual tidak punya sumber.</p>',
  };
}

/* ---------- Activities ---------- */

async function activities(query, user) {
  const state = query.get("state") ?? "";
  const domain = [["res_model", "=", "crm.lead"]];
  if (user) domain.push(["user_id", "=", user]);
  // mail.activity.state tidak tersimpan, jadi tidak bisa dicari: filter memakai tanggal tenggat (tanggal setempat).
  const today = todayText();
  if (state === "overdue") domain.push(["date_deadline", "<", today]);
  else if (state === "today") domain.push(["date_deadline", "=", today]);
  else if (state === "planned") domain.push(["date_deadline", ">", today]);
  const rows = await searchRead("mail.activity", domain, ["res_id", "res_name", "activity_type_id", "summary", "date_deadline", "user_id", "state"], { order: "date_deadline, id", limit: 200 });
  const all = state ? await searchRead("mail.activity", domain.filter((c) => c[0] !== "date_deadline"), ["state"], { limit: 1000 }) : rows;
  const counts = { overdue: 0, today: 0, planned: 0 };
  for (const a of all) counts[a.state] = (counts[a.state] ?? 0) + 1;
  const leadIds = [...new Set(rows.map((r) => r.res_id))];
  const types = new Map();
  if (leadIds.length) for (const l of await searchRead("crm.lead", [["id", "in", leadIds]], ["type"], { context: { active_test: false } })) types.set(l.id, l.type);
  const body = rows
    .map((a) => {
      const route = types.get(a.res_id) === "lead" ? "lead" : "opportunity";
      return `<tr><td class="py-2 px-4 text-sm"><a href="#/${route}/${a.res_id}" class="font-medium text-indigo-700 hover:underline">${esc(a.res_name)}</a></td>
        <td class="py-2 px-4 text-sm">${esc(a.activity_type_id?.[1] ?? "")}</td><td class="py-2 px-4 text-sm">${esc(a.summary || "-")}</td>
        <td class="py-2 px-4 text-sm">${esc(dateText(a.date_deadline))}</td><td class="py-2 px-4 text-sm">${esc(a.user_id?.[1] ?? "")}</td>
        <td class="py-2 px-4 text-sm">${badge(ACTIVITY_STATES, a.state)}</td>
        <td class="py-2 px-4 text-right"><button type="button" data-action="activity-done" data-id="${a.id}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Selesai</button></td></tr>`;
    })
    .join("");
  const filter = (key, label, count, tone) => `<a href="#/crmreport/activities${key ? `?state=${key}` : ""}${user ? `${key ? "&" : "?"}user=${user}` : ""}" class="block bg-white rounded-xl border ${state === key ? "border-indigo-400" : "border-gray-200"} shadow-sm p-4 hover:bg-gray-50"><div class="text-xs font-medium text-gray-500 uppercase">${label}</div><div class="text-xl font-semibold mt-1 ${tone}">${count}</div></a>`;
  return {
    html: `<div class="grid md:grid-cols-4 gap-4 mb-4">${filter("", "Semua", counts.overdue + counts.today + counts.planned, "")}${filter("overdue", "Lewat tenggat", counts.overdue, "text-rose-700")}${filter("today", "Hari ini", counts.today, "text-amber-700")}${filter("planned", "Terjadwal", counts.planned, "")}</div>` +
      section("Aktivitas CRM", `<table class="w-full text-left">${head(["Lead / Opportunity", "Jenis", "Ringkasan", "Tenggat", "Ditugaskan", "Status", ""])}<tbody class="divide-y divide-gray-100">${body || '<tr><td colspan="7" class="py-8 text-center text-sm text-gray-500">Tidak ada aktivitas.</td></tr>'}</tbody></table>`) +
      '<p class="text-xs text-gray-500">Jadwalkan aktivitas dari form lead atau opportunity. Selesai mencatat aktivitas di riwayat catatan.</p>',
  };
}

export async function onClick(event, el) {
  if (el.dataset.action !== "activity-done") return;
  const ok = await guarded(el, () => call("mail.activity", "action_feedback", { ids: [Number(el.dataset.id)], feedback: "" }));
  if (ok !== undefined) {
    toast("Aktivitas selesai.");
    render(last.sub, last.query);
  }
}

export function onChange(event, el) {
  const key = el.dataset.crm;
  if (!key) return;
  const params = new URLSearchParams(last.query);
  if (key === "measure") {
    if (el.value === "weighted") params.set("measure", "weighted");
    else params.delete("measure");
  } else if (el.value) params.set(key, el.value);
  else params.delete(key);
  const qs = params.toString();
  location.hash = `#/crmreport/${last.sub}${qs ? `?${qs}` : ""}`;
}
