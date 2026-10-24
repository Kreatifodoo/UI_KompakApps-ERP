// Users & Access (res.users): pengguna internal dengan peran per aplikasi (tanpa akses, pengguna, atau manajer) yang dipetakan ke grup
// Odoo, serta peran administrator. Kata sandi dan API key tidak diatur di sini: pengguna menyetel kata sandi lewat undangan Odoo dan
// membuat API key sendiri di profilnya. Cakupan data (Q9, D87) menentukan dokumen siapa yang terlihat (sendiri atau semua) lewat grup
// kecil; aturan record Odoo yang menegakkannya, jadi daftar, form, laporan, dan dashboard ikut terbatas.
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
  { key: "audit", label: "Audit Log", levels: [["user", "Pembaca log", "auditlog.group_auditlog_user"], ["manager", "Pengelola aturan audit", "auditlog.group_auditlog_manager"]] },
  { key: "hr", label: "Human Resources (karyawan, kontrak)", levels: [["user", "Petugas HR", "hr.group_hr_user"], ["manager", "Administrator HR", "hr.group_hr_manager"]] },
  { key: "attendance", label: "Attendance (kehadiran)", levels: [["officer", "Petugas", "hr_attendance.group_hr_attendance_officer"], ["manager", "Manajer", "hr_attendance.group_hr_attendance_manager"]] },
  { key: "holidays", label: "Time Off (cuti)", levels: [["responsible", "Penyetuju tim", "hr_holidays.group_hr_holidays_responsible"], ["user", "Petugas", "hr_holidays.group_hr_holidays_user"], ["manager", "Administrator", "hr_holidays.group_hr_holidays_manager"]] },
  { key: "expense", label: "Expenses (biaya karyawan)", levels: [["team", "Penyetuju tim", "hr_expense.group_hr_expense_team_approver"], ["user", "Petugas", "hr_expense.group_hr_expense_user"], ["manager", "Administrator", "hr_expense.group_hr_expense_manager"]] },
  { key: "payroll", label: "Payroll (gaji)", levels: [["officer", "Petugas (lihat, buat, hitung slip; kirim email)", "payroll.group_payroll_user"], ["manager", "Manajer (konfirmasi, batalkan, refund, jurnal, aturan, batch, parameter)", "payroll.group_payroll_manager"]] },
  { key: "account", label: "Accounting", levels: [["invoice", "Penagihan (faktur dan tagihan)", "account.group_account_invoice"], ["user", "Akuntan", "account.group_account_user"], ["manager", "Advisor (penuh)", "account.group_account_manager"]] },
];
/**
 * Cakupan data per aplikasi. Hanya berlaku pada peran `when` (peran di atasnya melihat semua; tanpa peran tidak ada akses). `group` adalah
 * grup tambahan yang menandai cakupan; `means` = arti keanggotaan grup itu: "all" (melonggarkan) atau "own" (membatasi). Administrator
 * selalu mendapat Semua dokumen.
 */
const SCOPES = [
  {
    key: "sale", app: "sale", label: "Sales dan CRM", when: "user", group: "sales_team.group_sale_salesman_all_leads", means: "all", initial: "own",
    hint: "Sendiri: hanya quotation, Sales Order, faktur penjualan, dan peluang miliknya (atau yang belum punya penanggung jawab). Semua: dokumen semua penjual. Manajer dan Administrator selalu melihat semua.",
  },
  {
    key: "purchase", app: "purchase", label: "Purchase dan Purchase Request", when: "user", group: "kompakapps_base.group_purchase_own", means: "own", initial: "all",
    hint: "Sendiri: hanya Purchase Order dengan dirinya sebagai pembeli, Purchase Request yang ia ajukan, serta penerimaan barang dan tagihan vendor dari PO miliknya. Semua: seluruh dokumen pembelian. Manajer dan Administrator selalu melihat semua.",
  },
];
const SCOPE_OPTIONS = [["own", "Hanya dokumen sendiri"], ["all", "Semua dokumen"]];
const ADMIN_GROUP = "base.group_system";
const XML_IDS = [...APPS.flatMap((a) => a.levels.map((l) => l[2])), ...SCOPES.map((s) => s.group), ADMIN_GROUP];

let groupIds = null; // xmlid -> id grup
const loadGroupIds = async () => {
  if (groupIds) return groupIds;
  const rows = await searchRead("ir.model.data", [["model", "=", "res.groups"], ["module", "in", [...new Set(XML_IDS.map((x) => x.split(".")[0]))]]], ["module", "name", "res_id"], { limit: 500 });
  const byName = new Map(rows.map((r) => [`${r.module}.${r.name}`, r.res_id]));
  groupIds = Object.fromEntries(XML_IDS.map((x) => [x, byName.get(x) ?? null]));
  return groupIds;
};

