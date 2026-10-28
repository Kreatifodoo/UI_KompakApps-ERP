"""Pengguna uji Cakupan data (Q9, D87) dengan API key sementara, untuk scripts/check_p2p_api.py dan uji browser.

HANYA untuk stack uji sendiri, bukan database pemilik. Dijalankan lewat `odoo shell` (seperti scripts/seed_demo.py):

    odoo shell -d <db> --no-http < scripts/access_test_users.py                        # membuat; mencetak baris "KEY|<NAMA>|<api key>"
    ACCESS_USERS=delete odoo shell -d <db> --no-http < scripts/access_test_users.py    # menghapus pengguna dan keynya

Simpan keluaran KEY ke berkas berizin 600 (jangan dicetak ke obrolan), lalu ekspor sebagai KOMPAKAPPS_KEY_<NAMA> untuk check_p2p_api.py.
Peran: SALES_A dan SALES_B = Salesperson "hanya dokumen sendiri", SALES_ALL = Salesperson "semua dokumen".
PURCHASE_A dan PURCHASE_B = Purchase "hanya dokumen sendiri", PURCHASE_ALL = Purchase tanpa pembatasan (semua dokumen).
STOCK_A dan STOCK_B = Inventory Pengguna yang dibatasi ke gudang utama (A) atau gudang uji kedua "UJB" (B), STOCK_ALL = tanpa gudang terpilih (semua gudang),
STOCK_MGR_A = Manajer Inventory (kepala gudang) yang dibatasi ke gudang A (hanya Manajer yang boleh membaca nilai stok).
HR_A dan HR_B = pengguna internal tanpa peran HR (masing-masing punya karyawan: hanya data sendiri), HR_OFFICER = Petugas Attendance, HR_ALL = Petugas Time Off, Administrator Attendance, dan Petugas Expenses (melihat semua).
Gudang kedua dibuat otomatis bila belum ada (dibiarkan saat mode delete; stack uji sekali pakai).
"""

import os
from datetime import datetime, timedelta

DOMAIN = "example.test"
# nama -> (login, grup di luar pengguna internal)
USERS = {
    "SALES_A": ("akses.sales.a", ["sales_team.group_sale_salesman"]),
    "SALES_B": ("akses.sales.b", ["sales_team.group_sale_salesman"]),
    "SALES_ALL": ("akses.sales.all", ["sales_team.group_sale_salesman_all_leads"]),
    # pembeli yang juga menerima barang butuh peran Inventory (bawaan Odoo)
    "PURCHASE_A": ("akses.purchase.a", ["purchase.group_purchase_user", "stock.group_stock_user", "kompakapps_base.group_purchase_own"]),
    "PURCHASE_B": ("akses.purchase.b", ["purchase.group_purchase_user", "stock.group_stock_user", "kompakapps_base.group_purchase_own"]),
    "PURCHASE_ALL": ("akses.purchase.all", ["purchase.group_purchase_user", "stock.group_stock_user"]),
    "STOCK_A": ("akses.stock.a", ["stock.group_stock_user"]),
    "STOCK_B": ("akses.stock.b", ["stock.group_stock_user"]),
    "STOCK_ALL": ("akses.stock.all", ["stock.group_stock_user"]),
    "STOCK_MGR_A": ("akses.stock.mgr.a", ["stock.group_stock_manager"]),
    "HR_A": ("akses.hr.a", []),
    "HR_B": ("akses.hr.b", []),
    "HR_OFFICER": ("akses.hr.officer", ["hr_attendance.group_hr_attendance_officer"]),  # Petugas Attendance: hanya karyawan yang ia kelola
    "HR_ALL": ("akses.hr.all", ["hr_holidays.group_hr_holidays_user", "hr_attendance.group_hr_attendance_manager", "hr_expense.group_hr_expense_user"]),
}
# nama -> kode gudang yang diizinkan (kosong = semua): "A" gudang utama perusahaan, "B" gudang uji kedua
WAREHOUSES = {"STOCK_A": ["A"], "STOCK_B": ["B"], "STOCK_MGR_A": ["A"]}
WAREHOUSE_B_CODE = "UJB"


def run(env):
    mode = os.environ.get("ACCESS_USERS", "create")
    Users = env["res.users"].with_context(active_test=False, tracking_disable=True)
    logins = {name: f"{login}@{DOMAIN}" for name, (login, _groups) in USERS.items()}
    if mode == "delete":
        for login in logins.values():
            user = Users.search([("login", "=", login)])
            if not user:
                continue
            env["res.users.apikeys"].sudo().search([("user_id", "in", user.ids)]).unlink()
            try:
                with env.cr.savepoint():
                    user.unlink()
            except Exception:  # dokumen yang dibuat pengguna ini masih merujuknya: cukup diarsipkan
                user.write({"active": False})
        env.cr.commit()
        print("ACCESS_USERS_DELETED")
        return
    base = env.ref("base.group_user")
    company = env.ref("base.main_company")
    Warehouse = env["stock.warehouse"]
    warehouse_a = Warehouse.search([("company_id", "=", company.id)], order="id", limit=1)
    warehouse_b = Warehouse.search([("code", "=", WAREHOUSE_B_CODE), ("company_id", "=", company.id)], limit=1) or Warehouse.create(
        {"name": "Gudang Uji Akses B", "code": WAREHOUSE_B_CODE, "company_id": company.id}
    )
    by_code = {"A": warehouse_a, "B": warehouse_b}
    for name, (_login, xmlids) in USERS.items():
        login = logins[name]
        groups = base.concat(*[env.ref(xmlid) for xmlid in xmlids])
        vals = {"name": f"Uji Akses {name}", "login": login, "email": login, "group_ids": [(6, 0, groups.ids)], "active": True}
        if name in WAREHOUSES:
            vals["kompakapps_warehouse_ids"] = [(6, 0, Warehouse.concat(*[by_code[code] for code in WAREHOUSES[name]]).ids)]
        user = Users.search([("login", "=", login)])
        if user:
            user.write(vals)
        else:
            user = Users.create(vals)
        if name.startswith("HR_") and not env["hr.employee"].search([("user_id", "=", user.id)]):
            env["hr.employee"].create({"name": f"Karyawan Uji Akses {name}", "user_id": user.id, "company_id": company.id})
        key = env["res.users.apikeys"].with_user(user)._generate("rpc", "tmp-q9", datetime.now() + timedelta(days=1))
        print(f"KEY|{name}|{key}")
    env.cr.commit()
    print("ACCESS_USERS_OK")


run(env)  # noqa: F821
