// Aktivitas terjadwal (mail.activity) pada setiap formulir dokumen dan master: tombol "Jadwalkan", daftar aktivitas dengan tenggat berwarna,
// tandai selesai, dan hapus. Bagiannya ikut chatterHtml (common.js), jadi tampil di semua halaman yang punya "Catatan dan riwayat";
// halaman memanggil loadMessages seperti biasa dan bagian ini terisi sendiri. Model yang belum mendukung aktivitas (tanpa
// mail.activity.mixin) tidak menampilkan bagian ini. Aksi tombol ditangani di main.js lewat handleActivityAction.
import {
  INPUT, call, closeModal, ctx, dateText, esc, fieldBlock, guarded, loadMessages, openModal, plain, referenceUsers, searchRead, selectOptions, setActivityHook, toast, today,
} from "./common.js";

const STATE = {
  overdue: ["Terlambat", "text-rose-700 bg-rose-50"],
  today: ["Hari ini", "text-amber-700 bg-amber-50"],
  planned: ["Terjadwal", "text-sky-700 bg-sky-50"],
};

const supported = new Map(); // model -> id ir.model bila mendukung aktivitas, null bila tidak
async function activityModelId(model) {
  if (!supported.has(model)) {
    const [row] = await searchRead("ir.model", [["model", "=", model], ["is_mail_activity", "=", true]], ["id"], { limit: 1 });
    supported.set(model, row?.id ?? null);
  }
  return supported.get(model);
}

function rowHtml(model, id, a) {
  const [label, tone] = STATE[a.state] ?? STATE.planned;
  const note = plain(a.note);
  return `<tr class="align-top">
    <td class="py-3 px-4 text-sm"><span class="font-medium text-gray-900">${esc(a.activity_type_id?.[1] ?? "Aktivitas")}</span>${a.summary ? `<div class="text-gray-700">${esc(a.summary)}</div>` : ""}${note ? `<div class="text-xs text-gray-500 mt-0.5">${esc(note)}</div>` : ""}</td>
    <td class="py-3 px-4 text-sm whitespace-nowrap"><span class="px-2 py-0.5 rounded-full text-xs ${tone}">${label}</span><div class="text-xs text-gray-500 mt-1">${esc(dateText(a.date_deadline))}</div></td>
    <td class="py-3 px-4 text-sm text-gray-700">${esc(a.user_id?.[1] ?? "")}</td>
    <td class="py-3 px-4 text-right whitespace-nowrap">
      <button type="button" data-action="act-done" data-id="${a.id}" data-model="${esc(model)}" data-res="${id}" class="px-3 py-1 bg-white border border-gray-300 rounded-lg text-sm hover:bg-gray-50"><i class="fas fa-check mr-1 text-emerald-600"></i>Selesai</button>
      <button type="button" data-action="act-cancel" data-id="${a.id}" data-model="${esc(model)}" data-res="${id}" class="ml-1 px-2 py-1 text-gray-400 hover:text-rose-600" aria-label="Hapus aktivitas" title="Hapus aktivitas"><i class="fas fa-trash-alt"></i></button></td></tr>`;
}

/** Isi bagian aktivitas pada halaman (dipanggil dari loadMessages); bagian dibuang bila model tidak mendukung aktivitas. */
export async function loadActivities(model, id) {
  const section = () => document.querySelector(`#section-activities[data-model="${model}"][data-id="${id}"]`);
  if (!section()) return;
  try {
    if (!(await activityModelId(model))) {
      section()?.remove();
      return;
    }
    const rows = await searchRead("mail.activity", [["res_model", "=", model], ["res_id", "=", id]], ["activity_type_id", "summary", "note", "date_deadline", "user_id", "state"], { order: "date_deadline, id" });
    const box = section();
    if (!box) return;
    box.classList.remove("hidden");
    box.querySelector("[data-activity-count]").textContent = rows.length ? `(${rows.length})` : "";
    box.querySelector("[data-activity-list]").innerHTML = rows.length
      ? `<table class="w-full text-left"><tbody class="divide-y divide-gray-100">${rows.map((a) => rowHtml(model, id, a)).join("")}</tbody></table>`
      : '<div class="py-6 text-center text-sm text-gray-500">Belum ada aktivitas terjadwal.</div>';
  } catch {
    section()?.remove(); // pengguna tanpa akses ke aktivitas: bagian ini tidak ditampilkan
  }
}
setActivityHook(loadActivities);

