#!/usr/bin/env node
/**
 * Draw AffiliatePoppy's app icon → frontend/public/affiliatepoppy-icon.png.
 *
 * This script is the icon's SOURCE OF TRUTH: there's no SVG rasteriser on a stock macOS box
 * (no rsvg/cairo/magick), so rather than commit a binary nobody can regenerate, we draw the
 * mark in code and encode the PNG with zlib. Deterministic — same bytes every run.
 *
 * The mark: one filled node with two smaller ones branching from it — a referral spreading
 * outward, which is what this poppy is for. Drawn in the ONE accent the host assigns us, on
 * transparency, deliberately simple so it stays legible at 24px in the sidebar. Square: the
 * host draws the rounded corners itself (AGENTS.md §9).
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "frontend", "public", "affiliatepoppy-icon.png");

const SIZE = 512;
const SS = 4; // supersample factor → anti-aliased edges without a graphics lib

/** The accent the host assigns us: poppyAccent("com.affiliatepoppy.desktop"). */
const ACCENT = [0xbc, 0xcf, 0x9e];
/** Dimmer tints of the same hue — one colour, three weights. */
const tint = (f) => ACCENT.map((c) => Math.round(c * f));

/** The source node, and the two it refers on to. */
const NODES = [
  { cx: 150, cy: 256, r: 68, colour: tint(1.0) },
  { cx: 366, cy: 148, r: 46, colour: tint(0.72) },
  { cx: 366, cy: 364, r: 46, colour: tint(0.72) },
];
/** The links between them, as thick line segments. */
const LINKS = [
  { from: NODES[0], to: NODES[1], width: 22, colour: tint(0.5) },
  { from: NODES[0], to: NODES[2], width: 22, colour: tint(0.5) },
];

const inCircle = (x, y, { cx, cy, r }) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;

/** Distance from a point to a segment — how a line becomes a shape with thickness. */
function onSegment(x, y, link) {
  const { from, to, width } = link;
  const dx = to.cx - from.cx;
  const dy = to.cy - from.cy;
  const len2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((x - from.cx) * dx + (y - from.cy) * dy) / len2));
  const px = from.cx + t * dx;
  const py = from.cy + t * dy;
  return (x - px) ** 2 + (y - py) ** 2 <= (width / 2) ** 2;
}

/** The colour at a point, or null for transparent. Nodes draw over links. */
function colourAt(x, y) {
  for (const node of NODES) if (inCircle(x, y, node)) return node.colour;
  for (const link of LINKS) if (onSegment(x, y, link)) return link.colour;
  return null;
}

/** Render RGBA, supersampled then box-filtered down. */
function render() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const hit = colourAt(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
          if (hit) {
            r += hit[0];
            g += hit[1];
            b += hit[2];
            a += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (y * SIZE + x) * 4;
      // Un-premultiply so partially-covered edge pixels keep full colour.
      if (a > 0) {
        const cov = a / n / 255;
        px[i] = Math.round(r / n / cov);
        px[i + 1] = Math.round(g / n / cov);
        px[i + 2] = Math.round(b / n / cov);
        px[i + 3] = Math.round(a / n);
      }
    }
  }
  return px;
}

/** One PNG chunk: length + type + data + CRC32. */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function encodePng(px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // truecolour + alpha
  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0;
    px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const png = encodePng(render());
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, png);
console.log(
  `✅ ${outPath} — ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB, sha256 ${createHash("sha256").update(png).digest("hex").slice(0, 12)}…`,
);
