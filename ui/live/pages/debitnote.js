// Nota Debit Vendor (account.move, in_refund): kerangka bersama ada di invoices.js.
import { DEBIT_NOTE, createInvoicePage } from "./invoices.js";

const page = createInvoicePage(DEBIT_NOTE);
export const { render, onClick, onInput, onChange, onSubmit, leave } = page;
