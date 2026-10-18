// Promotion & Loyalty (loyalty.program) untuk menu Sales dan POS. Satu halaman melayani kedua menu lewat parameter `kind`
// (sale atau pos), yang memfilter program menurut tempat berlakunya (Sales Order atau kasir POS). Form mengikuti form Odoo 19:
// tipe program (promosi otomatis, kode promo, beli X gratis Y, kupon, kupon pesanan berikutnya, kartu loyalti, kartu hadiah,
// e-wallet), masa berlaku, batas pemakaian, aturan (loyalty.rule) dan hadiah (loyalty.reward) sebagai kartu yang bisa diubah,
// rencana komunikasi, serta kupon dan kartu yang sudah terbit dengan pembuatan massal, ubah saldo, dan riwayat poin.
// Nilai bawaan tiap tipe diambil dari `loyalty.program.default_get` (lihat D30); aturan, hadiah, dan komunikasi dikirim
// eksplisit karena Odoo tidak mengisi `trigger` program yang dibuat lewat API.
import {
  PRODUCT_PAGE, searchProducts,
  INPUT, app, badge, button, call, cell, closeLookup, closeModal, ctx, dateText, dateTimeText, esc, fieldBlock, filterSelect, guarded, hasGroup,
  money, openModal, pageHeader, readOne, readonlyValue, referenceCategories, referenceCurrencies, referencePricelists, registerLookup, rowLink, runLookup, searchBox,
  searchRead, selectOptions, statTiles, table, toast,
} from "../common.js";

export const TYPES = {
  promotion: ["Promosi Otomatis", "Syarat pada pesanan (minimal belanja atau jumlah barang) membuka hadiah secara otomatis."],
  promo_code: ["Kode Promo", "Pelanggan memasukkan kode promo untuk mendapat hadiah, mis. diskon 10% untuk produk tertentu."],
  buy_x_get_y: ["Beli X Gratis Y", "Tiap barang yang dibeli memberi satu kredit; tukar sejumlah kredit dengan barang gratis."],
  coupons: ["Kupon", "Buat dan bagikan kode kupon unik; tiap kupon menukar hadiah satu kali (sesuai nilainya)."],
  next_order_coupons: ["Kupon Pesanan Berikutnya", "Kupon sekali pakai terbit setelah pesanan dikonfirmasi dan berlaku untuk pembelian berikutnya."],
  loyalty: ["Kartu Loyalti", "Pelanggan mengumpulkan poin dari setiap pembelian dan menukarnya dengan hadiah pada pesanan ini atau berikutnya."],
  gift_card: ["Kartu Hadiah", "Kartu hadiah dibuat manual atau otomatis saat produk kartu hadiah dibeli, lalu dipakai membayar pesanan."],
  ewallet: ["e-Wallet", "Saldo e-wallet diisi manual atau saat produk top-up dibeli, lalu dipakai membayar pesanan berikutnya."],
};
const TYPE_LIST = Object.entries(TYPES).map(([k, v]) => [k, v[0]]);
const PAYMENT_TYPES = ["gift_card", "ewallet"];
const CARD_TYPES = ["coupons", "loyalty", "gift_card", "ewallet", "next_order_coupons"];
const POINTS_TYPES = ["loyalty", "buy_x_get_y"]; // tipe yang memperlihatkan bagian poin (seperti form Odoo tanpa mode debug)
const TRIGGERS = { auto: "Otomatis", with_code: "Dengan kode" };
const POINT_MODES = { order: "per pesanan", money: "per Rp dibelanjakan", unit: "per unit dibayar" };
const DISCOUNT_MODES = { percent: "%", per_order: "Rp (nominal)", per_point: "Rp per poin" };
const APPLICABILITY = { order: "Seluruh pesanan", cheapest: "Produk termurah", specific: "Produk tertentu" };
const APPLIES_ON = { current: "Pesanan ini saja", future: "Pesanan berikutnya saja", both: "Pesanan ini dan berikutnya" };
const TAX_MODES = { incl: "termasuk pajak", excl: "belum termasuk pajak" };
const REWARD_TYPES = { discount: "Diskon", product: "Produk gratis" };
const COMM_TRIGGERS = { create: "Saat kupon atau kartu dibuat", points_reach: "Saat poin tercapai" };
const STATE_FILTERS = [["active", "Aktif"], ["archived", "Diarsipkan"]];
const MODULES = { sale: "Sales", pos: "POS" };
const DEFAULT_FIELDS = ["program_type", "applies_on", "trigger", "portal_visible", "portal_point_name", "rule_ids", "reward_ids", "communication_plan_ids"];
const nf = new Intl.NumberFormat("id-ID", { maximumFractionDigits: 4 });

/* Nilai bawaan Odoo memakai satuan mata uang kecil (mis. belanja minimal 50); untuk rupiah dibuat lebih masuk akal. */
const IDR_OVERRIDES = {
  promotion: { rule: { minimum_amount: 100000, minimum_amount_tax_mode: "incl" } },
  next_order_coupons: { rule: { minimum_amount: 100000 } },
  loyalty: { rule: { reward_point_amount: 0.001 } },
  promo_code: { reward: { discount_applicability: "order", discount_product_ids: [] } },
};

let form = null; // { id, type, program, values, initial, fixed, rules, rewards, comms, removed, cardsOpen }
let refs = null;
let kind = "sale";
let generate = null; // { customers, mode, qty, points, valid_until, description }
let cardTimer;
let last = { sub: "", query: new URLSearchParams() };
export const leave = () => {
  form = null;
  generate = null;
  closeLookup();
};
const reload = () => render(last.sub, last.query);

/* ---------- Pencarian produk dan pelanggan (chip) ---------- */

registerLookup("loy-product", {
  pageSize: PRODUCT_PAGE,
  search: (q, _input, page) => searchProducts(q, page, {}),
  isChosen: () => false,
  choose: (input, item) => {
    const { scope, i, f } = input.dataset;
    const row = (scope === "rule" ? form.rules : form.rewards)[Number(i)];
    if (f === "reward_product") row.reward_product = item;
    else if (!row[f].some((p) => p.id === item.id)) row[f].push(item);
    input.value = "";
    touchDependency(row);
    if (scope === "rule") paintRules();
    else paintRewards();
    if (typeIs(...PAYMENT_TYPES)) paintMain();
  },
});
registerLookup("loy-customer", {
  search: (q) => searchRead("res.partner", q ? [["name", "ilike", q]] : [], ["display_name"], { limit: 10, order: "customer_rank desc, name" }),
  isChosen: () => false,
  choose: (input, item) => {
    if (!generate.customers.some((c) => c.id === item.id)) generate.customers.push(item);
    input.value = "";
    paintGenerateCustomers();
  },
});

/* ---------- Data referensi ---------- */

async function loadRefs() {
  const [categories, currencies, pricelists, pricelistEnabled, tags, templates, posConfigs] = await Promise.all([
    referenceCategories(), referenceCurrencies(), referencePricelists().catch(() => []), hasGroup("product.group_product_pricelist").catch(() => false),
    searchRead("product.tag", [], ["display_name"], { order: "name", limit: 100 }).catch(() => []),
    searchRead("mail.template", [["model", "=", "loyalty.card"]], ["display_name"], { order: "name", limit: 50 }).catch(() => []),
    searchRead("pos.config", [], ["display_name"], { order: "name", limit: 50 }).catch(() => []),
  ]);
  refs = { categories, currencies, pricelists, pricelistEnabled, tags, templates, posConfigs };
}

const currencyName = () => refs.currencies.find((c) => c.id === form?.values.currency_id)?.display_name ?? ctx.company?.currency_id?.[1] ?? "IDR";
const fmtMoney = (n) => money(n, currencyName());
const num = (v, fallback = 0) => (v === "" || v === null || v === undefined || Number.isNaN(Number(v)) ? fallback : Number(v));
/** Id dari nilai bawaan default_get: bisa angka, daftar, atau representasi teks recordset ("product.product(4,)"). */
const reprIds = (value) => (Array.isArray(value) ? value : typeof value === "number" ? [value] : typeof value === "string" ? [...value.matchAll(/\d+/g)].map((m) => Number(m[0])) : []);

/* ---------- Baris aturan, hadiah, dan komunikasi ---------- */

const productChips = (names, ids) => ids.map((id) => ({ id, display_name: names.get(id) ?? `#${id}` }));

function ruleRow(vals, names = new Map(), id = null) {
  const row = {
    id, code: vals.code || "", minimum_qty: vals.minimum_qty ?? 1, minimum_amount: vals.minimum_amount ?? 0, minimum_amount_tax_mode: vals.minimum_amount_tax_mode ?? "incl",
    reward_point_amount: vals.reward_point_amount ?? 1, reward_point_mode: vals.reward_point_mode ?? "order", reward_point_split: Boolean(vals.reward_point_split),
    products: productChips(names, reprIds(vals.product_ids)), category: vals.product_category_id?.[0] ?? vals.product_category_id ?? null, tag: vals.product_tag_id?.[0] ?? vals.product_tag_id ?? null,
    domain: vals.product_domain ?? "[]",
  };
  if (typeof row.category !== "number") row.category = null;
  if (typeof row.tag !== "number") row.tag = null;
  return row;
}

