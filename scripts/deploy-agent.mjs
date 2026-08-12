#!/usr/bin/env node
/**
 * deploy-agent.mjs — bundle agents/<name>/ and deploy it to backend B as a
 * named agent definition (KV `agentdef:<key>`, no TTL, overwrite-on-deploy).
 *
 *   API_TOKEN=$(cat .api-token) node scripts/deploy-agent.mjs <name> [--as <key>]
 *   API_TOKEN=$(cat .api-token) node scripts/deploy-agent.mjs --all
 *
 * `--as <key>` deploys the bundle under a different KV key than its folder
 * name (generic alias mechanism; nothing in the app depends on an alias —
 * the GitHub channel reads `agentdef:hoth-trip-planner` directly):
 *   node scripts/deploy-agent.mjs <name> --as <alias-key>
 *
 * Builds fresh from agents/<name>/ via createAgentBundleFromDir (same loader
 * as bundle.mjs), so it never depends on a stale dist-bundle artifact. The
 * server re-validates at PUT /agents/:key before writing (the trust boundary);
 * sessions then ingest with just { agentName: <key> }.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentBundleFromDir, scanAgentsDir } from '../core/src/node.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const asIndex = args.indexOf('--as');
const alias = asIndex !== -1 ? args[asIndex + 1] : undefined;
if (asIndex !== -1) args.splice(asIndex, 2);
const all = args.includes('--all');
const names = args.filter((a) => !a.startsWith('--'));

if ((all && (names.length > 0 || alias)) || (!all && names.length !== 1) || (asIndex !== -1 && !alias)) {
  console.error('usage: node scripts/deploy-agent.mjs <name> [--as <key>] | --all');
  process.exit(2);
}

const token = process.env.API_TOKEN || readFileSync(join(root, '.api-token'), 'utf8').trim();
const base = process.env.B_URL ?? 'https://semantius-copilot-backend-b.ma532.workers.dev';

const targets = all
  ? scanAgentsDir(join(root, 'agents')).agents.map((name) => ({ name, key: name }))
  : [{ name: names[0], key: alias ?? names[0] }];

let failed = false;
for (const { name, key } of targets) {
  const bundle = createAgentBundleFromDir(join(root, 'agents', name));
  const body = JSON.stringify(bundle);
  const res = await fetch(`${base}/agents/${key}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`FAIL agents/${name} -> agentdef:${key} — ${res.status}: ${text.slice(0, 300)}`);
    failed = true;
    continue;
  }
  const info = JSON.parse(text);
  console.log(`deployed agents/${name} -> agentdef:${key}`);
  console.log(`  agentName: ${info.agentName}`);
  console.log(`  version:   ${info.version}`);
  console.log(`  skills:    ${info.skills.join(', ') || '(none)'}`);
  console.log(`  bytes:     ${info.bytes}`);
  // The server checks the bundle's model against the SAME pi-ai catalog the
  // deployed runtime resolves with (a local check could drift from the
  // worker's bundled catalog). Non-fatal: the definition IS deployed, but
  // sessions run degraded (8k output cap) until the model id is fixed.
  if (info.modelWarning) console.warn(`  ⚠ MODEL WARNING: ${info.modelWarning}`);
}
process.exit(failed ? 1 : 0);
