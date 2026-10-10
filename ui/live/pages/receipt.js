// Penerimaan Barang / Goods Receipt (stock.picking, tipe incoming): kerangka bersama ada di pickings.js.
import { RECEIPT, createPickingPage } from "./pickings.js";

const page = createPickingPage(RECEIPT);
export const { render, onClick, onInput, onSubmit, leave } = page;
