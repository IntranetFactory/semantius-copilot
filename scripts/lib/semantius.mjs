/**
 * Semantius test credentials for the scripts/ tools.
 *
 * The backend's chat surface only admits sessions that carry a verified
 * Semantius user, so every script that drives a real conversation
 * (chat-probe.mjs, the acceptance suite's chat checks) needs a live token —
 * the same one `pnpm mint-token` prints for the frontend's token box.
 *
 * Credentials come from the gitignored `.env` in the repo root
 * (`SEMANTIUS_API_KEY`, `SEMANTIUS_ORG`), loaded via Node's built-in
 * `process.loadEnvFile` so no dotenv wrapper is needed; already-set
 * environment variables win when there is no `.env`. Dependency-free.
 */

/** Load the repo-root `.env` into process.env, if present. Idempotent. */
export function loadRepoEnv() {
  try {
    process.loadEnvFile(new URL('../../.env', import.meta.url));
  } catch {
    // No .env — rely on the environment already being set.
  }
}

/**
 * The configured credentials, or null when the repo has none (so callers can
 * skip token-dependent work instead of failing).
 *
 * @returns {{ apiKey: string, org: string } | null}
 */
export function semantiusCredentials() {
  loadRepoEnv();
  const apiKey = process.env.SEMANTIUS_API_KEY;
  const org = process.env.SEMANTIUS_ORG;
  return apiKey && org ? { apiKey, org } : null;
}

/**
 * Exchange the API key for a user access token via the `client_credentials`
 * grant and return it in this POC's transport form, `<org>:<jwt>` — the org
 * prefix is what tells the backend which tenant host to verify against.
 *
 * @param {{ apiKey: string, org: string }} [credentials]
 * @returns {Promise<string>}
 */
export async function mintSemantiusToken(credentials = semantiusCredentials()) {
  if (!credentials) {
    throw new Error('missing SEMANTIUS_API_KEY / SEMANTIUS_ORG (set them in .env at the repo root)');
  }
  const { apiKey, org } = credentials;
  const url = `https://${org}.semantius.cloud/token`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-api-key': apiKey },
    body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`token endpoint ${response.status} ${response.statusText} at ${url}: ${detail.slice(0, 200)}`);
  }
  const { access_token: accessToken } = await response.json();
  if (!accessToken) throw new Error(`response from ${url} had no access_token`);
  return `${org}:${accessToken}`;
}
