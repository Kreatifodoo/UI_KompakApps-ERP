// Lead dan Opportunity (crm.lead). Satu kerangka melayani dua halaman: Leads (type lead, belum dikualifikasi) dan
// Opportunity (type opportunity, papan pipeline per tahap dan daftar). Form mengikuti form CRM Odoo 19: kontak, pendapatan
// diharapkan, probabilitas, prioritas, tag, aktivitas terjadwal, Menang, Kalah, konversi, dan Quotation.
import {
  INPUT, actionBar, app, badge, button, call, cell, changedValues, attachmentsPendingHtml, chatterHtml, closeLookup, closeModal, ctx, dateText, esc, fieldBlock, filterSelect, guarded,
  hasGroup, loadMessages, money, openModal, pageHeader, plain, readOne, readonlyValue, referenceCountries, referenceUsers, registerLookup, resetReferences,
  rowLink, runLookup, searchBox, searchRead, selectOptions, statTiles, statusbar, table, toast,
} from "../common.js";

const PRIORITY = { 0: "Normal", 1: "Rendah", 2: "Tinggi", 3: "Sangat Tinggi" };
const STARS = (p) => `<span class="text-amber-500 whitespace-nowrap" title="${esc(PRIORITY[p] ?? "")}">${"★".repeat(Number(p) || 0)}<span class="text-gray-300">${"★".repeat(3 - (Number(p) || 0))}</span></span>`;
const WON = { won: ["Menang", "success"], lost: ["Kalah", "danger"], pending: ["Berjalan", "info"] };
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 2 });

const READ = [
  "name", "type", "active", "stage_id", "probability", "expected_revenue", "partner_id", "partner_name", "contact_name", "email_from", "phone", "function", "street", "city", "zip",
  "country_id", "user_id", "team_id", "tag_ids", "priority", "date_deadline", "description", "won_status", "lost_reason_id", "date_closed", "create_date",
  "quotation_count", "sale_amount_total", "order_ids", "is_automated_probability",
];
const TEXT = ["name", "partner_name", "contact_name", "email_from", "phone", "function", "street", "city", "zip"];

