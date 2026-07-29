#!/usr/bin/env node
/**
 * Mint a Semantius test access token and print `<org>:<jwt>` to stdout — the
 * form the app's token box (and `sessionContext.semantius_jwt`) expects, since
 * the JWT alone doesn't say which org issued it.
 *
 *   pnpm mint-token
 *   TOKEN=$(pnpm --silent mint-token)
 *
 * Credentials come from the gitignored `.env` at the repo root; the exchange
 * itself lives in lib/semantius.mjs, shared with chat-probe.mjs and the
 * acceptance suite. Tokens are short-lived (~1 h), so mint per test session.
 */
import { mintSemantiusToken } from './lib/semantius.mjs';

try {
  process.stdout.write(await mintSemantiusToken());
} catch (err) {
  console.error(`mint-token: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
