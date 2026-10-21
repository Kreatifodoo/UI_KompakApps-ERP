import babel.dates

from odoo import Command, _, api, fields, models
from odoo.exceptions import AccessError, UserError

# Struktur gaji umum yang netral (D85, Q57): tanpa angka hukum apa pun. Gaji Pokok diambil dari gaji versi kontrak,
# Tunjangan dan Potongan dari input slip (diisi petugas), Gaji Bersih adalah jumlahnya. Aturan BPJS, PPh 21, lembur,
# dan THR TIDAK ada di sini: menunggu jawaban pemilik, lalu ditambahkan sebagai data aturan.
PAYROLL_STANDARD_CODE = "GAJI-STD"
PAYROLL_STANDARD_CATEGORIES = [
    ("BASIC", "Gaji Pokok"),
    ("ALW", "Tunjangan"),
    ("DED", "Potongan"),
    ("NET", "Gaji Bersih"),
]
PAYROLL_STANDARD_RULES = [
    {
        "key": "basic", "code": "GAPOK", "name": "Gaji Pokok", "sequence": 10, "category": "BASIC",
        "amount_select": "percentage", "amount_percentage": 100.0, "amount_percentage_base": "contract.wage",
        "note": "Gaji pokok dari versi kontrak karyawan (kolom Gaji).",
    },
    {
        "key": "allowance", "code": "TUNJ", "name": "Tunjangan", "sequence": 20, "category": "ALW",
        "amount_select": "code", "amount_python_compute": "result = inputs.TUNJ.amount if inputs.TUNJ else 0.0",
        "inputs": [("TUNJ", "Tunjangan")], "note": "Jumlah tunjangan diisi di input slip.",
    },
    {
        "key": "deduction", "code": "POT", "name": "Potongan", "sequence": 30, "category": "DED",
        "amount_select": "code", "amount_python_compute": "result = -(inputs.POT.amount if inputs.POT else 0.0)",
        "inputs": [("POT", "Potongan")], "note": "Jumlah potongan diisi positif di input slip; pada slip menjadi pengurang.",
    },
    {
        "key": "net", "code": "NET", "name": "Gaji Bersih", "sequence": 100, "category": "NET",
        "amount_select": "code", "amount_python_compute": "result = categories.BASIC + categories.ALW + categories.DED",
        "note": "Gaji pokok + tunjangan + potongan (potongan bernilai negatif).",
    },
]


class ResCompany(models.Model):
    _inherit = "res.company"

    def _kompakapps_payroll_record(self, model, key, values):
        """Ambil catatan setup payroll bertanda xml id (per perusahaan) atau buat bila belum ada atau sudah dihapus."""
        self.ensure_one()
        name = f"payroll_std_{key}_{self.id}"
        imd = self.env["ir.model.data"].sudo().search([("module", "=", "kompakapps_base"), ("name", "=", name)], limit=1)
        record = self.env[model].browse(imd.res_id).exists() if imd else self.env[model]
        if record:
            return record, False
        record = self.env[model].create(values)
        if imd:
            imd.write({"model": model, "res_id": record.id})
        else:
            self.env["ir.model.data"].sudo().create({"module": "kompakapps_base", "name": name, "model": model, "res_id": record.id, "noupdate": True})
        return record, True

    def kompakapps_setup_payroll(self):
        """Pasang struktur gaji umum "Gaji Standar" (D85, Q57): kategori, empat aturan, dan strukturnya untuk satu perusahaan.

        Netral: tanpa angka hukum (BPJS, PPh 21, lembur, THR menunggu jawaban pemilik). Hanya untuk Manager payroll karena aturan memuat ekspresi
        Python. Aman dijalankan ulang: yang sudah ada tidak ditimpa atau digandakan, yang dihapus pengguna dibuat lagi. Mengembalikan
        {"structure_id": ..., "created": ...}.
        """
        self.ensure_one()
        if not self.env.user.has_group("payroll.group_payroll_manager"):
            raise AccessError(_("Hanya Manager payroll yang boleh memasang struktur gaji."))
        categories = {}
        created = False
        for code, name in PAYROLL_STANDARD_CATEGORIES:
            categories[code], made = self._kompakapps_payroll_record(
                "hr.salary.rule.category", f"cat_{code.lower()}", {"name": name, "code": code, "company_id": self.id}
            )
            created = created or made
        rules = self.env["hr.salary.rule"]
        new_rules = self.env["hr.salary.rule"]
        for spec in PAYROLL_STANDARD_RULES:
            values = {
                key: spec[key]
                for key in ("code", "name", "sequence", "amount_select", "amount_percentage", "amount_percentage_base", "amount_python_compute", "note")
                if key in spec
            }
            values.update(
                {"category_id": categories[spec["category"]].id, "company_id": self.id}
            )
            if spec.get("inputs"):
                values["input_ids"] = [Command.create({"code": code, "name": name}) for code, name in spec["inputs"]]
            rule, made = self._kompakapps_payroll_record("hr.salary.rule", f"rule_{spec['key']}", values)
            rules |= rule
            if made:
                new_rules |= rule
            created = created or made
        structure, made = self._kompakapps_payroll_record(
            "hr.payroll.structure",
            "structure",
            {
                "name": "Gaji Standar",
                "code": PAYROLL_STANDARD_CODE,
                "company_id": self.id,
                "rule_ids": [Command.set(rules.ids)],
                "note": "Struktur umum netral: gaji pokok dari kontrak, tunjangan dan potongan dari input slip. Tanpa BPJS, PPh 21, lembur, atau THR.",
            },
        )
        created = created or made
        if not made and new_rules:  # struktur lama tetap; hanya aturan yang baru dibuat kembali yang ditautkan
            structure.rule_ids = [Command.link(rule.id) for rule in new_rules]
        return {"structure_id": structure.id, "created": created}


