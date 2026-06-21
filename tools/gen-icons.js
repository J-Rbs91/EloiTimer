/* Génère les icônes PNG (horloge bleue) de la PWA sans dépendance externe.
 * Rendu pixel avec sur-échantillonnage 4x pour l'anti-crénelage,
 * encodage PNG via le module zlib intégré de Node.
 * Usage : node tools/gen-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BLUE = [37, 99, 235];   // #2563eb
const DARK = [29, 78, 216];   // #1d4ed8 (dégradé léger)
const WHITE = [255, 255, 255];

const ICONS_DIR = path.join(__dirname, '..', 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

// --- Géométrie ------------------------------------------------------------
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Couleur d'un sous-pixel (peintre : fond -> cadran -> ticks -> aiguilles -> moyeu)
function sampleColor(x, y, N) {
  const c = N / 2;
  const R = N * 0.34;            // rayon du cadran blanc
  const ang = (clock) => (clock / 12) * 2 * Math.PI;
  const endX = (a, len) => c + Math.sin(a) * len;
  const endY = (a, len) => c - Math.cos(a) * len;

  // Fond : léger dégradé vertical bleu
  const f = y / N;
  let col = [
    Math.round(BLUE[0] * (1 - f) + DARK[0] * f),
    Math.round(BLUE[1] * (1 - f) + DARK[1] * f),
    Math.round(BLUE[2] * (1 - f) + DARK[2] * f),
  ];

  const d = Math.hypot(x - c, y - c);

  // Cadran blanc
  if (d <= R) col = WHITE.slice();

  // Ticks (12 repères bleus)
  if (d <= R && d >= R * 0.80) {
    for (let i = 0; i < 12; i++) {
      const a = ang(i);
      const tx = c + Math.sin(a) * R * 0.88;
      const ty = c - Math.cos(a) * R * 0.88;
      const big = i % 3 === 0;
      if (Math.hypot(x - tx, y - ty) <= R * (big ? 0.055 : 0.032)) {
        col = BLUE.slice();
      }
    }
  }

  // Aiguilles (pose 10:10) sur le cadran
  if (d <= R) {
    // heure -> 10, minute -> 2
    if (distToSeg(x, y, c, c, endX(ang(10), R * 0.50), endY(ang(10), R * 0.50)) <= N * 0.022) col = BLUE.slice();
    if (distToSeg(x, y, c, c, endX(ang(2), R * 0.72), endY(ang(2), R * 0.72)) <= N * 0.018) col = BLUE.slice();
  }

  // Moyeu central
  if (d <= N * 0.025) col = BLUE.slice();

  return col;
}

// --- Rendu d'une icône N x N avec sur-échantillonnage SS ------------------
function renderIcon(N, SS = 4) {
  const data = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          const col = sampleColor(px, py, N);
          r += col[0]; g += col[1]; b += col[2];
        }
      }
      const n = SS * SS;
      const o = (y * N + x) * 4;
      data[o] = Math.round(r / n);
      data[o + 1] = Math.round(g / n);
      data[o + 2] = Math.round(b / n);
      data[o + 3] = 255;
    }
  }
  return data;
}

// --- Encodage PNG (RGBA, sans filtre) ------------------------------------
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(N, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0);
  ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // chaque ligne préfixée par un octet de filtre (0)
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0;
    rgba.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// --- Génération -----------------------------------------------------------
const sizes = [
  ['icon-512.png', 512],
  ['icon-192.png', 192],
  ['icon-180.png', 180], // apple-touch
  ['icon-32.png', 32],
  ['icon-16.png', 16],
];
for (const [name, N] of sizes) {
  const png = encodePng(N, renderIcon(N, N <= 32 ? 6 : 4));
  fs.writeFileSync(path.join(ICONS_DIR, name), png);
  console.log('écrit', name, `(${N}x${N}, ${png.length} o)`);
}
