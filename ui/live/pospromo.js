// Promosi di kasir POS (best effort, lihat D30). Klien web POS Odoo menghitung promosi di JavaScript-nya sendiri dan server tidak
// punya metode publik untuk itu, jadi kasir Nusara menghitungnya di sini dari program, aturan, dan hadiah yang sama (loyalty.*),
// lalu mengirim baris hadiah (is_reward_line, reward_id, points_cost) pada pesanan POS lewat sync_from_ui.
// Didukung: promosi otomatis, kode promo, dan beli X gratis Y (program yang berlaku untuk pesanan ini saja). Kupon, kartu loyalti, kartu
// hadiah, e-wallet, dan kupon pesanan berikutnya belum didukung di kasir. Diskon "seluruh pesanan" hanya satu yang terbaik yang dipakai;
// diskon produk tertentu dan produk gratis boleh menumpuk, masing-masing dihitung atas harga baris sebelum promosi lain.
import { call, searchRead } from "./common.js";

export const SUPPORTED = ["promotion", "promo_code", "buy_x_get_y"];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const floor2 = (n) => Math.floor(Number(n) * 100 + 1e-9) / 100;
const sum = (rows, key) => rows.reduce((s, row) => s + Number(row[key] || 0), 0);
const randomCode = () => String(Math.floor(Math.random() * 2 ** 32));
const localDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Program POS yang berlaku untuk stasiun ini (cermin dari pos.config._get_program_ids) beserta aturan dan hadiahnya. */
export async function loadPrograms(config) {
  const [cfg] = await call("pos.config", "read", { ids: [config.id], fields: ["currency_id", "pricelist_id"] });
  const today = localDate();
  const rows = await searchRead(
    "loyalty.program",
    [
      ["pos_ok", "=", true], "|", ["pos_config_ids", "=", config.id], ["pos_config_ids", "=", false],
      "|", ["date_from", "=", false], ["date_from", "<=", today], "|", ["date_to", "=", false], ["date_to", ">=", today], ["currency_id", "=", cfg.currency_id[0]],
    ],
    ["name", "program_type", "trigger", "applies_on", "pricelist_ids", "limit_usage", "max_usage", "total_order_count", "portal_point_name"],
    { order: "sequence, id" },
  );
  const usable = rows.filter(
    (p) => (!p.pricelist_ids.length || p.pricelist_ids.includes(cfg.pricelist_id?.[0])) && (!p.limit_usage || p.total_order_count < p.max_usage),
  );
  const supported = usable.filter((p) => SUPPORTED.includes(p.program_type) && p.applies_on === "current");
  const unsupported = usable.filter((p) => !supported.includes(p));
  if (!supported.length) return { programs: [], unsupported: unsupported.map((p) => p.name) };
  const ids = supported.map((p) => p.id);
  const [rules, rewards] = await Promise.all([
    searchRead("loyalty.rule", [["program_id", "in", ids]], [
      "program_id", "code", "mode", "minimum_qty", "minimum_amount", "minimum_amount_tax_mode", "reward_point_amount", "reward_point_mode", "product_ids", "product_category_id", "product_tag_id",
    ], { order: "id" }),
    searchRead("loyalty.reward", [["program_id", "in", ids]], [
      "program_id", "description", "reward_type", "discount", "discount_mode", "discount_applicability", "discount_max_amount", "discount_product_ids", "discount_product_category_id",
      "discount_product_tag_id", "discount_line_product_id", "reward_product_id", "reward_product_ids", "reward_product_qty", "required_points", "clear_wallet", "is_global_discount",
    ], { order: "required_points, id" }),
  ]);
  return {
    programs: supported.map((p) => ({ ...p, rules: rules.filter((r) => r.program_id[0] === p.id), rewards: rewards.filter((r) => r.program_id[0] === p.id) })),
    unsupported: unsupported.map((p) => p.name),
  };
}

/** Kode promo yang dikenali di program POS (aturan dengan kode), tanpa memeriksa syaratnya. */
export const findCode = (programs, code) => {
  const wanted = code.trim().toLowerCase();
  for (const program of programs) {
    const rule = program.rules.find((r) => r.mode === "with_code" && r.code && r.code.toLowerCase() === wanted);
    if (rule) return { program, rule };
  }
  return null;
};

