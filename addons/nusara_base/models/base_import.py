import base64
import binascii

from odoo import _, api, models
from odoo.exceptions import UserError


class BaseImport(models.TransientModel):
    _inherit = "base_import.import"

    @api.model
    def nusara_create_from_file(self, res_model, file_name, file_type, data):
        """Buat sesi impor dari berkas biner (xlsx, xls, ods) yang dikirim sebagai teks base64.

        Kolom `file` menyimpan teks yang dikirim lewat `create` apa adanya (UTF-8), sedangkan JSON-2 tidak bisa
        membawa byte mentah. Berkas biner yang dikirim lewat `create` dibaca sebagai teks dan gagal dibuka oleh
        pembaca xlsx, begitu juga base64 yang tidak didekode. Metode ini mendekode base64 lebih dulu sehingga
        `parse_preview` dan `execute_import` bawaan Odoo membaca berkasnya seperti impor di klien web.

        Mengembalikan `{"id": id sesi impor, "sheets": [nama lembar]}`. Daftar lembar dibaca di sini karena
        `parse_preview` tidak mengembalikannya bila lembar pertama kosong atau galat, padahal pengguna perlu memilih
        lembar lain.
        """
        try:
            content = base64.b64decode(data or "", validate=True)
        except (binascii.Error, TypeError, ValueError) as exc:
            raise UserError(_("Isi berkas tidak valid: harus berupa teks base64.")) from exc
        if not content:
            raise UserError(_("Berkas kosong."))
        record = self.create({"res_model": res_model, "file": content, "file_type": file_type, "file_name": file_name})
        options = {}
        try:
            record._read_file(options)
        except Exception:  # noqa: BLE001 - galat baca dilaporkan oleh parse_preview; di sini hanya daftar lembar yang dicari
            pass
        return {"id": record.id, "sheets": options.get("sheets", [])}
