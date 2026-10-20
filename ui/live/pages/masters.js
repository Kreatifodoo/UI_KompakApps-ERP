// Kerangka halaman master sederhana (daftar dan form) untuk model Odoo yang tidak butuh logika khusus: Chart of Account, Tax Master,
// Currencies, Analytic Account, dan sejenisnya. Satu konfigurasi menentukan model, kolom daftar, bidang form (teks, angka, pilihan,
// relasi, kotak centang, tanggal), arsip, dan bagian tambahan. Pola halaman sama dengan halaman lain (render, onClick, onInput, ...).
import {
  INPUT, app, badge, button, call, cell, changedValues, attachmentsPendingHtml, chatterHtml, closeLookup, esc, fieldBlock, filterSelect, guarded, loadMessages, pageHeader, readOne, readonlyValue,
  rowLink, searchBox, searchRead, selectOptions, statTiles, table, toast, toInputDateTime, fromInputDateTime,
} from "../common.js";

const ARCHIVE_FILTERS = [["active", "Aktif"], ["archived", "Diarsipkan"]];

/**
 * config: {
 *   route, title, noun, model, newLabel, empty, order, limit, archive,
 *   listFields: [...], columns: [{ label, value(record), right?, raw? }], search: ["name", ...],
 *   filters: [{ key, label, options: [[value, label]], domain(value) }],
 *   fields: [{ key, label, type, required?, options?, optionsOf?(refs, values), readonly?, show?(values), span2?, hint?, placeholder? }],
 *   readFields, loadRefs?(), newValues?(refs), extraCreate?(values, refs), tiles?(record), extra?(record, refs), titleOf?(record),
 * }
 */
