// Klien JSON-2 Odoo 19 minimal untuk uji kelayakan UI KompakApps.
// Semua permintaan ke /json/2/<model>/<metode> pada alamat yang sama (diteruskan oleh nginx),
// dengan API key pengguna sebagai bearer. API key hanya disimpan di sessionStorage tab ini.

const STORAGE_KEY = "kompakapps.odoo.apikey";
const COMPANY_KEY = "kompakapps.odoo.company";

function store() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export const auth = {
  get key() {
    return store()?.getItem(STORAGE_KEY) ?? "";
  },
  set(key) {
    store()?.setItem(STORAGE_KEY, key);
    activeCompany.clear(); // pengguna lain mungkin tidak berhak atas perusahaan yang dipilih sebelumnya
  },
  clear() {
    store()?.removeItem(STORAGE_KEY);
    activeCompany.clear();
  },
};

/** Perusahaan aktif (multi-company, D62): dikirim pada setiap panggilan sebagai allowed_company_ids sehingga dokumen, laporan, dan nomor urut memakai perusahaan itu.
 *  `scope` bisa dibuat "all" sementara (halaman Perusahaan) agar semua perusahaan yang diizinkan pengguna terlihat. */
export const activeCompany = {
  allowed: [],
  scope: "one",
  get id() {
    return Number(store()?.getItem(COMPANY_KEY)) || null;
  },
  set(id) {
    store()?.setItem(COMPANY_KEY, String(id));
  },
  clear() {
    store()?.removeItem(COMPANY_KEY);
  },
  /** Daftar allowed_company_ids untuk panggilan: perusahaan aktif di depan, lalu (bila scope all) perusahaan lain yang diizinkan. */
  get ids() {
    const id = this.id;
    if (!id) return undefined;
    return this.scope === "all" ? [id, ...this.allowed.filter((x) => x !== id)] : [id];
  },
};

export class OdooError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "OdooError";
    this.status = status;
  }
}

// Pesan AccessError Odoo berbahasa Inggris dan bernada kelakar; diganti kalimat Indonesia yang menyebut tindakan dan dokumennya (Q9, D87).
const ACCESS_DENIED = /doesn't have '(\w+)' access to:\s*-\s*([^\n]+)/;
const ACCESS_ACTION = { read: "membuka", write: "mengubah", create: "membuat", unlink: "menghapus" };
function describeAccessDenied(message) {
  const [, action, target] = ACCESS_DENIED.exec(message);
  return `Anda tidak berhak ${ACCESS_ACTION[action] ?? action} ${target.replace(/\s*\([\w.]+\)\s*$/, "")}. Dokumen ini mungkin milik pengguna lain atau gudang lain, atau peran dan Cakupan data Anda belum mencakupnya.`;
}

function describeError(status, body) {
  if (status === 403 && typeof body?.message === "string" && ACCESS_DENIED.test(body.message)) return describeAccessDenied(body.message);
  if (body && typeof body === "object" && body.message) {
    return String(body.message);
  }
  if (status === 401) return "API key tidak valid atau sudah kedaluwarsa.";
  if (status === 403) return "Anda tidak punya hak akses untuk aksi ini.";
  return `Permintaan gagal (HTTP ${status}).`;
}

/** Memanggil metode model Odoo. `params` berisi ids, context, dan argumen bernama metode itu. */
export async function call(model, method, params = {}) {
  let response;
  try {
    // allowed_company_ids dari perusahaan aktif; pemanggil boleh menimpanya (atau mengisi undefined untuk tidak mengirimnya) lewat params.context
    const body = { ...params, context: { allowed_company_ids: activeCompany.ids, ...(params.context ?? {}) } };
    response = await fetch(`/json/2/${model}/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `bearer ${auth.key}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new OdooError(0, "Tidak dapat menjangkau server Odoo. Pastikan Odoo berjalan.");
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new OdooError(response.status, describeError(response.status, body));
  }
  return body;
}

export function searchRead(model, domain, fields, options = {}) {
  return call(model, "search_read", { domain, fields, ...options });
}

export async function readOne(model, id, fields) {
  const rows = await call(model, "read", { ids: [id], fields });
  return rows[0] ?? null;
}
