/**
 * The copilot page (`/copilot`) — the cookie-authenticated half of the user UI.
 *
 * Identical to the chat page (`/chat`) except for the credential: instead of a
 * minted Semantius token it takes a better-auth SESSION COOKIE value, which is
 * what a user who already signed in to the Semantius app holds. The backend's
 * chat gate validates it upstream (`GET /session`) and exchanges it for the JWT
 * the sandbox needs (`POST /session/token`), so this page never sees a token at
 * all.
 *
 * The value travels in the `x-better-auth-cookie` header, not a real Cookie
 * header: a browser cannot set `Cookie` from fetch. Pasting the value is the
 * POC stand-in for a same-site embed — a page whose origin is same-site with
 * the backend (and in its ALLOWED_ORIGINS) skips the pasting entirely via
 * AMBIENT mode, where the browser's own cookie rides on
 * `credentials: 'include'` requests. See components/ai-elements/session.ts
 * `ChatAuth` for all three transports.
 *
 * The cookie can also arrive in the URL fragment (`/copilot#cookie=<value>`,
 * optionally with `&session=<id>`).
 */
import { useMemo, useState } from 'react';

import { ChatPage } from './ChatPage';
import { consumeCredentialFragment, COOKIE_STORAGE } from './pages';

export function CopilotApp() {
  const fragment = useMemo(() => consumeCredentialFragment(), []);
  const [cookie, setCookie] = useState(() => {
    const initial = fragment.cookie ?? localStorage.getItem(COOKIE_STORAGE) ?? '';
    if (fragment.cookie) localStorage.setItem(COOKIE_STORAGE, fragment.cookie);
    return initial;
  });

  function updateCookie(value: string) {
    setCookie(value);
    localStorage.setItem(COOKIE_STORAGE, value);
  }

  return (
    <ChatPage
      title="Semantius Copilot"
      auth={{ authCookie: cookie.trim() }}
      credential={{
        value: cookie,
        onChange: updateCookie,
        // The VALUE only — `<token>.<signature>`, not `name=value`. Both cookie
        // names (`__Secure-better-auth.session_token` over HTTPS, plain over
        // HTTP) carry the same value, and the backend re-attaches the name.
        placeholder: 'value of your better-auth.session_token cookie — <token>.<signature>',
        prompt: 'Paste the value of your better-auth.session_token cookie to begin.',
      }}
      initialSessionId={fragment.session}
    />
  );
}
