import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const assets = readdirSync(path.join(dist, 'assets'), { withFileTypes: true })
  .filter(file => file.isFile()).map(file => `/assets/${file.name}`).sort();
if (!assets.length) throw new Error('No built frontend assets to precache');

const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
const file = path.join(dist, 'sw.js');
const source = readFileSync(file, 'utf8');
const cache = createHash('sha256').update(html).update(JSON.stringify(assets)).update(source).digest('hex').slice(0, 12);
const version = "const CACHE = 'pi-remote-shell-v3';";
const empty = 'const PRECACHE = [];';
if (!source.includes(version) || !source.includes(empty)) throw new Error('Unexpected service worker template');
writeFileSync(file, source.replace(version, `const CACHE = 'pi-remote-shell-${cache}';`)
  .replace(empty, `const PRECACHE = ${JSON.stringify(assets)};`));