const constraintDomain = ({ ids = [], category = null, tag = null }) => {
  const terms = [];
  if (ids.length) terms.push(["id", "in", ids]);
  if (category) terms.push(["categ_id", "child_of", category]);
  if (tag) terms.push(["all_product_tag_ids", "in", tag]);
  if (!terms.length) return null;
  return [...Array(terms.length - 1).fill("|"), ...terms];
};

const taxKey = (ids) => [...ids].sort((a, b) => a - b).join(",");

/**
 * Menghitung baris hadiah untuk keranjang.
 * cart: [{ product: { id, display_name, lst_price, taxes_id }, qty, discount, excl, incl }]; codes: kode promo yang dimasukkan kasir.
 * Mengembalikan { items: [{ program, reward, lines, value, code }], lines, messages }.
 */
export async function evaluate(programs, cart, codes = []) {
  const out = { items: [], lines: [], messages: [] };
  const lines = cart.filter((l) => Number(l.qty) > 0);
  if (!programs.length || !lines.length) return out;
  const productIds = [...new Set(lines.map((l) => l.product.id))];
  const matchCache = new Map();
  const matchSet = async (constraint) => {
    const domain = constraintDomain(constraint);
    if (!domain) return new Set(productIds);
    const key = JSON.stringify(domain);
    if (!matchCache.has(key)) matchCache.set(key, searchRead("product.product", [["id", "in", productIds], ...domain], ["id"]).then((rows) => new Set(rows.map((r) => r.id))));
    return matchCache.get(key);
  };
  const activeCodes = codes.map((c) => c.trim().toLowerCase());
  const candidates = [];
  for (const program of programs) {
    let points = 0;
    let passed = false;
    let usedCode = null;
    for (const rule of program.rules) {
      if (rule.mode === "with_code") {
        if (!activeCodes.includes(String(rule.code).toLowerCase())) continue;
        usedCode = rule.code;
      }
      const matched = await matchSet({ ids: rule.product_ids, category: rule.product_category_id?.[0], tag: rule.product_tag_id?.[0] });
      const rows = lines.filter((l) => matched.has(l.product.id));
      if (!rows.length) continue;
      const qty = sum(rows, "qty");
      if (qty < rule.minimum_qty) continue;
      if ((rule.minimum_amount_tax_mode === "incl" ? sum(rows, "incl") : sum(rows, "excl")) < rule.minimum_amount) continue;
      if (!(rule.reward_point_amount > 0)) continue;
      passed = true;
      if (rule.reward_point_mode === "order") points += rule.reward_point_amount;
      else if (rule.reward_point_mode === "money") points += floor2(rule.reward_point_amount * sum(rows, "incl"));
      else points += rule.reward_point_amount * qty;
    }
    if (!passed) {
      if (program.trigger === "with_code" && !usedCode) continue; // kode belum dimasukkan
      if (usedCode) out.messages.push(`Kode ${usedCode}: syarat program "${program.name}" belum terpenuhi.`);
      continue;
    }
    const built = [];
    for (const reward of program.rewards) {
      if (points < reward.required_points) continue;
      const item = await buildReward(program, reward, points, lines, matchSet);
      if (item) built.push(item);
    }
    if (!built.length) {
      if (usedCode) out.messages.push(`Kode ${usedCode}: tidak ada yang bisa didiskon pada keranjang ini.`);
      continue;
    }
    const best = built.reduce((a, b) => (b.value > a.value ? b : a));
    candidates.push({ ...best, code: usedCode });
  }
  // Hanya satu diskon seluruh pesanan (yang terbesar) yang dipakai; diskon lain dan produk gratis menumpuk.
  const globals = candidates.filter((c) => c.reward.is_global_discount);
  const bestGlobal = globals.length ? globals.reduce((a, b) => (b.value > a.value ? b : a)) : null;
  for (const item of candidates) {
    if (item.reward.is_global_discount && item !== bestGlobal) {
      if (item.code) out.messages.push(`Kode ${item.code}: tidak digabung karena diskon seluruh pesanan yang lebih besar sudah dipakai.`);
      continue;
    }
    out.items.push(item);
    out.lines.push(...item.lines);
  }
  return out;
}

