import { validateAgentBundle } from './agent.js';
import { makeTarGz, toBase64 } from './tar.js';

/**
 * The sandbox seam: anything that can write a file and run a shell command.
 * Satisfied by the @cloudflare/sandbox client, and by the local-fs adapter
 * in the Node smoke test — no Cloudflare types appear here.
 *
 * @typedef {Object} SandboxLike
 * @property {(command: string) => Promise<{ exitCode?: number, success?: boolean, stdout?: string, stderr?: string }>} exec
 * @property {(path: string, content: string) => Promise<unknown>} writeFile
 */

export const SKILLS_DIR = '/workspace/.agents/skills';

/**
 * Reconstruct a validated agent bundle's skills into the sandbox (design §6/§8).
 *
 * Absent→write only: a bundle is immutable per session id, so an existing
 * skill dir means this id was already materialized — never overwrite.
 * Exactly 2 RPCs regardless of skill count: writeFile of ONE base64 tar.gz
 * blob holding every skill (entries named `<skillName>/<relPath>`), then a
 * single exec that checks-and-extracts atomically and removes the blob. The
 * sentinel is the (sorted) first skill dir: all skills extract in one exec,
 * so its presence implies the whole agent was materialized for this id.
 * Zero-skill agents are valid and cost 0 RPCs.
 *
 * Safe to call from both the agent's lazy SessionEnv wrapper (first
 * container-needing op, backend-b/src/lazy-env.ts) and the admin skill-check
 * route (deterministic cold-recovery replay) — same-id calls converge on the
 * same immutable content.
 *
 * @param {SandboxLike} sandbox
 * @param {import('./agent.js').AgentBundle} bundle already-validated bundle
 * @param {{ skillsDir?: string }} [options]
 * @returns {Promise<{ skillDirs: string[], reconstructed: boolean }>}
 */
export async function provisionAgentSkills(sandbox, bundle, options = {}) {
  validateAgentBundle(bundle); // defense in depth: never reconstruct an unvalidated bundle
  const skillsDir = options.skillsDir ?? SKILLS_DIR;
  const skillNames = Object.keys(bundle.skills).sort();
  if (skillNames.length === 0) return { skillDirs: [], reconstructed: false };

  const combined = {};
  for (const [skillName, files] of Object.entries(bundle.skills)) {
    for (const [relPath, content] of Object.entries(files)) {
      combined[`${skillName}/${relPath}`] = content;
    }
  }
  const blob = `/tmp/agent-${bundle.agentName}-${bundle.version}.tgz.b64`;
  const tgz = await makeTarGz(combined);
  await sandbox.writeFile(blob, toBase64(tgz));

  const sentinel = `${skillsDir}/${skillNames[0]}`;
  const script =
    `if [ -d '${sentinel}' ]; then STATUS=present; ` +
    `else mkdir -p '${skillsDir}' && base64 -d '${blob}' | tar -xz -C '${skillsDir}' && STATUS=reconstructed; fi; ` +
    `rm -f '${blob}'; echo "provision:$STATUS"`;
  const result = await sandbox.exec(script);

  const stdout = result?.stdout ?? '';
  const ok = (result?.exitCode === undefined || result.exitCode === 0) && /provision:(present|reconstructed)/.test(stdout);
  if (!ok) {
    throw new Error(
      `skill reconstruction failed (exit=${result?.exitCode}): ${stdout} ${result?.stderr ?? ''}`.trim(),
    );
  }
  return {
    skillDirs: skillNames.map((name) => `${skillsDir}/${name}`),
    reconstructed: stdout.includes('provision:reconstructed'),
  };
}
