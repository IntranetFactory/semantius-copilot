# Instructions for Claude

- **All project knowledge lives in committed files in this repo** (README.md,
  copilot-design.md, code comments). Never record decisions, findings, or setup notes in
  out-of-repo memory/scratch files — if it's worth remembering, it goes in a committed file
  in the same change.
- Secrets never go in committed files: use `.dev.vars` (gitignored) locally and
  `wrangler secret put` for deployed Workers.
- **Dev environment**: local `flue dev` / containers do not run on this Windows machine
  (needs WSL). Verify changes against the deployed workers.dev URLs after `pnpm deploy:*`.
- **Communication**: answer every question directly and completely in the turn's final
  message. When an action is possible (saving a key, deploying), do it — don't print
  instructions for the user to run. When an input only the user can provide is missing
  (API key, credential), ask for it immediately.