async function priceOf(taxIds, unit, forceInclude = false) {
  if (!taxIds.length) return { excl: r2(unit), incl: r2(unit) };
  const result = await call("account.tax", "compute_all", { ids: taxIds, price_unit: unit, quantity: 1, ...(forceInclude ? { context: { force_price_include: true } } : {}) });
  return { excl: r2(result.total_excluded), incl: r2(result.total_included) };
}

async function buildReward(program, reward, points, lines, matchSet) {
  const identifier = randomCode();
  const base = { program, reward, identifier };
  if (reward.reward_type === "product") {
    const productId = reward.reward_product_id?.[0] ?? reward.reward_product_ids?.[0];
    if (!productId) return null;
    const [product] = await searchRead("product.product", [["id", "=", productId]], ["display_name", "lst_price", "taxes_id"]);
    if (!product) return null;
    const claims = reward.clear_wallet ? 1 : Math.floor(points / reward.required_points);
    const qty = reward.reward_product_qty * claims;
    if (!(qty > 0)) return null;
    return {
      ...base, value: product.lst_price * qty,
      lines: [{
        ...base, product_id: product.id, name: reward.description, qty, price_unit: product.lst_price, discount: 100, tax_ids: product.taxes_id, excl: 0, incl: 0,
        reward_id: reward.id, points_cost: reward.clear_wallet ? points : claims * reward.required_points,
      }],
    };
  }
  // Diskon: cari baris yang bisa didiskon, dikelompokkan menurut pajaknya (satu baris hadiah per kelompok pajak, seperti Sales Order).
  let discountable = lines;
  if (reward.discount_applicability !== "order") {
    const matched = await matchSet({ ids: reward.discount_product_ids, category: reward.discount_product_category_id?.[0], tag: reward.discount_product_tag_id?.[0] });
    discountable = lines.filter((l) => matched.has(l.product.id));
  }
  if (!discountable.length) return null;
  let groups = new Map();
  const add = (taxIds, excl, incl) => {
    const key = taxKey(taxIds);
    const group = groups.get(key) ?? { taxIds, excl: 0, incl: 0 };
    group.excl += excl;
    group.incl += incl;
    groups.set(key, group);
  };
  if (reward.discount_applicability === "cheapest") {
    const cheapest = discountable.reduce((a, b) => (b.excl / b.qty < a.excl / a.qty ? b : a));
    add(cheapest.product.taxes_id, cheapest.excl / cheapest.qty, cheapest.incl / cheapest.qty);
  } else for (const l of discountable) add(l.product.taxes_id, l.excl, l.incl);
  groups = [...groups.values()];
  const totalIncl = sum(groups, "incl");
  if (!(totalIncl > 0)) return null;
  let discountIncl;
  if (reward.discount_mode === "percent") discountIncl = (totalIncl * reward.discount) / 100;
  else if (reward.discount_mode === "per_order") discountIncl = Math.min(reward.discount, totalIncl);
  else discountIncl = Math.min(reward.discount * (Math.floor(points / reward.required_points) * reward.required_points), totalIncl);
  if (reward.discount_max_amount > 0) discountIncl = Math.min(discountIncl, reward.discount_max_amount);
  discountIncl = r2(discountIncl);
  if (!(discountIncl > 0)) return null;
  const out = [];
  let allocated = 0;
  for (const [i, group] of groups.entries()) {
    const share = i === groups.length - 1 ? r2(discountIncl - allocated) : r2((discountIncl * group.incl) / totalIncl);
    allocated += share;
    if (!(share > 0)) continue;
    const { excl } = await priceOf(group.taxIds, share, true);
    const final = await priceOf(group.taxIds, -excl);
    out.push({
      ...base, product_id: reward.discount_line_product_id[0], name: reward.description,
      qty: 1, price_unit: -excl, discount: 0, tax_ids: group.taxIds, excl: final.excl, incl: final.incl, reward_id: reward.id, points_cost: 0,
    });
  }
  if (!out.length) return null;
  out[0].points_cost = reward.required_points;
  return { ...base, value: discountIncl, lines: out };
}
