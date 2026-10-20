// Lampiran (ir.attachment) pada setiap formulir input (Q58, D84). Bagiannya ikut chatterHtml (common.js), jadi tampil di semua halaman yang
// punya "Catatan dan riwayat"; formulir tanpa chatter memakai attachmentsSectionHtml + loadAttachments. Lampiran memakai res_model dan res_id,
// sehingga berlaku untuk model apa pun, termasuk yang tanpa mail.thread. Fitur: daftar, unggah banyak berkas (pilih atau seret-lepas),
// pratinjau gambar dan PDF, unduh, hapus, dan lampiran pada catatan chatter (message_post dengan attachment_ids).
import { OdooError, call, dateTimeText, esc, guarded, loadMessages, searchRead, setAttachmentHook, toast } from "./common.js";

export const MAX_FILE = 25 * 1024 * 1024; // sebanding dengan client_max_body_size 40m pada lokasi /json/2/ (base64 menambah sepertiga)
const BLOCKED = new Set(["exe", "bat", "cmd", "com", "scr", "msi", "vbs", "jar", "apk", "sh", "dll"]);
const FIELDS = ["name", "mimetype", "file_size", "create_uid", "create_date"];

const extOf = (name) => String(name).split(".").pop().toLowerCase();

/** Ikon menurut jenis berkas. */
export function iconFor(mime, name = "") {
  const m = mime || "";
  const e = extOf(name);
  if (m.startsWith("image/")) return ["fa-file-image", "text-sky-600"];
  if (m === "application/pdf" || e === "pdf") return ["fa-file-pdf", "text-rose-600"];
  if (/spreadsheet|excel|csv/.test(m) || ["xls", "xlsx", "csv", "ods"].includes(e)) return ["fa-file-excel", "text-emerald-600"];
  if (/word|document|rtf/.test(m) || ["doc", "docx", "odt", "rtf"].includes(e)) return ["fa-file-word", "text-indigo-600"];
  if (/zip|compressed|tar|rar/.test(m) || ["zip", "rar", "7z", "gz", "tar"].includes(e)) return ["fa-file-archive", "text-amber-600"];
  if (m.startsWith("text/") || e === "txt") return ["fa-file-alt", "text-gray-600"];
  return ["fa-file", "text-gray-500"];
}

