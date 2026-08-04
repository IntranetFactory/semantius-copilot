#!/usr/bin/env node
/**
 * Node smoke test (plan §2/§11.7): proves the core agent-bundle flow —
 * scan agents/ → bundle (JSONC config + INSTRUCTIONS.md + skills) → validate →
 * provision (reconstruct) → discoverable layout → script executes and calls
 * the API — runs with ZERO Cloudflare present.
 *
 * The sandbox seam is satisfied by a local-fs adapter (Node fs + child
 * shell), state is in-memory, and there is no egress broker: the "API" is a
 * local HTTP echo server, so the test is fully offline. No import in this
 * file or in @semantius-copilot/core touches anything Cloudflare.
 */
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

// Child processes that call back into the in-process echo server must run
// async — a sync exec blocks the event loop and deadlocks the server.
const execFile = promisify(execFileCb);
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAgentBundleFromDir, scanAgentsDir } from '../core/src/node.js';
import { provisionAgentSkills } from '../core/src/provision.js';
import { normalizeModelSpecifier, validateAgentBundle } from '../core/src/agent.js';
import { BundleValidationError } from '../core/src/bundle.js';

const here = dirname(fileURLToPath(import.meta.url));
const agentDir = join(here, '..', 'agents', 'hoth-trip-planner');

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
}

// --- local sandbox adapter over a temp "workspace" (the sandbox seam) -----
const workspace = mkdtempSync(join(tmpdir(), 'semantius-copilot-smoke-'));
let rpcCount = 0;
const localSandbox = {
  async writeFile(path, content) {
    rpcCount++;
    const real = join(workspace, path.replace(/^\//, ''));
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, content, 'utf-8');
  },
  async exec(command) {
    rpcCount++;
    // Rebase the absolute container paths onto the temp workspace and run
    // through a POSIX shell (Git Bash ships one on Windows).
    const rebased = command
      .replaceAll('/workspace/', `${workspace.replaceAll('\\', '/')}/workspace/`)
      .replaceAll("'/tmp/", `'${workspace.replaceAll('\\', '/')}/tmp/`);
    try {
      const stdout = execFileSync('bash', ['-lc', rebased], { encoding: 'utf-8' });
      return { exitCode: 0, stdout, stderr: '' };
    } catch (err) {
      return { exitCode: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? String(err) };
    }
  },
};

// --- local echo server (no internet, no egress broker) ---------------------
const echo = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ headers: req.headers, json: safeParse(body), url: req.url }));
  });
});
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve));
const echoUrl = `http://127.0.0.1:${echo.address().port}/post`;

// Scratch agents/ tree for the scanner/JSONC/zero-skill checks.
const scratchAgents = mkdtempSync(join(tmpdir(), 'semantius-copilot-agents-'));