function rewardRow(vals, names = new Map(), id = null) {
  const productId = Array.isArray(vals.reward_product_id) ? vals.reward_product_id[0] : vals.reward_product_id;
  const row = {
    id, reward_type: vals.reward_type ?? "discount", discount: vals.discount ?? 10, discount_mode: vals.discount_mode ?? "percent",
    discount_applicability: vals.discount_applicability ?? "order", discount_max_amount: vals.discount_max_amount ?? 0,
    products: productChips(names, reprIds(vals.discount_product_ids)), category: vals.discount_product_category_id?.[0] ?? null, tag: vals.discount_product_tag_id?.[0] ?? null,
    reward_product: productId ? { id: productId, display_name: names.get(productId) ?? `#${productId}` } : null, reward_tag: vals.reward_product_tag_id?.[0] ?? null,
    reward_qty: vals.reward_product_qty ?? 1, required_points: vals.required_points ?? 1, clear_wallet: Boolean(vals.clear_wallet), description: vals.description || "",
    descAuto: !id, descManual: false, domain: vals.discount_product_domain ?? "[]",
  };
  if (!row.description) row.description = describeReward(row);
  return row;
}

const commRow = (vals, id = null) => ({ id, trigger: vals.trigger ?? "create", points: vals.points ?? 0, template: vals.mail_template_id?.[0] ?? vals.mail_template_id ?? null });

/** Deskripsi hadiah berbahasa Indonesia; ini yang tampil di baris Sales Order dan struk. Odoo menambahkan awalan "Discount" pada baris diskon Sales Order, jadi kata "Diskon" tidak diulang di sini. */
function describeReward(r) {
  if (r.reward_type === "product") return r.reward_product ? `Produk gratis - ${r.reward_product.display_name}` : "Produk gratis";
  const amount = r.discount_mode === "percent" ? `${nf.format(num(r.discount))}%` : r.discount_mode === "per_point" ? `${fmtMoney(num(r.discount))} per poin` : fmtMoney(num(r.discount));
  const target = r.discount_applicability === "order" ? "seluruh pesanan" : r.discount_applicability === "cheapest" ? "produk termurah"
    : r.products.length === 1 && !r.category && !r.tag ? r.products[0].display_name : "produk tertentu";
  return `${amount} untuk ${target}${num(r.discount_max_amount) ? ` (maks. ${fmtMoney(num(r.discount_max_amount))})` : ""}`;
}
/** Selama deskripsi belum diubah manual, deskripsi (juga pada hadiah yang sudah ada) mengikuti isian hadiah. */
function touchDependency(row) {
  if (!row || row.descManual !== false) return; // baris aturan tidak punya deskripsi; deskripsi manual tidak ditimpa
  row.descAuto = true;
  row.description = describeReward(row);
}

function ruleVals(r, type) {
  const qty = num(r.minimum_qty);
  if (qty < 0 || !Number.isInteger(qty)) throw new Error("Jumlah minimum barang pada aturan harus bilangan bulat nol atau lebih.");
  if (num(r.minimum_amount) < 0) throw new Error("Belanja minimum pada aturan tidak boleh negatif.");
  if (!(num(r.reward_point_amount) > 0)) throw new Error("Poin pada aturan harus lebih dari 0.");
  const vals = {
    product_ids: [[6, 0, r.products.map((p) => p.id)]], product_category_id: r.category || false, product_tag_id: r.tag || false, minimum_qty: qty,
    minimum_amount: num(r.minimum_amount), minimum_amount_tax_mode: r.minimum_amount_tax_mode, reward_point_amount: num(r.reward_point_amount),
    reward_point_mode: r.reward_point_mode, reward_point_split: Boolean(r.reward_point_split),
  };
  if (type === "promo_code") {
    const code = r.code.trim();
    if (!code) throw new Error("Isi kode promo pada setiap aturan program Kode Promo.");
    Object.assign(vals, { mode: "with_code", code });
  }
  if (type === "buy_x_get_y" && !r.products.length && !r.category && !r.tag) throw new Error("Pilih produk (atau kategori) yang dihitung pada aturan Beli X Gratis Y.");
  return vals;
}

function rewardVals(r) {
  const points = num(r.required_points);
  if (!(points > 0)) throw new Error("Poin yang ditukar untuk sebuah hadiah harus lebih dari 0.");
  const vals = { reward_type: r.reward_type, required_points: points, clear_wallet: Boolean(r.clear_wallet), description: r.description.trim() || describeReward(r) };
  if (r.reward_type === "discount") {
    const discount = num(r.discount);
    if (!(discount > 0)) throw new Error("Nilai diskon pada hadiah harus lebih dari 0.");
    if (r.discount_mode === "percent" && discount > 100) throw new Error("Diskon persen tidak boleh lebih dari 100.");
    if (num(r.discount_max_amount) < 0) throw new Error("Diskon maksimal tidak boleh negatif.");
    const specific = r.discount_applicability === "specific";
    Object.assign(vals, {
      discount, discount_mode: r.discount_mode, discount_applicability: r.discount_applicability, discount_max_amount: num(r.discount_max_amount),
      discount_product_ids: [[6, 0, specific ? r.products.map((p) => p.id) : []]], discount_product_category_id: specific ? r.category || false : false,
      discount_product_tag_id: specific ? r.tag || false : false,
    });
  } else {
    if (!r.reward_product && !r.reward_tag) throw new Error("Pilih produk (atau tag produk) yang menjadi hadiah gratis.");
    if (!(num(r.reward_qty) > 0) || !Number.isInteger(num(r.reward_qty))) throw new Error("Jumlah produk gratis harus bilangan bulat lebih dari 0.");
    Object.assign(vals, { reward_product_id: r.reward_product?.id ?? false, reward_product_tag_id: r.reward_tag || false, reward_product_qty: num(r.reward_qty) });
  }
  return vals;
}

const commVals = (c) => {
  if (!c.template) throw new Error("Pilih template email untuk setiap rencana komunikasi.");
  return { trigger: c.trigger, points: c.trigger === "points_reach" ? num(c.points) : 0, mail_template_id: c.template };
};

/* ---------- Nilai bawaan tipe program ---------- */

async function typeTemplate(type) {
  const d = await call("loyalty.program", "default_get", { fields: DEFAULT_FIELDS, context: { default_program_type: type } });
  const firstNew = (commands) => (commands ?? []).find((c) => c[0] === 0)?.[2] ?? null;
  const override = IDR_OVERRIDES[type] ?? {};
  const rule = firstNew(d.rule_ids) ? { ...firstNew(d.rule_ids), ...(override.rule ?? {}) } : null;
  const reward = firstNew(d.reward_ids) ? { ...firstNew(d.reward_ids), ...(override.reward ?? {}) } : null;
  const comms = (d.communication_plan_ids ?? []).filter((c) => c[0] === 0).map((c) => c[2]);
  const ids = [...new Set([...(rule ? reprIds(rule.product_ids) : []), ...(reward ? [...reprIds(reward.discount_product_ids), ...reprIds(reward.reward_product_id)] : [])])];
  const names = ids.length ? new Map((await searchRead("product.product", [["id", "in", ids]], ["display_name"])).map((p) => [p.id, p.display_name])) : new Map();
  return {
    program: { applies_on: d.applies_on ?? "current", trigger: d.trigger ?? "auto", portal_visible: Boolean(d.portal_visible), portal_point_name: d.portal_point_name ?? "Poin" },
    rules: rule ? [ruleRow(rule, names)] : [], rewards: reward ? [rewardRow(reward, names)] : [], comms: comms.map((c) => commRow(c)),
  };
}

function resetForType(type, template) {
  form.type = type;
  Object.assign(form.values, { program_type: type, applies_on: template.program.applies_on, portal_point_name: template.program.portal_point_name });
  // Kartu hadiah dan e-wallet belum didukung di kasir, dan program kartu hadiah yang berlaku di POS mengharuskan template email dan laporan cetak
  // agar sesi POS bisa dibuka (pos_loyalty), jadi dibuat khusus Sales Order lebih dulu.
  if (PAYMENT_TYPES.includes(type)) Object.assign(form.values, { sale_ok: true, pos_ok: false });
  else if (!form.values.sale_ok && !form.values.pos_ok) Object.assign(form.values, { sale_ok: kind === "sale", pos_ok: kind === "pos" });
  form.fixed = { trigger: template.program.trigger, portal_visible: template.program.portal_visible };
  form.rules = template.rules;
  form.rewards = template.rewards;
  form.comms = template.comms;
}

/* ---------- Daftar ---------- */

export async function render(sub, query) {
  last = { sub, query };
  if (sub === "") return renderList(query);
  return renderForm(sub === "new" ? null : Number(sub), query);
}

