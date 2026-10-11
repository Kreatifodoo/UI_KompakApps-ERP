// Opportunity: papan pipeline per tahap dan daftar. Kerangka bersama ada di leads.js.
import { createLeadPage } from "./leads.js";

const page = createLeadPage({
  route: "opportunity", type: "opportunity", title: "Opportunity", noun: "Opportunity", newLabel: "Opportunity Baru", newTitle: "Opportunity Baru", board: true,
  empty: "Belum ada opportunity. Buat dengan tombol Opportunity Baru atau konversi sebuah lead.",
});

export const { render, onClick, onInput, onChange, leave } = page;