export const sizeText = (bytes) => {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`.replace(".", ",");
  return `${(n / 1024 / 1024).toFixed(1)} MB`.replace(".", ",");
};

/** Pesan galat berbahasa Indonesia untuk kegagalan unggah, unduh, atau hapus. */
export function friendlyError(error) {
  const text = String(error?.message || "");
  if (error instanceof OdooError && error.status === 413) return `Berkas terlalu besar untuk diterima server (maksimal ${MAX_FILE / 1024 / 1024} MB).`;
  if (error instanceof OdooError && error.status === 403) return "Anda tidak punya hak untuk mengelola lampiran pada dokumen ini.";
  if (/access ?denied|AccessError|not allowed|tidak diizinkan|tidak punya hak/i.test(text)) return "Anda tidak punya hak untuk mengelola lampiran pada dokumen ini.";
  if (/413|too large|Request Entity/i.test(text)) return `Berkas terlalu besar untuk diterima server (maksimal ${MAX_FILE / 1024 / 1024} MB).`;
  return text || "Lampiran gagal diproses.";
}

/** Periksa berkas sebelum diunggah; mengembalikan pesan galat atau null. */
export function checkFile(file) {
  if (!file.size) return `"${file.name}" kosong (0 B).`;
  if (file.size > MAX_FILE) return `"${file.name}" terlalu besar (${sizeText(file.size)}); maksimal ${MAX_FILE / 1024 / 1024} MB.`;
  if (BLOCKED.has(extOf(file.name))) return `Jenis berkas "${file.name}" tidak diizinkan (berkas yang dapat dijalankan).`;
  return null;
}

const readFile = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error(`Berkas "${file.name}" tidak bisa dibaca.`));
    reader.readAsDataURL(file);
  });

const bytesOf = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Unggah satu berkas ke record; mengembalikan id lampiran. */
export async function uploadFile(file, model, id) {
  const datas = await readFile(file);
  const [created] = await call("ir.attachment", "create", {
    vals_list: [{ name: file.name, datas, res_model: model, res_id: id, mimetype: file.type || false, type: "binary" }],
  });
  return created;
}

const sectionOf = (model, id) => document.querySelector(`[data-att-section][data-model="${model}"][data-id="${id}"]`);

function rowHtml(a) {
  const [icon, tone] = iconFor(a.mimetype, a.name);
  const previewable = /^image\//.test(a.mimetype || "") || a.mimetype === "application/pdf";
  return `<li class="py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
    <i class="fas ${icon} ${tone} w-5 text-center"></i>
    <div class="flex-1 min-w-[10rem]"><div class="font-medium text-gray-800 break-all">${esc(a.name)}</div>
      <div class="text-xs text-gray-500">${esc(sizeText(a.file_size))} · ${esc(a.create_uid?.[1] ?? "-")} · ${esc(dateTimeText(a.create_date))}</div></div>
    ${previewable ? `<button type="button" data-action="att-open" data-aid="${a.id}" class="text-indigo-600 hover:underline">Pratinjau</button>` : ""}
    <button type="button" data-action="att-download" data-aid="${a.id}" class="text-indigo-600 hover:underline">Unduh</button>
    <button type="button" data-action="att-remove" data-aid="${a.id}" data-name="${esc(a.name)}" class="text-rose-600 hover:underline">Hapus</button></li>`;
}

/** Isi daftar Lampiran pada halaman (dipanggil dari loadMessages atau langsung oleh formulir tanpa chatter). */
export async function loadAttachmentList(model, id) {
  const box = sectionOf(model, id);
  if (!box) return;
  const list = box.querySelector("[data-att-list]");
  try {
    const rows = await searchRead("ir.attachment", [["res_model", "=", model], ["res_id", "=", id], ["res_field", "=", false]], FIELDS, { order: "id desc", limit: 200 });
    if (!sectionOf(model, id)) return;
    box.querySelector("[data-att-count]").textContent = rows.length ? `(${rows.length})` : "";
    list.innerHTML = rows.length ? `<ul class="divide-y divide-gray-100">${rows.map(rowHtml).join("")}</ul>` : '<div class="py-2 text-gray-500">Belum ada lampiran.</div>';
  } catch (error) {
    list.innerHTML = `<div class="py-2 text-rose-600">${esc(/access|hak|403/i.test(String(error.message)) ? "Anda tidak punya hak untuk melihat lampiran dokumen ini." : "Lampiran tidak dapat dimuat.")}</div>`;
  }
}
setAttachmentHook(loadAttachmentList);

/** Unggah beberapa berkas ke bagian Lampiran, satu per satu dengan laporan galat per berkas. */
async function uploadMany(box, files) {
  const model = box.dataset.model;
  const id = Number(box.dataset.id);
  const list = box.querySelector("[data-att-list]");
  let done = 0;
  const queue = [...files];
  for (const [i, file] of queue.entries()) {
    const problem = checkFile(file);
    if (problem) {
      toast(problem, "error");
      continue;
    }
    list.insertAdjacentHTML("afterbegin", `<div data-att-busy class="py-1 text-xs text-gray-500"><i class="fas fa-spinner fa-spin mr-1"></i>Mengunggah ${esc(file.name)} (${i + 1} dari ${queue.length})...</div>`);
    try {
      await uploadFile(file, model, id);
      done += 1;
    } catch (error) {
      toast(`${file.name}: ${friendlyError(error)}`, "error");
    }
    list.querySelector("[data-att-busy]")?.remove();
  }
  if (done) toast(done === 1 ? "Lampiran diunggah." : `${done} lampiran diunggah.`);
  await loadAttachmentList(model, id);
  if (done) loadMessages(model, id);
}

async function fetchFile(aid) {
  const [file] = await call("ir.attachment", "read", { ids: [aid], fields: ["name", "datas", "mimetype", "type", "url"] });
  if (!file) throw new Error("Lampiran tidak ditemukan.");
  if (file.type === "url" && file.url) return { url: file.url, name: file.name };
  const blob = new Blob([bytesOf(file.datas || "")], { type: file.mimetype || "application/octet-stream" });
  return { blob, name: file.name, mimetype: file.mimetype };
}

function saveBlob(blob, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

/** Aksi tombol lampiran; mengembalikan true bila aksinya milik modul ini. */
export async function handleAttachmentAction(action, el) {
  const aid = Number(el.dataset.aid);
  if (action === "att-download") {
    await guarded(el, async () => {
      const f = await fetchFile(aid).catch((e) => { throw new Error(friendlyError(e)); });
      if (f.url) window.open(f.url, "_blank", "noopener");
      else saveBlob(f.blob, f.name);
    });
  } else if (action === "att-open") {
    const tab = window.open("", "_blank"); // dibuka sebelum await agar tidak diblokir peramban
    const ok = await guarded(el, async () => {
      const f = await fetchFile(aid).catch((e) => { throw new Error(friendlyError(e)); });
      if (f.url) {
        if (tab) tab.location.href = f.url;
        return true;
      }
      if (/^image\//.test(f.mimetype || "") || f.mimetype === "application/pdf") {
        const url = URL.createObjectURL(f.blob);
        if (tab) tab.location.href = url;
        else saveBlob(f.blob, f.name);
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      } else {
        tab?.close();
        saveBlob(f.blob, f.name);
      }
      return true;
    });
    if (!ok) tab?.close();
  } else if (action === "att-remove") {
    if (!window.confirm(`Hapus lampiran "${el.dataset.name || "ini"}"?`)) return true;
    const box = el.closest("[data-att-section]");
    const ok = await guarded(el, () => call("ir.attachment", "unlink", { ids: [aid] }).catch((e) => { throw new Error(friendlyError(e)); }));
    if (ok !== undefined && box) {
      toast("Lampiran dihapus.");
      loadAttachmentList(box.dataset.model, Number(box.dataset.id));
    }
  } else if (action === "att-note-clear") {
    const form = el.closest("form");
    form.querySelector("[data-note-file]").value = "";
    form._files = [];
    renderNoteFiles(form);
  } else return false;
  return true;
}

/** Perubahan input berkas (bagian Lampiran atau catatan); mengembalikan true bila milik modul ini. */
export async function handleAttachmentChange(el) {
  if (el.matches("[data-att-file]")) {
    const box = el.closest("[data-att-section]");
    const files = [...el.files];
    el.value = "";
    if (box && files.length) await uploadMany(box, files);
    return true;
  }
  if (el.matches("[data-note-file]")) {
    const form = el.closest("form");
    form._files = [...(form._files ?? []), ...el.files];
    el.value = "";
    renderNoteFiles(form);
    return true;
  }
  return false;
}

function renderNoteFiles(form) {
  const files = form._files ?? [];
  form.querySelector("[data-note-files]").innerHTML = files.length
    ? files.map((f) => `<span class="px-2 py-1 bg-gray-100 rounded-full"><i class="fas fa-paperclip mr-1"></i>${esc(f.name)} (${esc(sizeText(f.size))})</span>`).join("") +
      '<button type="button" data-action="att-note-clear" class="text-rose-600 hover:underline">Buang lampiran</button>'
    : "";
}

/** Kirim catatan chatter, dengan lampiran bila ada (diunggah dahulu sebagai lampiran sementara, lalu message_post attachment_ids). */
export async function postNoteWithFiles(form, submitButton) {
  const { model } = form.dataset;
  const id = Number(form.dataset.id);
  const field = form.elements.note;
  const files = form._files ?? [];
  const body = field.value.trim();
  if (!body && !files.length) {
    toast("Tulis catatan atau pilih berkas.", "error");
    return;
  }
  for (const f of files) {
    const problem = checkFile(f);
    if (problem) {
      toast(problem, "error");
      return;
    }
  }
  const ok = await guarded(submitButton, async () => {
    const ids = [];
    try {
      for (const f of files) {
        const [created] = await call("ir.attachment", "create", {
          vals_list: [{ name: f.name, datas: await readFile(f), res_model: "mail.compose.message", res_id: 0, mimetype: f.type || false, type: "binary" }],
        });
        ids.push(created);
      }
      return await call(model, "message_post", {
        ids: [id], body: body || (files.length ? `Lampiran: ${files.map((f) => f.name).join(", ")}` : ""), message_type: "comment", subtype_xmlid: "mail.mt_note", attachment_ids: ids,
      });
    } catch (error) {
      if (ids.length) await call("ir.attachment", "unlink", { ids }).catch(() => {});
      throw new Error(friendlyError(error));
    }
  });
  if (ok !== undefined) {
    field.value = "";
    form._files = [];
    renderNoteFiles(form);
    loadMessages(model, id);
    if (files.length) loadAttachmentList(model, id);
  }
}

/* Seret-lepas ke bagian Lampiran */
document.addEventListener("dragover", (event) => {
  const box = event.target.closest?.("[data-att-drop]");
  if (!box || !event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  box.classList.add("ring-2", "ring-indigo-400");
});
document.addEventListener("dragleave", (event) => {
  event.target.closest?.("[data-att-drop]")?.classList.remove("ring-2", "ring-indigo-400");
});
document.addEventListener("drop", (event) => {
  const box = event.target.closest?.("[data-att-drop]");
  if (!box) return;
  event.preventDefault();
  box.classList.remove("ring-2", "ring-indigo-400");
  if (event.dataTransfer?.files?.length) uploadMany(box, [...event.dataTransfer.files]);
});
