/**
 * Minimal ustar tar writer + gzip, so a whole skill bundle can be
 * reconstructed into a sandbox in 2 RPCs (design §8/P2): one writeFile of a
 * base64 tar.gz blob, one exec of `base64 -d | tar -xz`. Works in Workers
 * and Node >=18 (CompressionStream).
 */

const BLOCK = 512;
const encoder = new TextEncoder();

/**
 * @param {Record<string, string | Uint8Array>} files rel-path -> content
 * @param {string} [prefix] optional directory prefix for every entry (e.g. the skill name)
 * @returns {Uint8Array} uncompressed tar archive
 */
export function makeTar(files, prefix = '') {
  const chunks = [];
  // Fixed mtime keeps the archive deterministic; extraction times are irrelevant.
  const mtime = 0;
  for (const [relPath, raw] of Object.entries(files)) {
    const body = typeof raw === 'string' ? encoder.encode(raw) : raw;
    const name = prefix ? `${prefix}/${relPath}` : relPath;
    chunks.push(tarHeader(name, body.length, mtime), body, padding(body.length));
  }
  chunks.push(new Uint8Array(BLOCK * 2)); // end-of-archive
  return concat(chunks);
}

/**
 * @param {Record<string, string | Uint8Array>} files
 * @param {string} [prefix]
 * @returns {Promise<Uint8Array>} gzipped tar archive
 */
export async function makeTarGz(files, prefix = '') {
  const tar = makeTar(files, prefix);
  const gz = new Response(
    new Blob([tar]).stream().pipeThrough(new CompressionStream('gzip')),
  );
  return new Uint8Array(await gz.arrayBuffer());
}

/** Base64 without Buffer so it runs identically in Workers and Node. */
export function toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function tarHeader(name, size, mtime) {
  if (encoder.encode(name).length > 100) throw new Error(`tar entry name too long: ${name}`);
  const header = new Uint8Array(BLOCK);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);        // mode
  writeOctal(header, 108, 8, 0);            // uid
  writeOctal(header, 116, 8, 0);            // gid
  writeOctal(header, 124, 12, size);        // size
  writeOctal(header, 136, 12, mtime);       // mtime
  header.fill(0x20, 148, 156);              // checksum placeholder (spaces)
  header[156] = 0x30;                       // typeflag '0' regular file
  writeString(header, 257, 6, 'ustar');     // magic
  header[263] = 0x30; header[264] = 0x30;   // version "00"
  writeString(header, 265, 32, 'root');     // uname
  writeString(header, 297, 32, 'root');     // gname
  let sum = 0;
  for (const byte of header) sum += byte;
  writeOctal(header, 148, 7, sum);          // checksum: 6 digits + NUL, then space
  header[155] = 0x20;
  return header;
}

function writeString(buf, offset, length, value) {
  const bytes = encoder.encode(value);
  buf.set(bytes.subarray(0, length), offset);
}

function writeOctal(buf, offset, length, value) {
  const str = value.toString(8).padStart(length - 1, '0');
  writeString(buf, offset, length - 1, str);
  buf[offset + length - 1] = 0;
}

function padding(size) {
  const rem = size % BLOCK;
  return new Uint8Array(rem === 0 ? 0 : BLOCK - rem);
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
