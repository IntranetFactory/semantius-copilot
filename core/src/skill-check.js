/**
 * Deterministic skill-check (plan §13). A BOUNDED set of fixed commands built
 * server-side from validated structured params — never a client-supplied shell
 * string. This is what lets the acceptance harness drive the core directly and
 * isolate the A/B skill-delivery comparison from LLM nondeterminism, without
 * shipping an arbitrary-exec surface. (In test-oracle terms this IS the
 * oracle; the route is named skill-check because that's what it inspects.)
 *
 * Each op maps to one hard-coded command template. The only interpolated
 * values are strictly validated (site names, ISO dates), and are passed to the
 * skill script as `--flag=value` args, not spliced into shell syntax.
 */
import { ECHO_HOST } from './config.js';
import { SKILLS_DIR } from './provision.js';

const SITE_RE = /^[A-Za-z0-9 ]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SKILL_NAME = 'planner';
const SCRIPT = `${SKILLS_DIR}/${SKILL_NAME}/scripts/opening-times.js`;
const SKILL_DIR = `${SKILLS_DIR}/${SKILL_NAME}`;

/**
 * Validate a request and return the exact command string to exec. Throws on
 * anything not in the allowlisted shape.
 *
 * @param {{ op?: string, sites?: string[], from?: string, to?: string, debugEcho?: boolean }} req
 * @returns {string}
 */
export function buildSkillCheckCommand(req) {
  const op = req?.op;
  switch (op) {
    case 'opening-times': {
      const sites = req.sites;
      if (!Array.isArray(sites) || sites.length === 0 || sites.length > 8) {
        throw new SkillCheckError('sites must be 1-8 site names');
      }
      for (const s of sites) if (typeof s !== 'string' || !SITE_RE.test(s)) throw new SkillCheckError(`invalid site name: ${s}`);
      if (!DATE_RE.test(req.from ?? '')) throw new SkillCheckError('from must be YYYY-MM-DD');
      if (!DATE_RE.test(req.to ?? '')) throw new SkillCheckError('to must be YYYY-MM-DD');
      // Args are single-quoted; site names are already restricted to
      // [A-Za-z0-9 ] so no quote/metachar can appear.
      const sitesArg = sites.join(',');
      const debug = req.debugEcho ? ' --debug-echo' : '';
      return `node '${SCRIPT}' --sites='${sitesArg}' --from='${req.from}' --to='${req.to}'${debug} 2>&1`;
    }
    case 'hash-skill':
      // C3 triple-hash leg inside the live sandbox.
      return `cd '${SKILL_DIR}' && find . -type f | sort | xargs sha256sum`;
    case 'count-skill-files':
      // Clean-base / positive-control file count (plan §13). A *file* count.
      return `find '${SKILLS_DIR}' -type f 2>/dev/null | wc -l`;
    case 'curl-check':
      // Per-process TLS-trust proof: curl uses the OpenSSL default verify
      // paths (NOT NODE_EXTRA_CA_CERTS), so this only succeeds when the
      // baked CURL_CA_BUNDLE/SSL_CERT_FILE point curl at the interceptor CA.
      // Prints the HTTP status the whitelisted echo host returned over 443.
      // No interpolation — fully fixed string.
      return `curl -sS -o /dev/null -w '%{http_code}' -m 20 -X POST 'https://${ECHO_HOST}/post?api=hoth-tourism&query=curl-check' 2>&1`;
    case 'semantius-whoami':
      // End-to-end egress proof: semantius reads the container's __sak__
      // placeholder and its per-session SEMANTIUS_ORG, and calls
      // https://<org>.semantius.ai; the Worker's brokerEgress swaps __sak__ for
      // THIS session's user JWT on the whitelisted host. A successful identity
      // response means the whole credential-at-egress path (per-session env +
      // interceptHttps + CA trust + swap + whitelist) works, and the identity
      // it reports is the session's user. No interpolation — fully fixed
      // string. SEMANTIUS_TIMEOUT bounds a hang.
      return `SEMANTIUS_TIMEOUT=20 semantius whoami 2>&1`;
    case 'semantius-env':
      // Diagnostic for the credential wiring: the CLI version shipped in the
      // image, which SEMANTIUS_* variables that build documents, and what the
      // container actually holds. Safe to print — the container's values are
      // only the org and the sentinel, never a real credential.
      return (
        `semantius --version 2>&1; ` +
        `echo '--- container env ---'; env | grep '^SEMANTIUS_' | sort; ` +
        `echo '--- cli honors ---'; semantius --help 2>&1 | grep -oE 'SEMANTIUS_[A-Z_]+' | sort -u`
      );
    default:
      throw new SkillCheckError(`unknown op: ${String(op)}`);
  }
}

export class SkillCheckError extends Error {
  constructor(message) {
    super(`skill-check request invalid: ${message}`);
    this.name = 'SkillCheckError';
  }
}
