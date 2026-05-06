#!/usr/bin/env node
/**
 * prepare-public-assets.mjs
 *
 * Copies the static portfolio files from the repo root into
 *   cloudflare/workers/public/public/
 * so wrangler can bundle them as the Worker's static assets.
 *
 * Run from cloudflare/workers/public/  (via `npm run prepare-assets`).
 *
 * The repo root and the destination are both auto-detected so this works
 * no matter which directory you invoke it from.
 */

import { cp, mkdir, rm, stat, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// scripts/ lives at cloudflare/scripts/ → repo root is two levels up
const REPO_ROOT = resolve(__dirname, '..', '..');
const DEST = resolve(REPO_ROOT, 'cloudflare', 'workers', 'public', 'public');

// Cloudflare Workers caps individual static assets at 25 MiB. Skip anything
// over a slightly conservative limit so a single oversized file can't break
// a deploy. (Skipped files are reported, not silently dropped.)
const MAX_ASSET_BYTES = 24 * 1024 * 1024;

// Allowlist — only these top-level entries from the repo root get copied.
const ALLOW = [
  'index.html',
  'resume.html',
  'contact.html',
  'prototype-layout.html',
  'styles.css',
  'favicon.svg',
  'barbara-broadnax-resume.pdf',
  'images',
  // case study pages — every *.html that isn't in the list above:
  'alaska-same-day-change.html',
  'alaska-view-reservation.html',
  'inksoft-design-studio.html',
  'inksoft-ssl.html',
  'ipro-eda.html',
  'ipro-ner.html',
  'ipro-search-redact.html',
];

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function clean(dest) {
  if (!(await exists(dest))) {
    await mkdir(dest, { recursive: true });
    return;
  }
  for (const entry of await readdir(dest)) {
    if (entry === '.gitkeep') continue;
    try {
      await rm(join(dest, entry), { recursive: true, force: true });
    } catch (err) {
      // Best-effort: log and continue. cp { recursive: true } below will
      // overwrite individual files even if we couldn't pre-clean them.
      console.warn(`  ! could not remove ${entry}: ${err.code ?? err.message}`);
    }
  }
}

// Filter passed to fs.cp — returns false for paths that should be skipped.
// We use it to drop files over Workers' static-asset size limit.
const tooLarge = [];
async function copyFilter(src) {
  try {
    const s = await stat(src);
    if (s.isFile() && s.size > MAX_ASSET_BYTES) {
      tooLarge.push({ path: relative(REPO_ROOT, src), size: s.size });
      return false;
    }
  } catch { /* ignore stat errors */ }
  return true;
}

function fmtMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MiB';
}

async function main() {
  console.log(`Source : ${REPO_ROOT}`);
  console.log(`Dest   : ${DEST}`);
  console.log('');

  if (!(await exists(REPO_ROOT))) {
    console.error(`✗ Repo root not found at ${REPO_ROOT}`);
    process.exit(1);
  }

  await clean(DEST);

  let copied = 0, missing = [];
  for (const name of ALLOW) {
    const src = join(REPO_ROOT, name);
    if (!(await exists(src))) {
      missing.push(name);
      continue;
    }
    await cp(src, join(DEST, name), {
      recursive: true,
      force: true,
      filter: copyFilter,
    });
    copied++;
    console.log(`  ✓ ${name}`);
  }

  console.log('');
  console.log(`Copied ${copied} entries.`);
  if (missing.length) {
    console.log(`Skipped (not present in repo): ${missing.join(', ')}`);
  }
  if (tooLarge.length) {
    console.log('');
    console.log(`! Skipped ${tooLarge.length} file(s) over the 24 MiB Workers asset limit:`);
    for (const { path, size } of tooLarge) {
      console.log(`    ${path}  (${fmtMb(size)})`);
    }
    console.log(`  These files were NOT staged for deploy. Compress, replace,`);
    console.log(`  or remove them, then re-run.`);
  }
}

main().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