export function createMasterPage(config) {
  let form = null; // { id, values, initial }
  let refs = {};
  let last = { sub: "", query: new URLSearchParams() };
  const leave = () => {
    form = null;
  };
  const reload = () => render(last.sub, last.query);
  const fieldKeys = config.fields.map((f) => f.key);
  const realKeys = config.fields.filter((f) => !f.virtual).map((f) => f.key);

  async function render(sub, query) {
    last = { sub, query };
    if (sub === "") return renderList(query);
    return renderForm(sub === "new" ? null : Number(sub));
  }

  async function renderList(query) {
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    const state = query.get("state") || "active";
    const text = query.get("q") ?? "";
    const domain = [...(config.baseDomain ?? [])];
    if (config.archive && state === "archived") domain.push(["active", "=", false]);
    for (const f of config.filters ?? []) {
      const value = query.get(f.key);
      if (value) domain.push(...f.domain(value));
    }
    if (text && config.search?.length) {
      const terms = config.search.map((s) => [s, "ilike", text]);
      domain.push(...Array(terms.length - 1).fill("|"), ...terms);
    }
    const rows = await searchRead(config.model, domain, config.listFields, {
      order: config.order ?? "name", limit: config.limit ?? 200, context: { active_test: !(config.archive && state === "archived") },
    });
    const listRefs = (await config.loadListRefs?.()) ?? {};
    const body = rows
      .map((r) => rowLink(`#/${config.route}/${r.id}`, config.columns.map((c, i) => cell(c.value(r, listRefs), { right: c.right, strong: i === 0, raw: c.raw }))))
      .join("");
    const filterControls = (config.filters ?? [])
      .filter((f) => !f.hidden)
      .map((f) => `<select data-master-filter="${esc(f.key)}" class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" aria-label="${esc(f.label)}"><option value="">${esc(f.label)}</option>${f.options.map(([v, l]) => `<option value="${esc(v)}" ${query.get(f.key) === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`)
      .join("");
    app.innerHTML =
      pageHeader(
        config.title,
        `${config.search?.length ? searchBox(text, "Cari...") : ""}${filterControls}${config.archive ? filterSelect(ARCHIVE_FILTERS, state) : ""}${config.headerExtra ?? ""}${(await config.headerAsync?.()) ?? ""}
         ${config.noNew ? "" : `<a href="#/${config.route}/new" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>${esc(config.newLabel)}</a>`}`,
      ) +
      table(config.columns.map((c) => ({ label: c.label, right: c.right })), body, config.empty) +
      (config.listNote ? `<p class="text-xs text-gray-500 mt-3">${config.listNote}</p>` : "") +
      (rows.length >= (config.limit ?? 200) ? `<p class="text-xs text-gray-500 mt-3">Menampilkan ${rows.length} pertama; gunakan pencarian atau filter.</p>` : "");
  }

  const normalize = (record) => {
    const values = {};
    for (const f of config.fields) {
      const raw = record[f.key];
      if (f.type === "m2o") values[f.key] = Array.isArray(raw) ? raw[0] : raw || null;
      else if (f.type === "m2m") values[f.key] = [...(raw ?? [])].sort((a, b) => a - b);
      else if (f.type === "check") values[f.key] = Boolean(raw);
      else if (f.type === "datetime") values[f.key] = toInputDateTime(raw);
      else if (f.type === "number") values[f.key] = raw ?? 0;
      else values[f.key] = raw || (f.type === "select" ? (f.options?.[0]?.[0] ?? "") : "");
    }
    return values;
  };

  const toOdoo = (f, value) => {
    switch (f.type) {
      case "m2o": return value || false;
      case "m2m": return [[6, 0, value]];
      case "check": return Boolean(value);
      case "number": return value === "" ? 0 : Number(value);
      case "select": return value === "" ? false : value;
      case "date": return value || false;
      case "datetime": return fromInputDateTime(value);
      default: return String(value ?? "").trim() || false;
    }
  };

  function input(f, v, record) {
    const readonly = typeof f.readonly === "function" ? f.readonly(record, v) : f.readonly;
    const dis = readonly ? "disabled" : "";
    const data = `data-mf="${esc(f.key)}"`;
    switch (f.type) {
      case "textarea": return `<textarea ${data} rows="3" ${dis} class="${INPUT}">${esc(v[f.key])}</textarea>`;
      case "number": return `<input type="number" step="${f.step ?? "any"}" ${f.min !== undefined ? `min="${f.min}"` : ""} ${data} data-kind="number" value="${esc(v[f.key])}" ${dis} class="${INPUT} text-right">`;
      case "date": return `<input type="date" ${data} value="${esc(v[f.key])}" ${dis} class="${INPUT}">`;
      case "datetime": return `<input type="datetime-local" ${data} value="${esc(v[f.key])}" ${dis} class="${INPUT}">`;
      case "check": return `<label class="flex items-center gap-2 text-sm text-gray-700 mt-2"><input type="checkbox" ${data} ${v[f.key] ? "checked" : ""} ${dis} class="rounded border-gray-300 text-indigo-600"> ${esc(f.checkLabel ?? f.label)}</label>`;
      case "select": {
        const options = f.options ?? f.optionsOf?.(refs, v) ?? [];
        return `<select ${data} ${dis} class="${INPUT}">${options.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(v[f.key]) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
      }
      case "m2o": return `<select ${data} data-kind="id" ${dis} class="${INPUT}">${selectOptions(f.optionsOf?.(refs) ?? [], v[f.key], f.blank ?? "-")}</select>`;
      case "m2m": {
        const options = f.optionsOf?.(refs) ?? [];
        return options.length
          ? `<div class="mt-1 border border-gray-200 rounded-lg p-2 max-h-40 overflow-y-auto space-y-1">${options.map((o) => `<label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-mm="${esc(f.key)}" value="${o.id}" ${v[f.key].includes(o.id) ? "checked" : ""} ${dis} class="rounded border-gray-300 text-indigo-600"> ${esc(o.display_name)}</label>`).join("")}</div>`
          : '<div class="py-2 text-sm text-gray-400">Belum ada pilihan.</div>';
      }
      default: return `<input ${data} value="${esc(v[f.key])}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ""} ${f.maxlength ? `maxlength="${f.maxlength}"` : ""} ${dis} class="${INPUT}">`;
    }
  }

  async function renderForm(id) {
    closeLookup();
    app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
    refs = (await config.loadRefs?.()) ?? {};
    let record = null;
    if (id) {
      record = await readOne(config.model, id, [...new Set([...realKeys, "display_name", ...(config.archive ? ["active"] : []), ...(config.readFields ?? [])])]);
      if (!record) {
        app.innerHTML = `<p class="text-sm text-rose-600">${esc(config.noun)} tidak ditemukan.</p>`;
        return;
      }
    }
    if (!form || form.id !== (record?.id ?? null)) {
      const virtual = record ? await (config.virtualValues?.(record, refs) ?? {}) : {};
      const values = record ? { ...normalize(record), ...virtual } : { ...normalize({}), ...(config.newValues?.(refs) ?? {}) };
      form = { id: record?.id ?? null, values, initial: record ? { ...values } : null };
    }
    const v = form.values;
    const title = record ? (config.titleOf?.(record) ?? record.display_name) : config.newTitle ?? `${config.noun} Baru`;
    const tiles = record ? (config.tiles?.(record) ?? []) : [];
    const extra = record ? await (config.extra?.(record, refs) ?? "") : "";
    const blocks = config.fields
      .filter((f) => !f.show || f.show(v, record))
      .map((f) => {
        const body = `${fieldBlock(f.type === "check" ? "" : f.label, input(f, v, record))}${f.hint ? `<div class="text-xs text-gray-500 mt-1">${f.hint}</div>` : ""}`;
        return f.span2 ? `<div class="md:col-span-2">${body}</div>` : f.type === "check" ? `<div>${body}</div>` : `<div>${body}</div>`;
      })
      .join("");
    app.innerHTML = `
      <div class="text-sm text-gray-500 mb-2"><a href="#/${config.route}" class="hover:text-indigo-600">${esc(config.title)}</a> / ${esc(record ? title : "Baru")}</div>
      <div class="flex flex-wrap items-center gap-2 mb-3">${record && config.archive ? button("toggle-active", record.active ? "Arsipkan" : "Aktifkan Kembali", record.active ? "danger" : "primary", { id: record.id }) : ""}${record ? config.actions?.(record) ?? "" : ""}</div>
      ${tiles.length ? `<div class="flex flex-wrap gap-2 mb-4">${statTiles(tiles)}</div>` : ""}
      <div class="mb-3 flex items-center gap-3"><h1 class="text-2xl font-bold text-gray-900">${esc(title)}</h1>${record && config.archive && !record.active ? badge({ a: ["Diarsipkan", "muted"] }, "a") : ""}</div>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">${blocks}</section>
      ${config.formNote ? `<p class="mt-3 text-xs text-gray-500">${config.formNote}</p>` : ""}
      <div class="flex gap-2 mt-4">
        <button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
        <a href="#/${config.route}" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
      </div>
      ${extra}
      ${config.chatter === false ? "" : record ? chatterHtml(config.model, record.id) : attachmentsPendingHtml()}`;
    if (record && config.chatter !== false) loadMessages(config.model, record.id);
  }

  async function persist() {
    const v = form.values;
    for (const f of config.fields) {
      if (f.show && !f.show(v, null)) continue;
      const empty = f.type === "m2m" ? !v[f.key].length : f.type === "check" ? false : v[f.key] === "" || v[f.key] === null || v[f.key] === undefined;
      if (f.required && empty) throw new Error(`${f.label} wajib diisi.`);
    }
    config.validate?.(v, form.id);
    if (!form.id) {
      const vals = {};
      for (const f of config.fields) {
        if (f.virtual || (f.show && !f.show(v, null))) continue;
        const value = toOdoo(f, v[f.key]);
        if (value === false && f.type !== "check" && f.type !== "number") continue;
        vals[f.key] = value;
      }
      Object.assign(vals, config.extraCreate?.(v, refs) ?? {});
      const [created] = await call(config.model, "create", { vals_list: [vals] });
      await config.afterSave?.(created, v, true, refs);
      return created;
    }
    const changed = changedValues(v, form.initial, fieldKeys);
    const vals = {};
    for (const f of config.fields) {
      if (f.virtual || !(f.key in changed)) continue;
      const readonly = typeof f.readonly === "function" ? f.readonly(null, v) : f.readonly;
      if (readonly) continue;
      vals[f.key] = toOdoo(f, v[f.key]);
    }
    Object.assign(vals, config.extraWrite?.(v, changed, refs) ?? {});
    if (Object.keys(vals).length) await call(config.model, "write", { ids: [form.id], vals });
    await config.afterSave?.(form.id, v, false, refs);
    return form.id;
  }

  async function onClick(event, el) {
    const { action } = el.dataset;
    if (action === "discard") form = null;
    else if (action === "save") {
      const saved = await guarded(el, persist);
      if (saved) {
        const wasNew = !form.id;
        form = null;
        config.onSaved?.();
        toast(wasNew ? `${config.noun} dibuat.` : "Perubahan disimpan.");
        if (wasNew) location.hash = `#/${config.route}/${saved}`;
        else reload();
      }
    } else if (action === "toggle-active") {
      const archiving = el.textContent.trim() === "Arsipkan";
      if (archiving && !window.confirm(`Arsipkan ${config.noun.toLowerCase()} ini? Data lamanya tetap utuh.`)) return;
      const ok = await guarded(el, () => call(config.model, archiving ? "action_archive" : "action_unarchive", { ids: [Number(el.dataset.id)] }));
      if (ok !== undefined) {
        form = null;
        config.onSaved?.();
        toast(archiving ? `${config.noun} diarsipkan.` : `${config.noun} diaktifkan kembali.`);
        reload();
      }
    } else if (config.onAction) await config.onAction(action, el, { reload, getForm: () => form });
  }

  function onInput(event, el) {
    if (config.onInputExtra?.(event, el)) return;
    if (!form) return;
    if (el.dataset.mf) {
      const f = config.fields.find((x) => x.key === el.dataset.mf);
      form.values[f.key] = el.type === "checkbox" ? el.checked : el.dataset.kind === "id" ? (el.value ? Number(el.value) : null) : el.dataset.kind === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
      if (f.rerender) reload();
    }
  }

  function onChange(event, el) {
    if (config.onChangeExtra?.(event, el, { reload })) return;
    if (!form) return;
    if (el.dataset.mm) {
      form.values[el.dataset.mm] = [...document.querySelectorAll(`[data-mm="${el.dataset.mm}"]:checked`)].map((b) => Number(b.value)).sort((a, b) => a - b);
    } else if (el.dataset.masterFilter) {
      const [path, queryText = ""] = location.hash.replace(/^#\/?/, "").split("?");
      const params = new URLSearchParams(queryText);
      if (el.value) params.set(el.dataset.masterFilter, el.value);
      else params.delete(el.dataset.masterFilter);
      const qs = params.toString();
      location.hash = `#/${path}${qs ? `?${qs}` : ""}`;
    }
  }

  return { render, onClick, onInput, onChange, leave };
}
