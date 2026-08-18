/**
 * Shared bundle validation primitives (design §8): per-skill file-map checks,
 * path safety, size caps, and the baseImage -> Sandbox binding resolver.
 * The agent-level bundle format that composes these lives in ./agent.js.
 */

export const BUNDLE_LIMITS = {
  maxFiles: 64,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
};

/** Naming rule shared by agent names and skill names (folder-name charset). */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Validate one skill's files map (rel-path -> utf-8 content): reject `..`,
 * absolute paths, backslashes; per-file/per-skill caps; required SKILL.md;
 * ustar entry-name limit for the tar the provisioner will build.
 *
 * @param {unknown} files
 * @param {{ label?: string, tarPrefix?: string }} [options] label for error
 *   messages; tarPrefix is prepended to each rel-path in the ustar name check
 * @returns {number} total content bytes across the map
 */
export function validateFilesMap(files, options = {}) {
  const label = options.label ?? 'bundle';
  const tarPrefix = options.tarPrefix ?? '';
  if (files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new BundleValidationError(`${label}: files must be an object of relPath -> content`);
  }
  const entries = Object.entries(files);
  if (entries.length === 0) throw new BundleValidationError(`${label}: files must not be empty`);
  if (entries.length > BUNDLE_LIMITS.maxFiles) {
    throw new BundleValidationError(`${label}: too many files (${entries.length} > ${BUNDLE_LIMITS.maxFiles})`);
  }
  if (!Object.prototype.hasOwnProperty.call(files, 'SKILL.md')) {
    throw new BundleValidationError(`${label}: must contain SKILL.md at its root`);
  }

  let total = 0;
  const seen = new Set();
  for (const [relPath, content] of entries) {
    validateRelPath(relPath);
    if (utf8Length(tarPrefix + relPath) > 100) {
      throw new BundleValidationError(`${label}: path too long for tar entry: ${tarPrefix}${relPath}`);
    }
    const canonical = relPath.split('/').filter(Boolean).join('/');
    if (seen.has(canonical)) throw new BundleValidationError(`${label}: duplicate path after normalization: ${relPath}`);
    seen.add(canonical);
    if (typeof content !== 'string') throw new BundleValidationError(`${label}: file content must be a string: ${relPath}`);
    const bytes = utf8Length(content);
    if (bytes > BUNDLE_LIMITS.maxFileBytes) {
      throw new BundleValidationError(`${label}: file too large: ${relPath} (${bytes} > ${BUNDLE_LIMITS.maxFileBytes})`);
    }
    total += bytes;
  }
  if (total > BUNDLE_LIMITS.maxTotalBytes) {
    throw new BundleValidationError(`${label}: too large (${total} > ${BUNDLE_LIMITS.maxTotalBytes})`);
  }
  return total;
}

/** Reject any path that could resolve outside the skill directory. */
export function validateRelPath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > 512) {
    throw new BundleValidationError(`invalid path: ${String(relPath)}`);
  }
  if (relPath.includes('\\')) throw new BundleValidationError(`backslash in path: ${relPath}`);
  if (relPath.startsWith('/') || /^[A-Za-z]:/.test(relPath)) {
    throw new BundleValidationError(`absolute path not allowed: ${relPath}`);
  }
  if (relPath.includes('\0')) throw new BundleValidationError(`NUL byte in path: ${relPath}`);
  const segments = relPath.split('/');
  for (const seg of segments) {
    if (seg === '' ) throw new BundleValidationError(`empty path segment: ${relPath}`);
    if (seg === '.' || seg === '..') throw new BundleValidationError(`path traversal not allowed: ${relPath}`);
  }
}

export class BundleValidationError extends Error {
  constructor(message) {
    super(`bundle validation failed: ${message}`);
    this.name = 'BundleValidationError';
  }
}

function utf8Length(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * baseImage -> Sandbox binding resolver (design §16 design hook).
 * Both getSandbox and the bearer KV key must derive from the SAME
 * selected binding (design §7). Adding an image later is a wrangler
 * entry + a row here, not a rewrite.
 */
export const BASE_IMAGE_BINDINGS = { node: 'Sandbox' };

export function resolveSandboxBinding(baseImage) {
  const binding = BASE_IMAGE_BINDINGS[baseImage];
  if (!binding) throw new BundleValidationError(`unsupported baseImage: ${baseImage}`);
  return binding;
}
