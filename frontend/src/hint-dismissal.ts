/**
 * This app's implementation of the chat surface's `HintStore`
 * (components/ai-elements/hint.tsx): which welcome-prompt tips the user has
 * closed, kept in localStorage under HINTS_STORAGE.
 *
 * App-level on purpose. The ai-elements folder must stay copy-pasteable into
 * another app, so it carries the interface and no storage choice — see the
 * contract stated in components/ai-elements/session.ts and in pages.ts. THIS
 * FILE IS THE WHOLE SEAM: moving dismissals server-side later (POST them to an
 * API, hydrate the set at sign-in) means rewriting these two methods and
 * nothing else — no component changes, no prop changes.
 *
 * One JSON array under one key rather than a key per hint: it is the payload a
 * server API would take as-is, and it is one thing to clear.
 */
import type { HintStore } from './components/ai-elements/hint';
import { HINTS_STORAGE } from './pages';

/** Lazily hydrated from localStorage, then authoritative for this page load. */
let dismissed: Set<string> | undefined;

function load(): Set<string> {
  if (dismissed) return dismissed;
  dismissed = new Set();
  try {
    const raw = localStorage.getItem(HINTS_STORAGE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === 'string') dismissed.add(id);
    }
  } catch {
    // Unreadable storage (private browsing) or a corrupt/hand-edited value:
    // fail OPEN — a tip shown once too often beats a broken chat surface.
  }
  return dismissed;
}

export const localHintStore: HintStore = {
  isDismissed: (id) => load().has(id),
  dismiss: (id) => {
    const set = load();
    set.add(id);
    try {
      localStorage.setItem(HINTS_STORAGE, JSON.stringify([...set]));
    } catch {
      // Quota/blocked storage: the tip still closes for this page load.
    }
  },
};
