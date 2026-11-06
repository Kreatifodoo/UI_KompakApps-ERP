# ruff: noqa: F821
"""Data CRM untuk perusahaan demo COGM (Q77): "PROLINE Manufaktur (Demo)" dan "PROLINE Periodik (Demo)".

Data CRM yang sudah ada hanya milik "PROLINE (Demo)", dan Odoo memisahkan data per perusahaan, jadi halaman Leads, Opportunity, dan laporan CRM kosong saat
perusahaan demo COGM terpilih. Skrip ini mengisi masing-masing perusahaan dengan pipeline yang selaras dengan pelanggan dan Sales Order yang sudah ada:

* 9 opportunity terbuka di tahap New, Qualified, dan Proposition (kit reagen, kontrak tahunan, tender, e-Katalog), dengan prioritas, tanggal tutup, tag, dan tim;
* 3 opportunity Won yang tertaut ke Sales Order terbesar pelanggan yang sama (pendapatan sama dengan nilai pesanan), sehingga pipeline dan penjualan nyambung;
* 3 lead dari situs web, dan aktivitas terjadwal (telepon, rapat, email, tugas) pada tiap opportunity terbuka, sebagian sudah lewat tenggat.

Tahap, tag, dan tim penjualan bersifat global di Odoo, jadi dipakai ulang. Aman dijalankan ulang: perusahaan yang sudah punya data CRM dilewati. Dijalankan lewat
`odoo shell` pada database yang sudah memasang kompakapps_base dan perusahaan demo COGM:

    docker compose run --rm -T odoo odoo shell -d kompakapps --no-http < scripts/seed_crm_perusahaan_demo.py
"""

import random
from datetime import date, timedelta

BASE_ENV = env
today = date.today()

# judul, tahap (1 New, 2 Qualified, 3 Proposition), pendapatan minimum dan maksimum (Rp), tag
OPEN = [
    ("Kontrak tahunan kit reagen kolesterol dan glukosa, {c}", 3, 180e6, 420e6, ()),
    ("Pengadaan kit reagen kreatinin dan asam urat, {c}", 3, 90e6, 210e6, ()),
    ("Paket kit reagen lewat e-Katalog, {c}", 3, 120e6, 300e6, ("e-Katalog", "TKDN")),
    ("Tender reagen kimia klinik semester pertama 2027, {c}", 2, 150e6, 380e6, ("Tender",)),
    ("Penawaran kit trigliserida untuk program skrining, {c}", 2, 40e6, 110e6, ()),
    ("Kebutuhan kit reagen untuk laboratorium baru, {c}", 2, 60e6, 160e6, ()),
    ("Permintaan sampel dan demo kit reagen, {c}", 1, 8e6, 30e6, ()),
    ("Pameran alat kesehatan: minat kit reagen jumlah besar, {c}", 1, 15e6, 60e6, ()),
    ("Rencana pengadaan reagen akhir tahun, {c}", 1, 25e6, 90e6, ("Tender",)),
]
ACTIVITIES = [
    ("mail.mail_activity_data_call", "Telepon bagian pengadaan untuk konfirmasi kebutuhan"),
    ("mail.mail_activity_data_meeting", "Jadwalkan rapat presentasi produk dan harga"),
    ("mail.mail_activity_data_email", "Kirim penawaran dan brosur kit reagen"),
    ("mail.mail_activity_data_todo", "Lengkapi dokumen dan sertifikat untuk pengadaan"),
]
LEADS = [
    ("Permintaan informasi kit kolesterol dari situs web", "Laboratorium Klinik Cendana", "Rina Wulandari", "rina@cendana.example"),
    ("Permintaan penawaran kit glukosa dari situs web", "Klinik Utama Harapan", "Maya Lestari", "maya@harapan.example"),
    ("Permintaan katalog reagen dari situs web", "Apotek dan Lab Mitra Sehat", "Budi Santoso", "budi@mitrasehat.example"),
]


