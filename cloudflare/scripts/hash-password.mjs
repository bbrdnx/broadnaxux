#!/usr/bin/env node
/**
 * hash-password.mjs — generate ADMIN_PASSWORD_HASH for the admin Worker.
 *
 * Usage:
 *   node scripts/hash-password.mjs
 *
 * Prompts for a password, prints the hash, and shows you the wrangler
 * command to set it as a secret. The hash format is "salt:iter:hash"
 * (PBKDF2 SHA-256, 100k iterations) — matches verifyPassword() in the
 * admin Worker.
 */

import { randomBytes, pbkdf2Sync } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const ITERATIONS = 100_000;
const KEY_LEN = 32;
const SALT_LEN = 16;

const rl = createInterface({ input: stdin, output: stdout });

const password = await rl.question('Admin password (won\'t echo, but typing is fine): ');
const confirm = await rl.question('Confirm password: ');
rl.close();

if (password !== confirm) {
  console.error('\n✗ Passwords do not match.');
  process.exit(1);
}
if (password.length < 12) {
  console.error('\n✗ Password must be at least 12 characters.');
  process.exit(1);
}

const salt = randomBytes(SALT_LEN);
const hash = pbkdf2Sync(password, salt, ITERATIONS, KEY_LEN, 'sha256');
const formatted = `${salt.toString('base64')}:${ITERATIONS}:${hash.toString('base64')}`;

console.log('\n✓ Hash generated.\n');
console.log('Copy this value:\n');
console.log('  ' + formatted + '\n');
console.log('Set it as a Worker secret:\n');
console.log('  cd workers/admin');
console.log('  npx wrangler secret put ADMIN_PASSWORD_HASH');
console.log('  # paste the hash when prompted\n');
console.log('Or in one shot (zsh/bash):\n');
console.log(`  echo '${formatted}' | npx wrangler secret put ADMIN_PASSWORD_HASH\n`);
