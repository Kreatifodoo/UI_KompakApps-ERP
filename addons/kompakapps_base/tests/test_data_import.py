import base64
import datetime
import io

import openpyxl

from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@tagged("post_install", "-at_install", "kompakapps")
class TestImportXlsx(TransactionCase):
    """Impor Excel (D36): berkas biner masuk sebagai base64 lewat kompakapps_create_from_file dan dibaca mesin impor Odoo."""

    @staticmethod
    def _book():
        book = openpyxl.Workbook()
        book.active.title = "Catatan"
        book.active.append(["Lembar pertama hanya catatan"])
        data = book.create_sheet("Kontak")
        data.append(["name", "email", "date"])
        data.append(["Impor Xlsx PT A & B", "a@example.com", datetime.date(2026, 3, 5)])
        out = io.BytesIO()
        book.save(out)
        return out.getvalue()

    def _upload(self, content):
        return self.env["base_import.import"].kompakapps_create_from_file("res.partner", "uji.xlsx", XLSX, base64.b64encode(content).decode())

    def test_upload_returns_sheets_and_preview_reads_chosen_sheet(self):
        upload = self._upload(self._book())
        self.assertEqual(upload["sheets"], ["Catatan", "Kontak"])
        wizard = self.env["base_import.import"].browse(upload["id"])
        options = {"quoting": '"', "separator": ",", "has_headers": True, "date_format": "", "datetime_format": ""}
        self.assertIn("error", wizard.parse_preview(dict(options)), "lembar pertama hanya berisi satu baris")
        preview = wizard.parse_preview(dict(options, sheet="Kontak"))
        self.assertEqual(preview["headers"], ["name", "email", "date"])
        self.assertEqual(preview["num_rows"], 2)

    def test_execute_import_creates_records_from_xlsx(self):
        wizard = self.env["base_import.import"].browse(self._upload(self._book())["id"])
        options = {"quoting": '"', "separator": ",", "has_headers": True, "date_format": "", "datetime_format": "", "sheet": "Kontak"}
        preview = wizard.parse_preview(options)
        result = wizard.execute_import(["name", "email", False], preview["headers"], preview["options"], dryrun=False)
        self.assertFalse(result["messages"])
        partner = self.env["res.partner"].browse(result["ids"])
        self.assertEqual((partner.name, partner.email), ("Impor Xlsx PT A & B", "a@example.com"))

    def test_invalid_payloads_are_rejected(self):
        imports = self.env["base_import.import"]
        with self.assertRaises(UserError):
            imports.kompakapps_create_from_file("res.partner", "x.xlsx", XLSX, "bukan base64!!")
        with self.assertRaises(UserError):
            imports.kompakapps_create_from_file("res.partner", "x.xlsx", XLSX, "")
