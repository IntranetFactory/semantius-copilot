/**
 * Session sidebar for a single-agent chat surface: a "New request" entry on
 * top, then the signed-in user's sessions for ONE agent (`GET /sessions`,
 * narrowed to `agentName` client-side — the route answers all of the user's
 * sessions). Pure navigation surface: it never touches the conversation. The
 * HOST owns the container key contract (epoch bump + explicitSessionId — see
 * ChatPage.tsx / AgentApp.tsx) — this component only reports clicks via
 * onNewRequest/onOpenSession, highlights `activeSessionId`, and refetches when
 * `refreshToken` changes (bump it after onSessionCreated so a draft-created
 * session appears).
 *
 * Auth mirrors AgentChatContainer: bearer wins, then authCookie, neither =
 * ambient (`credentials: 'include'`); a failure renders as an inline notice.
 */
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { BACKEND, fetchSessions, type ChatAuth, type SessionListing } from './session';

/** Mirrors core/src/config.js `sessionIdTail`: the random tail after the
 * tenant prefix — the only hyphen-free part of a minted id. Its `.slice(0, 8)`
 * is the repo's git-style short label. Inlined so this folder carries no
 * workspace imports. */
const sessionIdTail = (id: string) => id.split('-').at(-1) ?? '';

export type SessionSidebarProps = {
  /** Only sessions whose record names this agent are listed. */
  agentName: string;
  bearer?: string;
  authCookie?: string;
  baseUrl?: string;
  /** Highlighted entry: explicit navigation or a reported draft create. */
  activeSessionId?: string;
  /** Bump to refetch the list (e.g. after onSessionCreated). */
  refreshToken?: number;
  onNewRequest: () => void;
  onOpenSession: (sessionId: string) => void;
  className?: string;
};

export function SessionSidebar({
  agentName,
  bearer,
  authCookie,
  baseUrl = BACKEND.baseUrl,
  activeSessionId,
  refreshToken = 0,
  onNewRequest,
  onOpenSession,
  className,
}: SessionSidebarProps) {
  // undefined = loading, empty sessions = loaded empty. Auth is destructured
  // to trimmed primitives BEFORE the dependency array, same as the session.ts
  // hooks.
  const [listing, setListing] = useState<SessionListing>();
  const [error, setError] = useState<string>();
  const trimmedBearer = bearer?.trim() ?? '';
  const trimmedCookie = authCookie?.trim() ?? '';
  useEffect(() => {
    let cancelled = false;
    const auth: ChatAuth = trimmedBearer
      ? { bearer: trimmedBearer }
      : trimmedCookie
        ? { authCookie: trimmedCookie }
        : { ambient: true };
    setError(undefined);
    fetchSessions(auth, baseUrl).then(
      (result) => {
        if (!cancelled) setListing(result);
      },
      (err) => {
        if (cancelled) return;
        setListing({ sessions: [] });
        setError(String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [trimmedBearer, trimmedCookie, baseUrl, refreshToken]);

  // The record's agentName is bundle.agentName; a `--as` alias deploy may
  // diverge from the KV name in the URL — those sessions won't list here.
  const mine = listing?.sessions.filter((entry) => entry.agentName === agentName);
  /** WHOSE sessions the backend scoped the listing to — shown so a browser
   * holding several credentials can never be silently listing (and chatting!)
   * as somebody else. */
  const identity = listing?.user?.sub ? `${listing.user.sub}@${listing.user.org ?? '?'}` : undefined;

  return (
    <div className={cn('flex h-full flex-col gap-2 p-3', className)}>
      <Button className="w-full justify-start" onClick={onNewRequest} type="button" variant="outline">
        New request
      </Button>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {listing === undefined ? (
          <div className="flex justify-center p-4">
            <Spinner />
          </div>
        ) : error ? (
          <p className="px-2 text-destructive text-xs">could not list sessions — {error}</p>
        ) : mine && mine.length === 0 ? (
          <p className="px-2 text-muted-foreground text-sm">
            No sessions{identity ? ` for ${identity}` : ''} yet — send a message to start one.
          </p>
        ) : (
          mine?.map((entry) => (
            <button
              className={cn(
                'flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                entry.id === activeSessionId && 'bg-sidebar-accent text-sidebar-accent-foreground',
              )}
              key={entry.id}
              onClick={() => onOpenSession(entry.id)}
              type="button"
            >
              {/* Generated title once the backend produced one; the id-tail
                  short label is the fallback for brand-new/legacy sessions. */}
              {entry.title ? (
                <span className="w-full truncate text-sm">{entry.title}</span>
              ) : (
                <span className="font-mono text-xs">{sessionIdTail(entry.id).slice(0, 8)}</span>
              )}
              {entry.createdAt ? (
                <span className="text-muted-foreground text-xs">{new Date(entry.createdAt).toLocaleString()}</span>
              ) : null}
            </button>
          ))
        )}
      </div>
      {identity ? <p className="px-2 pt-1 text-muted-foreground text-xs">signed in as {identity}</p> : null}
    </div>
  );
}