export function createLeadPage(config) {
  let form = null; // { id, values, initial, partner }
  let last = { sub: "", query: new URLSearchParams() };
  let refs = null; // { stages, teams, tags, reasons }
  const leave = () => {
    form = null;
  };
  const reload = () => render(last.sub, last.query);

  async function references() {
    refs ??= {
      stages: await searchRead("crm.stage", [], ["name", "is_won", "sequence", "fold"], { order: "sequence, id" }),
      teams: await searchRead("crm.team", [], ["display_name"], { order: "sequence, name" }),
      tags: await searchRead("crm.tag", [], ["display_name"], { order: "name" }),
      reasons: await searchRead("crm.lost.reason", [], ["name"], { order: "name" }),
    };
    return refs;
  }

  registerLookup(`${config.route}-partner`, {
    search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: "customer_rank desc, name" }),
    isChosen: (input) => form?.partner?.display_name === input.value,
    choose: (input, item) => {
      form.partner = item;
      form.values.partner_id = item.id;
      input.value = item.display_name;
    },
  });

  async function render(sub, query) {
    last = { sub, query };
    if (sub === "") return config.board && query.get("view") !== "list" ? renderBoard(query) : renderList(query);
    return renderForm(sub === "new" ? null : Number(sub));
  }

  const baseDomain = (query) => {
    const state = query.get("state") ?? "";
    const text = query.get("q") ?? "";
    const domain = [["type", "=", config.type]];
    if (state === "lost") domain.push(["active", "=", false], ["probability", "=", 0]);
    else if (state === "won") domain.push(["won_status", "=", "won"]);
    else if (state === "open") domain.push(["active", "=", true], ["won_status", "=", "pending"]);
    if (text) domain.push("|", "|", "|", ["name", "ilike", text], ["partner_name", "ilike", text], ["contact_name", "ilike", text], ["email_from", "ilike", text]);
    const user = Number(query.get("user")) || null;
    if (user) domain.push(["user_id", "=", user]);
    if (query.get("ids")) domain.push(["id", "in", query.get("ids").split(",").map(Number).filter(Boolean)]);
    return domain;
  };
  const FILTERS = [["", "Aktif"], ["open", "Masih berjalan"], ["won", "Menang"], ["lost", "Kalah"]];
  const domainOf = (query) => {
    const domain = baseDomain(query);
    return { domain, withInactive: query.get("state") === "lost" };
  };

  /* ---------- Daftar ---------- */

  async function renderList(query) {
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    const { domain, withInactive } = domainOf(query);
    const [rows, enabled] = await Promise.all([
      searchRead("crm.lead", domain, ["name", "partner_id", "partner_name", "contact_name", "email_from", "phone", "stage_id", "expected_revenue", "user_id", "create_date", "won_status", "priority", "probability"], {
        order: "priority desc, id desc", limit: 100, context: { active_test: !withInactive },
      }),
      config.type === "lead" ? hasGroup("crm.group_use_lead") : true,
    ]);
    const body = rows
      .map((r) =>
        rowLink(`#/${config.route}/${r.id}`, [
          cell(r.name, { strong: true }),
          cell(r.partner_id?.[1] || r.partner_name || r.contact_name || "-"),
          cell(r.email_from || r.phone || "-"),
          ...(config.type === "opportunity" ? [cell(r.stage_id?.[1] ?? "-"), cell(money(r.expected_revenue), { right: true }), cell(`${nf.format(r.probability)}%`, { right: true })] : []),
          cell(r.user_id?.[1] ?? "-"),
          cell(dateText(r.create_date)),
          cell(badge(WON, r.won_status), { raw: true }),
        ]),
      )
      .join("");
    const heads = [{ label: "Nama" }, { label: "Kontak" }, { label: "Email / Telepon" }, ...(config.type === "opportunity" ? [{ label: "Tahap" }, { label: "Pendapatan", right: true }, { label: "Prob.", right: true }] : []), { label: "Sales" }, { label: "Dibuat" }, { label: "Status" }];
    app.innerHTML =
      pageHeader(
        config.title,
        `${searchBox(query.get("q") ?? "", "Cari nama, kontak, email")}${filterSelect(FILTERS, query.get("state") ?? "")}
         ${config.board ? '<a href="#/opportunity" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-table-columns mr-2"></i>Pipeline</a>' : ""}
         <a href="#/${config.route}/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>${config.newLabel}</a>`,
      ) +
      (enabled ? "" : leadsOff()) +
      table(heads, body, config.empty);
  }

  const leadsOff = () => `<div class="mb-4 text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex flex-wrap items-center gap-3">
      <span>Fitur Leads belum aktif, jadi kontak baru langsung menjadi opportunity.</span>
      <button data-action="enable-leads" class="px-3 py-1 bg-white border border-amber-300 rounded-lg hover:bg-amber-100">Aktifkan Leads</button></div>`;

  /* ---------- Papan pipeline ---------- */

  async function renderBoard(query) {
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat pipeline...</p>';
    const { stages } = await references();
    const { domain } = domainOf(query);
    if (!query.get("state")) domain.push(["active", "=", true]);
    const rows = await searchRead("crm.lead", domain, ["name", "partner_id", "partner_name", "contact_name", "stage_id", "expected_revenue", "probability", "priority", "user_id", "date_deadline", "won_status"], {
      order: "priority desc, id desc", limit: 500, context: { active_test: query.get("state") !== "lost" },
    });
    const columns = stages
      .map((st) => {
        const cards = rows.filter((r) => r.stage_id?.[0] === st.id);
        const total = cards.reduce((sum, r) => sum + r.expected_revenue, 0);
        const html = cards
          .map(
            (r) => `<div draggable="true" data-card="${r.id}" class="bg-white border border-gray-200 rounded-lg p-3 shadow-sm cursor-grab hover:border-indigo-300">
              <a href="#/opportunity/${r.id}" class="block text-sm font-medium text-gray-900 hover:text-indigo-700">${esc(r.name)}</a>
              <div class="text-xs text-gray-500 mt-1">${esc(r.partner_id?.[1] || r.partner_name || r.contact_name || "-")}</div>
              <div class="flex items-center justify-between mt-2 text-xs"><span class="font-medium text-gray-700">${esc(money(r.expected_revenue))}</span>${STARS(r.priority)}</div>
              <div class="flex items-center justify-between mt-1 text-xs text-gray-500"><span>${r.date_deadline ? esc(dateText(r.date_deadline)) : ""}</span><span>${esc(r.user_id?.[1] ?? "")}</span></div>
              <select data-change-stage="${r.id}" class="mt-2 w-full border border-gray-200 rounded px-2 py-1 text-xs text-gray-600" aria-label="Pindahkan ke tahap">${stages.map((s) => `<option value="${s.id}" ${s.id === st.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>`,
          )
          .join("");
        return `<div data-stage="${st.id}" class="w-72 shrink-0 bg-gray-100 rounded-xl p-3">
          <div class="flex items-center justify-between mb-1"><div class="text-sm font-semibold text-gray-800">${esc(st.name)}</div><span class="text-xs bg-white border border-gray-200 rounded-full px-2 py-0.5">${cards.length}</span></div>
          <div class="text-xs text-gray-500 mb-3">${esc(money(total))}</div>
          <div class="space-y-2 min-h-16" data-dropzone="${st.id}">${html || '<div class="text-xs text-gray-400 text-center py-4">Kosong</div>'}</div></div>`;
      })
      .join("");
    const open = rows.filter((r) => r.won_status === "pending");
    const totalOpen = open.reduce((s, r) => s + r.expected_revenue, 0);
    const weighted = open.reduce((s, r) => s + (r.expected_revenue * r.probability) / 100, 0);
    app.innerHTML =
      pageHeader(
        config.title,
        `${searchBox(query.get("q") ?? "", "Cari peluang")}
         <a href="#/opportunity?view=list" class="px-3 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-list mr-2"></i>Daftar</a>
         <a href="#/${config.route}/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>${config.newLabel}</a>`,
      ) +
      `<div class="grid md:grid-cols-3 gap-4 mb-4">
         <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">Peluang berjalan</div><div class="text-xl font-semibold mt-1">${open.length}</div></div>
         <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">Pendapatan diharapkan</div><div class="text-xl font-semibold mt-1">${esc(money(totalOpen))}</div></div>
         <div class="bg-white rounded-xl border border-gray-200 shadow-sm p-4"><div class="text-xs font-medium text-gray-500 uppercase">Berbobot probabilitas</div><div class="text-xl font-semibold mt-1">${esc(money(weighted))}</div></div></div>
       <div id="board" class="flex gap-4 overflow-x-auto pb-4">${columns}</div>
       <p class="text-xs text-gray-500 mt-2">Seret kartu ke tahap lain, atau pilih tahap pada kartu. Opportunity yang menang atau kalah keluar dari papan; lihat lewat Daftar.${rows.length >= 500 ? " Menampilkan 500 pertama." : ""}</p>`;
    wireBoard();
  }

  /** Seret dan lepas kartu antar kolom tahap; pilihan tahap pada kartu adalah jalur cadangan. */
  function wireBoard() {
    const board = document.querySelector("#board");
    if (!board) return;
    board.addEventListener("dragstart", (event) => {
      const card = event.target.closest?.("[data-card]");
      if (!card) return;
      event.dataTransfer.setData("text/plain", card.dataset.card);
      event.dataTransfer.effectAllowed = "move";
    });
    board.addEventListener("dragover", (event) => {
      if (event.target.closest?.("[data-stage]")) event.preventDefault();
    });
    board.addEventListener("drop", async (event) => {
      const column = event.target.closest?.("[data-stage]");
      if (!column) return;
      event.preventDefault();
      const id = Number(event.dataTransfer.getData("text/plain"));
      if (id) await moveToStage(id, Number(column.dataset.stage));
    });
  }

  async function moveToStage(id, stage) {
    const ok = await guarded(null, () => call("crm.lead", "write", { ids: [id], vals: { stage_id: stage } }));
    if (ok !== undefined) reload();
  }

  /* ---------- Form ---------- */

  const normalize = (r) => {
    const values = {};
    for (const key of TEXT) values[key] = r[key] || "";
    values.expected_revenue = r.expected_revenue ?? 0;
    values.probability = r.probability ?? 0;
    values.priority = String(r.priority ?? "0");
    values.partner_id = r.partner_id?.[0] ?? null;
    values.country_id = r.country_id?.[0] ?? null;
    values.user_id = r.user_id?.[0] ?? null;
    values.team_id = r.team_id?.[0] ?? null;
    values.stage_id = r.stage_id?.[0] ?? null;
    values.tag_ids = [...(r.tag_ids ?? [])].sort((a, b) => a - b);
    values.date_deadline = r.date_deadline || "";
    values.description = plain(r.description);
    return values;
  };

  const BUTTONS = [
    { action: "convert", label: "Konversi ke Opportunity", kind: "primary", show: (l) => l.type === "lead" && l.active },
    { action: "won", label: "Menang", kind: "success", show: (l) => l.type === "opportunity" && l.active && l.won_status === "pending" },
    { action: "quotation", label: "Buat Quotation", show: (l) => l.type === "opportunity" && l.active },
    { action: "lost", label: "Kalah", kind: "danger", show: (l) => l.active },
    { action: "restore", label: "Pulihkan", show: (l) => !l.active },
    { action: "delete", label: "Hapus", kind: "danger", show: () => true },
  ];

  async function renderForm(id) {
    closeLookup();
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    const r = await references();
    const [users, countries] = await Promise.all([referenceUsers(), referenceCountries()]);
    let lead = null;
    let activities = [];
    if (id) {
      lead = await readOne("crm.lead", id, READ);
      if (!lead || lead.type !== config.type) {
        app.innerHTML = `<p class="text-sm text-rose-600">${config.noun} tidak ditemukan.</p>`;
        return;
      }
      activities = await searchRead("mail.activity", [["res_model", "=", "crm.lead"], ["res_id", "=", id]], ["activity_type_id", "summary", "date_deadline", "user_id", "state"], { order: "date_deadline" });
    }
    if (!form || form.id !== (lead?.id ?? null)) {
      const values = lead
        ? normalize(lead)
        : { ...normalize({}), user_id: ctx.user.id, team_id: r.teams[0]?.id ?? null, stage_id: r.stages[0]?.id ?? null, probability: 0 };
      form = { id: lead?.id ?? null, values, initial: lead ? { ...values } : null, partner: lead?.partner_id ? { id: lead.partner_id[0], display_name: lead.partner_id[1] } : null };
    }
    const v = form.values;
    const open = !lead || lead.active;
    const input = (key, extra = "") => `<input data-lead="${key}" value="${esc(v[key])}" ${extra} class="${INPUT}">`;
    const stageBar = lead && config.type === "opportunity"
      ? `<div class="flex flex-wrap gap-1" role="group" aria-label="Tahap">${r.stages
          .map((s) => `<button type="button" data-action="set-stage" data-stage="${s.id}" data-id="${lead.id}" class="px-3 py-1 rounded-full text-xs font-medium border ${s.id === lead.stage_id?.[0] ? "bg-indigo-600 text-white border-indigo-600" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"}" ${open ? "" : "disabled"}>${esc(s.name)}</button>`)
          .join("")}</div>`
      : lead
        ? statusbar(["lead", "opportunity"], { lead: ["Lead", "muted"], opportunity: ["Opportunity", "success"] }, lead.type)
        : "";
    const tagChecks = r.tags.length
      ? `<div class="mt-1 border border-gray-200 rounded-lg p-2 max-h-32 overflow-y-auto grid grid-cols-2 gap-1">${r.tags
          .map((t) => `<label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-tag value="${t.id}" ${v.tag_ids.includes(t.id) ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> ${esc(t.display_name)}</label>`)
          .join("")}</div>`
      : '<div class="py-2 text-sm text-gray-400">Belum ada tag. Tambahkan di CRM Setting.</div>';
    app.innerHTML = `
      <div class="text-sm text-gray-500 mb-2"><a href="#/${config.route}" class="hover:text-indigo-600">${config.title}</a> / ${esc(lead?.name ?? "Baru")}</div>
      <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-3">
        <div class="flex flex-wrap gap-2">${lead ? actionBar(BUTTONS, lead) : ""}</div>
        ${stageBar}
      </div>
      ${lead ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles([
        { count: lead.quotation_count, label: `Quotation (${money(lead.sale_amount_total)})`, icon: "fa-file-invoice", href: `#/sale?ids=${lead.order_ids.join(",")}` },
        { count: activities.length, label: "Aktivitas", icon: "fa-clock", target: "section-activities" },
      ])}</div>` : ""}
      <div class="mb-3 flex flex-wrap items-center gap-3"><h1 class="text-2xl font-bold text-gray-900">${esc(lead?.name ?? config.newTitle)}</h1>${lead ? badge(WON, lead.won_status) : ""}
        ${lead && lead.lost_reason_id ? `<span class="text-sm text-gray-500">Alasan: ${esc(lead.lost_reason_id[1])}</span>` : ""}</div>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">
        ${fieldBlock(config.type === "lead" ? "Judul Lead" : "Nama Peluang", input("name"))}
        ${config.type === "opportunity" ? fieldBlock("Pelanggan", `<input data-lookup="${config.route}-partner" autocomplete="off" role="combobox" aria-autocomplete="list" value="${esc(form.partner?.display_name ?? "")}" placeholder="Cari pelanggan (opsional)..." class="${INPUT}">`) : fieldBlock("Perusahaan", input("partner_name"))}
        ${config.type === "opportunity" ? fieldBlock("Pendapatan Diharapkan", `<input type="number" min="0" step="any" data-lead="expected_revenue" data-kind="number" value="${esc(v.expected_revenue)}" class="${INPUT} text-right">`) : ""}
        ${config.type === "opportunity" ? fieldBlock("Probabilitas (%)", `<input type="number" min="0" max="100" step="any" data-lead="probability" data-kind="number" value="${esc(v.probability)}" class="${INPUT} text-right">`) : ""}
        ${fieldBlock("Prioritas", `<select data-lead="priority" class="${INPUT}">${Object.entries(PRIORITY).map(([k, label]) => `<option value="${k}" ${k === v.priority ? "selected" : ""}>${esc(label)}</option>`).join("")}</select>`)}
        ${fieldBlock("Tanggal Penutupan", `<input type="date" data-lead="date_deadline" value="${esc(v.date_deadline)}" class="${INPUT}">`)}
        ${fieldBlock("Sales", `<select data-lead="user_id" data-kind="id" class="${INPUT}">${selectOptions(users, v.user_id, "-")}</select>`)}
        ${fieldBlock("Tim Sales", `<select data-lead="team_id" data-kind="id" class="${INPUT}">${selectOptions(r.teams, v.team_id, "-")}</select>`)}
        ${fieldBlock("Tag", tagChecks)}
        <div class="md:col-span-2 border-t border-gray-100 pt-4 text-sm font-semibold text-gray-700">Kontak</div>
        ${config.type === "opportunity" ? fieldBlock("Nama Perusahaan", input("partner_name")) : ""}
        ${fieldBlock("Nama Kontak", input("contact_name"))}
        ${fieldBlock("Jabatan", input("function"))}
        ${fieldBlock("Email", input("email_from", 'type="email"'))}
        ${fieldBlock("Telepon", input("phone"))}
        ${fieldBlock("Alamat", input("street"))}
        ${fieldBlock("Kota", input("city"))}
        ${fieldBlock("Kode Pos", input("zip"))}
        ${fieldBlock("Negara", `<select data-lead="country_id" data-kind="id" class="${INPUT}">${selectOptions(countries, v.country_id, "-")}</select>`)}
        <div class="md:col-span-2">${fieldBlock("Catatan Internal", `<textarea data-lead="description" rows="3" class="${INPUT}">${esc(v.description)}</textarea>`)}</div>
      </section>
      <div class="flex gap-2 mt-4">
        <button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
        <a href="#/${config.route}" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
      </div>
      ${lead ? chatterHtml("crm.lead", lead.id) : attachmentsPendingHtml()}`;
    if (lead) loadMessages("crm.lead", lead.id);
  }

  const toOdoo = (key, value) => {
    if (key === "tag_ids") return [[6, 0, value]];
    if (TEXT.includes(key)) return String(value).trim() || false;
    if (["partner_id", "country_id", "user_id", "team_id", "stage_id"].includes(key)) return value || false;
    if (key === "date_deadline") return value || false;
    if (key === "description") return String(value).trim() ? `<p>${esc(String(value).trim())}</p>` : false;
    if (key === "priority") return String(value);
    return value === "" ? 0 : Number(value);
  };

  async function persist() {
    const v = form.values;
    if (!String(v.name).trim()) throw new Error("Nama wajib diisi.");
    for (const key of ["expected_revenue", "probability"]) {
      if (v[key] === "") v[key] = 0;
      if (!(Number(v[key]) >= 0)) throw new Error("Angka tidak boleh negatif.");
    }
    if (Number(v.probability) > 100) throw new Error("Probabilitas tidak boleh lebih dari 100%.");
    if (!form.id) {
      const vals = { type: config.type };
      for (const key of Object.keys(v)) {
        if (config.type === "lead" && ["expected_revenue", "probability", "partner_id", "stage_id"].includes(key)) continue;
        const value = toOdoo(key, v[key]);
        if (value === false || value === "" || (key === "tag_ids" && !v.tag_ids.length)) continue;
        vals[key] = value;
      }
      const [id] = await call("crm.lead", "create", { vals_list: [vals] });
      return id;
    }
    const changed = changedValues(v, form.initial, Object.keys(v));
    const vals = Object.fromEntries(Object.keys(changed).map((key) => [key, toOdoo(key, v[key])]));
    if ("probability" in vals) vals.is_automated_probability = false;
    if (Object.keys(vals).length) await call("crm.lead", "write", { ids: [form.id], vals });
    return form.id;
  }

  /* ---------- Tindakan ---------- */

  async function lostDialog() {
    const { reasons } = await references();
    openModal(
      "Tandai Kalah",
      `<form data-form="lost" class="space-y-3">${fieldBlock("Alasan", `<select data-lost="reason" class="${INPUT}"><option value="">Tanpa alasan</option>${reasons.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select>`)}
         <p class="text-xs text-gray-500">Yang kalah diarsipkan dan bisa dipulihkan.</p></form>`,
      `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
       <button data-action="lost-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-rose-600 text-white hover:bg-rose-700">Tandai Kalah</button>`,
    );
  }

  async function createQuotation(button, id) {
    const orderId = await guarded(button, async () => {
      const lead = await readOne("crm.lead", id, ["partner_id", "partner_name", "contact_name", "email_from", "phone", "street", "city", "zip", "country_id", "user_id", "team_id"]);
      let partner = lead.partner_id?.[0];
      if (!partner) {
        const name = lead.partner_name || lead.contact_name;
        if (!name) throw new Error("Isi nama perusahaan atau kontak, atau pilih pelanggan, sebelum membuat quotation.");
        [partner] = await call("res.partner", "create", {
          vals_list: [{
            name, is_company: Boolean(lead.partner_name), email: lead.email_from || false, phone: lead.phone || false, street: lead.street || false, city: lead.city || false,
            zip: lead.zip || false, country_id: lead.country_id?.[0] ?? false, customer_rank: 1,
          }],
        });
        await call("crm.lead", "write", { ids: [id], vals: { partner_id: partner } });
      }
      const [order] = await call("sale.order", "create", {
        vals_list: [{ partner_id: partner, opportunity_id: id, ...(lead.user_id ? { user_id: lead.user_id[0] } : {}), ...(lead.team_id ? { team_id: lead.team_id[0] } : {}) }],
      });
      return order;
    });
    if (orderId) {
      form = null;
      toast("Quotation dibuat (draft). Tambahkan barangnya.");
      location.hash = `#/sale/${orderId}`;
    }
  }

  async function convertDialog(id) {
    openModal(
      "Konversi ke Opportunity",
      `<form data-form="convert" class="space-y-3">
         <p class="text-sm text-gray-700">Lead menjadi opportunity di pipeline. Pelanggan bisa dibuat dari kontak lead ini sekarang.</p>
         <label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-convert="customer" checked class="rounded border-gray-300 text-indigo-600"> Buat pelanggan dari kontak lead</label></form>`,
      `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
       <button data-action="convert-confirm" data-id="${id}" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Konversi</button>`,
    );
  }

  async function onClick(event, el) {
    const { action } = el.dataset;
    const id = Number(el.dataset.id) || form?.id || null;
    if (action === "refresh") reload();
    else if (action === "discard") form = null;
    else if (action === "save") {
      const saved = await guarded(el, persist);
      if (saved) {
        const wasNew = !form.id;
        form = null;
        toast(wasNew ? `${config.noun} dibuat.` : "Perubahan disimpan.");
        if (wasNew) location.hash = `#/${config.route}/${saved}`;
        else reload();
      }
    } else if (action === "set-stage") {
      const ok = await guarded(el, () => call("crm.lead", "write", { ids: [id], vals: { stage_id: Number(el.dataset.stage) } }));
      if (ok !== undefined) {
        form = null;
        reload();
      }
    } else if (action === "won") {
      const ok = await guarded(el, () => call("crm.lead", "action_set_won", { ids: [id] }));
      if (ok !== undefined) {
        form = null;
        toast("Opportunity ditandai menang.");
        reload();
      }
    } else if (action === "lost") await lostDialog();
    else if (action === "lost-confirm") {
      const reason = Number(document.querySelector('[data-lost="reason"]').value) || false;
      const ok = await guarded(el, () => call("crm.lead", "action_set_lost", { ids: [form.id], lost_reason_id: reason }));
      if (ok !== undefined) {
        closeModal();
        form = null;
        toast(`${config.noun} ditandai kalah.`);
        reload();
      }
    } else if (action === "restore") {
      const ok = await guarded(el, () => call("crm.lead", "toggle_active", { ids: [id] }));
      if (ok !== undefined) {
        form = null;
        toast(`${config.noun} dipulihkan.`);
        reload();
      }
    } else if (action === "delete") {
      if (!window.confirm(`Hapus ${config.noun.toLowerCase()} ini?`)) return;
      const ok = await guarded(el, () => call("crm.lead", "unlink", { ids: [id] }));
      if (ok !== undefined) {
        form = null;
        toast(`${config.noun} dihapus.`);
        location.hash = `#/${config.route}`;
      }
    } else if (action === "quotation") await createQuotation(el, id);
    else if (action === "convert") await convertDialog(id);
    else if (action === "convert-confirm") {
      const makeCustomer = document.querySelector('[data-convert="customer"]').checked;
      const ok = await guarded(el, async () => {
        await call("crm.lead", "convert_opportunity", { ids: [id], partner: false });
        if (makeCustomer) {
          const lead = await readOne("crm.lead", id, ["partner_name", "contact_name", "email_from", "phone", "street", "city", "zip", "country_id", "partner_id"]);
          const name = lead.partner_name || lead.contact_name;
          if (!lead.partner_id && name) {
            const [partner] = await call("res.partner", "create", {
              vals_list: [{ name, is_company: Boolean(lead.partner_name), email: lead.email_from || false, phone: lead.phone || false, street: lead.street || false, city: lead.city || false, zip: lead.zip || false, country_id: lead.country_id?.[0] ?? false, customer_rank: 1 }],
            });
            await call("crm.lead", "write", { ids: [id], vals: { partner_id: partner } });
          }
        }
        return true;
      });
      if (ok) {
        closeModal();
        form = null;
        toast("Lead dikonversi menjadi opportunity.");
        location.hash = `#/opportunity/${id}`;
      }
    } else if (action === "enable-leads") {
      const ok = await guarded(el, async () => {
        const [sid] = await call("res.config.settings", "create", { vals_list: [{ group_use_lead: true }] });
        await call("res.config.settings", "execute", { ids: [sid] });
        return true;
      });
      if (ok) {
        resetReferences();
        refs = null;
        toast("Fitur Leads diaktifkan.");
        reload();
      }
    }
  }

  function onInput(event, el) {
    if (!form) return;
    if (el.dataset.lead) {
      const key = el.dataset.lead;
      form.values[key] = el.dataset.kind === "id" ? (el.value ? Number(el.value) : null) : el.dataset.kind === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
    } else if (el.dataset.lookup === `${config.route}-partner`) {
      form.partner = null;
      form.values.partner_id = null;
      runLookup(el, 250);
    }
  }

  function onChange(event, el) {
    if (el.dataset.tag !== undefined && form) {
      form.values.tag_ids = [...document.querySelectorAll("[data-tag]:checked")].map((b) => Number(b.value)).sort((a, b) => a - b);
    } else if (el.dataset.changeStage) moveToStage(Number(el.dataset.changeStage), Number(el.value));
  }

  return { render, onClick, onInput, onChange, leave };
}
