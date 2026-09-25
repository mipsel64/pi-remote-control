// Recolors the default app icon's background into dist/icons/<color>.* so the settings can pick a home-screen icon.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = name => path.join(root, 'public', name);
const out = path.join(root, 'dist', 'icons');
const { default: base, ...colors } = JSON.parse(readFileSync(path.join(root, 'src/icon-colors.json'), 'utf8'));
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const [from, to] = [rgb(base), [0xfa, 0xfa, 0xfa]];

// 8-bit RGB/RGBA only, which is what public/ ships.
function decode(file) {
  const png = readFileSync(file);
  const idat = [];
  let width, height, bpp;
  for (let i = 8; i < png.length;) {
    const length = png.readUInt32BE(i), type = png.toString('latin1', i + 4, i + 8), data = png.subarray(i + 8, i + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.ok(data[8] === 8 && [2, 6].includes(data[9]) && data[12] === 0, `${file}: unsupported PNG format`);
      bpp = data[9] === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    i += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat)), stride = width * bpp, pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], row = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const a = x >= bpp ? pixels[i - bpp] : 0, b = y ? pixels[i - stride] : 0, c = x >= bpp && y ? pixels[i - stride - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      pixels[i] = raw[row + x] + [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][filter];
    }
  }
  return { width, height, bpp, pixels };
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), frame = Buffer.alloc(body.length + 8);
  frame.writeUInt32BE(data.length, 0);
  body.copy(frame, 4);
  frame.writeUInt32BE(crc32(body), body.length + 4);
  return frame;
}

function encode({ width, height, bpp, pixels }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header.set([8, bpp === 4 ? 6 : 2, 0, 0, 0], 8);
  const stride = width * bpp, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// Pixels are anti-aliased blends of the dark background and the light mark; keep each pixel's blend, swap the background.
function recolor(image, color) {
  const { pixels, bpp } = image, target = rgb(color), next = Buffer.from(pixels);
  for (let i = 0; i < pixels.length; i += bpp) {
    const t = Math.min(1, Math.max(0, (pixels[i] + pixels[i + 1] + pixels[i + 2] - from[0] - from[1] - from[2]) / (to[0] + to[1] + to[2] - from[0] - from[1] - from[2])));
    for (let c = 0; c < 3; c++) next[i + c] = Math.round(target[c] + (to[c] - target[c]) * t);
  }
  return { ...image, pixels: next };
}

mkdirSync(out, { recursive: true });
const svg = readFileSync(pub('icon.svg'), 'utf8');
assert.ok(svg.includes(`fill="${base}"`), 'icon.svg background colour changed; update src/icon-colors.json');
const manifest = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8'));
const sources = { 180: decode(pub('apple-touch-icon.png')), 192: decode(pub('icon-192.png')), 512: decode(pub('icon-512.png')) };
for (const [name, color] of Object.entries(colors)) {
  writeFileSync(path.join(out, `${name}.svg`), svg.replace(`fill="${base}"`, `fill="${color}"`));
  for (const [size, image] of Object.entries(sources)) {
    const file = path.join(out, `${name}-${size}.png`);
    writeFileSync(file, encode(recolor(image, color)));
    // Round-trip check: the background above the mark must come out as exactly the chosen colour.
    const back = decode(file), at = (Math.floor(back.height / 10) * back.width + Math.floor(back.width / 2)) * back.bpp;
    assert.deepEqual([...back.pixels.subarray(at, at + 3)], rgb(color), `${file}: background not recoloured`);
  }
  writeFileSync(path.join(out, `${name}.webmanifest`), JSON.stringify({ ...manifest,
    icons: manifest.icons.map(icon => ({ ...icon, src: `/icons/${name}-${icon.sizes.split('x')[0]}.png` })) }));
}
