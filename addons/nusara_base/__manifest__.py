{
    "name": "Nusara Base",
    "summary": "Fondasi KompakApps: dependensi modul inti, OCA, dan lokalisasi Indonesia",
    "version": "19.0.1.0.0",
    "category": "Uncategorized",
    "author": "Nusara",
    "license": "LGPL-3",
    "depends": [
        "base_import",  # mesin impor data (CSV, xlsx) yang dipakai halaman Import Data (D33, D36)
        "account",
        "l10n_id",
        "purchase",
        "sale_management",
        "stock",
        "product_expiry",  # tanggal kedaluwarsa pada lot dan penarikan FEFO
        "mrp",  # BoM, Manufacturing Order, work center, work order, unbuild
        "crm",  # lead, peluang, tahap pipeline (sale_crm terpasang otomatis bersama sale)
        "point_of_sale",  # kasir, sesi, pesanan POS, metode pembayaran
        "loyalty",  # program promosi, kupon, kartu loyalti, aturan dan hadiah
        "sale_loyalty",  # penerapan promosi dan hadiah pada Sales Order
        "pos_loyalty",  # penerapan promosi dan hadiah pada pesanan kasir POS
        # OCA (purchase-workflow)
        "purchase_request",
        # OCA akuntansi: Community tidak membawa laporan keuangan, aset, atau rekonsiliasi bank.
        # Dipilih menurut unduhan PyPI bulanan dan status pemeliharaan (lihat docs/DECISIONS.md, D12).
        "mis_builder",  # laporan P&L, neraca, arus kas dari template KPI
        "mis_builder_budget",  # anggaran per akun dan periode untuk laporan MIS (lihat D31)
        "account_financial_report",  # buku besar, neraca saldo, umur hutang/piutang, laporan PPN
        "account_reconcile_oca",  # rekonsiliasi bank
        "account_asset_management",  # aset tetap dan penyusutan
        "account_usability",  # menu akuntansi yang disembunyikan di Community
        # OCA (server-tools)
        "auditlog",  # jejak audit: siapa mengubah apa, kapan, nilai lama dan baru
    ],
    "data": ["data/mis_reports.xml"],
    "installable": True,
    "application": False,
}
