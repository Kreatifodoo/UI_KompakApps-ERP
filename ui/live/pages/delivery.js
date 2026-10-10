// Pengiriman Barang / Delivery Order (stock.picking, tipe outgoing): kerangka bersama ada di pickings.js.
import { DELIVERY, createPickingPage } from "./pickings.js";

const page = createPickingPage(DELIVERY);
export const { render, onClick, onInput, onSubmit, leave } = page;