try {
  // 1. bundle + round-trip is exercised by the bundler; here: create + validate
  const bundle = createAgentBundleFromDir(agentDir);
  check(
    'agent bundle created & valid',
    bundle.agentName === 'hoth-trip-planner' && Object.keys(bundle.skills.planner ?? {}).length >= 4,
  );
  check(
    'instructions merged from INSTRUCTIONS.md',
    bundle.instructions === readFileSync(join(agentDir, 'INSTRUCTIONS.md'), 'utf-8').trim(),
  );
  check(
    'proxy_whitelist carried into the bundle',
    Array.isArray(bundle.proxyWhitelist) && bundle.proxyWhitelist.includes('postman-echo.com'),
  );

  // 2. model prefix rule (decided): known provider as-is, else openrouter/
  check('normalize: unqualified gets openrouter/ prefix', normalizeModelSpecifier('deepseek/deepseek-v4-flash') === 'openrouter/deepseek/deepseek-v4-flash');
  check('normalize: openrouter/ kept as-is', normalizeModelSpecifier('openrouter/x/y') === 'openrouter/x/y');
  check('normalize: custom/ kept as-is', normalizeModelSpecifier('custom/my-model') === 'custom/my-model');

  // 3. agents/ scanner + JSONC config: comments/trailing commas parse; a
  //    folder without agent.jsonc is skipped, not an error.
  const jsoncAgent = join(scratchAgents, 'commented-agent');
  mkdirSync(jsoncAgent, { recursive: true });
  writeFileSync(
    join(jsoncAgent, 'agent.jsonc'),
    '{\n  // line comment\n  "instructions": "Scratch agent.", /* block */\n  "model": "deepseek/deepseek-v4-flash",\n}\n',
    'utf-8',
  );
  mkdirSync(join(scratchAgents, 'no-config'), { recursive: true });
  const scan = scanAgentsDir(scratchAgents);
  check('scanAgentsDir: agent.jsonc folders found, others skipped', scan.agents.join() === 'commented-agent' && scan.skipped.join() === 'no-config');
  const jsoncBundle = createAgentBundleFromDir(jsoncAgent);
  check('JSONC config parsed (comments + trailing comma) & model normalized', jsoncBundle.model === 'openrouter/deepseek/deepseek-v4-flash');

  // 4. hostile bundles rejected before reconstruction (plan §8/§13)
  for (const [label, mutate] of [
    ['path traversal ..', (b) => ({ ...b, skills: { ...b.skills, planner: { ...b.skills.planner, '../evil.md': 'x' } } })],
    ['absolute path', (b) => ({ ...b, skills: { ...b.skills, planner: { ...b.skills.planner, '/etc/passwd': 'x' } } })],
    ['backslash path', (b) => ({ ...b, skills: { ...b.skills, planner: { ...b.skills.planner, 'refs\\evil.md': 'x' } } })],
    ['missing per-skill SKILL.md', (b) => ({ ...b, skills: { planner: { 'references/only.md': 'x' } } })],
    ['oversize file', (b) => ({ ...b, skills: { ...b.skills, planner: { ...b.skills.planner, 'big.md': 'x'.repeat(300 * 1024) } } })],
    ['bad skill name', (b) => ({ ...b, skills: { ...b.skills, 'Bad Name': { 'SKILL.md': 'x' } } })],
    ['too many skills', (b) => ({ ...b, skills: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`s${i}`, { 'SKILL.md': 'x' }])) })],
    ['missing instructions', (b) => ({ ...b, instructions: '' })],
    ['bad modelBaseUrl', (b) => ({ ...b, modelBaseUrl: 'ftp://nope' })],
    ['proxyWhitelist not an array', (b) => ({ ...b, proxyWhitelist: '*.semantius.ai' })],
    ['proxyWhitelist bad glob', (b) => ({ ...b, proxyWhitelist: ['evil/*', 'ok.com'] })],
    ['proxyWhitelist too many hosts', (b) => ({ ...b, proxyWhitelist: Array.from({ length: 33 }, (_, i) => `h${i}.com`) })],
  ]) {
    let rejected = false;
    try { validateAgentBundle(mutate(structuredClone(bundle))); } catch (err) { rejected = err instanceof BundleValidationError; }
    check(`hostile bundle rejected: ${label}`, rejected);
  }

  // 5. clean base: skills dir starts empty (absent)
  check('clean base (no skill before provision)', !existsSync(join(workspace, 'workspace/.agents/skills/planner')));

  // 6. provision: absent → reconstructed (all skills, one tar, 2 RPCs)
  rpcCount = 0;
  const first = await provisionAgentSkills(localSandbox, bundle);
  check('provision reconstructs on absent dir', first.reconstructed === true);
  check('provision is 2 RPCs regardless of skill count', rpcCount === 2, `rpcs=${rpcCount}`);

  // 7. byte-identical reconstruction (single-source check, C3 shape)
  let identical = true;
  for (const [skillName, files] of Object.entries(bundle.skills)) {
    for (const [relPath, content] of Object.entries(files)) {
      const real = join(workspace, 'workspace/.agents/skills', skillName, ...relPath.split('/'));
      if (!existsSync(real) || readFileSync(real, 'utf-8') !== content) identical = false;
    }
  }
  check('reconstructed files byte-identical to bundle', identical);

  // 8. immutable-per-id: second provision is a no-op (present)
  const second = await provisionAgentSkills(localSandbox, bundle);
  check('re-provision is absent→write only (no overwrite)', second.reconstructed === false);

  // 9. zero-skill agent (semantius-admin shape): valid, provisions nothing
  rpcCount = 0;
  const zero = await provisionAgentSkills(localSandbox, jsoncBundle);
  check('zero-skill agent provisions with 0 RPCs', zero.reconstructed === false && zero.skillDirs.length === 0 && rpcCount === 0, `rpcs=${rpcCount}`);

  // 10. the skill script runs from the reconstructed dir and calls the API
  const scriptPath = join(workspace, 'workspace/.agents/skills/planner/scripts/opening-times.js');
  const { stdout } = await execFile(
    process.execPath,
    [scriptPath, '--sites=Echo Base Thermal Springs', '--from=2026-08-01', '--to=2026-08-02'],
    { encoding: 'utf-8', env: { ...process.env, HOTH_API_URL: echoUrl }, timeout: 30000 },
  );
  const parsed = JSON.parse(stdout);
  check(
    'script runs from reconstructed skill and returns opening times',
    parsed[0]?.site_id === 'echo_base_thermal_springs' && parsed[0]?.opening_times?.length === 2,
  );

  // 11. the script sent NO Authorization header (zero-trust shape)
  const { stdout: debugOut } = await execFile(
    process.execPath,
    [scriptPath, '--sites=Echo Base Thermal Springs', '--from=2026-08-01', '--to=2026-08-01', '--debug-echo'],
    { encoding: 'utf-8', env: { ...process.env, HOTH_API_URL: echoUrl }, timeout: 30000 },
  );
  const received = JSON.parse(debugOut).upstream_received_headers ?? {};
  check('container-side request carries no Authorization header', !('authorization' in received));
} finally {
  echo.close();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(scratchAgents, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nnode smoke test: ALL PASS (zero Cloudflare imports)' : `\nnode smoke test: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
