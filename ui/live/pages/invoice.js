// Faktur Pelanggan (account.move, out_invoice): kerangka bersama ada di invoices.js.
import { INVOICE, createInvoicePage } from "./invoices.js";

const page = createInvoicePage(INVOICE);
export const { render, onClick, onInput, onChange, onSubmit, leave } = page;
