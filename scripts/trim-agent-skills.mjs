#!/usr/bin/env node
/**
 * trim-agent-skills.mjs — adapt agents/semantius-agent/skills/ after the mirror,
 * because the skills that agent leaves out (AGENT_EXCLUDED_SKILLS in update.sh)
 * are not in its bundle. Upstream and semantius-architect keep the files as is.
 *
 *   - Every file a kept skill links in an excluded skill is copied to the common
 *     folder use-semantius/references/shared/, with the files those copies link in
 *     turn, and the link text is rewritten to the new place (asked for by Martin
 *     Amm, 2026-11-03).
 *   - semantius-optimizer/evals/ is removed.
 *
 * The common folder sits inside use-semantius because a bundle only takes folders
 * with a SKILL.md, and a skill of its own would show up in the agent's catalog.
 *
 *   node scripts/trim-agent-skills.mjs --check <upstream skills> <excluded skill>...   # writes nothing
 *   node scripts/trim-agent-skills.mjs <upstream skills> <agent skills> <excluded skill>...
 *
 * A link that cannot be copied stops the script before anything is written.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, posix } from 'node:path';

const SHARED = 'use-semantius/references/shared';

// Maintainer-only: this test needs files from the excluded skills, so it cannot pass in this agent.
const REMOVE = ['semantius-optimizer/evals'];

// `../<skill>/<path>` and the repo-rooted `semantius-plugin/skills/<skill>/<path>`.
const LINK = /(?:(?:\.\.\/)+|semantius-plugin\/skills\/)([a-z-]+)\/([\w./-]*\w)/g;
// A markdown link to a file next to a copied file.
const SIBLING = /\]\(\.\/([\w.-]+)/g;

const args = process.argv.slice(2);
const check = args[0] === '--check';
if (check) args.shift();
const src = args.shift();
const dst = check ? src : args.shift();
const excluded = args;
if (!src || !dst || excluded.length === 0) {
  console.error('usage: node scripts/trim-agent-skills.mjs [--check] <upstream skills> [<agent skills>] <excluded skill>...');
  process.exit(2);
}

function die(message) {
  console.error(`trim-agent-skills: ${message}`);
  process.exit(1);
}

// Shared file name -> its upstream path. Grows while it is walked below.
const copies = new Map();

function share(from, linkedBy) {
  const name = basename(from);
  if (name === 'SKILL.md') die(`${linkedBy} links ${from}: copying it would bring that skill back`);
  if (!existsSync(from)) die(`${linkedBy} links ${from}, which is not upstream`);
  if (copies.has(name) && copies.get(name) !== from) die(`two linked files are named ${name}: ${copies.get(name)}, ${from}`);
  copies.set(name, from);
  return `${SHARED}/${name}`;
}

// A copied file moved, so its links to kept skills need the new relative path too.
function rewrite(text, at, moved) {
  return text.replace(LINK, (link, skill, path) => {
    const target = excluded.includes(skill)
      ? share(join(src, skill, path), at)
      : moved && existsSync(join(src, skill))
        ? `${skill}/${path}`
        : undefined;
    return target ? posix.relative(`/${posix.dirname(at)}`, `/${target}`) : link;
  });
}

const output = new Map();
for (const entry of readdirSync(dst, { withFileTypes: true })) {
  if (!entry.isDirectory() || excluded.includes(entry.name)) continue;
  for (const file of readdirSync(join(dst, entry.name), { recursive: true })) {
    const at = `${entry.name}/${String(file).replaceAll('\\', '/')}`;
    if (!/\.(md|ts)$/.test(at) || basename(at) === 'CHANGELOG.md') continue;
    if (REMOVE.some((path) => at.startsWith(`${path}/`))) continue;
    const text = readFileSync(join(dst, at), 'utf8');
    const next = rewrite(text, at, false);
    if (next !== text) output.set(at, next);
  }
}
for (const [name, from] of copies) {
  const at = `${SHARED}/${name}`;
  const text = readFileSync(from, 'utf8');
  for (const [, sibling] of text.matchAll(SIBLING)) share(join(dirname(from), sibling), at);
  output.set(at, rewrite(text, at, true));
}
if (check) process.exit(0);

for (const path of REMOVE) rmSync(join(dst, path), { recursive: true, force: true });
mkdirSync(join(dst, SHARED), { recursive: true });
for (const [file, text] of output) writeFileSync(join(dst, file), text);
console.log(`    semantius-agent: copied ${[...copies.keys()].join(', ')} to ${SHARED}; removed ${REMOVE.join(', ')}`);
