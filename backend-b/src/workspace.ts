/**
 * Workspace file surface helpers — the pure half of the /workspace/:sessionId
 * routes in app.ts: filename hygiene, collision-safe naming, and byte<->base64
 * conversion.
 *
 * Base64 strings are the transfer format on purpose: the sandbox SDK runs on
 * its default HTTP transport here (SANDBOX_TRANSPORT is never set), where the
 * streaming file APIs (`readFile({encoding:'none'})`, `writeFile(stream)`)
 * throw "requires the rpc transport". String-encoded reads/writes work on
 * every transport. The size caps keep the buffered copies bounded — the DO
 * control channel moves ~0.6 MB/s (see backups.ts), so big files would time
 * out long before they OOM anyway.
 */

export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const WORKSPACE_DIR = '/workspace';

/**
 * The sandbox surface the workspace routes touch — structural on purpose (the
 * SandboxLike posture of core/src/provision.js): decoupled from the SDK's
 * generics and stubbable in tests. File API everywhere except the one size
 * probe, so filenames never meet a shell unquoted.
 */
export type WorkspaceSandbox = {
  exists(path: string): Promise<{ exists: boolean }>;
  writeFile(path: string, content: string, options?: { encoding?: string }): Promise<{ success: boolean }>;
  readFile(
    path: string,
    options?: { encoding?: string },
  ): Promise<{ success: boolean; content: string; encoding?: string }>;
  exec(command: string): Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
};

/**
 * One workspace-safe filename or null. Flat names only — path separators and
 * dot-traversal are rejected rather than stripped (a silently rewritten name
 * would desync from what the client inserts into the composer). Unicode is
 * kept: it travels URL-encoded in the query param and RFC 5987-encoded in the
 * download's content-disposition.
 */
export function sanitizeFilename(raw: string): string | null {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..') return null;
  if (/[/\\]/.test(name) || name.length > 128) return null;
  return name;
}

/**
 * Collision-safe name in WORKSPACE_DIR: `report.pdf` -> `report (1).pdf` ->
 * `report (2).pdf` … (extension-preserving, the OS convention). One exists()
 * RPC in the no-collision common case. The 50-attempt cap turns a pathological
 * workspace into a clear 500 instead of an unbounded RPC loop; two concurrent
 * uploads of the same name can race exists() — accepted, sessions are
 * single-user and last write wins.
 */
export async function uniqueWorkspaceName(sandbox: WorkspaceSandbox, name: string): Promise<string> {
  if (!(await sandbox.exists(`${WORKSPACE_DIR}/${name}`)).exists) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 1; i <= 50; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!(await sandbox.exists(`${WORKSPACE_DIR}/${candidate}`)).exists) return candidate;
  }
  throw new Error(`no free workspace name for "${name}" after 50 attempts`);
}

/** Chunked btoa — String.fromCharCode(...wholeFile) overflows the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
