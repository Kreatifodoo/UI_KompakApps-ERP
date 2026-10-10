{
    "name": "Nusara Base",
    "summary": "Fondasi Nusara ERP: dependensi modul inti, OCA, dan lokalisasi Indonesia",
    "version": "19.0.1.0.0",
    "category": "Uncategorized",
    "author": "Nusara",
    "license": "LGPL-3",
    "depends": [
        "account",
        "l10n_id",
        "purchase",
        "sale_management",
        "stock",
        # OCA (purchase-workflow)
        "purchase_request",
        # OCA akuntansi: Community tidak membawa laporan keuangan, aset, atau rekonsiliasi bank.
        # Dipilih menurut unduhan PyPI bulanan dan status pemeliharaan (lihat docs/DECISIONS.md, D12).
        "mis_builder",  # laporan P&L, neraca, arus kas dari template KPI
        "account_financial_report",  # buku besar, neraca saldo, umur hutang/piutang, laporan PPN
        "account_reconcile_oca",  # rekonsiliasi bank
        "account_asset_management",  # aset tetap dan penyusutan
        "account_usability",  # menu akuntansi yang disembunyikan di Community
    ],
    "data": ["data/mis_reports.xml"],
    "installable": True,
    "application": False,
}
