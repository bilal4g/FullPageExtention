#!/usr/bin/env node
/**
 * FullPage – Microsoft Edge Add-ons release pipeline.
 *
 * Dependency-free (Node 18+). Performs, in order:
 *   1. Build   – stage publishable files into ./build (dev/OS junk excluded)
 *   2. Version – bump manifest.json version (patch by default)
 *   3. Package – create ./dist/fullpage-v<version>.zip
 *   4. Validate– verify manifest + declared icons + no leaked junk
 *   5. Publish – upload + submit via the official Edge Add-ons API v1.1
 *               (only when EDGE_CLIENT_ID / EDGE_API_KEY / EDGE_PRODUCT_ID
 *                are all present; otherwise stops after packaging)
 *
 * Secrets are read from environment variables ONLY and are never logged.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, cpSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = process.cwd();
const MANIFEST = join(ROOT, 'manifest.json');
const BUILD_DIR = join(ROOT, 'build');
const DIST_DIR = join(ROOT, 'dist');

// Files/dirs that must never ship inside the extension package.
const EXCLUDES = new Set([
  'build', 'dist', 'scripts', 'node_modules', '.git', '.github',
  'package.json', 'package-lock.json', '.gitignore', '.env', '.env.example',
  'README.md', 'desktop.ini', '.DS_Store', 'Thumbs.db'
]);
const isExcluded = (name) => EXCLUDES.has(name) || name.endsWith('.cmd') || name.endsWith('.zip');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const getVal = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const bumpKind = has('--major') ? 'major' : has('--minor') ? 'minor' : 'patch';
const setVersion = getVal('--set');
const noPublish = has('--no-publish') || has('--package-only');
const dryRun = has('--dry-run');

const log = (...a) => console.log('[edge-release]', ...a);
const fail = (msg) => { console.error('[edge-release] ERROR:', msg); process.exit(1); };

// ---- 1. read manifest -------------------------------------------------
if (!existsSync(MANIFEST)) fail(`manifest.json not found in ${ROOT}`);
let manifest;
try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')); }
catch (e) { fail('manifest.json is not valid JSON: ' + e.message); }

// ---- 2. bump version --------------------------------------------------
function bump(v, kind) {
  const parts = String(v || '0.0.0').split('.').map((n) => parseInt(n, 10) || 0);
  while (parts.length < 3) parts.push(0);
  if (kind === 'major') { parts[0]++; parts[1] = 0; parts[2] = 0; }
  else if (kind === 'minor') { parts[1]++; parts[2] = 0; }
  else { parts[2]++; }
  return parts.slice(0, 3).join('.');
}
const oldVersion = manifest.version || '0.0.0';
const newVersion = setVersion || bump(oldVersion, bumpKind);
if (!/^\d+(\.\d+){0,3}$/.test(newVersion)) fail('Invalid target version: ' + newVersion);
log(`Version: ${oldVersion} -> ${newVersion}`);
if (!dryRun) {
  manifest.version = newVersion;
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
}

// ---- 3. stage build ---------------------------------------------------
function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (isExcluded(entry.name)) continue;
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else cpSync(s, d);
  }
}
rmSync(BUILD_DIR, { recursive: true, force: true });
copyTree(ROOT, BUILD_DIR);
log('Staged publishable files into build/');

// ---- 4. validate ------------------------------------------------------
function validate() {
  const m = JSON.parse(readFileSync(join(BUILD_DIR, 'manifest.json'), 'utf8'));
  const missing = ['manifest_version', 'name', 'version'].filter((k) => !m[k]);
  if (missing.length) fail('manifest missing required fields: ' + missing.join(', '));

  const iconPaths = new Set();
  if (m.icons) Object.values(m.icons).forEach((p) => iconPaths.add(p));
  for (const key of ['action', 'browser_action']) {
    const di = m[key] && m[key].default_icon;
    if (!di) continue;
    if (typeof di === 'string') iconPaths.add(di);
    else Object.values(di).forEach((p) => iconPaths.add(p));
  }
  for (const p of iconPaths) {
    if (!existsSync(join(BUILD_DIR, p))) fail('Declared icon not found in package: ' + p);
  }
  if (existsSync(join(BUILD_DIR, 'desktop.ini'))) fail('desktop.ini leaked into the package.');
  log(`Package validation passed (name="${m.name}", version=${m.version}).`);
}
validate();

// ---- 5. package (zip) -------------------------------------------------
mkdirSync(DIST_DIR, { recursive: true });
const zipPath = join(DIST_DIR, `fullpage-v${newVersion}.zip`);
rmSync(zipPath, { force: true });
function makeZip() {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -Path "${join(BUILD_DIR, '*')}" -DestinationPath "${zipPath}" -Force`],
      { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: BUILD_DIR, stdio: 'inherit' });
  }
}
makeZip();
if (!existsSync(zipPath) || statSync(zipPath).size === 0) fail('ZIP package was not created.');
log(`Created package: ${relative(ROOT, zipPath)} (${statSync(zipPath).size} bytes)`);

// ---- 6. publish -------------------------------------------------------
const clientId = process.env.EDGE_CLIENT_ID;
const apiKey = process.env.EDGE_API_KEY;
const productId = process.env.EDGE_PRODUCT_ID;

if (noPublish) { log('--no-publish set: packaging only. Done.'); process.exit(0); }
if (dryRun) { log('--dry-run set: skipped publish. Done.'); process.exit(0); }
if (!clientId || !apiKey || !productId) {
  log('Publish skipped: EDGE_CLIENT_ID / EDGE_API_KEY / EDGE_PRODUCT_ID are not all set.');
  log(`The package is ready at ${relative(ROOT, zipPath)}. Configure the secrets to enable one-command publishing.`);
  process.exit(0);
}

const API = `https://api.addons.microsoftedge.microsoft.com/v1/products/${productId}/submissions`;
const authHeaders = { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function poll(url, label) {
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: authHeaders });
    const data = await res.json().catch(() => ({}));
    const status = data.status || data.Status;
    log(`${label} status: ${status || res.status}`);
    if (status === 'Succeeded') return data;
    if (status === 'Failed') fail(`${label} failed: ${JSON.stringify(data.errors || data.message || data)}`);
    await sleep(5000);
  }
  fail(`${label} timed out after 10 minutes.`);
}

async function publish() {
  const zip = readFileSync(zipPath);
  log('Uploading package to the Microsoft Edge Add-ons Store...');
  const up = await fetch(`${API}/draft/package`, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/zip' },
    body: zip
  });
  if (up.status !== 202) fail('Upload failed: HTTP ' + up.status + ' ' + (await up.text().catch(() => '')));
  const opId = up.headers.get('Location');
  if (!opId) fail('Upload did not return an operation id.');
  await poll(`${API}/draft/package/operations/${opId}`, 'Upload');

  log('Submitting for publication...');
  const sub = await fetch(API, {
    method: 'POST',
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ notes: `Automated release v${newVersion}` })
  });
  if (sub.status !== 202) fail('Submit failed: HTTP ' + sub.status + ' ' + (await sub.text().catch(() => '')));
  const subOp = sub.headers.get('Location');
  if (!subOp) fail('Submit did not return an operation id.');
  await poll(`${API}/operations/${subOp}`, 'Publish');

  log(`Published v${newVersion} to the Microsoft Edge Add-ons Store.`);
}
publish().catch((e) => fail(e.stack || String(e)));
