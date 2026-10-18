from odoo import api, models

from .mis_templates import INSTANCES, REPORTS

STYLES = {
    "header": {"name": "KompakApps - Judul bagian", "font_weight": "bold", "background_color": "#f3f4f6", "color": "#374151"},
    "sub": {"name": "KompakApps - Subtotal", "font_weight": "bold"},
    "total": {"name": "KompakApps - Total", "font_weight": "bold", "background_color": "#e0e7ff", "color": "#1e1b4b"},
    "check": {"name": "KompakApps - Pemeriksaan", "font_style": "italic", "color": "#b45309"},
}


class KompakAppsMisLoader(models.AbstractModel):
    """Memuat (membuat atau memperbarui) template laporan MIS KompakApps dari mis_templates.py.

    Dipanggil dari data/mis_reports.xml setiap modul dipasang atau diperbarui. Laporan yang sudah ada
    ditimpa menurut definisi di kode; salin laporan lebih dulu bila ingin mengubahnya sendiri.
    """

    _name = "kompakapps.mis.loader"
    _description = "Pemuat template laporan MIS KompakApps"

    def _upsert(self, model, key, vals):
        xmlid = f"kompakapps_base.{key}"
        record = self.env.ref(xmlid, raise_if_not_found=False)
        if record:
            record.write(vals)
            return record
        record = self.env[model].create(vals)
        self.env["ir.model.data"].create(
            # noupdate: tanpa ini Odoo menghapus xmlid yang tidak ada di berkas data saat akhir pembaruan modul.
            {"module": "kompakapps_base", "name": key, "model": model, "res_id": record.id, "noupdate": True}
        )
        return record

    def _load_styles(self):
        styles = {}
        for key, spec in STYLES.items():
            vals = {"name": spec["name"]}
            for prop, value in spec.items():
                if prop != "name":
                    vals[prop] = value
                    vals[f"{prop}_inherit"] = False
            styles[key] = self._upsert("mis.report.style", f"mis_style_{key}", vals)
        return styles

    def _load_report(self, spec, styles):
        report = self._upsert(
            "mis.report",
            spec["key"],
            {
                "name": spec["name"],
                "description": spec["description"],
                "move_lines_source": self.env.ref("account.model_account_move_line").id,
            },
        )
        report.kpi_ids.unlink()
        report.subkpi_ids.unlink()
        kpi_model = self.env["mis.report.kpi"]
        if "columns" in spec:
            subkpis = {
                name: self.env["mis.report.subkpi"].create(
                    {"report_id": report.id, "name": name, "description": label, "sequence": index}
                )
                for index, (name, label, _expression) in enumerate(spec["columns"], start=1)
            }
            kpi_model.create(
                {
                    "report_id": report.id,
                    "name": "neraca_saldo",
                    "description": spec["expand"],
                    "multi": True,
                    "auto_expand_accounts": True,
                    "sequence": 1,
                    "expression_ids": [
                        (0, 0, {"name": expression, "subkpi_id": subkpis[name].id})
                        for name, _label, expression in spec["columns"]
                    ],
                }
            )
            return report
        for sequence, row in enumerate(spec["kpis"], start=1):
            name, label, expression, style = row[:4]
            kpi_type = row[4] if len(row) > 4 else "num"
            options = row[5] if len(row) > 5 else {}
            kpi_model.create(
                {
                    "report_id": report.id,
                    "name": name,
                    "description": label,
                    "expression": expression,
                    "type": "num" if kpi_type == "num" else kpi_type,
                    "style_id": styles[style].id if style else False,
                    "sequence": sequence,
                    # "expand": baris diperluas per akun (satu baris rincian per akun yang punya nilai).
                    "auto_expand_accounts": bool(options.get("expand")),
                }
            )
        return report

    def _load_instance(self, spec, reports):
        instance = self._upsert(
            "mis.report.instance",
            spec["key"],
            {"name": spec["name"], "report_id": reports[spec["report"]].id, "company_id": self.env.company.id, "target_move": "posted"},
        )
        instance.period_ids.unlink()
        for sequence, (label, offset) in enumerate(spec["periods"], start=1):
            self.env["mis.report.instance.period"].create(
                {
                    "report_instance_id": instance.id,
                    "name": label,
                    "sequence": sequence,
                    "mode": "relative",
                    "type": "y",
                    "offset": offset,
                    "duration": 1,
                }
            )

    @api.model
    def load_templates(self):
        # Saat modul dipasang fungsi ini berjalan sebagai superuser; sudo menjaga hasil yang sama bila dipanggil pengguna lain.
        loader = self.sudo()
        styles = loader._load_styles()
        reports = {spec["key"]: loader._load_report(spec, styles) for spec in REPORTS}
        for spec in INSTANCES:
            loader._load_instance(spec, reports)
        return True
