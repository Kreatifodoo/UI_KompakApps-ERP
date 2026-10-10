// Tagihan Vendor (account.move, in_invoice): kerangka bersama ada di invoices.js.
import { BILL, createInvoicePage } from "./invoices.js";

const page = createInvoicePage(BILL);
export const { render, onClick, onInput, onChange, onSubmit, leave } = page;
