#!/usr/bin/env node
// scripts/check.mjs — offline static check: syntax + policy scan.
// 1. `node --check` on every JS source file (modules and workers).
// 2. Scan for forbidden patterns (eval, network access, remote URLs, document.write).
// 3. Validate manifest.webmanifest and package.json parse.

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function walk(dir, acc = []) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.github' || entry.name === '.vibe') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const files = await walk(root);
const jsFiles = files.filter((f) => /\.(mjs|js)$/.test(f) && !f.startsWith(path.join(root, 'test', 'fixtures')));
const htmlFiles = files.filter((f) => f.endsWith('.html'));
const jsonFiles = files.filter((f) => f.endsWith('.json') || f.endsWith('.webmanifest'));

let failures = 0;

// --- 1. syntax checks ---
const nodeBin = process.execPath;
let checks = 0;
for (const file of jsFiles) {
  checks += 1;
  const r = spawnSync(nodeBin, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failures += 1;
    console.error(`✗ syntax ${path.relative(root, file)}\n${r.stderr}`);
  }
}
console.log(`Syntax-checked ${checks} files with node --check.`);

// --- 2. policy scan ---
// The app must make no runtime network calls and contain no remote URLs.
// Exceptions the scan itself must understand (they make no external request):
//  - sw.js uses fetch() only for same-origin shell assets (offline cache pattern)
//  - the SVG namespace constant (http://www.w3.org/2000/svg) is an XML identifier, not a URL fetch
//  - 'http://localhost' is used as a URL-parsing base in the dev server
const SELF = path.resolve(fileURLToPath(import.meta.url));
const FORBIDDEN = [
  { re: /\beval\s*\(/, why: 'eval is not allowed' },
  { re: /new\s+Function\s*\(/, why: 'dynamic code generation is not allowed' },
  { re: /\bdocument\.write\s*\(/, why: 'document.write is not allowed' },
  { re: /\bfetch\s*\(/, why: 'no runtime network requests (fetch)', skip: (rel) => rel === 'sw.js' },
  { re: /\bXMLHttpRequest\b/, why: 'no runtime network requests (XHR)' },
  { re: /\bWebSocket\b/, why: 'no runtime network requests (WebSocket)' },
  { re: /\bEventSource\b/, why: 'no runtime network requests (SSE)' },
  {
    re: /https?:\/\/(?!www\.reddit\.com|github\.com|www\.w3\.org\/2000\/svg|localhost)[a-z0-9.-]+/i,
    why: 'remote URL outside documented sources (README allowed)',
  },
];

for (const file of [...jsFiles, ...htmlFiles]) {
  if (file === SELF) continue; // the checker does not scan its own pattern strings
  const rel = path.relative(root, file);
  if (rel.startsWith('README') || rel === path.join('test', 'fixtures', 'sample-import.csv')) continue;
  if (rel === 'sw.js') {
    // the service worker must never touch anything off-device
    const sw = await fs.readFile(file, 'utf8');
    if (!sw.includes('url.origin !== self.location.origin')) {
      failures += 1;
      console.error('✗ sw.js — missing same-origin guard for fetch handling');
    }
  }
  const text = await fs.readFile(file, 'utf8');
  for (const { re, why, skip } of FORBIDDEN) {
    if (skip && skip(rel)) continue;
    const m = re.exec(text);
    if (m) {
      const line = text.slice(0, m.index).split('\n').length;
      failures += 1;
      console.error(`✗ ${rel}:${line} — ${why}`);
    }
  }
}
console.log('Scanned JS/HTML sources for forbidden patterns (eval, network calls, remote URLs).');

// --- 3. JSON validation ---
for (const file of jsonFiles) {
  try {
    JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    failures += 1;
    console.error(`✗ ${path.relative(root, file)} — invalid JSON: ${err.message}`);
  }
}
console.log(`Validated ${jsonFiles.length} JSON/manifest files.`);

if (failures > 0) {
  console.error(`\ncheck FAILED with ${failures} issue(s).`);
  process.exit(1);
}
console.log('\ncheck PASSED.');
