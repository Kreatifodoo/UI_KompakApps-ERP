// Pembuat kode QR mandiri (tanpa pustaka): mode byte UTF-8, koreksi galat M, versi 1-9 (sampai 178 byte). Dipakai struk 80 mm (print.js).
// Hasilnya matriks boolean (true = modul gelap) atau SVG; tanpa zona hening, pemanggil menambahkan margin sendiri.

// Per versi (indeks 1-9): [byte koreksi per blok, [jumlah blok, kata data per blok] kelompok 1, kelompok 2]
const BLOCKS = [
  null,
  [10, [1, 16]],
  [16, [1, 28]],
  [26, [1, 44]],
  [18, [2, 32]],
  [24, [2, 43]],
  [16, [4, 27]],
  [18, [4, 31]],
  [22, [2, 38], [2, 39]],
  [22, [3, 36], [2, 37]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46]];

// Aritmetika GF(256), polinomial 0x11D.
const EXP = new Array(512);
const LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function ecBytes(data, count) {
  let gen = [1];
  for (let i = 0; i < count; i++) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => {
      next[j] ^= c;
      next[j + 1] ^= gmul(c, EXP[i]);
    });
    gen = next;
  }
  const rest = new Array(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ rest.shift();
    rest.push(0);
    gen.slice(1).forEach((c, j) => {
      rest[j] ^= gmul(c, factor);
    });
  }
  return rest;
}

const dataCapacity = (v) => BLOCKS[v].slice(1).reduce((s, [n, k]) => s + n * k, 0);

function codewords(bytes, version) {
  const capacity = dataCapacity(version);
  const bits = [];
  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, 8);
  bytes.forEach((b) => put(b, 8));
  put(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  for (let pad = 0xec; words.length < capacity; pad ^= 0xec ^ 0x11) words.push(pad);
  const [ecCount, ...groups] = BLOCKS[version];
  const blocks = [];
  let offset = 0;
  for (const [n, k] of groups) {
    for (let i = 0; i < n; i++) {
      const data = words.slice(offset, offset + k);
      offset += k;
      blocks.push({ data, ec: ecBytes(data, ecCount) });
    }
  }
  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) blocks.forEach((b) => i < b.data.length && out.push(b.data[i]));
  for (let i = 0; i < ecCount; i++) blocks.forEach((b) => out.push(b.ec[i]));
  return out;
}

const bch = (value, poly, bitsLen) => {
  let rem = value << bitsLen;
  const top = (n) => 31 - Math.clz32(n);
  while (rem && top(rem) >= top(poly)) rem ^= poly << (top(rem) - top(poly));
  return (value << bitsLen) | rem;
};

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m) {
  const n = m.length;
  let score = 0;
  const runs = (get) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j <= n; j++) {
        if (j < n && get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
    }
  };
  runs((r, c) => m[r][c]);
  runs((r, c) => m[c][r]);
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const rev = [...pat].reverse();
  const match = (get, i, j, p) => p.every((v, k) => (get(i, j + k) ? 1 : 0) === v);
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= n - 11; j++) {
      for (const p of [pat, rev]) {
        if (match((r, c) => m[r][c], i, j, p)) score += 40;
        if (match((r, c) => m[c][r], i, j, p)) score += 40;
      }
    }
  const dark = m.flat().filter(Boolean).length;
  score += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10;
  return score;
}

function build(words, version, mask) {
  const n = version * 4 + 17;
  const m = Array.from({ length: n }, () => new Array(n).fill(false));
  const fixed = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= n || c >= n) return;
    m[r][c] = v;
    fixed[r][c] = true;
  };
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(r0 + r, c0 + c, r >= 0 && r <= 6 && c >= 0 && c <= 6 && ring !== 2);
      }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const pos = ALIGN[version];
  for (const r of pos)
    for (const c of pos) {
      if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  // Area format (dicadangkan dulu), modul gelap, dan informasi versi.
  for (let i = 0; i < 9; i++) {
    if (i === 6) continue; // baris dan kolom 6 adalah pola waktu
    set(8, i, false);
    set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(8, n - 1 - i, false);
    set(n - 1 - i, 8, false);
  }
  set(n - 8, 8, true);
  if (version >= 7) {
    const info = bch(version, 0x1f25, 12);
    for (let i = 0; i < 18; i++) {
      const bit = ((info >> i) & 1) === 1;
      set(Math.floor(i / 3), n - 11 + (i % 3), bit);
      set(n - 11 + (i % 3), Math.floor(i / 3), bit);
    }
  }
  // Data zig-zag dari kanan bawah.
  const bits = words.flatMap((w) => Array.from({ length: 8 }, (_, i) => (w >> (7 - i)) & 1));
  let k = 0;
  for (let c = n - 1, up = true; c > 0; c -= 2, up = !up) {
    if (c === 6) c--;
    for (let i = 0; i < n; i++) {
      const r = up ? n - 1 - i : i;
      for (const cc of [c, c - 1]) {
        if (fixed[r][cc]) continue;
        const bit = k < bits.length ? bits[k++] === 1 : false;
        m[r][cc] = bit !== MASKS[mask](r, cc);
      }
    }
  }
  // Format: koreksi M (00) + nomor mask.
  const format = bch((0b00 << 3) | mask, 0x537, 10) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const bit = ((format >> i) & 1) === 1;
    if (i < 6) m[i][8] = bit;
    else if (i < 8) m[i + 1][8] = bit;
    else m[n - 15 + i][8] = bit;
    if (i < 8) m[8][n - 1 - i] = bit;
    else if (i < 9) m[8][15 - i] = bit;
    else m[8][14 - i] = bit;
  }
  return m;
}

/** Matriks QR (array baris berisi boolean) untuk teks; melempar galat bila teks terlalu panjang (lebih dari 178 byte UTF-8). */
export function qrMatrix(textValue) {
  const bytes = [...new TextEncoder().encode(String(textValue))];
  const version = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((v) => bytes.length * 8 + 12 <= dataCapacity(v) * 8);
  if (!version) throw new Error("Teks QR terlalu panjang.");
  const words = codewords(bytes, version);
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const m = build(words, version, mask);
    const score = penalty(m);
    if (!best || score < best.score) best = { m, score };
  }
  return best.m;
}

/** SVG QR dengan zona hening 2 modul; `size` dalam piksel CSS. */
export function qrSvg(textValue, size = 96) {
  const m = qrMatrix(textValue);
  const quiet = 2;
  const total = m.length + quiet * 2;
  const cells = m.flatMap((row, r) => row.map((on, c) => (on ? `M${c + quiet} ${r + quiet}h1v1h-1z` : ""))).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${cells}" fill="#000"/></svg>`;
}
