#!/usr/bin/env python3
"""Uji beban sederhana untuk Nusara ERP lewat API JSON-2 (tanpa dependensi luar; jalankan dengan `python3 -I`).

N pengguna paralel (thread, tiap thread satu koneksi HTTP tetap) menjalankan skenario selama durasi tertentu:
  baca   daftar produk, daftar Sales Order dan Purchase Order, laporan grup (Purchase Report per bulan,
         buku besar per akun)
  tulis  membuat draf Purchase Order atau Sales Order lalu membatalkannya (data uji "Bahan Baku Nusara",
         "PT Pemasok Nusantara", "PT Pelanggan Nusantara" dari scripts/seed_demo.py); rekaman yang dibuat
         diberi penanda LOADTEST-<id> dan dihapus di akhir (tidak diukur), kecuali --no-purge

Melaporkan throughput, p50/p95/p99 (peringkat terdekat), dan galat per operasi serta total.
Skrip ini MENULIS data bila skenario mengandung tulis, jadi pakai database uji; wajib --yes untuk itu.
Menolak URL non-loopback tanpa --yes-remote.

    NUSARA_API_KEY=... python3 -I scripts/loadtest.py --url http://127.0.0.1:8480 --users 10 --duration 30
    NUSARA_API_KEY=... python3 -I scripts/loadtest.py --url http://127.0.0.1:8480 --scenario mix --yes --json

Kode keluar: 0 selesai dan galat di bawah batas, 1 galat di atas --max-error-rate (atau p95 di atas
--max-p95-ms), 2 salah pemakaian atau penolakan keamanan.
"""

from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import math
import os
import platform
import random
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime
from urllib.parse import urlparse


def fail(message):
    print(f"GALAT: {message}", file=sys.stderr)
    sys.exit(2)


def is_loopback(host):
    host = (host or "").strip("[]").lower()
    if host == "localhost" or host.endswith(".localhost"):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(f"HTTP {status}: {message}" if isinstance(status, int) else f"{status}: {message}")
        self.status, self.detail = status, message
        self.kind = f"HTTP {status}" if isinstance(status, int) else status

    def label(self):
        return f"{self.kind}: {self.detail[:60]}" if isinstance(self.status, int) else self.kind


class Client:
    """Satu koneksi tetap (keep-alive) per thread."""

    def __init__(self, url, key, db, timeout):
        parsed = urlparse(url)
        self.prefix = parsed.path.rstrip("/")
        self.host, self.port = parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
        self.https = parsed.scheme == "https"
        self.timeout = timeout
        self.headers = {"Content-Type": "application/json; charset=utf-8", "Authorization": f"bearer {key}"}
        if db:
            self.headers["X-Odoo-Database"] = db
        self.conn = None
        self.used = False

    def _connect(self):
        cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
        self.conn = cls(self.host, self.port, timeout=self.timeout)
        self.used = False

    def call(self, model, method, **params):
        """Mengembalikan (hasil, milidetik). Waktu mencakup pengiriman, pemrosesan server, dan pembacaan isi."""
        body = json.dumps(params).encode()
        path = f"{self.prefix}/json/2/{model}/{method}"
        for attempt in (1, 2):
            if self.conn is None:
                self._connect()
            started = time.perf_counter()
            try:
                self.conn.request("POST", path, body=body, headers=self.headers)
                response = self.conn.getresponse()
                payload = response.read()
            except (http.client.RemoteDisconnected, BrokenPipeError, ConnectionResetError, http.client.CannotSendRequest):
                stale = self.used
                self.close()
                if stale and attempt == 1:
                    continue  # koneksi diam ditutup server; ulangi sekali pada koneksi baru
                raise ApiError("koneksi", "koneksi terputus") from None
            except (TimeoutError, socket.timeout):
                self.close()
                raise ApiError("timeout", f"lebih dari {self.timeout:g} detik") from None
            except OSError as error:
                self.close()
                raise ApiError("koneksi", str(error)[:80]) from None
            elapsed = (time.perf_counter() - started) * 1000
            self.used = True
            if response.will_close:
                self.close()
            if response.status != 200:
                message = payload.decode("utf-8", "replace")
                try:
                    message = json.loads(message).get("message", message)
                except ValueError:
                    pass
                raise ApiError(response.status, str(message)[:100])
            return json.loads(payload), elapsed
        raise ApiError("koneksi", "koneksi terputus")

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            finally:
                self.conn = None


