/**
 * Markdown link rendering for agent replies, with workspace-download support.
 *
 * The agent is instructed (main.ts WORKSPACE_LINK_INSTRUCTIONS) to emit
 * download links as `/workspace/{sessionId}/<file>` with the LITERAL
 * {sessionId} placeholder — the prompt stays static across sessions, so the
 * provider's prefix cache keeps working. This component closes the loop: it
 * substitutes the real session id and downloads via authenticated fetch +
 * blob, because the backend is cross-origin and a plain <a href> carries no
 * bearer / cookie-header credential.
 *
 * Context, not props: MessageResponse's memo comparator only checks
 * children/isAnimating, so a sessionId prop change would be swallowed —
 * context reads bypass that. `chatMarkdownComponents` is a module-level
 * const for the same reason (stable identity across renders).
 *
 * Known trade-off: overriding `components.a` replaces streamdown's built-in
 * anchor for ALL links (it isn't exported), so external links lose the
 * link-safety confirm modal and render as plain new-tab anchors.
 */
import { DownloadIcon } from 'lucide-react';
import { createContext, useContext, useState, type AnchorHTMLAttributes } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { authFetchInit, workspaceFileUrl, type ChatAuth } from './session';

export const WorkspaceLinkContext = createContext<{
  auth: ChatAuth;
  sessionId?: string;
  baseUrl?: string;
} | null>(null);

const LINK_CLASSES = 'wrap-anywhere font-medium text-primary underline';

/** The workspace-file name in an agent-emitted href, or null for other links.
 * Accepts the {sessionId} placeholder (the instructed form) and, defensively,
 * the real session id (a model echoing a resolved link from user text). */
function workspaceFileName(href: string, sessionId?: string): string | null {
  const match = /^\/workspace\/([^/]+)\/([^/]+)$/.exec(href);
  if (!match) return null;
  const [, rawId, nameSegment] = match;
  // The markdown pipeline percent-encodes braces: {sessionId} arrives as
  // %7BsessionId%7D. Compare decoded.
  let idSegment = rawId;
  try {
    idSegment = decodeURIComponent(rawId);
  } catch {
    // keep raw
  }
  if (idSegment !== '{sessionId}' && idSegment !== sessionId) return null;
  try {
    return decodeURIComponent(nameSegment);
  } catch {
    return nameSegment;
  }
}

function WorkspaceDownloadLink({ name, children }: { name: string; children?: React.ReactNode }) {
  const ctx = useContext(WorkspaceLinkContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function download() {
    if (!ctx?.sessionId || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(workspaceFileUrl(ctx.sessionId, name, ctx.baseUrl), authFetchInit(ctx.auth));
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}) as { error?: string });
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`${LINK_CLASSES} inline-flex cursor-pointer items-center gap-1 bg-transparent p-0`}
        disabled={!ctx?.sessionId || busy}
        onClick={() => void download()}
        title={`Download ${name} from the workspace`}
      >
        {busy ? <Spinner className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
        {children ?? name}
      </button>
      {error ? <span className="ml-1 text-destructive text-xs">download failed — {error}</span> : null}
    </>
  );
}

/** streamdown `components.a` override for agent replies. */
function ChatMarkdownLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const ctx = useContext(WorkspaceLinkContext);
  // Mid-stream sentinel from parseIncompleteMarkdown: render inert.
  if (!href || href === 'streamdown:incomplete-link') {
    return <span className={LINK_CLASSES}>{children}</span>;
  }
  const name = workspaceFileName(href, ctx?.sessionId);
  if (name) return <WorkspaceDownloadLink name={name}>{children}</WorkspaceDownloadLink>;
  // `node` is streamdown's hast node — not a DOM attribute.
  const { node: _node, ...anchorProps } = rest as { node?: unknown } & AnchorHTMLAttributes<HTMLAnchorElement>;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASSES} {...anchorProps}>
      {children}
    </a>
  );
}

/** Stable identity — MessageResponse's memo never re-renders on prop changes,
 * so this map must be created exactly once. */
export const chatMarkdownComponents = { a: ChatMarkdownLink };
