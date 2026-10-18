"""Aktifkan jurnal pada transaksi inventori (Q49, D69) untuk perusahaan yang sudah memakai valuasi perpetual.

Instalasi baru memperolehnya lewat `kompakapps_setup_indonesia`; database yang sudah ada mendapatkannya di sini saat modul di-upgrade. Transaksi lama
tidak dijurnal ulang, dan dokumen yang sudah ditagih atau difakturkan dengan pola lama dilewati oleh aturan modul, jadi tidak ada penghitungan ganda.
"""

from odoo import SUPERUSER_ID, api


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    env["res.company"].search([]).kompakapps_setup_stock_journals()
