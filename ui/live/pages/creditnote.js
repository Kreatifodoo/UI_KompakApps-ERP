// Nota Kredit Pelanggan (account.move, out_refund): kerangka bersama ada di invoices.js.
import { CREDIT_NOTE, createInvoicePage } from "./invoices.js";

const page = createInvoicePage(CREDIT_NOTE);
export const { render, onClick, onInput, onChange, onSubmit, leave } = page;
