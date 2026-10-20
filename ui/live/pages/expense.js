// Expenses (hr.expense): biaya karyawan. Alur Odoo 19 tanpa laporan biaya: Draft, Diajukan, Disetujui, Diposting, Dibayar (atau Ditolak).
// Biaya dibayar karyawan menjadi tanda terima (Dr akun biaya, Cr Hutang Usaha ke karyawan) lewat jurnal Purchases; biaya dibayar perusahaan
// langsung membuat pembayaran keluar. Akun biaya dan pajak pembelian dipilih dari COA Indonesia; lampiran struk lewat bagian Lampiran umum (D84).
import { badge, button, call, ctx, dateText, esc, guarded, journalHtml, loadJournalItems, money, searchRead, toast, today } from "../common.js";
import { hrRefs } from "./employee.js";
import { createMasterPage } from "./masters.js";

export const EXPENSE_STATES = {
  draft: ["Draft", "muted"], submitted: ["Diajukan", "warning"], approved: ["Disetujui", "info"], posted: ["Diposting", "info"],
  in_payment: ["Dalam pembayaran", "info"], paid: ["Dibayar", "success"], refused: ["Ditolak", "danger"],
};
const MODES = [["own_account", "Dibayar karyawan (diganti perusahaan)"], ["company_account", "Dibayar perusahaan"]];
const EXPENSE_TYPES = ["expense", "expense_depreciation", "expense_direct_cost"];
const editable = (r) => !r || r.state === "draft";
const page = createMasterPage({
  route: "expense", title: "Expenses", noun: "Biaya", model: "hr.expense", newLabel: "Biaya Baru", newTitle: "Biaya Baru", order: "date desc, id desc", limit: 200,
  empty: "Belum ada biaya yang cocok.",
  listFields: ["name", "employee_id", "product_id", "date", "total_amount", "payment_mode", "state"],
  columns: [
    { label: "Deskripsi", value: (r) => r.name },
    { label: "Karyawan", value: (r) => r.employee_id[1] },
    { label: "Kategori", value: (r) => r.product_id?.[1] ?? "-" },
    { label: "Tanggal", value: (r) => (r.date ? dateText(r.date) : "-") },
    { label: "Total", value: (r) => money(r.total_amount), right: true },
    { label: "Status", value: (r) => badge(EXPENSE_STATES, r.state), raw: true },
  ],
  search: ["name", "employee_id.name"],
  filters: [
    { key: "status", label: "Semua status", options: Object.entries(EXPENSE_STATES).map(([k, v]) => [k, v[0]]), domain: (v) => [["state", "=", v]] },
    { key: "employee", hidden: true, label: "Karyawan", options: [], domain: (v) => [["employee_id", "=", Number(v)]] },
  ],
  loadRefs: async () => {
    const [base, categories, accounts, taxes] = await Promise.all([
      hrRefs(),
      searchRead("product.product", [["can_be_expensed", "=", true]], ["display_name"], { order: "default_code, name", limit: 100 }),
      searchRead("account.account", [["account_type", "in", EXPENSE_TYPES]], ["display_name"], { order: "code", limit: 300 }),
      searchRead("account.tax", [["type_tax_use", "=", "purchase"]], ["display_name"], { order: "sequence, name", limit: 100 }),
    ]);
    const [mine] = await searchRead("hr.employee", [["user_id", "=", ctx.user.id]], ["id"], { limit: 1 });
    return { ...base, categories, accounts, taxes, me: mine?.id ?? null };
  },
  fields: [
    { key: "name", label: "Deskripsi", type: "text", required: true, readonly: (r) => !editable(r), span2: true },
    { key: "employee_id", label: "Karyawan", type: "m2o", required: true, optionsOf: (refs) => refs.employees, readonly: (r) => !editable(r) },
    { key: "product_id", label: "Kategori Biaya", type: "m2o", required: true, optionsOf: (refs) => refs.categories, readonly: (r) => !editable(r) },
    { key: "date", label: "Tanggal", type: "date", required: true, readonly: (r) => !editable(r) },
    { key: "total_amount_currency", label: "Total (termasuk pajak)", type: "number", min: 0, step: "any", required: true, readonly: (r) => !editable(r) },
    { key: "payment_mode", label: "Dibayar Oleh", type: "select", options: MODES, readonly: (r) => !editable(r) },
    { key: "account_id", label: "Akun Biaya", type: "m2o", optionsOf: (refs) => refs.accounts, blank: "- (bawaan kategori)", readonly: (r) => !editable(r), hint: "Pilih akun beban COA. Bila kosong Odoo memakai akun bawaan kategori, yang pada instalasi baru bisa berupa HPP (51000010); isi akun beban agar laporan laba rugi benar." },
    { key: "tax_ids", label: "Pajak Pembelian", type: "m2m", optionsOf: (refs) => refs.taxes, readonly: (r) => !editable(r) },
    { key: "description", label: "Catatan", type: "textarea", span2: true, readonly: (r) => !editable(r) },
  ],
  newValues: (refs) => ({ date: today(), payment_mode: "own_account", product_id: refs.categories?.[0]?.id ?? null, employee_id: refs.me }),
  readFields: ["state", "total_amount", "untaxed_amount", "tax_amount", "account_move_id", "payment_mode", "currency_id", "can_approve"],
  titleOf: (r) => r.name,
  tiles: (r) => [
    { count: money(r.untaxed_amount), label: "Sebelum pajak", icon: "fa-receipt", always: true },
    { count: money(r.tax_amount), label: "Pajak", icon: "fa-percent", always: r.tax_amount > 0 },
    { count: money(r.total_amount), label: "Total", icon: "fa-coins", always: true },
  ],
  validate: (v) => {
    if (!(Number(v.total_amount_currency) > 0)) throw new Error("Total biaya harus lebih dari 0.");
  },
  actions: (r) => {
    const parts = [];
    if (r.state === "draft") parts.push(button("exp-submit", "Ajukan", "primary", { id: r.id }), button("exp-delete", "Hapus", "danger", { id: r.id }));
    if (r.state === "submitted") parts.push(button("exp-approve", "Setujui", "primary", { id: r.id }), button("exp-refuse", "Tolak", "danger", { id: r.id }));
    if (r.state === "approved") parts.push(button("exp-post", r.payment_mode === "company_account" ? "Catat Pembayaran Perusahaan" : "Posting ke Akuntansi", "primary", { id: r.id }));
    if (r.state === "posted") parts.push(button("exp-pay", "Catat Pembayaran", "success", { id: r.id }));
    if (["submitted", "approved", "refused"].includes(r.state)) parts.push(button("exp-reset", "Kembalikan ke Draft", "plain", { id: r.id }));
    return `${parts.join("")}<span class="self-center">${badge(EXPENSE_STATES, r.state)}</span>`;
  },
  extra: async (r) => {
    const items = r.account_move_id ? await loadJournalItems(r.account_move_id[0]) : [];
    const journal = journalHtml(items, r.currency_id?.[1], { title: `Jurnal ${r.account_move_id?.[1] ?? ""}` });
    return journal;
  },
  formNote: "Biaya diajukan oleh karyawan, disetujui atasan atau petugas Expenses, lalu diposting ke akuntansi. Tanpa penyetuju yang ditetapkan, pengajuan langsung berstatus Disetujui.",
  onAction: async (action, el, { reload }) => {
    const id = Number(el.dataset.id);
    const run = async (task, message) => {
      const ok = await guarded(el, task);
      if (ok !== undefined) {
        if (message) toast(message);
        reload();
      }
    };
    if (action === "exp-submit") await run(() => call("hr.expense", "action_submit", { ids: [id] }), "Biaya diajukan.");
    else if (action === "exp-approve") {
      await run(async () => {
        const result = await call("hr.expense", "action_approve", { ids: [id] });
        if (result && typeof result === "object") {
          if (!window.confirm("Ada biaya serupa yang sudah diajukan atau diproses (kemungkinan duplikat). Tetap setujui biaya ini?")) return true;
          const [wizard] = await call("hr.expense.approve.duplicate", "create", { vals_list: [{ expense_ids: [[6, 0, [id]]] }] });
          await call("hr.expense.approve.duplicate", "action_approve", { ids: [wizard] });
        }
        return true;
      }, "Biaya disetujui.");
    } else if (action === "exp-refuse") {
      const reason = window.prompt("Alasan penolakan:");
      if (!reason?.trim()) return;
      await run(async () => {
        const context = { active_ids: [id], active_model: "hr.expense" };
        const [wizard] = await call("hr.expense.refuse.wizard", "create", { vals_list: [{ reason: reason.trim(), expense_ids: [[6, 0, [id]]] }], context });
        await call("hr.expense.refuse.wizard", "action_refuse", { ids: [wizard], context });
        return true;
      }, "Biaya ditolak.");
    } else if (action === "exp-reset") await run(() => call("hr.expense", "action_reset", { ids: [id] }), "Biaya dikembalikan ke draft.");
    else if (action === "exp-post") {
      await run(async () => {
        const [expense] = await call("hr.expense", "read", { ids: [id], fields: ["payment_mode"] });
        if (expense.payment_mode === "company_account") {
          await call("hr.expense", "action_post", { ids: [id] });
        } else {
          const context = { active_ids: [id], validate_analytic: true };
          const [wizard] = await call("hr.expense.post.wizard", "create", { vals_list: [{}], context });
          await call("hr.expense.post.wizard", "action_post_entry", { ids: [wizard], context });
        }
        return true;
      }, "Biaya diposting ke akuntansi.");
    } else if (action === "exp-pay") {
      await run(async () => {
        const [expense] = await call("hr.expense", "read", { ids: [id], fields: ["account_move_id"] });
        const context = { active_model: "account.move", active_ids: [expense.account_move_id[0]] };
        const [wizard] = await call("account.payment.register", "create", { vals_list: [{}], context });
        await call("account.payment.register", "action_create_payments", { ids: [wizard], context });
        return true;
      }, "Pembayaran dicatat.");
    } else if (action === "exp-delete") {
      if (!window.confirm("Hapus biaya ini?")) return;
      const ok = await guarded(el, () => call("hr.expense", "unlink", { ids: [id] }));
      if (ok !== undefined) {
        toast("Biaya dihapus.");
        location.hash = "#/expense";
      }
    }
  },
});

export const { render, onClick, onInput, onChange, leave } = page;