class Sample:
    __slots__ = ("op", "start", "ms", "error")

    def __init__(self, op, start, ms, error):
        self.op, self.start, self.ms, self.error = op, start, ms, error


def percentile(sorted_values, pct):
    if not sorted_values:
        return 0.0
    rank = max(1, math.ceil(pct / 100.0 * len(sorted_values)))
    return sorted_values[rank - 1]


def worker(index, args, key, ids, deadline, stop, results):
    client = Client(args.url, key, args.db, args.timeout)
    rng = random.Random(index * 7919 + int(time.time()))
    samples = results[index]
    marker = f"LOADTEST-{args.run_id}"

    def timed(op, model, method, **params):
        started = time.monotonic()
        try:
            result, ms = client.call(model, method, **params)
            samples.append(Sample(op, started, ms, None))
            return result
        except ApiError as error:
            samples.append(Sample(op, started, (time.monotonic() - started) * 1000, error.label()))
            return None

    reads = [
        (4, lambda: timed("produk.daftar", "product.template", "search_read", domain=[], fields=["name", "list_price", "standard_price", "categ_id", "type"], limit=80, order="name")),
        (3, lambda: timed("so.daftar", "sale.order", "search_read", domain=[], fields=["name", "partner_id", "amount_total", "state", "date_order"], limit=50, order="id desc")),
        (3, lambda: timed("po.daftar", "purchase.order", "search_read", domain=[], fields=["name", "partner_id", "amount_total", "state", "date_order"], limit=50, order="id desc")),
        (2, lambda: timed("laporan.po_bulanan", "purchase.report", "formatted_read_group", domain=[["state", "in", ["purchase", "done"]]], groupby=["date_order:month"], aggregates=["price_total:sum", "qty_ordered:sum"])),
        (2, lambda: timed("laporan.buku_besar", "account.move.line", "formatted_read_group", domain=[["parent_state", "=", "posted"]], groupby=["account_id"], aggregates=["debit:sum", "credit:sum", "balance:sum"])),
    ]
    weights = [w for w, _ in reads]

    def write_po():
        qty = rng.randint(1, 5)
        res = timed("po.buat", "purchase.order", "create", vals_list=[{
            "partner_id": ids["vendor"], "partner_ref": marker,
            "order_line": [[0, 0, {"product_id": ids["product"], "name": "Uji beban", "product_qty": float(qty), "product_uom_id": ids["uom"]}]],
        }])
        if res:
            timed("po.batal", "purchase.order", "button_cancel", ids=[res[0]])

    def write_so():
        qty = rng.randint(1, 5)
        res = timed("so.buat", "sale.order", "create", vals_list=[{
            "partner_id": ids["customer"], "client_order_ref": marker,
            "order_line": [[0, 0, {"product_id": ids["product"], "product_uom_qty": float(qty)}]],
        }])
        if res:
            timed("so.batal", "sale.order", "action_cancel", ids=[res[0]])

    try:
        while time.monotonic() < deadline and not stop.is_set():
            if args.scenario == "write" or (args.scenario == "mix" and rng.random() < args.write_ratio):
                (write_po if rng.random() < 0.5 else write_so)()
            else:
                rng.choices([r for _, r in reads], weights=weights)[0]()
            if args.think > 0:
                time.sleep(args.think * rng.uniform(0.8, 1.2))
    finally:
        client.close()


def purge(args, key):
    """Menghapus rekaman uji beban (PO dan SO berstatus batal dengan penanda LOADTEST-). Tidak diukur."""
    client = Client(args.url, key, args.db, 120)
    removed = 0
    try:
        for model, field in (("purchase.order", "partner_ref"), ("sale.order", "client_order_ref")):
            domain = [[field, "=like", "LOADTEST-%"], ["state", "=", "cancel"]]
            while True:
                rows, _ = client.call(model, "search", domain=domain, limit=500)
                if not rows:
                    break
                client.call(model, "unlink", ids=rows)
                removed += len(rows)
    except ApiError as error:
        print(f"PERINGATAN: pembersihan rekaman uji beban terhenti: {error}", file=sys.stderr)
    finally:
        client.close()
    return removed


