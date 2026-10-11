// Users & Access (res.users): pengguna internal dengan peran per aplikasi (tanpa akses, pengguna, atau manajer) yang dipetakan ke grup
// Odoo, serta peran administrator. Kata sandi dan API key tidak diatur di sini: pengguna menyetel kata sandi lewat undangan Odoo dan
// membuat API key sendiri di profilnya.
import { call, ctx, dateTimeText, searchRead } from "../common.js";
import { createMasterPage } from "./masters.js";

/** Tiap aplikasi punya tingkat peran berurutan; tingkat lebih tinggi mencakup yang lebih rendah. */
const APPS = [
  { key: "pr", label: "Purchase Request", levels: [["user", "Pengguna", "purchase_request.group_purchase_request_user"], ["manager", "Manajer (menyetujui)", "purchase_request.group_purchase_request_manager"]] },
  { key: "purchase", label: "Purchase", levels: [["user", "Pengguna", "purchase.group_purchase_user"], ["manager", "Manajer", "purchase.group_purchase_manager"]] },
  { key: "stock", label: "Inventory", levels: [["user", "Pengguna", "stock.group_stock_user"], ["manager", "Manajer", "stock.group_stock_manager"]] },
  { key: "mrp", label: "Manufacture", levels: [["user", "Pengguna", "mrp.group_mrp_user"], ["manager", "Manajer", "mrp.group_mrp_manager"]] },
  { key: "sale", label: "Sales dan CRM", levels: [["user", "Salesperson", "sales_team.group_sale_salesman"], ["manager", "Manajer", "sales_team.group_sale_manager"]] },
  { key: "pos", label: "POS", levels: [["user", "Kasir", "point_of_sale.group_pos_user"], ["manager", "Manajer", "point_of_sale.group_pos_manager"]] },
  { key: "account", label: "Accounting", levels: [["invoice", "Penagihan (faktur dan tagihan)", "account.group_account_invoice"], ["user", "Akuntan", "account.group_account_user"], ["manager", "Advisor (penuh)", "account.group_account_manager"]] },
];
const ADMIN_GROUP = "base.group_system";
const XML_IDS = [...APPS.flatMap((a) => a.levels.map((l) => l[2])), ADMIN_GROUP];

let groupIds = null; // xmlid -> id grup
const loadGroupIds = async () => {
  if (groupIds) return groupIds;
  const rows = await searchRead("ir.model.data", [["model", "=", "res.groups"], ["module", "in", [...new Set(XML_IDS.map((x) => x.split(".")[0]))]]], ["module", "name", "res_id"], { limit: 500 });
  const byName = new Map(rows.map((r) => [`${r.module}.${r.name}`, r.res_id]));
  groupIds = Object.fromEntries(XML_IDS.map((x) => [x, byName.get(x) ?? null]));
  return groupIds;
};

/** Peran tertinggi yang dimiliki pengguna pada sebuah aplikasi, dari grupnya (termasuk yang tersirat). */
const roleOf = (app, memberOf, ids) => {
  let role = "";
  for (const [value, , xml] of app.levels) if (ids[xml] && memberOf.has(ids[xml])) role = value;
  return role;
};

const page = createMasterPage({
  route: "users", title: "Users & Access", noun: "Pengguna", model: "res.users", newLabel: "Pengguna Baru", order: "name", archive: true,
  baseDomain: [["share", "=", false]], chatter: false,
  empty: "Belum ada pengguna internal yang cocok.",
  listFields: ["name", "login", "login_date", "all_group_ids", "active"],
  columns: [
    { label: "Nama", value: (r) => r.name },
    { label: "Login", value: (r) => r.login },
    {
      label: "Akses",
      value: (r, refs) => {
        const memberOf = new Set(r.all_group_ids);
        if (refs.ids?.[ADMIN_GROUP] && memberOf.has(refs.ids[ADMIN_GROUP])) return "Administrator";
        const parts = APPS.map((a) => {
          const role = roleOf(a, memberOf, refs.ids ?? {});
          return role ? `${a.label}${role === "manager" ? " (manajer)" : ""}` : "";
        }).filter(Boolean);
        return parts.join(", ") || "-";
      },
    },
    { label: "Login Terakhir", value: (r) => (r.login_date ? dateTimeText(r.login_date) : "belum pernah") },
  ],
  search: ["name", "login"],
  loadListRefs: async () => ({ ids: await loadGroupIds() }),
  fields: [
    { key: "name", label: "Nama", type: "text", required: true },
    { key: "login", label: "Login (email)", type: "text", required: true, hint: "Dipakai untuk masuk dan menerima undangan." },
    ...APPS.map((a) => ({
      key: `role_${a.key}`, label: `Peran ${a.label}`, type: "select", virtual: true,
      options: [["", "Tanpa akses"], ...a.levels.map(([v, l]) => [v, l])],
    })),
    { key: "is_admin", label: "Administrator", type: "check", virtual: true, checkLabel: "Administrator: akses penuh ke pengaturan dan seluruh modul" },
  ],
  loadRefs: async () => ({ ids: await loadGroupIds() }),
  readFields: ["all_group_ids", "login_date"],
  virtualValues: async (record, refs) => {
    const memberOf = new Set(record.all_group_ids);
    return { ...Object.fromEntries(APPS.map((a) => [`role_${a.key}`, roleOf(a, memberOf, refs.ids)])), is_admin: Boolean(refs.ids[ADMIN_GROUP] && memberOf.has(refs.ids[ADMIN_GROUP])) };
  },
  newValues: () => Object.fromEntries(APPS.map((a) => [`role_${a.key}`, ""])),
  extraCreate: (v) => (String(v.login).includes("@") ? { email: String(v.login).trim() } : {}),
  validate: (v, id) => {
    if (id === ctx.user.id && !v.is_admin) throw new Error("Anda tidak bisa mencabut peran administrator dari akun Anda sendiri.");
  },
  afterSave: async (userId, v, isNew, refs) => {
    const commands = [];
    for (const a of APPS) {
      const desired = a.levels.findIndex(([value]) => value === v[`role_${a.key}`]);
      a.levels.forEach(([, , xml], i) => {
        const gid = refs.ids[xml];
        if (!gid) return;
        if (i === desired) commands.push([4, gid]);
        else if (i > desired) commands.push([3, gid]); // tingkat yang lebih tinggi dicabut; yang lebih rendah tetap (tersirat)
      });
    }
    const admin = refs.ids[ADMIN_GROUP];
    if (admin) commands.push([v.is_admin ? 4 : 3, admin]);
    if (commands.length) await call("res.users", "write", { ids: [userId], vals: { group_ids: commands } });
  },
  formNote: "Peran per aplikasi menentukan menu dan tindakan yang tersedia: Pengguna membuat dan mengedit dokumennya, Manajer juga menyetujui dan mengubah pengaturan modulnya. Kata sandi disetel pengguna lewat undangan Odoo; API key dibuat pengguna di profilnya.",
});

export const { render, onClick, onInput, onChange, leave } = page;
