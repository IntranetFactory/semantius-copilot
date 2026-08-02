/**
 * Node-only helpers (fs access): the agent bundler library and round-trip
 * assert. Kept out of ./index.js so the Workers backends never import node:fs
 * (or jsonc-parser — agent.jsonc is only ever parsed here at build time).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

import { mergeInstructions, normalizeModelSpecifier, validateAgentBundle, validateAgentConfig } from './agent.js';

export * from './index.js';

export const AGENT_CONFIG_FILE = 'agent.jsonc';

/**
 * Scan an agents/ folder: subfolders WITH agent.jsonc are agents; subfolders
 * without it are skipped (returned so the caller can warn).
 *
 * @param {string} agentsDir
 * @returns {{ agents: string[], skipped: string[] }} sorted folder names
 */
export function scanAgentsDir(agentsDir) {
  const agents = [];
  const skipped = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = existsSync(join(agentsDir, entry.name, AGENT_CONFIG_FILE)) ? agents : skipped;
    target.push(entry.name);
  }
  return { agents: agents.sort(), skipped: skipped.sort() };
}

/**
 * Build an agent bundle from an agents/<name>/ folder (plan §5):
 *   - agent.jsonc (REQUIRED, JSONC with comments/trailing commas) validated
 *     against the contract in agents/agent.schema.json,
 *   - optional INSTRUCTIONS.md appended to the config's instructions,
 *   - `model` normalized via the prefix rule (unqualified -> openrouter/),
 *   - every skills/<skill>/ subfolder walked into a files map.
 * `version` is a content hash over config + sorted skill files, so any change
 * is a visibly different bundle (and must be a new session id, §6).
 *
 * @param {string} agentDir path to the agent folder (its basename = agentName)
 * @param {{ baseImage?: string }} [options]
 * @returns {import('./agent.js').AgentBundle}
 */
export function createAgentBundleFromDir(agentDir, options = {}) {
  const agentName = agentDir.replaceAll('\\', '/').split('/').filter(Boolean).at(-1);

  const configPath = join(agentDir, AGENT_CONFIG_FILE);
  const errors = [];
  const config = parseJsonc(readFileSync(configPath, 'utf-8'), errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const { error, offset } = errors[0];
    throw new Error(`${configPath}: JSONC parse error ${printParseErrorCode(error)} at offset ${offset}`);
  }
  validateAgentConfig(config);

  const mdPath = join(agentDir, 'INSTRUCTIONS.md');
  const instructions = mergeInstructions(
    config.instructions,
    existsSync(mdPath) ? readFileSync(mdPath, 'utf-8') : undefined,
  );
  const model = config.model ? normalizeModelSpecifier(config.model) : undefined;

  const skills = {};
  const skillsRoot = join(agentDir, 'skills');
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const files = {};
      const skillDir = join(skillsRoot, entry.name);
      for (const relPath of walk(skillDir)) {
        // Read as utf-8; normalize path separators so bundles built on Windows
        // are byte-identical to the Docker COPY of the same folder (plan §13 C3).
        files[relPath.split(sep).join('/')] = readFileSync(join(skillDir, relPath), 'utf-8');
      }
      skills[entry.name] = files;
    }
  }

  const hash = createHash('sha256');
  hash.update(agentName).update('\0');
  hash.update(instructions).update('\0');
  hash.update(model ?? '').update('\0');
  hash.update(config.model_base_url ?? '').update('\0');
  hash.update((config.proxy_whitelist ?? []).join(',')).update('\0');
  hash.update(config.welcome ? JSON.stringify(config.welcome) : '').update('\0');
  hash.update(options.baseImage ?? 'node').update('\0');
  for (const skillName of Object.keys(skills).sort()) {
    hash.update(skillName).update('\0');
    for (const relPath of Object.keys(skills[skillName]).sort()) {
      hash.update(relPath).update('\0').update(skills[skillName][relPath]).update('\0');
    }
  }

  const bundle = {
    agentName,
    version: hash.digest('hex').slice(0, 16),
    baseImage: options.baseImage ?? 'node',
    instructions,
    ...(model ? { model } : {}),
    ...(config.model_base_url ? { modelBaseUrl: config.model_base_url } : {}),
    ...(config.proxy_whitelist ? { proxyWhitelist: config.proxy_whitelist } : {}),
    ...(config.welcome ? { welcome: config.welcome } : {}),
    skills,
  };
  return validateAgentBundle(bundle);
}

/**
 * Round-trip assert (plan §5): each bundled skill -> reconstruct ->
 * byte-identical to agents/<name>/skills/<skill>/. Throws on any drift.
 *
 * @param {string} agentDir
 * @param {import('./agent.js').AgentBundle} bundle
 * @param {string} scratchDir temp directory to reconstruct into
 * @returns {{ files: number, skills: number }}
 */
export function assertAgentRoundTrip(agentDir, bundle, scratchDir) {
  let totalFiles = 0;
  for (const [skillName, files] of Object.entries(bundle.skills)) {
    const sourceDir = join(agentDir, 'skills', skillName);
    const outDir = join(scratchDir, `roundtrip-${bundle.agentName}-${skillName}-${bundle.version}`);
    for (const [relPath, content] of Object.entries(files)) {
      const target = join(outDir, ...relPath.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
    }
    const sourceFiles = walk(sourceDir).map((p) => p.split(sep).join('/')).sort();
    const rebuiltFiles = walk(outDir).map((p) => p.split(sep).join('/')).sort();
    if (JSON.stringify(sourceFiles) !== JSON.stringify(rebuiltFiles)) {
      throw new Error(`round-trip file set mismatch (${skillName}):\n  source: ${sourceFiles}\n  rebuilt: ${rebuiltFiles}`);
    }
    for (const relPath of sourceFiles) {
      const a = readFileSync(join(sourceDir, ...relPath.split('/')));
      const b = readFileSync(join(outDir, ...relPath.split('/')));
      if (!a.equals(b)) throw new Error(`round-trip byte mismatch: ${skillName}/${relPath}`);
    }
    totalFiles += sourceFiles.length;
  }
  return { files: totalFiles, skills: Object.keys(bundle.skills).length };
}

/**
 * Per-file sha256 of one skill's files map, for the C3 triple-hash comparison.
 *
 * @param {Record<string, string>} files
 * @returns {Record<string, string>} rel-path -> sha256 hex
 */
export function skillFileHashes(files) {
  const hashes = {};
  for (const relPath of Object.keys(files).sort()) {
    hashes[relPath] = createHash('sha256').update(files[relPath]).digest('hex');
  }
  return hashes;
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlink not allowed in skill folder: ${full}`);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) {
      if (statSync(full).size === 0) throw new Error(`empty file in skill folder: ${full}`);
      out.push(relative(base, full));
    }
  }
  return out;
}