def seed(name, offset):
    company = BASE_ENV["res.company"].search([("name", "=", name)])
    if not company:
        print(f"{name}: perusahaan belum ada, dilewati.")
        return None
    env = BASE_ENV(context={**BASE_ENV.context, "allowed_company_ids": [company.id], "active_test": False})
    if env["crm.lead"].search_count([("company_id", "=", company.id)]):
        print(f"{name}: sudah punya data CRM, dilewati.")
        return None
    rnd = random.Random(20261106 + offset)
    admin = env.ref("base.user_admin")
    tags = {tag.name: tag for tag in env["crm.tag"].search([])}
    stages = {stage.id: stage for stage in env["crm.stage"].search([])}
    gov_team, private_team = env["crm.team"].browse(4), env["crm.team"].browse(5)
    customers = env["res.partner"].search([("company_id", "=", company.id), ("customer_rank", ">", 0)], order="id")
    assert len(customers) >= 9, (name, len(customers))
    rotation = list(customers)
    rnd.shuffle(rotation)
    stats = {"terbuka": 0, "won": 0, "lead": 0, "aktivitas": 0}

    def team_for(partner):
        return gov_team if any(word in partner.name for word in ("RSUD", "Dinas", "Dinkes")) else private_team

    for index, (title, stage_id, low, high, tag_names) in enumerate(OPEN):
        partner = rotation[index % len(rotation)]
        revenue = round(rnd.uniform(low, high) / 500_000) * 500_000
        lead = env["crm.lead"].create(
            {
                "name": title.format(c=partner.name), "type": "opportunity", "partner_id": partner.id, "company_id": company.id, "user_id": admin.id, "team_id": team_for(partner).id,
                "stage_id": stages[stage_id].id, "expected_revenue": revenue, "priority": str(rnd.choice((0, 1, 2, 3))), "date_deadline": today + timedelta(days=rnd.randint(7, 75)),
                "tag_ids": [(6, 0, [tags[t].id for t in tag_names if t in tags])], "description": f"<p>Prospek kit reagen untuk {partner.name}.</p>",
            }
        )
        code, summary = ACTIVITIES[index % len(ACTIVITIES)]
        lead.activity_schedule(code, date_deadline=today + timedelta(days=rnd.randint(-6, 14)), summary=summary, user_id=admin.id)
        stats["terbuka"] += 1
        stats["aktivitas"] += 1

    # Opportunity Won: satu per pelanggan dengan pesanan terbesar, tertaut ke pesanan itu
    orders = env["sale.order"].search([("company_id", "=", company.id), ("state", "=", "sale")])
    biggest = {}
    for order in orders:
        if order.partner_id not in biggest or order.amount_total > biggest[order.partner_id].amount_total:
            biggest[order.partner_id] = order
    for partner, order in sorted(biggest.items(), key=lambda item: -item[1].amount_total)[:3]:
        lead = env["crm.lead"].create(
            {
                "name": f"Pasokan kit reagen {order.date_order:%B %Y}, {partner.name}", "type": "opportunity", "partner_id": partner.id, "company_id": company.id, "user_id": admin.id,
                "team_id": team_for(partner).id, "stage_id": stages[3].id, "expected_revenue": order.amount_total, "priority": "2", "date_deadline": order.date_order.date(),
            }
        )
        order.write({"opportunity_id": lead.id})
        lead.action_set_won()
        stats["won"] += 1

    for title, partner_name, contact, email in LEADS:
        env["crm.lead"].create({"name": title, "type": "lead", "partner_name": partner_name, "contact_name": contact, "email_from": email, "company_id": company.id, "user_id": admin.id, "team_id": private_team.id})
        stats["lead"] += 1
    leads = env["crm.lead"].search([("company_id", "=", company.id)])
    won = leads.filtered(lambda rec: rec.type == "opportunity" and rec.won_status == "won")
    assert len(won) == 3 and all(rec.expected_revenue > 0 for rec in won), (name, len(won))
    assert len(leads.filtered(lambda rec: rec.type == "opportunity" and rec.won_status == "pending")) == 9, name
    print(f"{name}: {stats}")
    return company


done = [seed("PROLINE Manufaktur (Demo)", 0), seed("PROLINE Periodik (Demo)", 1)]
BASE_ENV.cr.commit()
print("Data CRM perusahaan demo COGM selesai." if any(done) else "Tidak ada yang diubah.")
