"use client";

import type { ReactNode } from "react";

/**
 * Inline markdown SUBSET for short UI copy (welcome subtitles, prompt hints):
 * `**bold**` and `[text](url)`, nestable either way except a link inside a
 * link. Everything else — headings, lists, `*`, backticks, unclosed `**` —
 * stays literal text. Deliberately not Streamdown: that renders block-level
 * markup (paragraph margins, `# ` → heading) into one-line slots.
 *
 * Output is React elements only (no HTML injection). Links open in a new tab
 * and only for http(s)/mailto; any other scheme renders as its label text.
 * core/src/agent.js validateWelcome rejects those at deploy — keep the two
 * patterns in step.
 */
// Bold needs non-space just inside its `**` (as in markdown: `a ** b` stays literal).
const TOKEN = /\*\*(\S(?:.*?\S)??)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
const SAFE_URL = /^(https?:|mailto:)/i;

export const InlineMarkdown = ({ children }: { children: string }) => (
  <>{render(children, true)}</>
);

function render(text: string, links: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [raw, bold, label, url] = match;
    const index = match.index;
    if (index > last) out.push(text.slice(last, index));
    if (bold !== undefined) {
      out.push(<strong key={index}>{render(bold, links)}</strong>);
    } else if (links && SAFE_URL.test(url)) {
      out.push(
        <a
          className="font-medium underline underline-offset-2"
          href={url}
          key={index}
          rel="noopener noreferrer"
          target="_blank"
        >
          {render(label, false)}
        </a>,
      );
    } else {
      out.push(links ? <span key={index}>{render(label, false)}</span> : raw);
    }
    last = index + raw.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
