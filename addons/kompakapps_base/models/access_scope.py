from odoo import api, models

# Kondisi "dibatasi": pemegang grup penanda "hanya dokumen sendiri" yang bukan manajer Purchase atau administrator.
_LIMITED = (
    "(not user.has_group('kompakapps_base.group_purchase_own')) or user.has_group('purchase.group_purchase_manager') "
    "or user.has_group('base.group_system')"
)

# Domain tagihan vendor (D87, Q9 irisan 2): domain bawaan Odoo ditambah pembatasan hanya bagi pemegang grup penanda.
_BILL_RULES = {
    "purchase.purchase_user_account_move_rule": (
        "[('move_type', 'in', ('in_invoice', 'in_refund', 'in_receipt'))] + ([] if " + _LIMITED + " else "
        "['|', ('invoice_line_ids.purchase_line_id.order_id.user_id', '=', user.id), ('create_uid', '=', user.id)])"
    ),
    "purchase.purchase_user_account_move_line_rule": (
        "[('move_id.move_type', 'in', ('in_invoice', 'in_refund', 'in_receipt'))] + ([] if " + _LIMITED + " else "
        "['|', ('move_id.invoice_line_ids.purchase_line_id.order_id.user_id', '=', user.id), ('move_id.create_uid', '=', user.id)])"
    ),
}


class IrRule(models.Model):
    _inherit = "ir.rule"

    @api.model
    def kompakapps_apply_purchase_scope(self):
        """Memperketat aturan tagihan vendor bawaan Purchase hanya untuk pemegang grup `group_purchase_own`; idempoten, dipanggil dari security/access_scope.xml."""
        for xmlid, domain in _BILL_RULES.items():
            rule = self.env.ref(xmlid, raise_if_not_found=False)
            if rule and rule.domain_force != domain:
                rule.sudo().write({"domain_force": domain})
        return True
