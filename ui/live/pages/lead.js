// Leads: kontak masuk yang belum dikualifikasi. Kerangka bersama ada di leads.js.
import { createLeadPage } from "./leads.js";

const page = createLeadPage({
  route: "lead", type: "lead", title: "Leads", noun: "Lead", newLabel: "Lead Baru", newTitle: "Lead Baru", board: false,
  empty: "Belum ada lead. Buat dengan tombol Lead Baru; lead yang layak dikonversi menjadi opportunity.",
});

export const { render, onClick, onInput, onChange, leave } = page;