async function renderList(query) {
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  kind = query.get("kind") === "pos" ? "pos" : "sale";
  const state = query.get("state") || "active";
  const type = query.get("jenis") || "";
  const text = query.get("q") ?? "";
  const domain = [[kind === "pos" ? "pos_ok" : "sale_ok", "=", true]];
  if (state === "archived") domain.push(["active", "=", false]);
  if (type) domain.push(["program_type", "=", type]);
  if (text) domain.push(["name", "ilike", text]);
  const rows = await searchRead(
    "loyalty.program", domain,
    ["name", "program_type", "date_from", "date_to", "coupon_count", "total_order_count", "limit_usage", "max_usage", "sale_ok", "pos_ok", "active", "trigger"],
    { order: "sequence, id", limit: 200, context: { active_test: state !== "archived" } },
  );
  const rewards = rows.length
    ? await searchRead("loyalty.reward", [["program_id", "in", rows.map((r) => r.id)]], ["program_id", "description"], { order: "required_points, id", context: { active_test: state !== "archived" } })
    : [];
  const rewardText = new Map();
  for (const r of rewards) rewardText.set(r.program_id[0], [...(rewardText.get(r.program_id[0]) ?? []), r.description]);
  const validity = (r) => (r.date_from || r.date_to ? `${r.date_from ? dateText(r.date_from) : "sejak awal"} - ${r.date_to ? dateText(r.date_to) : "tanpa batas"}` : "Selalu");
  const body = rows
    .map((r) =>
      rowLink(`#/loyalty/${r.id}`, [
        cell(r.name, { strong: true }),
        cell(TYPES[r.program_type]?.[0] ?? r.program_type),
        cell((rewardText.get(r.id) ?? []).join("; ") || "-"),
        cell(validity(r)),
        cell(CARD_TYPES.includes(r.program_type) ? String(r.coupon_count) : "-", { right: true }),
        cell(r.limit_usage ? `${r.total_order_count} / ${r.max_usage}` : String(r.total_order_count), { right: true }),
        cell(`${r.sale_ok ? "Sales" : ""}${r.sale_ok && r.pos_ok ? " · " : ""}${r.pos_ok ? "POS" : ""}`),
        cell(r.active ? "" : badge({ archived: ["Diarsipkan", "muted"] }, "archived"), { raw: true }),
      ]),
    )
    .join("");
  const typeFilter = `<select data-loy-filter="jenis" class="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" aria-label="Tipe program"><option value="">Semua tipe</option>${TYPE_LIST.map(([k, l]) => `<option value="${k}" ${k === type ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  app.innerHTML =
    pageHeader(
      `Promotion & Loyalty (${MODULES[kind]})`,
      `${searchBox(text, "Cari program")}${typeFilter}${filterSelect(STATE_FILTERS, state)}
       <a href="#/loyalty/new?kind=${kind}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700"><i class="fas fa-plus mr-2"></i>Program Baru</a>`,
    ) +
    table(
      [{ label: "Program" }, { label: "Tipe" }, { label: "Hadiah" }, { label: "Berlaku" }, { label: "Kupon/Kartu", right: true }, { label: "Dipakai", right: true }, { label: "Tersedia di" }, { label: "" }],
      body,
      "Belum ada program. Buat dengan tombol Program Baru.",
    ) +
    `<p class="text-xs text-gray-500 mt-3">${kind === "pos"
      ? "Program POS dipakai di layar Kasir. Penerapan promosi otomatis, kode promo, dan beli X gratis Y di Kasir dijelaskan pada D30; kartu loyalti, kupon, dan e-wallet baru berlaku di Sales Order."
      : "Program Sales dipakai di Sales Order lewat tombol Kode Kupon dan Hadiah. Daftar Hadiah juga memperbarui promosi otomatis."}</p>`;
}

/* ---------- Form ---------- */

async function loadProgram(id) {
  const program = await readOne("loyalty.program", id, [
    "name", "program_type", "active", "sale_ok", "pos_ok", "pos_config_ids", "currency_id", "pricelist_ids", "date_from", "date_to", "limit_usage", "max_usage", "applies_on",
    "trigger", "portal_visible", "portal_point_name", "coupon_count", "total_order_count", "order_count", "pos_order_count", "rule_ids", "reward_ids", "communication_plan_ids",
  ]);
  if (!program) return null;
  const context = { active_test: program.active };
  const [rules, rewards, comms] = await Promise.all([
    searchRead("loyalty.rule", [["program_id", "=", id]], [
      "code", "minimum_qty", "minimum_amount", "minimum_amount_tax_mode", "reward_point_amount", "reward_point_mode", "reward_point_split", "product_ids", "product_category_id",
      "product_tag_id", "product_domain",
    ], { order: "id", context }),
    searchRead("loyalty.reward", [["program_id", "=", id]], [
      "reward_type", "discount", "discount_mode", "discount_applicability", "discount_max_amount", "discount_product_ids", "discount_product_category_id", "discount_product_tag_id",
      "reward_product_id", "reward_product_tag_id", "reward_product_qty", "required_points", "clear_wallet", "description", "discount_product_domain",
    ], { order: "required_points, id", context }),
    searchRead("loyalty.mail", [["program_id", "=", id]], ["trigger", "points", "mail_template_id"], { order: "id", context }),
  ]);
  const productIds = [...new Set([...rules.flatMap((r) => r.product_ids), ...rewards.flatMap((r) => [...r.discount_product_ids, ...(r.reward_product_id ? [r.reward_product_id[0]] : [])])])];
  const names = productIds.length ? new Map((await searchRead("product.product", [["id", "in", productIds]], ["display_name"], { context: { active_test: false } })).map((p) => [p.id, p.display_name])) : new Map();
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return {}; // data lama yang tidak lolos validasi UI: semua isian dianggap berubah saat disimpan
    }
  };
  const ruleRows = rules.map((r) => {
    const row = ruleRow(r, names, r.id);
    row.initialVals = safe(() => ruleVals(row, program.program_type));
    return row;
  });
  const rewardRows = rewards.map((r) => {
    const row = rewardRow(r, names, r.id);
    row.initialVals = safe(() => rewardVals(row));
    return row;
  });
  const commRows = comms.map((c) => {
    const row = commRow(c, c.id);
    row.initialVals = safe(() => commVals(row));
    return row;
  });
  return { program, rules: ruleRows, rewards: rewardRows, comms: commRows };
}

function valuesFromProgram(p) {
  return {
    name: p.name, program_type: p.program_type, sale_ok: Boolean(p.sale_ok), pos_ok: Boolean(p.pos_ok), pos_config_ids: [...p.pos_config_ids].sort((a, b) => a - b),
    currency_id: p.currency_id?.[0] ?? null, pricelist_ids: [...p.pricelist_ids].sort((a, b) => a - b), date_from: p.date_from || "", date_to: p.date_to || "",
    limit_usage: Boolean(p.limit_usage), max_usage: p.max_usage || 1, applies_on: p.applies_on, portal_point_name: p.portal_point_name || "",
  };
}

async function renderForm(id, query) {
  closeLookup();
  app.innerHTML = '<p class="text-sm text-gray-500">Memuat...</p>';
  await loadRefs();
  let loaded = null;
  if (id) {
    loaded = await loadProgram(id);
    if (!loaded) {
      app.innerHTML = '<p class="text-sm text-rose-600">Program tidak ditemukan.</p>';
      return;
    }
    kind = loaded.program.pos_ok && !loaded.program.sale_ok ? "pos" : "sale";
  } else if (query.get("kind")) kind = query.get("kind") === "pos" ? "pos" : "sale";
  if (!form || form.id !== (loaded?.program.id ?? null)) {
    if (loaded) {
      const values = valuesFromProgram(loaded.program);
      form = {
        id, type: loaded.program.program_type, program: loaded.program, values, initial: { ...values }, fixed: { trigger: loaded.program.trigger, portal_visible: loaded.program.portal_visible },
        rules: loaded.rules, rewards: loaded.rewards, comms: loaded.comms, removed: { rule: [], reward: [], comm: [] },
      };
    } else {
      const type = TYPE_LIST.some(([k]) => k === query.get("type")) ? query.get("type") : "promotion";
      const template = await typeTemplate(type);
      const values = {
        name: "", program_type: type, sale_ok: kind === "sale", pos_ok: kind === "pos", pos_config_ids: [], currency_id: ctx.company?.currency_id?.[0] ?? refs.currencies[0]?.id ?? null,
        pricelist_ids: [], date_from: "", date_to: "", limit_usage: false, max_usage: 1, applies_on: template.program.applies_on, portal_point_name: template.program.portal_point_name,
      };
      form = {
        id: null, type, program: null, values, initial: null, fixed: { trigger: template.program.trigger, portal_visible: template.program.portal_visible },
        rules: template.rules, rewards: template.rewards, comms: template.comms, removed: { rule: [], reward: [], comm: [] },
      };
    }
  }
  paintForm();
  if (loaded) loadCards();
}

const typeIs = (...types) => types.includes(form.type);