def machine_info():
    memory = None
    try:
        if sys.platform == "darwin":
            memory = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5).stdout.strip())
        elif os.path.exists("/proc/meminfo"):
            with open("/proc/meminfo", encoding="ascii") as handle:
                memory = int(handle.readline().split()[1]) * 1024
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return {"platform": platform.platform(), "machine": platform.machine(), "cpus": os.cpu_count(), "memory_gb": round(memory / 2**30, 1) if memory else None, "python": platform.python_version()}


def summarize(samples, seconds):
    values = sorted(s.ms for s in samples if s.error is None)
    errors = sum(1 for s in samples if s.error is not None)
    total = len(samples)
    return {
        "n": total,
        "errors": errors,
        "rps": round(total / seconds, 1) if seconds else 0.0,
        "mean_ms": round(sum(values) / len(values), 1) if values else 0.0,
        "p50_ms": round(percentile(values, 50), 1),
        "p95_ms": round(percentile(values, 95), 1),
        "p99_ms": round(percentile(values, 99), 1),
        "max_ms": round(values[-1], 1) if values else 0.0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], epilog=__doc__.split("\n\n", 1)[1], formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, help="alamat UI atau Odoo, mis. http://127.0.0.1:8480 (WAJIB, tanpa nilai bawaan)")
    parser.add_argument("--users", type=int, default=5, help="jumlah pengguna paralel (bawaan 5)")
    parser.add_argument("--duration", type=float, default=30.0, help="detik pengukuran (bawaan 30)")
    parser.add_argument("--warmup", type=float, default=3.0, help="detik pemanasan yang tidak dihitung (bawaan 3)")
    parser.add_argument("--scenario", choices=["read", "write", "mix"], default="read", help="read = hanya baca (bawaan), write = hanya tulis, mix = baca dengan sebagian tulis")
    parser.add_argument("--write-ratio", type=float, default=0.1, help="pada mix: peluang satu putaran berupa tulis (bawaan 0.1)")
    parser.add_argument("--think", type=float, default=0.0, help="jeda antar permintaan per pengguna, detik (bawaan 0 = secepat mungkin)")
    parser.add_argument("--db", default=os.environ.get("ODOO_DB", ""), help="header X-Odoo-Database (perlu bila --url langsung ke Odoo dengan banyak database)")
    parser.add_argument("--timeout", type=float, default=60.0, help="batas waktu per permintaan (bawaan 60 detik)")
    parser.add_argument("--yes", action="store_true", help="konfirmasi bahwa database tujuan adalah database uji (wajib untuk write dan mix)")
    parser.add_argument("--yes-remote", action="store_true", help="izinkan URL non-loopback (hati-hati: beban nyata ke server lain)")
    parser.add_argument("--no-purge", action="store_true", help="jangan hapus rekaman uji beban di akhir")
    parser.add_argument("--max-error-rate", type=float, default=0.01, help="kode keluar 1 bila laju galat lebih besar (bawaan 0.01 = 1%%)")
    parser.add_argument("--max-p95-ms", type=float, default=0.0, help="kode keluar 1 bila p95 total lebih besar (bawaan 0 = tidak dicek)")
    parser.add_argument("--json", action="store_true", help="keluaran JSON, bukan tabel")
    args = parser.parse_args()

    parsed = urlparse(args.url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        fail("--url harus berupa http://host:port atau https://host:port")
    if not is_loopback(parsed.hostname) and not args.yes_remote:
        fail(f"{parsed.hostname} bukan alamat loopback; uji beban ke server lain butuh --yes-remote")
    if args.scenario != "read" and not args.yes:
        fail("skenario write/mix menulis data; tambahkan --yes dan pastikan database tujuan adalah database uji")
    if not 1 <= args.users <= 500:
        fail("--users harus antara 1 dan 500")
    if args.duration <= 0 or args.warmup < 0 or not 0 <= args.write_ratio <= 1:
        fail("--duration harus positif, --warmup tidak negatif, --write-ratio antara 0 dan 1")
    key = os.environ.get("NUSARA_API_KEY", "")
    if not key:
        fail("isi NUSARA_API_KEY (sengaja bukan argumen agar tidak terlihat di daftar proses)")
    args.run_id = datetime.now().strftime("%Y%m%d%H%M%S")

    # Pra-pemeriksaan (tidak diukur): kunci berlaku dan data uji tersedia.
    probe = Client(args.url, key, args.db, args.timeout)
    ids = {}
    try:
        probe.call("res.users", "context_get")
        if args.scenario != "read":
            product, _ = probe.call("product.product", "search_read", domain=[["name", "=", "Bahan Baku Nusara"]], fields=["uom_id"], limit=1)
            vendor, _ = probe.call("res.partner", "search", domain=[["name", "=", "PT Pemasok Nusantara"]], limit=1)
            customer, _ = probe.call("res.partner", "search", domain=[["name", "=", "PT Pelanggan Nusantara"]], limit=1)
            if not (product and vendor and customer):
                fail("data uji tidak ada; jalankan scripts/seed_demo.py di database uji dulu")
            ids.update(product=product[0]["id"], uom=product[0]["uom_id"][0], vendor=vendor[0], customer=customer[0])
    except ApiError as error:
        fail(f"pra-pemeriksaan gagal: {error}")
    finally:
        probe.close()

    if not args.json:
        print(f"Uji beban {args.url}: skenario={args.scenario}, pengguna={args.users}, durasi={args.duration:g} detik (+{args.warmup:g} detik pemanasan), think={args.think:g} detik", flush=True)

    stop = threading.Event()
    results = [[] for _ in range(args.users)]
    start = time.monotonic()
    measure_from = start + args.warmup
    deadline = measure_from + args.duration
    threads = [threading.Thread(target=worker, args=(i, args, key, ids, deadline, stop, results), daemon=True) for i in range(args.users)]
    for t in threads:
        t.start()
    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        stop.set()
        for t in threads:
            t.join(timeout=args.timeout + 5)
        print("Dihentikan pengguna; hasil sebagian dilaporkan.", file=sys.stderr)

    samples = [s for per_thread in results for s in per_thread if s.start >= measure_from]
    by_op = {}
    for s in samples:
        by_op.setdefault(s.op, []).append(s)
    seconds = args.duration
    report = {
        "timestamp": datetime.now().astimezone().isoformat(timespec="seconds"),
        "url": args.url,
        "scenario": args.scenario,
        "users": args.users,
        "duration_s": args.duration,
        "warmup_s": args.warmup,
        "think_s": args.think,
        "client_machine": machine_info(),
        "total": summarize(samples, seconds),
        "operations": {op: summarize(rows, seconds) for op, rows in sorted(by_op.items())},
        "errors": {},
    }
    for s in samples:
        if s.error:
            report["errors"][s.error] = report["errors"].get(s.error, 0) + 1

    removed = 0
    if args.scenario != "read" and not args.no_purge:
        removed = purge(args, key)
    report["purged_records"] = removed

    total = report["total"]
    error_rate = total["errors"] / total["n"] if total["n"] else 1.0
    report["error_rate"] = round(error_rate, 4)
    exceeded = error_rate > args.max_error_rate or bool(args.max_p95_ms and total["p95_ms"] > args.max_p95_ms)
    report["passed"] = not exceeded

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        machine = report["client_machine"]
        print(f"Mesin klien: {machine['platform']}, {machine['cpus']} CPU, {machine['memory_gb']} GB RAM, Python {machine['python']}")
        print(f"\n{'operasi':<20} {'n':>7} {'galat':>6} {'req/s':>8} {'rata':>8} {'p50':>8} {'p95':>8} {'p99':>8} {'maks':>8}   (ms)")
        rows = list(report["operations"].items()) + [("TOTAL", total)]
        for op, r in rows:
            print(f"{op:<20} {r['n']:>7} {r['errors']:>6} {r['rps']:>8.1f} {r['mean_ms']:>8.1f} {r['p50_ms']:>8.1f} {r['p95_ms']:>8.1f} {r['p99_ms']:>8.1f} {r['max_ms']:>8.1f}")
        if report["errors"]:
            print("\nGalat:")
            for kind, count in sorted(report["errors"].items(), key=lambda kv: -kv[1]):
                print(f"  {count:>6}  {kind}")
        if removed:
            print(f"\nRekaman uji beban dibersihkan: {removed}")
        print(f"\nLaju galat {error_rate:.2%} (batas {args.max_error_rate:.2%})" + (f", p95 {total['p95_ms']:.0f} ms (batas {args.max_p95_ms:g} ms)" if args.max_p95_ms else "") + (": LULUS" if not exceeded else ": GAGAL"))
    return 1 if exceeded else 0


if __name__ == "__main__":
    sys.exit(main())
