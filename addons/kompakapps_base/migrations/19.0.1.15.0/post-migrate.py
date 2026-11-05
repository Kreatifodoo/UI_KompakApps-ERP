"""Akun HPP penjualan pada pengaturan COGM yang sudah ada (Q68, D95): HPP penjualan periodik butuh akun HPP; bawaannya 51000010 Cost of Goods Sold."""

from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    for config in env["kompakapps.cogm.config"].search([("cogs_account_id", "=", False)]):
        account = env["account.account"].with_company(config.company_id).search([("code", "=", "51000010"), ("company_ids", "in", config.company_id.id)], limit=1)
        if account:
            config.cogs_account_id = account