async function scheduleDialog(model, id) {
  const [types, users] = await Promise.all([
    searchRead("mail.activity.type", ["|", ["res_model", "=", false], ["res_model", "=", model]], ["name"], { order: "sequence, id" }),
    referenceUsers(),
  ]);
  openModal(
    "Jadwalkan Aktivitas",
    `<form data-form="activity" class="space-y-3">
       ${fieldBlock("Jenis", `<select data-act="type" class="${INPUT}">${types.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select>`)}
       ${fieldBlock("Ringkasan", `<input data-act="summary" class="${INPUT}" placeholder="mis. Telepon untuk penawaran">`)}
       ${fieldBlock("Tenggat", `<input type="date" data-act="date" value="${esc(today())}" class="${INPUT}">`)}
       ${fieldBlock("Ditugaskan ke", `<select data-act="user" class="${INPUT}">${selectOptions(users, ctx.user.id)}</select>`)}
       ${fieldBlock("Catatan", `<textarea data-act="note" rows="2" class="${INPUT}" placeholder="Opsional"></textarea>`)}</form>`,
    `<button data-action="modal-close" class="px-4 py-2 rounded-lg text-sm font-medium bg-white text-gray-700 border border-gray-300 hover:bg-gray-50">Batal</button>
     <button data-action="act-save" data-model="${esc(model)}" data-id="${id}" class="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700">Jadwalkan</button>`,
  );
}

async function refresh(model, id) {
  await loadActivities(model, id);
  loadMessages(model, id); // menyelesaikan aktivitas mencatat pesan di riwayat
}

/** Aksi tombol aktivitas; mengembalikan true bila aksinya milik modul ini. */
export async function handleActivityAction(action, el) {
  const model = el.dataset.model;
  if (action === "act-schedule") {
    await scheduleDialog(model, Number(el.dataset.id));
  } else if (action === "act-save") {
    const id = Number(el.dataset.id);
    const ok = await guarded(el, async () => {
      const date = document.querySelector('[data-act="date"]').value;
      if (!date) throw new Error("Isi tenggat aktivitas.");
      const modelId = await activityModelId(model);
      if (!modelId) throw new Error("Formulir ini belum mendukung aktivitas terjadwal.");
      const note = document.querySelector('[data-act="note"]').value.trim();
      await call("mail.activity", "create", {
        vals_list: [{
          res_model_id: modelId, res_id: id, activity_type_id: Number(document.querySelector('[data-act="type"]').value),
          summary: document.querySelector('[data-act="summary"]').value.trim() || false, date_deadline: date,
          user_id: Number(document.querySelector('[data-act="user"]').value), note: note ? `<p>${esc(note)}</p>` : false,
        }],
      });
      return true;
    });
    if (ok) {
      closeModal();
      toast("Aktivitas dijadwalkan.");
      await refresh(model, id);
    }
  } else if (action === "act-done" || action === "act-cancel") {
    if (action === "act-cancel" && !window.confirm("Hapus aktivitas ini?")) return true;
    const ok = await guarded(el, () =>
      action === "act-done" ? call("mail.activity", "action_feedback", { ids: [Number(el.dataset.id)], feedback: "" }) : call("mail.activity", "unlink", { ids: [Number(el.dataset.id)] }),
    );
    if (ok !== undefined) {
      toast(action === "act-done" ? "Aktivitas selesai." : "Aktivitas dihapus.");
      await refresh(model, Number(el.dataset.res));
    }
  } else return false;
  return true;
}
