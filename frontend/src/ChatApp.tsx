/**
 * The chat page (`/chat`) — the token-authenticated half of the user UI.
 *
 * Authenticated by the user's own Semantius token (`<org>:<jwt>`, from
 * `pnpm mint-token`) and nothing else: no deployment API key is entered here,
 * loaded here, or accepted by the routes this page calls. Everything else — the
 * agent picker, session create/open, the conversation itself — is
 * ChatWorkbench, shared verbatim with the copilot page (`/copilot`), which
 * differs only in presenting a better-auth session cookie instead.
 *
 * The token can also arrive in the URL fragment (`/chat#jwt=<org>:<jwt>`,
 * optionally with `&session=<id>`).
 */
import { useMemo, useState } from 'react';

import { ChatWorkbench } from './ChatWorkbench';
import { consumeCredentialFragment, TOKEN_STORAGE } from './lib/session';

export function ChatApp() {
  const fragment = useMemo(() => consumeCredentialFragment('jwt'), []);
  const [token, setToken] = useState(() => {
    const initial = fragment.credential ?? localStorage.getItem(TOKEN_STORAGE) ?? '';
    if (fragment.credential) localStorage.setItem(TOKEN_STORAGE, fragment.credential);
    return initial;
  });

  function updateToken(value: string) {
    setToken(value);
    localStorage.setItem(TOKEN_STORAGE, value);
  }

  return (
    <ChatWorkbench
      title="Hoth Trip Planner"
      auth={{ bearer: token.trim() }}
      credential={{
        value: token,
        onChange: updateToken,
        placeholder: 'your Semantius token — <org>:<jwt> (mint one with `pnpm mint-token`)',
        prompt: 'Paste your Semantius token to begin.',
      }}
      initialSessionId={fragment.session}
    />
  );
}
