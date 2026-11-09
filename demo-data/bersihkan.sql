-- Membersihkan rahasia dari SALINAN database sebelum dipublikasikan (repo publik).
-- JANGAN dijalankan pada database yang dipakai harian: skrip ini menghapus API key dan kata sandi.
-- Panduan lengkap: demo-data/README.md. Dipakai untuk salinan 2026-11-09 (Odoo 19.0, kompakapps_base 19.0.1.17.0).
--
-- Kata sandi admin (id 2) disetel LEWAT Odoo shell sebelum skrip ini, supaya hash-nya dibuat Odoo sendiri.
-- Pemakaian pada database sementara:
--   docker compose exec -T db psql -U odoo -d <database-sementara> -v ON_ERROR_STOP=1 < demo-data/bersihkan.sql

begin;

-- Kata sandi: hanya admin (id 2) yang boleh punya.
update res_users set password = null where id <> 2;
delete from res_users_apikeys;

-- Jejak perangkat dan sesi.
delete from res_device_log;
delete from res_device;
delete from res_users_log;
delete from bus_bus;

-- Secret dan pengenal instalasi (dibuat acak baru; nilai asli tidak ikut).
update ir_config_parameter set value = gen_random_uuid()::text where key in ('database.secret', 'database.uuid');
delete from ir_config_parameter where key in ('iap_vies.client_identifier', 'iap_vies.client_token');
update iap_account set account_token = gen_random_uuid()::text;

-- Token akses portal (dibuat ulang otomatis saat dibutuhkan).
update sale_order set access_token = null where access_token is not null;
update purchase_order set access_token = null where access_token is not null;
update pos_session set access_token = null where access_token is not null;
update pos_config set access_token = null where access_token is not null;

-- Bundel aset web: Odoo membuatnya ulang saat halaman pertama dibuka.
delete from ir_attachment where url like '/web/assets/%';

-- Riwayat audit: nilai lama/baru field sensitif bisa memuat hash atau token asli.
delete from auditlog_log_line l
  using auditlog_log g
  where g.id = l.log_id
    and (l.field_name ~* '(password|passwd|token|secret|api_?key|private_key)'
         or g.model_model in ('res.users.apikeys', 'ir.config_parameter'));
update auditlog_http_session set name = md5(random()::text || id::text), display_name = null;

commit;