class HrPayslip(models.Model):
    _inherit = "hr.payslip"

    @api.model
    def kompakapps_prepare_values(self, employee_id, date_from, date_to, struct_id=False, contract_id=False):
        """Nilai awal satu slip: versi kontrak, struktur, nama, hari kerja, dan isian input dari aturan struktur.

        Menggantikan onchange form Odoo yang tidak berjalan lewat API. Panggilan `get_payslip_vals` OCA pada model kosong tidak menghasilkan
        isian input (aturan diambil dari slip yang sudah ada), jadi isian input dibangun di sini dari aturan struktur beserta induknya.
        """
        date_from, date_to = fields.Date.to_date(date_from), fields.Date.to_date(date_to)
        employee = self.env["hr.employee"].browse(employee_id).exists()
        if not employee:
            raise UserError(_("Karyawan tidak ditemukan."))
        if not date_from or not date_to or date_from > date_to:
            raise UserError(_("Periode slip tidak valid: tanggal mulai harus sebelum atau sama dengan tanggal akhir."))
        model = self.with_context(contract=True) if contract_id else self
        vals = model.get_payslip_vals(date_from, date_to, employee.id, contract_id=contract_id or False, struct_id=(struct_id,) if struct_id else False)["value"]
        structure = self.env["hr.payroll.structure"].browse(vals.get("struct_id") or False)
        rules = structure.get_structure_with_parents().get_all_rules()
        month = babel.dates.format_date(date_from, format="MMMM y", locale="id")
        return {
            "employee_id": employee.id,
            "date_from": date_from,
            "date_to": date_to,
            "name": _("Slip Gaji %(employee)s %(period)s", employee=employee.name, period=month),
            "contract_id": vals.get("contract_id") or False,
            "struct_id": structure.id or False,
            "worked_days_line_ids": [dict(line) for line in vals.get("worked_days_line_ids", [])],
            "input_line_ids": [{"name": rule_input.name, "code": rule_input.code, "contract_id": vals.get("contract_id")} for rule_input in rules.input_ids]
            if vals.get("contract_id")
            else [],
        }

    @api.model
    def kompakapps_create_payslip(self, employee_id, date_from, date_to, struct_id=False, contract_id=False, run_id=False):
        """Buat satu slip draf untuk karyawan dan periode. Ditolak bila tidak ada kontrak berjalan, kontrak belum bersruktur gaji, atau slip yang
        sama (karyawan, periode) sudah ada dan belum dibatalkan. Mengembalikan id slip."""
        values = self.kompakapps_prepare_values(employee_id, date_from, date_to, struct_id=struct_id, contract_id=contract_id)
        employee = self.env["hr.employee"].browse(employee_id)
        if not values["contract_id"]:
            raise UserError(_("%(employee)s tidak punya kontrak yang berjalan pada periode ini.", employee=employee.name))
        if not values["struct_id"]:
            raise UserError(_("Kontrak %(employee)s belum memiliki Struktur Gaji. Pilih struktur di halaman Contracts.", employee=employee.name))
        duplicate = self.search(
            [("employee_id", "=", employee.id), ("date_from", "<=", values["date_to"]), ("date_to", ">=", values["date_from"]), ("state", "!=", "cancel"), ("credit_note", "=", False)],
            limit=1,
        )
        if duplicate:
            raise UserError(
                _("%(employee)s sudah punya slip pada periode yang beririsan (%(number)s). Batalkan atau hapus slip itu lebih dulu.", employee=employee.name, number=duplicate.number or duplicate.name)
            )
        values["worked_days_line_ids"] = [Command.create(line) for line in values["worked_days_line_ids"]]
        values["input_line_ids"] = [Command.create(line) for line in values["input_line_ids"]]
        values["company_id"] = employee.company_id.id or self.env.company.id
        if run_id:
            values["payslip_run_id"] = run_id
        return self.create(values).id
