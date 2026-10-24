"""Pengguna uji Cakupan data (Q9, D87) dengan API key sementara, untuk scripts/check_p2p_api.py dan uji browser.

HANYA untuk stack uji sendiri, bukan database pemilik. Dijalankan lewat `odoo shell` (seperti scripts/seed_demo.py):

    odoo shell -d <db> --no-http < scripts/access_test_users.py                        # membuat; mencetak baris "KEY|<NAMA>|<api key>"
    ACCESS_USERS=delete odoo shell -d <db> --no-http < scripts/access_test_users.py    # menghapus pengguna dan keynya

Simpan keluaran KEY ke berkas berizin 600 (jangan dicetak ke obrolan), lalu ekspor sebagai KOMPAKAPPS_KEY_<NAMA> untuk check_p2p_api.py.
Peran: SALES_A dan SALES_B = Salesperson "hanya dokumen sendiri", SALES_ALL = Salesperson "semua dokumen".
PURCHASE_A dan PURCHASE_B = Purchase "hanya dokumen sendiri", PURCHASE_ALL = Purchase tanpa pembatasan (semua dokumen).
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
}


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
    for name, (_login, xmlids) in USERS.items():
        login = logins[name]
        groups = base.concat(*[env.ref(xmlid) for xmlid in xmlids])
        vals = {"name": f"Uji Akses {name}", "login": login, "email": login, "group_ids": [(6, 0, groups.ids)], "active": True}
        user = Users.search([("login", "=", login)])
        if user:
            user.write(vals)
        else:
            user = Users.create(vals)
        key = env["res.users.apikeys"].with_user(user)._generate("rpc", "tmp-q9", datetime.now() + timedelta(days=1))
        print(f"KEY|{name}|{key}")
    env.cr.commit()
    print("ACCESS_USERS_OK")


run(env)  # noqa: F821
