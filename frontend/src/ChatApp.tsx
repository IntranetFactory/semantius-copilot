/**
 * The chat page (`/chat`) — the token-authenticated half of the user UI.
 *
 * Authenticated by the user's own Semantius token (`<org>:<jwt>`, from
 * `pnpm mint-token`) and nothing else: no deployment API key is entered here,
 * loaded here, or accepted by the routes this page calls. Everything else — the
 * agent picker, session create/open, the conversation itself — is
 * ChatPage, shared verbatim with the copilot page (`/copilot`), which
 * differs only in presenting a better-auth session cookie instead.
 *
 * The token can also arrive in the URL fragment (`/chat#jwt=<org>:<jwt>`,
 * optionally with `&session=<id>`).
 */
import { useMemo, useState } from 'react';

import { ChatPage } from './ChatPage';
import { consumeCredentialFragment, TOKEN_STORAGE } from './pages';

export function ChatApp() {
  const fragment = useMemo(() => consumeCredentialFragment(), []);
  const [token, setToken] = useState(() => {
    const initial = fragment.jwt ?? localStorage.getItem(TOKEN_STORAGE) ?? '';
    if (fragment.jwt) localStorage.setItem(TOKEN_STORAGE, fragment.jwt);
    return initial;
  });

  function updateToken(value: string) {
    setToken(value);
    localStorage.setItem(TOKEN_STORAGE, value);
  }

  return (
    <ChatPage
      title="Semantius Copilot"
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
