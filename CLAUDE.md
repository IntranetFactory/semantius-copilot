# Instructions for Claude

- **All project knowledge lives in committed files in this repo** (README.md,
  copilot-design.md, code comments). Never record decisions, findings, or setup notes in
  out-of-repo memory/scratch files — if it's worth remembering, it goes in a committed file
  in the same change.
- Secrets never go in committed files: use `.dev.vars` (gitignored) locally and
  `wrangler secret put` for deployed Workers.
- **Never rewrite the working tree with git**: no `git checkout -- <file>`, `git restore`,
  `git stash`, `git reset` — not even to undo your own edits. The tree routinely carries
  uncommitted work from earlier sessions, and a wholesale revert destroys it together with
  the evidence. Undo a change by re-applying the inverse with targeted edits. Read-only git
  (`status`, `diff`, `log`, `show`) is fine; anything that stages, commits, or touches the
  tree needs an explicit ask.
- **Dev environment**: local `flue dev` / containers do not run on this Windows machine
  (needs WSL). Verify changes against the deployed workers.dev URLs after `pnpm deploy:*`.
- **Communication**: answer every question directly and completely in the turn's final
  message. When an action is possible (saving a key, deploying), do it — don't print
  instructions for the user to run. When an input only the user can provide is missing
  (API key, credential), ask for it immediately.
