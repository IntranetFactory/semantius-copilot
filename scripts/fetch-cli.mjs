#!/usr/bin/env node
/**
 * fetch-cli.mjs — make linux-x64/semantius-linux-x64 (the semantius CLI baked into
 * the backend-b container image) match the release pinned in linux-x64/semantius-cli.json.
 *
 *   node scripts/fetch-cli.mjs            # ensure the pinned release (run by `pnpm deploy:b`)
 *   node scripts/fetch-cli.mjs latest     # re-pin to the latest release, then ensure it
 *   node scripts/fetch-cli.mjs v0.8.19    # re-pin to a tag, then ensure it
 *
 * The binary is NOT committed: it outgrew GitHub's 100 MiB file limit (v0.8.19 is
 * 104.8 MiB), so the committed pin { version, sha256 } is what decides which CLI ships.
 * A local binary whose sha256 already matches is left alone; anything else is
 * downloaded from the GitHub release, verified against the pin, and only then
 * moved into place. Re-pinning reads the hash from the release's checksums.txt.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/semantius/semantius-cli';
const ASSET = 'semantius-linux-x64';
const bin = join(root, 'linux-x64', ASSET);
const pinFile = join(root, 'linux-x64', 'semantius-cli.json');

const die = (msg) => {
  console.error(`fetch-cli: ${msg}`);
  process.exit(1);
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) die(`${res.status} ${res.statusText} for ${url}`);
  return res;
}

let pin;
const arg = process.argv[2];
if (arg) {
  let version = arg;
  if (version === 'latest') {
    // /releases/latest redirects to /releases/tag/<tag> — no API token needed.
    version = (await get(`${REPO}/releases/latest`)).url.split('/').pop();
  }
  if (!version.startsWith('v')) version = `v${version}`;
  if (!/^v\d/.test(version)) die(`could not resolve a release tag (got '${version}')`);
  const sums = await (await get(`${REPO}/releases/download/${version}/checksums.txt`)).text();
  const line = sums.split(/\r?\n/).find((l) => [ASSET, `*${ASSET}`].includes(l.trim().split(/\s+/)[1]));
  if (!line) die(`no ${ASSET} entry in ${version}/checksums.txt`);
  pin = { version, sha256: line.trim().split(/\s+/)[0] };
  writeFileSync(pinFile, `${JSON.stringify(pin, null, 2)}\n`);
  console.log(`==> pinned semantius CLI ${pin.version} (${pin.sha256})`);
} else {
  if (!existsSync(pinFile)) die(`missing ${pinFile}; run: node scripts/fetch-cli.mjs latest`);
  pin = JSON.parse(readFileSync(pinFile, 'utf8'));
}

if (existsSync(bin) && sha256(readFileSync(bin)) === pin.sha256) {
  console.log(`==> semantius CLI ${pin.version} already in place`);
} else {
  const url = `${REPO}/releases/download/${pin.version}/${ASSET}`;
  console.log(`==> downloading semantius CLI ${pin.version}: ${url}`);
  const buf = Buffer.from(await (await get(url)).arrayBuffer());
  const got = sha256(buf);
  if (got !== pin.sha256) die(`checksum mismatch for ${ASSET}: got ${got}, want ${pin.sha256}`);
  mkdirSync(dirname(bin), { recursive: true });
  const tmp = `${bin}.download`;
  writeFileSync(tmp, buf);
  chmodSync(tmp, 0o755);
  rmSync(bin, { force: true });
  renameSync(tmp, bin);
  console.log(`    installed linux-x64/${ASSET}`);
}
