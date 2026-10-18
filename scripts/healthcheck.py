#!/usr/bin/env python3
"""Pemeriksaan kesehatan KompakApps (tanpa dependensi luar; jalankan dengan `python3 -I`).

Memeriksa: Odoo (/web/health, versi, waktu respons), UI nginx beserta proxy JSON-2, JSON-2 dengan
API key (opsional), ruang disk, dan umur backup terakhir. Hanya membaca; tidak mengubah apa pun.

    python3 -I scripts/healthcheck.py [--odoo-url URL] [--ui-url URL] [--backup-dir DIR] [--json]

Kode keluar (sama dengan konvensi Nagios, cocok untuk cron atau monitor):
    0 semua sehat, 1 ada peringatan, 2 ada yang kritis, 3 salah pemakaian atau galat internal.

Variabel lingkungan (argumen mengalahkan variabel): KOMPAKAPPS_ODOO_URL, KOMPAKAPPS_UI_URL, KOMPAKAPPS_API_KEY
(sengaja bukan argumen agar tidak terlihat di daftar proses), ODOO_DB, BACKUP_DIR.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from urllib.parse import urlparse

OK, WARN, CRIT, SKIP = "ok", "warning", "critical", "skipped"
LABEL = {OK: "OK", WARN: "PERINGATAN", CRIT: "KRITIS", SKIP: "DILEWATI"}
LOOPBACK = {"127.0.0.1", "localhost", "::1", "[::1]"}

# Tanpa proxy sistem: pemantauan harus terhubung langsung ke alamat yang diperiksa.
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class Result:
    def __init__(self, name, status, message, **data):
        self.name, self.status, self.message, self.data = name, status, message, data

    def as_dict(self):
        return {"name": self.name, "status": self.status, "message": self.message, **self.data}


def http(url, timeout, method="GET", headers=None, body=None):
    """Mengembalikan (status_http, isi_bytes, milidetik, galat). Status 4xx/5xx bukan galat jaringan."""
    request = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    started = time.monotonic()
    try:
        with OPENER.open(request, timeout=timeout) as response:
            payload = response.read(1_000_000)
            return response.status, payload, (time.monotonic() - started) * 1000, None
    except urllib.error.HTTPError as error:
        payload = error.read(1_000_000)
        return error.code, payload, (time.monotonic() - started) * 1000, None
    except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as error:
        reason = getattr(error, "reason", error)
        return None, b"", (time.monotonic() - started) * 1000, str(reason)[:160]


def judge_latency(ms, warn_ms, crit_ms):
    if ms >= crit_ms:
        return CRIT
    if ms >= warn_ms:
        return WARN
    return OK


def json_body(payload):
    try:
        return json.loads(payload.decode("utf-8", "replace"))
    except ValueError:
        return None


def check_odoo(args):
    base = args.odoo_url.rstrip("/")
    status, payload, ms, error = http(f"{base}/web/health?db_server_status=1", args.timeout)
    if error:
        return Result("odoo", CRIT, f"tidak terjangkau di {base}: {error}", ms=round(ms))
    info = json_body(payload)
    if status != 200 or not isinstance(info, dict) or info.get("status") != "pass":
        detail = ""
        if isinstance(info, dict) and info.get("db_server_status") not in (None, True):
            detail = f"; database: {str(info['db_server_status'])[:100]}"
        return Result("odoo", CRIT, f"/web/health menjawab HTTP {status}{detail}", ms=round(ms), http=status)
    version = None
    v_status, v_payload, _, _ = http(f"{base}/web/version", args.timeout)
    v_info = json_body(v_payload) if v_status == 200 else None
    if isinstance(v_info, dict):
        version = v_info.get("version")
    level = judge_latency(ms, args.warn_ms, args.crit_ms)
    note = "" if level == OK else f" (lambat; batas {args.warn_ms:g} ms)"
    return Result(
        "odoo", level, f"sehat, versi {version or 'tidak diketahui'}, koneksi database baik, {ms:.0f} ms{note}", ms=round(ms), version=version
    )


def check_ui(args):
    if not args.ui_url:
        return Result("ui", SKIP, "alamat UI tidak diberikan (--ui-url)")
    base = args.ui_url.rstrip("/")
    status, _, ms, error = http(f"{base}/", args.timeout)
    if error:
        return Result("ui", CRIT, f"nginx tidak terjangkau di {base}: {error}", ms=round(ms))
    if status != 200:
        return Result("ui", CRIT, f"halaman UI menjawab HTTP {status}", ms=round(ms), http=status)
    # Tanpa kunci, Odoo menjawab 401 untuk JSON-2; itu bukti proxy sampai ke Odoo. 502/503/504 berarti Odoo tidak terjangkau.
    p_status, _, p_ms, p_error = http(
        f"{base}/json/2/res.users/context_get",
        args.timeout,
        method="POST",
        headers={"Content-Type": "application/json"},
        body=b"{}",
    )
    level = judge_latency(ms, args.warn_ms, args.crit_ms)
    if p_error:
        return Result("ui", CRIT, f"UI hidup tetapi proxy JSON-2 gagal: {p_error}", ms=round(ms))
    if p_status in (401, 403):
        return Result("ui", level, f"nginx hidup ({ms:.0f} ms); proxy JSON-2 sampai ke Odoo ({p_ms:.0f} ms)", ms=round(ms), proxy_ms=round(p_ms))
    if p_status in (502, 503, 504):
        return Result("ui", CRIT, f"nginx hidup tetapi Odoo tidak terjangkau lewat proxy (HTTP {p_status})", ms=round(ms), http=p_status)
    return Result("ui", WARN, f"nginx hidup, tetapi proxy JSON-2 menjawab HTTP {p_status} (diharapkan 401 tanpa kunci)", ms=round(ms), http=p_status)


def check_json2(args):
    key = os.environ.get("KOMPAKAPPS_API_KEY", "")
    if not key:
        return Result("json2", SKIP, "KOMPAKAPPS_API_KEY tidak diisi")
    base = (args.api_url or args.ui_url or args.odoo_url).rstrip("/")
    headers = {"Content-Type": "application/json; charset=utf-8", "Authorization": f"bearer {key}"}
    if args.db:
        headers["X-Odoo-Database"] = args.db
    host = urlparse(base).hostname or ""
    plain = urlparse(base).scheme == "http" and host not in LOOPBACK
    status, payload, ms, error = http(f"{base}/json/2/ir.module.module/search_read", args.timeout, "POST", headers,
                                      json.dumps({"domain": [["name", "=", "kompakapps_base"]], "fields": ["state", "latest_version"]}).encode())
    if error:
        return Result("json2", CRIT, f"tidak terjangkau di {base}: {error}", ms=round(ms))
    if status == 401:
        return Result("json2", CRIT, "API key ditolak (HTTP 401); kunci salah, kedaluwarsa, atau dicabut", http=status)
    if status == 200:
        rows = json_body(payload)
        module = rows[0] if isinstance(rows, list) and rows else None
        if module and module.get("state") != "installed":
            return Result("json2", CRIT, f"kompakapps_base berstatus '{module.get('state')}', bukan installed", ms=round(ms))
        extra = f", kompakapps_base {module['latest_version']} terpasang" if module else ""
        level = judge_latency(ms, args.warn_ms, args.crit_ms)
        note = "; API key dikirim lewat HTTP polos ke host non-loopback" if plain else ""
        if plain and level == OK:
            level = WARN
        return Result("json2", level, f"JSON-2 menjawab dengan API key{extra}, {ms:.0f} ms{note}", ms=round(ms))
    # Pengguna tanpa hak baca ir.module.module (HTTP 403): cukup buktikan JSON-2 hidup dengan panggilan netral.
    status, _, ms, error = http(f"{base}/json/2/res.users/context_get", args.timeout, "POST", headers, b"{}")
    if error:
        return Result("json2", CRIT, f"tidak terjangkau di {base}: {error}", ms=round(ms))
    if status == 200:
        return Result("json2", judge_latency(ms, args.warn_ms, args.crit_ms), f"JSON-2 menjawab dengan API key, {ms:.0f} ms", ms=round(ms))
    return Result("json2", CRIT, f"JSON-2 menjawab HTTP {status}", http=status)


def check_disks(args):
    paths = list(args.disk_path or [])
    if not paths:
        paths = ["/"]
        if args.backup_dir and os.path.isdir(args.backup_dir):
            paths.append(args.backup_dir)
        if os.path.isdir("/var/lib/docker"):
            paths.append("/var/lib/docker")
    results, seen = [], set()
    for path in paths:
        try:
            usage = shutil.disk_usage(path)
            device = os.stat(path).st_dev
        except OSError as error:
            results.append(Result(f"disk:{path}", CRIT, f"tidak bisa dibaca: {error.strerror or error}"))
            continue
        if device in seen:
            continue  # satu perangkat cukup dilaporkan sekali
        seen.add(device)
        free_pct = usage.free * 100.0 / usage.total if usage.total else 0.0
        level = CRIT if free_pct < args.disk_crit_pct else WARN if free_pct < args.disk_warn_pct else OK
        note = "" if level == OK else f" (batas {args.disk_crit_pct:g}% kritis, {args.disk_warn_pct:g}% peringatan)"
        results.append(
            Result(f"disk:{path}", level, f"{path}: {free_pct:.0f}% kosong ({usage.free / 1e9:.1f} dari {usage.total / 1e9:.1f} GB){note}",
                   free_pct=round(free_pct, 1), free_bytes=usage.free)
        )
    return results


def list_backups(backup_dir, db):
    """Folder backup (terbaru dulu) yang punya manifest.json; db menyaring menurut nama database."""
    found = []
    for name in os.listdir(backup_dir):
        path = os.path.join(backup_dir, name)
        manifest = os.path.join(path, "manifest.json")
        if name.startswith(".") or not os.path.isfile(manifest):
            continue
        try:
            with open(manifest, encoding="utf-8") as handle:
                data = json.load(handle)
            epoch = int(data["created_epoch"])
        except (OSError, ValueError, KeyError, TypeError):
            found.append((0, path, None))
            continue
        if db and data.get("database") != db:
            continue
        found.append((epoch, path, data))
    return sorted(found, key=lambda item: item[0], reverse=True)


def check_backup(args):
    if not args.backup_dir:
        return Result("backup", SKIP, "folder backup tidak diberikan (--backup-dir)")
    if not os.path.isdir(args.backup_dir):
        return Result("backup", CRIT, f"folder backup tidak ada: {args.backup_dir}")
    backups = list_backups(args.backup_dir, args.db)
    valid = [item for item in backups if item[2]]
    if not valid:
        return Result("backup", CRIT, f"tidak ada backup yang valid di {args.backup_dir}" + (f" untuk database {args.db}" if args.db else ""))
    epoch, path, data = valid[0]
    age_h = (time.time() - epoch) / 3600.0
    name = os.path.basename(path)
    problems = []
    for key_file, key_bytes in (("dump_file", "dump_bytes"), ("filestore_file", "filestore_bytes")):
        target = os.path.join(path, str(data.get(key_file, "")))
        try:
            if os.path.getsize(target) != int(data[key_bytes]):
                problems.append(f"{data.get(key_file)} ukurannya tidak sama dengan manifest")
        except (OSError, KeyError, ValueError):
            problems.append(f"{data.get(key_file, key_file)} hilang atau tidak terbaca")
    size = sum(int(data.get(k, 0)) for k in ("dump_bytes", "filestore_bytes"))
    info = {"latest": name, "age_hours": round(age_h, 1), "count": len(valid), "bytes": size}
    if problems:
        return Result("backup", CRIT, f"backup terakhir {name} rusak: {'; '.join(problems)}", **info)
    level = CRIT if age_h >= args.backup_crit_hours else WARN if age_h >= args.backup_warn_hours else OK
    age_text = f"{age_h:.0f} jam" if age_h >= 2 else f"{age_h * 60:.0f} menit"
    note = "" if level == OK else f" (batas {args.backup_warn_hours:g} jam peringatan, {args.backup_crit_hours:g} jam kritis)"
    return Result("backup", level, f"terakhir {age_text} lalu ({name}, {size / 1e6:.1f} MB), {len(valid)} backup tersimpan{note}", **info)


def build_parser():
    env = os.environ.get
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__.split("\n\n", 1)[1])
    parser.add_argument("--odoo-url", default=env("KOMPAKAPPS_ODOO_URL", "http://127.0.0.1:8069"), help="alamat Odoo (bawaan: http://127.0.0.1:8069)")
    parser.add_argument("--ui-url", default=env("KOMPAKAPPS_UI_URL", ""), help="alamat UI nginx; kosong = lewati pemeriksaan UI")
    parser.add_argument("--api-url", default="", help="alamat untuk panggilan JSON-2 (bawaan: --ui-url bila ada, jika tidak --odoo-url)")
    parser.add_argument("--db", default=env("ODOO_DB", ""), help="nama database: header X-Odoo-Database untuk JSON-2 dan penyaring backup")
    parser.add_argument("--backup-dir", default=env("BACKUP_DIR", ""), help="folder backup (keluaran scripts/backup.sh); kosong = lewati")
    parser.add_argument("--backup-warn-hours", type=float, default=26.0, help="umur backup untuk peringatan (bawaan 26 jam)")
    parser.add_argument("--backup-crit-hours", type=float, default=50.0, help="umur backup untuk kritis (bawaan 50 jam)")
    parser.add_argument("--disk-path", action="append", help="jalur yang dicek ruang disknya (boleh berulang; bawaan: /, folder backup, /var/lib/docker)")
    parser.add_argument("--disk-warn-pct", type=float, default=20.0, help="peringatan bila ruang kosong di bawah persen ini (bawaan 20)")
    parser.add_argument("--disk-crit-pct", type=float, default=10.0, help="kritis bila ruang kosong di bawah persen ini (bawaan 10)")
    parser.add_argument("--warn-ms", type=float, default=1000.0, help="peringatan bila respons lebih lambat dari ini (bawaan 1000 ms)")
    parser.add_argument("--crit-ms", type=float, default=5000.0, help="kritis bila respons lebih lambat dari ini (bawaan 5000 ms)")
    parser.add_argument("--timeout", type=float, default=5.0, help="batas waktu per permintaan (bawaan 5 detik)")
    parser.add_argument("--json", action="store_true", help="keluaran JSON, bukan teks")
    parser.add_argument("-q", "--quiet", action="store_true", help="tidak mencetak apa pun bila semuanya sehat")
    return parser


def main():
    args = build_parser().parse_args()
    results = [check_odoo(args), check_ui(args), check_json2(args)]
    results += check_disks(args)
    results.append(check_backup(args))

    worst = CRIT if any(r.status == CRIT for r in results) else WARN if any(r.status == WARN for r in results) else OK
    code = {OK: 0, WARN: 1, CRIT: 2}[worst]
    stamp = datetime.now().astimezone().isoformat(timespec="seconds")
    counts = {s: sum(1 for r in results if r.status == s) for s in (OK, WARN, CRIT, SKIP)}

    if args.json:
        print(json.dumps({"status": worst, "exit_code": code, "timestamp": stamp, "host": socket.gethostname(), "summary": counts,
                          "checks": [r.as_dict() for r in results]}, ensure_ascii=False, indent=2))
    elif not (args.quiet and worst == OK):
        print(f"KompakApps health check {stamp} ({socket.gethostname()})")
        for r in results:
            print(f"  {LABEL[r.status]:<10} {r.name.split(':')[0]:<7} {r.message}")
        print(f"Ringkasan: {LABEL[worst]} ({counts[OK]} sehat, {counts[WARN]} peringatan, {counts[CRIT]} kritis, {counts[SKIP]} dilewati); kode keluar {code}")
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - monitor harus selalu mengeluarkan kode yang bermakna
        print(f"GALAT INTERNAL: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(3)