/** Cakupan data efektif ("own" atau "all") dari grup pengguna; peran di atas `when` otomatis "all" karena grupnya tersirat. */
const scopeOf = (scope, memberOf, ids) => {
  const member = Boolean(ids[scope.group] && memberOf.has(ids[scope.group]));
  return (scope.means === "all" ? member : !member) ? "all" : "own";
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
          const scope = SCOPES.find((s) => s.app === a.key && s.when === role);
          const suffix = role === "manager" ? " (manajer)" : scope ? ` (${scopeOf(scope, memberOf, refs.ids ?? {}) === "all" ? "semua dokumen" : "dokumen sendiri"})` : "";
          return role ? `${a.label}${suffix}` : "";
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
      rerender: SCOPES.some((s) => s.app === a.key),
    })),
    { key: "is_admin", label: "Administrator", type: "check", virtual: true, rerender: true, checkLabel: "Administrator: akses penuh ke pengaturan dan seluruh modul" },
    // Cakupan data: tampil bila pengguna punya peran pada aplikasinya; hanya bisa diubah pada peran `when` dan bukan Administrator
    ...SCOPES.map((s) => ({
      key: `scope_${s.key}`, label: `Cakupan data ${s.label}`, type: "select", virtual: true, hint: s.hint,
      show: (v) => v[`role_${s.app}`] !== "",
      readonly: (record, v) => v[`role_${s.app}`] !== s.when || Boolean(v.is_admin),
      optionsOf: (refs, v) => (v[`role_${s.app}`] !== s.when || v.is_admin ? [["all", "Semua dokumen (otomatis untuk peran ini)"]] : SCOPE_OPTIONS),
    })),
    // hak perusahaan hanya relevan bila ada lebih dari satu perusahaan (D62)
    { key: "company_ids", label: "Perusahaan yang boleh diakses", type: "m2m", optionsOf: (refs) => refs.companies ?? [], show: () => ctx.multiCompany, hint: "Pengguna hanya melihat dokumen perusahaan yang dicentang dan bisa berpindah di antaranya lewat pemilih di header." },
    { key: "company_id", label: "Perusahaan bawaan", type: "m2o", optionsOf: (refs) => refs.companies ?? [], blank: "-", show: () => ctx.multiCompany, hint: "Perusahaan yang aktif saat pengguna masuk; harus termasuk yang boleh diakses." },
  ],
  loadRefs: async () => ({ ids: await loadGroupIds(), companies: ctx.companies }),
  readFields: ["all_group_ids", "login_date"],
  virtualValues: async (record, refs) => {
    const memberOf = new Set(record.all_group_ids);
    return {
      ...Object.fromEntries(APPS.map((a) => [`role_${a.key}`, roleOf(a, memberOf, refs.ids)])),
      ...Object.fromEntries(SCOPES.map((s) => [`scope_${s.key}`, scopeOf(s, memberOf, refs.ids)])),
      is_admin: Boolean(refs.ids[ADMIN_GROUP] && memberOf.has(refs.ids[ADMIN_GROUP])),
    };
  },
  newValues: () => ({
    ...Object.fromEntries(APPS.map((a) => [`role_${a.key}`, ""])),
    ...Object.fromEntries(SCOPES.map((s) => [`scope_${s.key}`, s.initial])),
    company_ids: [ctx.company.id], company_id: ctx.company.id,
  }),
  extraCreate: (v) => (String(v.login).includes("@") ? { email: String(v.login).trim() } : {}),
  validate: (v, id) => {
    if (id === ctx.user.id && !v.is_admin) throw new Error("Anda tidak bisa mencabut peran administrator dari akun Anda sendiri.");
    if (ctx.multiCompany) {
      if (!v.company_ids.length) throw new Error("Pilih minimal satu perusahaan yang boleh diakses pengguna ini.");
      if (v.company_id && !v.company_ids.includes(v.company_id)) throw new Error("Perusahaan bawaan harus termasuk perusahaan yang boleh diakses.");
    }
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
    // Cakupan data: grup penanda dipasang hanya pada peran `when` dengan cakupan yang sesuai; Administrator dan peran di atasnya = Semua
    for (const s of SCOPES) {
      const gid = refs.ids[s.group];
      if (!gid) continue;
      const role = v[`role_${s.app}`];
      const effective = v.is_admin || role !== s.when ? "all" : v[`scope_${s.key}`];
      commands.push([role === s.when && effective === (s.means === "all" ? "all" : "own") ? 4 : 3, gid]);
    }
    const admin = refs.ids[ADMIN_GROUP];
    if (admin) commands.push([v.is_admin ? 4 : 3, admin]);
    if (commands.length) await call("res.users", "write", { ids: [userId], vals: { group_ids: commands } });
  },
  formNote: "Peran per aplikasi menentukan menu dan tindakan yang tersedia: Pengguna membuat dan mengedit dokumennya, Manajer juga menyetujui dan mengubah pengaturan modulnya. Cakupan data menentukan dokumen siapa yang terlihat: pengguna dengan cakupan Sendiri tidak bisa melihat, membuka, mengubah, atau menghitung dokumen orang lain (daftar, laporan, dan dashboard ikut terbatas). Kata sandi disetel pengguna lewat undangan Odoo; API key dibuat pengguna di profilnya.",
});

export const { render, onClick, onInput, onChange, leave } = page;