function mainFieldsHtml() {
  const v = form.values;
  const p = form.program;
  const checks = (key, options, selected, label) => options.length
    ? `<div class="mt-1 border border-gray-200 rounded-lg p-2 max-h-36 overflow-y-auto space-y-1" aria-label="${esc(label)}">${options.map((o) => `<label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-lm="${key}" value="${o.id}" ${selected.includes(o.id) ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> ${esc(o.display_name)}</label>`).join("")}</div>`
    : '<div class="py-2 text-sm text-gray-400">Belum ada pilihan.</div>';
  const typeSelect = form.id
    ? readonlyValue(TYPES[form.type]?.[0] ?? form.type)
    : `<select data-lf="program_type" data-rp="all" class="${INPUT}">${TYPE_LIST.map(([k, l]) => `<option value="${k}" ${k === form.type ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  const gift = typeIs(...PAYMENT_TYPES);
  const info = `<p class="text-xs text-gray-500 mt-1">${esc(TYPES[form.type]?.[1] ?? "")} Pemicu: ${esc(TRIGGERS[form.fixed.trigger] ?? "-")}.</p>`;
  const where = `<div class="flex flex-wrap gap-4 mt-2"><label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-lf="sale_ok" ${v.sale_ok ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> Sales Order</label>
    <label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-lf="pos_ok" data-rp="main" ${v.pos_ok ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> Kasir POS</label></div>`;
  return `
    ${fieldBlock("Nama Program", `<input data-lf="name" value="${esc(v.name)}" placeholder="mis. Diskon 10% belanja di atas Rp100.000" class="${INPUT}">`)}
    <div>${fieldBlock("Tipe Program", typeSelect)}${info}</div>
    <div>${fieldBlock("Tersedia di", where)}${gift && v.pos_ok ? '<div class="text-xs text-amber-700 mt-1">Kartu hadiah yang berlaku di POS mengharuskan template email dan laporan cetak kartu (diatur di Odoo) agar sesi kasir bisa dibuka; kasir KompakApps belum memakainya.</div>' : ""}</div>
    ${v.pos_ok ? `<div>${fieldBlock("Stasiun POS", checks("pos_config_ids", refs.posConfigs, v.pos_config_ids, "Stasiun POS"))}<div class="text-xs text-gray-500 mt-1">Kosongkan agar berlaku di semua stasiun POS.</div></div>` : ""}
    ${fieldBlock("Mata Uang", `<select data-lf="currency_id" data-kind="id" data-rp="all" class="${INPUT}">${selectOptions(refs.currencies, v.currency_id)}</select>`)}
    ${!gift && refs.pricelistEnabled ? `<div>${fieldBlock("Daftar Harga", checks("pricelist_ids", refs.pricelists, v.pricelist_ids, "Daftar harga"))}<div class="text-xs text-gray-500 mt-1">Kosongkan agar berlaku untuk semua daftar harga.</div></div>` : ""}
    ${!gift ? fieldBlock("Berlaku Mulai", `<input type="date" data-lf="date_from" value="${esc(v.date_from)}" class="${INPUT}">`) : ""}
    ${!gift ? fieldBlock("Berlaku Sampai", `<input type="date" data-lf="date_to" value="${esc(v.date_to)}" class="${INPUT}">`) : ""}
    ${!gift ? fieldBlock("Batas Pemakaian", `<div class="flex items-center gap-3"><label class="flex items-center gap-2 text-sm text-gray-700"><input type="checkbox" data-lf="limit_usage" data-rp="main" ${v.limit_usage ? "checked" : ""} class="rounded border-gray-300 text-indigo-600"> Batasi</label>
        ${v.limit_usage ? `<span class="text-sm text-gray-600">sampai</span><input type="number" min="1" step="1" data-lf="max_usage" data-kind="number" value="${esc(v.max_usage)}" class="${INPUT} w-28 text-right"><span class="text-sm text-gray-600">pemakaian${p ? ` (terpakai ${p.total_order_count})` : ""}</span>` : ""}</div>`) : ""}
    ${typeIs("loyalty") ? fieldBlock("Poin Dipakai Pada", `<select data-lf="applies_on" data-rp="main" class="${INPUT}">${Object.entries(APPLIES_ON).map(([k, l]) => `<option value="${k}" ${k === v.applies_on ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`) : ""}
    ${typeIs("loyalty") ? fieldBlock("Satuan Poin", `<input data-lf="portal_point_name" value="${esc(v.portal_point_name)}" placeholder="mis. Poin" class="${INPUT}">`) : ""}
    ${gift && form.rules[0] ? `<div class="md:col-span-2">${fieldBlock(typeIs("gift_card") ? "Produk Kartu Hadiah" : "Produk Top-up e-Wallet", `<div class="flex flex-wrap gap-2 mt-1">${chipHtml(form.rules[0]?.products ?? [], 'data-scope="rule" data-i="0" data-f="products"')}</div>
        <input data-lookup="loy-product" data-scope="rule" data-i="0" data-f="products" autocomplete="off" role="combobox" aria-autocomplete="list" placeholder="Cari produk untuk ditambahkan..." class="${INPUT} mt-2">`)}
        <div class="text-xs text-gray-500 mt-1">Membeli produk ini menerbitkan ${typeIs("gift_card") ? "kartu hadiah" : "saldo e-wallet"} senilai harganya. Aturan dan hadiahnya tetap: 1 poin per rupiah dibelanjakan, ditukar Rp1 per poin.</div></div>` : ""}`;
}

function chipHtml(items, attrs) {
  return items.map((p) => `<span class="inline-flex items-center gap-1 bg-indigo-50 text-indigo-800 rounded-full px-2 py-1 text-xs">${esc(p.display_name)}
    <button type="button" data-action="chip-remove" ${attrs} data-id="${p.id}" class="text-indigo-400 hover:text-rose-600" aria-label="Hapus ${esc(p.display_name)}"><i class="fas fa-times"></i></button></span>`).join("");
}

const productPicker = (items, scope, i, f, label) => `<div class="flex flex-wrap gap-1 mb-1">${chipHtml(items, `data-scope="${scope}" data-i="${i}" data-f="${f}"`)}</div>
  <input data-lookup="loy-product" data-scope="${scope}" data-i="${i}" data-f="${f}" autocomplete="off" role="combobox" aria-autocomplete="list" placeholder="${esc(label)}" class="${INPUT}" aria-label="${esc(label)}">`;
const sel = (attrs, options, selected, blank) => `<select ${attrs} class="${INPUT}">${blank ? `<option value="">${esc(blank)}</option>` : ""}${options.map(([k, l]) => `<option value="${esc(k)}" ${String(k) === String(selected ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const labeled = (label, content) => `<div><div class="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">${esc(label)}</div>${content}</div>`;
const nameOptions = (rows) => rows.map((r) => [r.id, r.display_name]);

function ruleCard(r, i) {
  const showPoints = typeIs(...POINTS_TYPES);
  const code = typeIs("promo_code") ? labeled("Kode Promo", `<input data-rule="${i}" data-f="code" value="${esc(r.code)}" placeholder="mis. HEMAT10" class="${INPUT}" aria-label="Kode promo">`) : "";
  const amount = typeIs("buy_x_get_y") ? "" : labeled("Belanja Minimum", `<div class="flex gap-2"><input type="number" min="0" step="any" data-rule="${i}" data-f="minimum_amount" value="${esc(r.minimum_amount)}" class="${INPUT} text-right" aria-label="Belanja minimum">
      ${sel(`data-rule="${i}" data-f="minimum_amount_tax_mode" aria-label="Pajak"`, Object.entries(TAX_MODES), r.minimum_amount_tax_mode)}</div>`);
  const points = showPoints
    ? labeled("Poin Diberikan", `<div class="flex gap-2"><input type="number" min="0" step="any" data-rule="${i}" data-f="reward_point_amount" value="${esc(r.reward_point_amount)}" class="${INPUT} w-28 text-right" aria-label="Poin">
        ${sel(`data-rule="${i}" data-f="reward_point_mode" aria-label="Cara hitung poin"`, Object.entries(POINT_MODES), r.reward_point_mode)}</div>
        ${typeIs("loyalty") && r.reward_point_mode === "money" ? '<div class="text-xs text-gray-500 mt-1">Mis. 0,001 poin per rupiah = 1 poin tiap Rp1.000.</div>' : ""}`)
    : typeIs("coupons") ? labeled("Poin", '<div class="py-2 text-sm text-gray-600">Sebesar nilai kupon</div>') : "";
  return `<div class="border border-gray-200 rounded-lg p-4 bg-gray-50">
    <div class="flex items-center justify-between mb-3"><span class="text-sm font-semibold text-gray-800">Aturan ${i + 1}</span>
      <button type="button" data-action="rule-remove" data-i="${i}" class="text-gray-400 hover:text-rose-600" aria-label="Hapus aturan ${i + 1}"><i class="fas fa-trash-alt"></i></button></div>
    <div class="grid md:grid-cols-2 gap-x-6 gap-y-3">
      ${code}
      ${labeled("Jumlah Barang Minimum", `<input type="number" min="0" step="1" data-rule="${i}" data-f="minimum_qty" value="${esc(r.minimum_qty)}" class="${INPUT} text-right" aria-label="Jumlah minimum">`)}
      ${amount}
      ${labeled("Produk yang Dihitung", productPicker(r.products, "rule", i, "products", "Cari produk (kosong = semua)..."))}
      ${labeled("Kategori Produk", sel(`data-rule="${i}" data-f="category" aria-label="Kategori"`, nameOptions(refs.categories), r.category, "Semua kategori"))}
      ${refs.tags.length ? labeled("Tag Produk", sel(`data-rule="${i}" data-f="tag" aria-label="Tag"`, nameOptions(refs.tags), r.tag, "Semua tag")) : ""}
      ${points}
    </div>
    ${r.domain && r.domain !== "[]" && r.domain !== "[['sale_ok', '=', True]]" ? `<p class="text-xs text-amber-700 mt-2">Aturan ini punya filter produk lanjutan dari Odoo (${esc(r.domain)}); filter itu tidak diubah di sini.</p>` : ""}
  </div>`;
}

function rewardCard(r, i) {
  const fixedType = typeIs("buy_x_get_y");
  const showPoints = typeIs(...POINTS_TYPES);
  const typeSelect = labeled("Jenis Hadiah", sel(`data-reward="${i}" data-f="reward_type" data-rp="rewards" ${fixedType ? "disabled" : ""} aria-label="Jenis hadiah"`, Object.entries(REWARD_TYPES), r.reward_type));
  const discount = r.reward_type === "discount"
    ? `${labeled("Diskon", `<div class="flex gap-2"><input type="number" min="0" step="any" data-reward="${i}" data-f="discount" value="${esc(r.discount)}" class="${INPUT} w-28 text-right" aria-label="Nilai diskon">
        ${sel(`data-reward="${i}" data-f="discount_mode" aria-label="Satuan diskon"`, Object.entries(DISCOUNT_MODES), r.discount_mode)}</div>`)}
       ${labeled("Berlaku untuk", sel(`data-reward="${i}" data-f="discount_applicability" data-rp="rewards" aria-label="Berlaku untuk"`, Object.entries(APPLICABILITY), r.discount_applicability))}
       ${labeled("Diskon Maksimal", `<input type="number" min="0" step="any" data-reward="${i}" data-f="discount_max_amount" value="${esc(r.discount_max_amount)}" class="${INPUT} text-right" aria-label="Diskon maksimal"><div class="text-xs text-gray-500 mt-1">0 berarti tanpa batas.</div>`)}
       ${r.discount_applicability === "specific"
         ? `${labeled("Produk yang Didiskon", productPicker(r.products, "reward", i, "products", "Cari produk..."))}
            ${labeled("Kategori yang Didiskon", sel(`data-reward="${i}" data-f="category" aria-label="Kategori yang didiskon"`, nameOptions(refs.categories), r.category, "Tanpa kategori"))}
            ${refs.tags.length ? labeled("Tag yang Didiskon", sel(`data-reward="${i}" data-f="tag" aria-label="Tag yang didiskon"`, nameOptions(refs.tags), r.tag, "Tanpa tag")) : ""}`
         : ""}`
    : `${labeled("Produk Gratis", productPicker(r.reward_product ? [r.reward_product] : [], "reward", i, "reward_product", r.reward_product ? "Ganti produk..." : "Cari produk..."))}
       ${labeled("Jumlah Gratis", `<input type="number" min="1" step="1" data-reward="${i}" data-f="reward_qty" value="${esc(r.reward_qty)}" class="${INPUT} text-right" aria-label="Jumlah gratis">`)}
       ${refs.tags.length ? labeled("Atau Tag Produk", sel(`data-reward="${i}" data-f="reward_tag" data-rp="rewards" aria-label="Tag produk gratis"`, nameOptions(refs.tags), r.reward_tag, "Tanpa tag")) : ""}
       ${form.values.pos_ok ? '<div class="md:col-span-2 text-xs text-gray-500">Produk gratis harus dijual di POS agar sesi kasir bisa dibuka (aktifkan "Dijual di POS" pada Product Master).</div>' : ""}`;
  const points = showPoints
    ? labeled("Ditukar dengan", `<div class="flex items-center gap-2"><input type="number" min="0" step="any" data-reward="${i}" data-f="required_points" value="${esc(r.required_points)}" class="${INPUT} w-28 text-right" aria-label="Poin ditukar"><span class="text-sm text-gray-600">${esc(form.values.portal_point_name || "poin")}</span></div>`)
    : "";
  return `<div class="border border-gray-200 rounded-lg p-4 bg-gray-50">
    <div class="flex items-center justify-between mb-3"><span class="text-sm font-semibold text-gray-800">Hadiah ${i + 1}</span>
      <button type="button" data-action="reward-remove" data-i="${i}" class="text-gray-400 hover:text-rose-600" aria-label="Hapus hadiah ${i + 1}"><i class="fas fa-trash-alt"></i></button></div>
    <div class="grid md:grid-cols-2 gap-x-6 gap-y-3">
      ${typeSelect}${discount}${points}
      <div class="md:col-span-2">${labeled("Deskripsi di Pesanan", `<input data-reward="${i}" data-f="description" value="${esc(r.description)}" class="${INPUT}" aria-label="Deskripsi hadiah">`)}
        <div class="text-xs text-gray-500 mt-1">${r.descAuto ? "Mengikuti isian di atas; ketik untuk menggantinya." : "Deskripsi manual."} Tampil pada baris Sales Order dan struk.</div></div>
    </div></div>`;
}

const rulesHtml = () => `<div class="space-y-3">${form.rules.map(ruleCard).join("") || '<p class="text-sm text-gray-500">Belum ada aturan: program berlaku untuk setiap pesanan.</p>'}</div>
  <button type="button" data-action="rule-add" class="mt-3 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah aturan</button>`;
const rewardsHtml = () => `<div class="space-y-3">${form.rewards.map(rewardCard).join("") || '<p class="text-sm text-rose-600">Program wajib punya minimal satu hadiah.</p>'}</div>
  <button type="button" data-action="reward-add" class="mt-3 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah hadiah</button>`;

function commsHtml() {
  if (typeIs(...PAYMENT_TYPES)) {
    const comm = form.comms[0];
    return `${labeled("Template Email", sel(`data-comm="0" data-f="template" data-solo="1" aria-label="Template email"`, nameOptions(refs.templates), comm?.template ?? "", "Tanpa email"))}
      <p class="text-xs text-gray-500 mt-1">Dikirim ke pelanggan saat kartu atau e-wallet dibuat.</p>`;
  }
  const rows = form.comms.map((c, i) => `<tr class="align-top">
      <td class="py-2 pr-2 w-64">${sel(`data-comm="${i}" data-f="trigger" data-rp="comms" aria-label="Kapan"`, Object.entries(COMM_TRIGGERS), c.trigger)}</td>
      <td class="py-2 px-2 w-32">${c.trigger === "points_reach" ? `<input type="number" min="0" step="any" data-comm="${i}" data-f="points" value="${esc(c.points)}" class="${INPUT} text-right" aria-label="Poin">` : '<span class="text-sm text-gray-400">-</span>'}</td>
      <td class="py-2 px-2 min-w-48">${sel(`data-comm="${i}" data-f="template" aria-label="Template email"`, nameOptions(refs.templates), c.template, "Pilih template...")}</td>
      <td class="py-2 pl-2 w-10 text-center"><button type="button" data-action="comm-remove" data-i="${i}" class="text-gray-400 hover:text-rose-600 mt-2" aria-label="Hapus komunikasi"><i class="fas fa-trash-alt"></i></button></td></tr>`).join("");
  return `<table class="w-full text-left"><thead><tr>${["Kapan", "Poin", "Template Email", ""].map((h) => `<th class="pb-2 px-2 text-xs font-semibold text-gray-600 uppercase">${h}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
    <button type="button" data-action="comm-add" class="mt-1 text-sm text-indigo-600 font-medium hover:text-indigo-800"><i class="fas fa-plus mr-1"></i>Tambah komunikasi</button>`;
}

const showComms = () => !typeIs(...PAYMENT_TYPES) ? form.values.applies_on !== "current" || typeIs("coupons") : Boolean(refs.templates.length);

function paintForm() {
  const p = form.program;
  const gift = typeIs(...PAYMENT_TYPES);
  const actions = [];
  if (p) actions.push(button("toggle-active", p.active ? "Arsipkan" : "Aktifkan Kembali", p.active ? "danger" : "primary", { id: p.id }));
  if (p && p.active && typeIs("coupons")) actions.push(button("generate-open", "Buat Kupon", "primary"));
  if (p && p.active && typeIs("gift_card")) actions.push(button("generate-open", "Buat Kartu Hadiah", "primary"));
  if (p && p.active && typeIs("ewallet")) actions.push(button("generate-open", "Buat e-Wallet", "primary"));
  if (p && p.active && typeIs("loyalty")) actions.push(button("generate-open", "Buat Kartu Loyalti", "plain"));
  const tile = (count, label, icon, attrs) => `<${attrs.tag} ${attrs.attr} class="flex items-center gap-3 border border-gray-200 bg-white rounded-lg px-4 py-2 hover:bg-gray-50 text-left"><i class="fas ${icon} text-gray-400"></i><div><div class="text-base font-semibold leading-none">${esc(count)}</div><div class="text-xs text-gray-500">${esc(label)}</div></div></${attrs.tag}>`;
  const cardLabel = typeIs("loyalty") ? "Kartu Loyalti" : typeIs("gift_card") ? "Kartu Hadiah" : typeIs("ewallet") ? "e-Wallet" : "Kupon";
  const tiles = p
    ? [
        CARD_TYPES.includes(form.type) && p.coupon_count > 0 ? tile(p.coupon_count, cardLabel, "fa-ticket", { tag: "a", attr: 'href="#" data-action="scroll" data-target="loy-cards"' }) : "",
        p.order_count > 0 ? tile(p.order_count, "Sales Order", "fa-file-invoice", { tag: "button", attr: 'type="button" data-action="orders"' }) : "",
        p.pos_order_count > 0 ? tile(p.pos_order_count, "Pesanan POS", "fa-cash-register", { tag: "button", attr: 'type="button" data-action="pos-orders"' }) : "",
      ].join("")
    : "";
  app.innerHTML = `
    <div class="text-sm text-gray-500 mb-2"><a href="#/loyalty?kind=${kind}" class="hover:text-indigo-600">Promotion & Loyalty (${MODULES[kind]})</a> / ${esc(p?.name ?? "Baru")}</div>
    <div class="flex flex-wrap items-center gap-2 mb-3">${actions.join("")}</div>
    <div class="flex flex-wrap gap-2 mb-4" id="loy-tiles">${tiles}</div>
    <div class="mb-3 flex items-center gap-3"><h1 class="text-2xl font-bold text-gray-900">${esc(p?.name ?? "Program Baru")}</h1>${p && !p.active ? badge({ archived: ["Diarsipkan", "muted"] }, "archived") : ""}</div>
    <section id="loy-main" class="bg-white rounded-xl shadow-sm border border-gray-200 p-6 grid md:grid-cols-2 gap-x-8 gap-y-4">${mainFieldsHtml()}</section>
    ${gift ? "" : `<div class="grid xl:grid-cols-2 gap-4 mt-4">
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-4"><div class="text-sm font-semibold mb-1">Aturan</div><p class="text-xs text-gray-500 mb-3">Syarat pesanan agar program berlaku. Kosongkan produk dan kategori untuk semua produk.</p><div id="loy-rules">${rulesHtml()}</div></section>
      <section class="bg-white rounded-xl shadow-sm border border-gray-200 p-4"><div class="text-sm font-semibold mb-1">Hadiah</div><p class="text-xs text-gray-500 mb-3">Yang diterima pelanggan bila syarat terpenuhi.</p><div id="loy-rewards">${rewardsHtml()}</div></section></div>`}
    ${showComms() ? `<section class="bg-white rounded-xl shadow-sm border border-gray-200 p-4 mt-4 overflow-x-auto"><div class="text-sm font-semibold mb-3">Komunikasi</div><div id="loy-comms">${commsHtml()}</div></section>` : ""}
    <div class="flex gap-2 mt-4">
      <button data-action="save" class="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700">Simpan</button>
      <a href="#/loyalty?kind=${kind}" data-action="discard" class="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Buang</a>
    </div>
    ${p && CARD_TYPES.includes(form.type) ? `<section id="loy-cards" class="bg-white rounded-xl shadow-sm border border-gray-200 mt-4 overflow-x-auto"><div class="px-4 py-3 border-b border-gray-200 flex items-center justify-between gap-3">
        <span class="text-sm font-semibold">${cardLabel}</span>
        <input data-loy-card-q placeholder="Cari kode atau pelanggan" aria-label="Cari kupon" class="border border-gray-300 rounded-lg px-3 py-1.5 text-sm w-56"></div>
        <div id="loy-cards-body" class="p-4 text-sm text-gray-500">Memuat...</div></section>` : ""}`;
}

const paintMain = () => {
  const box = document.querySelector("#loy-main");
  if (box) box.innerHTML = mainFieldsHtml();
};
const paintRules = () => {
  const box = document.querySelector("#loy-rules");
  if (box) box.innerHTML = rulesHtml();
};
const paintRewards = () => {
  const box = document.querySelector("#loy-rewards");
  if (box) box.innerHTML = rewardsHtml();
};
const paintComms = () => {
  const box = document.querySelector("#loy-comms");
  if (box) box.innerHTML = commsHtml();
};

/* ---------- Kupon dan kartu ---------- */

async function loadCards() {
  const body = document.querySelector("#loy-cards-body");
  if (!body || !form?.id) return;
  const text = document.querySelector("[data-loy-card-q]")?.value.trim() ?? "";
  const domain = [["program_id", "=", form.id]];
  if (text) domain.push("|", ["code", "ilike", text], ["partner_id.name", "ilike", text]);
  const rows = await searchRead("loyalty.card", domain, ["code", "partner_id", "points", "points_display", "expiration_date", "use_count", "active"], { order: "id desc", limit: 60, context: { active_test: false } });
  if (!document.querySelector("#loy-cards-body")) return;
  const head = ["Kode", "Pelanggan", "Saldo", "Berlaku Sampai", "Dipakai", ""].map((h, i) => `<th class="py-2 px-3 text-xs font-semibold text-gray-600 uppercase ${i === 2 || i === 4 ? "text-right" : ""}">${h}</th>`).join("");
  const body2 = rows.map((c) => `<tr class="${c.active ? "" : "opacity-60"}">
      <td class="py-2 px-3 text-sm font-mono">${esc(c.code)}</td><td class="py-2 px-3 text-sm">${esc(c.partner_id?.[1] ?? "Anonim")}</td>
      <td class="py-2 px-3 text-sm text-right">${esc(c.points_display)}</td><td class="py-2 px-3 text-sm">${c.expiration_date ? esc(dateText(c.expiration_date)) : "-"}</td>
      <td class="py-2 px-3 text-sm text-right">${esc(c.use_count)}</td>
      <td class="py-2 px-3 text-sm text-right whitespace-nowrap"><button type="button" data-action="card-history" data-id="${c.id}" class="text-indigo-600 hover:underline mr-3">Riwayat</button>
        <button type="button" data-action="card-balance" data-id="${c.id}" data-points="${c.points}" data-code="${esc(c.code)}" class="text-indigo-600 hover:underline mr-3">Ubah Saldo</button>
        <button type="button" data-action="card-toggle" data-id="${c.id}" data-active="${c.active ? 1 : 0}" class="text-gray-500 hover:text-rose-600">${c.active ? "Arsipkan" : "Aktifkan"}</button></td></tr>`).join("");
  document.querySelector("#loy-cards-body").className = "";
  document.querySelector("#loy-cards-body").innerHTML = rows.length
    ? `<table class="w-full text-left"><thead class="bg-gray-50"><tr>${head}</tr></thead><tbody class="divide-y divide-gray-100">${body2}</tbody></table>${rows.length >= 60 ? '<p class="text-xs text-gray-500 p-3">Menampilkan 60 terbaru; gunakan pencarian.</p>' : ""}`
    : '<p class="p-4 text-sm text-gray-500">Belum ada kupon atau kartu. Buat dengan tombol di atas, atau terbit otomatis dari pesanan.</p>';
}

function openGenerate() {
  const t = form.type;
  generate = {
    customers: [], mode: t === "ewallet" || t === "loyalty" ? "selected" : "anonymous", qty: 1, points: t === "loyalty" ? 0 : 1, valid_until: "", description: "",
  };
  paintGenerate();
}

const generateLabel = () => (typeIs("gift_card") ? "Nilai Kartu Hadiah" : typeIs("ewallet") ? "Saldo Awal e-Wallet" : typeIs("loyalty") ? "Poin Awal" : "Nilai Kupon (poin)");
function paintGenerate() {
  const g = generate;
  const selectedMode = g.mode === "selected";
  const body = `<div class="space-y-4">
    ${typeIs("ewallet", "loyalty") ? "" : fieldBlock("Untuk", `<select data-gen="mode" class="${INPUT}"><option value="anonymous" ${g.mode === "anonymous" ? "selected" : ""}>Pelanggan anonim (kode dibagikan)</option><option value="selected" ${selectedMode ? "selected" : ""}>Pelanggan tertentu</option></select>`)}
    ${selectedMode ? fieldBlock("Pelanggan", `<div id="gen-customers" class="flex flex-wrap gap-1 mb-1">${chipHtml(g.customers, 'data-scope="gen"')}</div><input data-lookup="loy-customer" autocomplete="off" role="combobox" aria-autocomplete="list" placeholder="Cari pelanggan..." class="${INPUT}" aria-label="Pelanggan">`)
      : fieldBlock("Jumlah yang Dibuat", `<input type="number" min="1" step="1" data-gen="qty" data-kind="number" value="${esc(g.qty)}" class="${INPUT} text-right">`)}
    ${fieldBlock(generateLabel(), `<input type="number" min="0" step="any" data-gen="points" data-kind="number" value="${esc(g.points)}" class="${INPUT} text-right">`)}
    ${typeIs("loyalty") ? "" : fieldBlock("Berlaku Sampai", `<input type="date" data-gen="valid_until" value="${esc(g.valid_until)}" class="${INPUT}">`)}
    ${fieldBlock("Deskripsi (riwayat)", `<input data-gen="description" value="${esc(g.description)}" placeholder="mis. Hadiah untuk pelanggan setia" class="${INPUT}">`)}
    ${selectedMode ? '<p class="text-xs text-gray-500">Satu kartu dibuat untuk setiap pelanggan yang dipilih. Email dikirim bila program punya rencana komunikasi.</p>' : ""}
  </div>`;
  openModal(typeIs("coupons") ? "Buat Kupon" : typeIs("gift_card") ? "Buat Kartu Hadiah" : typeIs("ewallet") ? "Buat e-Wallet" : "Buat Kartu Loyalti", body,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="generate-confirm" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Buat</button>`,
    () => { generate = null; });
}
function paintGenerateCustomers() {
  const box = document.querySelector("#gen-customers");
  if (box) box.innerHTML = chipHtml(generate.customers, 'data-scope="gen"');
}

async function confirmGenerate(button_) {
  const g = generate;
  if (!(num(g.points) >= 0)) throw new Error("Nilai tidak boleh negatif.");
  if (g.mode === "selected" && !g.customers.length) throw new Error("Pilih minimal satu pelanggan.");
  if (g.mode === "anonymous" && !(num(g.qty) >= 1 && Number.isInteger(num(g.qty)))) throw new Error("Jumlah yang dibuat harus bilangan bulat minimal 1.");
  if (typeIs("coupons", "gift_card") && !(num(g.points) > 0)) throw new Error("Nilai kupon atau kartu harus lebih dari 0.");
  const context = { active_id: form.id, active_model: "loyalty.program", default_program_id: form.id };
  const created = await guarded(button_, async () => {
    const [wizard] = await call("loyalty.generate.wizard", "create", {
      vals_list: [{
        program_id: form.id, mode: g.mode, points_granted: num(g.points), valid_until: g.valid_until || false, description: g.description.trim() || false,
        ...(g.mode === "selected" ? { customer_ids: [[6, 0, g.customers.map((c) => c.id)]] } : { coupon_qty: num(g.qty) }),
      }],
      context,
    });
    return call("loyalty.generate.wizard", "generate_coupons", { ids: [wizard], context });
  });
  if (!created) return;
  generate = null;
  closeModal();
  toast(`${created.length} ${typeIs("gift_card") ? "kartu hadiah" : typeIs("ewallet") ? "e-wallet" : typeIs("loyalty") ? "kartu loyalti" : "kupon"} dibuat.`);
  form.program.coupon_count += created.length;
  paintForm();
  loadCards();
}

function openBalance(el) {
  openModal(
    `Ubah Saldo ${el.dataset.code}`,
    `<form data-form="balance" class="space-y-4">${fieldBlock("Saldo Baru", `<input type="number" min="0" step="any" data-bal="points" value="${esc(el.dataset.points)}" class="${INPUT} text-right">`)}
      ${fieldBlock("Alasan", `<input data-bal="description" placeholder="mis. Koreksi saldo" class="${INPUT}">`)}</form>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="balance-confirm" data-id="${el.dataset.id}" data-old="${esc(el.dataset.points)}" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Simpan</button>`,
  );
}

async function openHistory(cardId) {
  const rows = await searchRead("loyalty.history", [["card_id", "=", cardId]], ["description", "issued", "used", "order_model", "order_id", "create_date"], { order: "id desc", limit: 50 });
  openModal(
    "Riwayat Poin",
    rows.length
      ? `<div class="overflow-x-auto"><table class="w-full text-left"><thead><tr>${["Tanggal", "Keterangan", "Masuk", "Keluar"].map((h, i) => `<th class="py-1 px-2 text-xs font-semibold text-gray-600 uppercase ${i > 1 ? "text-right" : ""}">${h}</th>`).join("")}</tr></thead>
          <tbody class="divide-y divide-gray-100">${rows.map((r) => `<tr><td class="py-1 px-2 text-sm">${esc(dateTimeText(r.create_date))}</td><td class="py-1 px-2 text-sm">${esc(r.description)}</td><td class="py-1 px-2 text-sm text-right">${r.issued ? esc(nf.format(r.issued)) : ""}</td><td class="py-1 px-2 text-sm text-right">${r.used ? esc(nf.format(r.used)) : ""}</td></tr>`).join("")}</tbody></table></div>`
      : '<p class="text-sm text-gray-500">Belum ada riwayat.</p>',
    '<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Tutup</button>',
    null,
    { wide: true },
  );
}

/* ---------- Simpan ---------- */

function programVals(v) {
  const vals = {
    name: v.name.trim(), sale_ok: v.sale_ok, pos_ok: v.pos_ok, currency_id: v.currency_id, date_from: v.date_from || false, date_to: v.date_to || false,
    limit_usage: v.limit_usage, max_usage: v.limit_usage ? num(v.max_usage, 1) : 1, pricelist_ids: [[6, 0, v.pricelist_ids]], pos_config_ids: [[6, 0, v.pos_ok ? v.pos_config_ids : []]],
  };
  if (typeIs("loyalty")) Object.assign(vals, { applies_on: v.applies_on, portal_point_name: v.portal_point_name.trim() || "Poin" });
  return vals;
}

function validateProgram() {
  const v = form.values;
  if (!v.name.trim()) throw new Error("Nama program wajib diisi.");
  if (!v.sale_ok && !v.pos_ok) throw new Error("Pilih minimal satu tempat berlaku: Sales Order atau Kasir POS.");
  if (!v.currency_id) throw new Error("Pilih mata uang program.");
  if (v.date_from && v.date_to && v.date_to < v.date_from) throw new Error("Tanggal akhir berlaku harus setelah tanggal mulai.");
  if (v.limit_usage && !(num(v.max_usage) > 0 && Number.isInteger(num(v.max_usage)))) throw new Error("Batas pemakaian harus bilangan bulat lebih dari 0.");
  if (!form.rewards.length) throw new Error("Program wajib punya minimal satu hadiah.");
  if (typeIs(...PAYMENT_TYPES) && !form.rules[0]?.products.length) throw new Error("Pilih produk pemicu untuk kartu hadiah atau e-wallet.");
  if (typeIs("promo_code") && !form.rules.length) throw new Error("Program Kode Promo butuh minimal satu aturan dengan kode.");
  const codes = form.rules.map((r) => r.code.trim().toLowerCase()).filter(Boolean);
  if (new Set(codes).size !== codes.length) throw new Error("Kode promo yang sama dipakai dua kali pada program ini.");
}

const diff = (now, before) => Object.fromEntries(Object.entries(now).filter(([k, value]) => JSON.stringify(value) !== JSON.stringify(before?.[k])));

async function persist() {
  validateProgram();
  const v = form.values;
  const ruleCommands = [];
  const rewardCommands = [];
  const commCommands = [];
  for (const r of form.rules) {
    const vals = ruleVals(r, form.type);
    if (!r.id) ruleCommands.push([0, 0, vals]);
    else {
      const changed = diff(vals, r.initialVals);
      if (Object.keys(changed).length) ruleCommands.push([1, r.id, changed]);
    }
  }
  const descriptions = []; // [id, deskripsi]: ditulis sebagai langkah kedua (lihat D30)
  for (const r of form.rewards) {
    const vals = rewardVals(r);
    if (!r.id) rewardCommands.push([0, 0, vals]);
    else {
      const changed = diff(vals, r.initialVals);
      const dependsChanged = Object.keys(changed).some((k) => !["description", "required_points", "clear_wallet"].includes(k));
      // Odoo menghitung ulang deskripsi bila kolom pembentuknya ikut ditulis, sekalipun deskripsi dikirim bersamaan; karena itu deskripsi ditulis sesudahnya.
      if (dependsChanged || "description" in changed) descriptions.push([r.id, vals.description]);
      delete changed.description;
      if (Object.keys(changed).length) rewardCommands.push([1, r.id, changed]);
    }
  }
  for (const c of form.comms) {
    const vals = commVals(c);
    if (!c.id) commCommands.push([0, 0, vals]);
    else {
      const changed = diff(vals, c.initialVals);
      if (Object.keys(changed).length) commCommands.push([1, c.id, changed]);
    }
  }
  if (!form.id) {
    const vals = {
      ...programVals(v), program_type: form.type, trigger: form.fixed.trigger, portal_visible: form.fixed.portal_visible, applies_on: v.applies_on, portal_point_name: v.portal_point_name,
      rule_ids: ruleCommands, reward_ids: rewardCommands, communication_plan_ids: commCommands,
    };
    const [id] = await call("loyalty.program", "create", { vals_list: [vals] });
    return id;
  }
  const vals = diff(programVals(v), programVals(form.initial));
  if (ruleCommands.length) vals.rule_ids = ruleCommands;
  if (rewardCommands.length) vals.reward_ids = rewardCommands;
  if (commCommands.length) vals.communication_plan_ids = commCommands;
  if (Object.keys(vals).length) await call("loyalty.program", "write", { ids: [form.id], vals });
  for (const [rid, description] of descriptions) await call("loyalty.reward", "write", { ids: [rid], vals: { description } });
  // Baris yang dibuang dihapus sesudah penulisan agar program tidak sempat tanpa hadiah; hadiah yang sudah dipakai pesanan diarsipkan Odoo.
  for (const rid of form.removed.reward) await call("loyalty.reward", "unlink", { ids: [rid] });
  for (const rid of form.removed.rule) await call("loyalty.rule", "unlink", { ids: [rid] });
  for (const rid of form.removed.comm) await call("loyalty.mail", "unlink", { ids: [rid] });
  return form.id;
}

/* ---------- Penanganan acara ---------- */

export async function onClick(event, el) {
  const { action } = el.dataset;
  if (action === "discard") form = null;
  else if (action === "save") {
    const saved = await guarded(el, persist);
    if (saved) {
      const wasNew = !form.id;
      form = null;
      toast(wasNew ? "Program dibuat." : "Perubahan disimpan.");
      if (wasNew) location.hash = `#/loyalty/${saved}`;
      else reload();
    }
  } else if (action === "toggle-active") {
    const archiving = el.textContent.trim() === "Arsipkan";
    if (archiving && !window.confirm("Arsipkan program ini? Program tidak lagi berlaku di Sales Order dan Kasir; datanya tetap utuh.")) return;
    const ok = await guarded(el, () => call("loyalty.program", archiving ? "action_archive" : "action_unarchive", { ids: [Number(el.dataset.id)] }));
    if (ok !== undefined) {
      form = null;
      toast(archiving ? "Program diarsipkan." : "Program diaktifkan kembali.");
      reload();
    }
  } else if (action === "rule-add") {
    form.rules.push(ruleRow({ minimum_qty: 0, minimum_amount: 0, reward_point_mode: "order", reward_point_amount: 1 }));
    paintRules();
  } else if (action === "rule-remove") {
    const [removed] = form.rules.splice(Number(el.dataset.i), 1);
    if (removed?.id) form.removed.rule.push(removed.id);
    paintRules();
  } else if (action === "reward-add") {
    form.rewards.push(rewardRow(typeIs("buy_x_get_y") ? { reward_type: "product", required_points: 2 } : {}));
    paintRewards();
  } else if (action === "reward-remove") {
    const [removed] = form.rewards.splice(Number(el.dataset.i), 1);
    if (removed?.id) form.removed.reward.push(removed.id);
    paintRewards();
  } else if (action === "comm-add") {
    form.comms.push(commRow({ trigger: "create" }));
    paintComms();
  } else if (action === "comm-remove") {
    const [removed] = form.comms.splice(Number(el.dataset.i), 1);
    if (removed?.id) form.removed.comm.push(removed.id);
    paintComms();
  } else if (action === "chip-remove") {
    const id = Number(el.dataset.id);
    const { scope, i, f } = el.dataset;
    if (scope === "gen") {
      generate.customers = generate.customers.filter((c) => c.id !== id);
      paintGenerateCustomers();
    } else {
      const row = (scope === "rule" ? form.rules : form.rewards)[Number(i)];
      if (f === "reward_product") row.reward_product = null;
      else row[f] = row[f].filter((p) => p.id !== id);
      touchDependency(row);
      if (scope === "rule") paintRules();
      else paintRewards();
    }
    if (form && typeIs(...PAYMENT_TYPES)) paintMain();
  } else if (action === "generate-open") openGenerate();
  else if (action === "generate-confirm") await guarded(el, () => confirmGenerate(el));
  else if (action === "card-history") await guarded(el, () => openHistory(Number(el.dataset.id)));
  else if (action === "card-balance") openBalance(el);
  else if (action === "balance-confirm") {
    const points = Number(document.querySelector('[data-bal="points"]').value);
    const description = document.querySelector('[data-bal="description"]').value.trim();
    const ok = await guarded(el, async () => {
      if (!(points >= 0) || points === Number(el.dataset.old)) throw new Error("Saldo baru harus nol atau lebih dan berbeda dari saldo saat ini.");
      if (!description) throw new Error("Isi alasan perubahan saldo.");
      const [wizard] = await call("loyalty.card.update.balance", "create", { vals_list: [{ card_id: Number(el.dataset.id), new_balance: points, description }] });
      await call("loyalty.card.update.balance", "action_update_card_point", { ids: [wizard] });
      return true;
    });
    if (ok) {
      closeModal();
      toast("Saldo diperbarui.");
      loadCards();
    }
  } else if (action === "card-toggle") {
    const archiving = el.dataset.active === "1";
    if (archiving && !window.confirm("Arsipkan kupon atau kartu ini? Kode tidak bisa dipakai lagi.")) return;
    const ok = await guarded(el, () => call("loyalty.card", archiving ? "action_archive" : "action_unarchive", { ids: [Number(el.dataset.id)] }));
    if (ok !== undefined) loadCards();
  } else if (action === "orders" || action === "pos-orders") {
    const model = action === "orders" ? "sale.order.line" : "pos.order.line";
    const lines = await guarded(el, () => searchRead(model, [["reward_id.program_id", "=", form.id]], ["order_id"], { limit: 500, context: { active_test: false } }));
    if (lines) location.hash = `#/${action === "orders" ? "sale" : "posorder"}?ids=${[...new Set(lines.map((l) => l.order_id[0]))].join(",")}`;
  }
}

const REPAINT = { all: ["main", "rules", "rewards", "comms"], main: ["main"], rewards: ["rewards"], comms: ["comms"] };
const repaint = (targets) => {
  for (const t of REPAINT[targets] ?? []) ({ main: paintMain, rules: paintRules, rewards: paintRewards, comms: paintComms })[t]();
};

export async function onInput(event, el) {
  if (el.dataset.lookup === "loy-product" || el.dataset.lookup === "loy-customer") {
    runLookup(el, 250);
    return;
  }
  if (el.dataset.gen && generate) {
    const key = el.dataset.gen;
    generate[key] = el.dataset.kind === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
    if (key === "mode") paintGenerate();
    return;
  }
  if (el.matches?.("[data-loy-card-q]")) {
    clearTimeout(cardTimer);
    cardTimer = setTimeout(loadCards, 300);
    return;
  }
  if (!form) return;
  if (el.dataset.lm) {
    form.values[el.dataset.lm] = [...document.querySelectorAll(`[data-lm="${el.dataset.lm}"]:checked`)].map((b) => Number(b.value)).sort((a, b) => a - b);
  } else if (el.dataset.lf) {
    const key = el.dataset.lf;
    const value = el.type === "checkbox" ? el.checked : el.dataset.kind === "id" ? (el.value ? Number(el.value) : null) : el.dataset.kind === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
    form.values[key] = value;
    if (key === "program_type") {
      try {
        resetForType(value, await typeTemplate(value));
        paintForm();
      } catch (error) {
        toast(error.message, "error");
      }
    } else if (key === "currency_id") {
      form.rewards.forEach(touchDependency);
      repaint("all");
    } else if (el.dataset.rp) repaint(el.dataset.rp);
  } else if (el.dataset.rule !== undefined) {
    const row = form.rules[Number(el.dataset.rule)];
    const f = el.dataset.f;
    row[f] = el.type === "checkbox" ? el.checked : f === "category" || f === "tag" ? (el.value ? Number(el.value) : null) : el.value;
  } else if (el.dataset.reward !== undefined) {
    const row = form.rewards[Number(el.dataset.reward)];
    const f = el.dataset.f;
    if (f === "category" || f === "tag" || f === "reward_tag") row[f] = el.value ? Number(el.value) : null;
    else row[f] = el.value;
    if (f === "description") {
      row.descManual = el.value.trim() !== "";
      row.descAuto = !row.descManual;
    } else if (f !== "required_points") touchDependency(row);
    if (f === "reward_type" && el.value === "product" && !row.reward_qty) row.reward_qty = 1;
    if (el.dataset.rp) paintRewards();
    else if (f !== "description") {
      const input = document.querySelector(`[data-reward="${el.dataset.reward}"][data-f="description"]`);
      if (input && row.descAuto) input.value = row.description;
    }
  } else if (el.dataset.comm !== undefined) {
    const f = el.dataset.f;
    if (el.dataset.solo) {
      // Satu template untuk kartu hadiah dan e-wallet: kosong berarti tanpa email.
      const value = el.value ? Number(el.value) : null;
      if (form.comms[0]) form.comms[0].template = value;
      else form.comms.push(commRow({ trigger: "create", mail_template_id: value }));
      if (!value && form.comms[0]) {
        if (form.comms[0].id) form.removed.comm.push(form.comms[0].id);
        form.comms.splice(0, 1);
      }
      return;
    }
    const row = form.comms[Number(el.dataset.comm)];
    row[f] = f === "template" ? (el.value ? Number(el.value) : null) : el.value;
    if (el.dataset.rp) paintComms();
  }
}

export function onChange(event, el) {
  if (el.dataset.loyFilter) {
    const [path, queryText = ""] = location.hash.replace(/^#\/?/, "").split("?");
    const params = new URLSearchParams(queryText);
    if (el.value) params.set(el.dataset.loyFilter, el.value);
    else params.delete(el.dataset.loyFilter);
    const qs = params.toString();
    location.hash = `#/${path}${qs ? `?${qs}` : ""}`;
  }
}
