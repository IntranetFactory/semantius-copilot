/**
 * Agent bundle format and server-side validation of untrusted agent bundles.
 *
 * An agent bundle is the one-JSON-string unit of delivery for backend B: it
 * carries the agent's merged instructions, optional model overrides, and ALL
 * of its skills (0..maxSkills). It is built by scripts/bundle.mjs from an
 * agents/<name>/ folder (agent.jsonc + optional INSTRUCTIONS.md +
 * skills/<skill>/...) — see agents/agent.schema.json for the config contract.
 *
 * @typedef {Object} AgentBundle
 * @property {string} agentName    lowercase/hyphens, <=64, matches agents/ folder name
 * @property {string} version      content hash over config + all skill files
 * @property {string} baseImage    toolchain the agent needs; selects the Sandbox binding
 * @property {string} instructions merged agent.jsonc instructions + INSTRUCTIONS.md
 * @property {string} [model]      normalized provider/model specifier
 * @property {string} [modelBaseUrl] OpenAI-compatible endpoint override
 * @property {string[]} [proxyWhitelist] egress allow list (host/URL globs), unioned at
 *   egress with the org's own list; DENY-ALL when both are absent/empty
 * @property {AgentWelcome} [welcome] welcome card shown by the chat UI while a conversation is empty
 * @property {Record<string, Record<string, string>>} skills skillName -> (rel-path -> utf-8 content)
 */

/**
 * Welcome card config: UI-only, rendered by the chat frontend in place of the
 * empty-conversation state. Clicking a prompt sends `prompt ?? display` as the
 * user's message — immediately unless `prefill` is true, which only puts the
 * text into the composer for editing. A prompt's optional `hint` is shown as a
 * dismissible tip above the composer when that prompt is clicked.
 *
 * @typedef {Object} AgentWelcome
 * @property {string} title
 * @property {string} [subtitle]
 * @property {Array<{ title: string, subtitle?: string, prompts: Array<{ display: string, prompt?: string, prefill?: boolean, hint?: string }> }>} [sections]
 */

import {
  BUNDLE_LIMITS,
  BundleValidationError,
  SKILL_NAME_RE,
  validateFilesMap,
} from './bundle.js';

/** Providers the model prefix rule recognizes (first '/'-segment of `model`). */
export const KNOWN_MODEL_PROVIDERS = ['openrouter', 'custom', 'cloudflare'];

export const AGENT_LIMITS = {
  maxSkills: 16,
  maxInstructionsBytes: 64 * 1024,
  maxAgentTotalBytes: 4 * 1024 * 1024,
  maxBaseUrlChars: 512,
  maxWhitelistHosts: 32,
};

/** Per-string caps on the welcome card. Deliberately no caps on the NUMBER of
 * sections or prompts — the UI renders any count without truncation. */
export const WELCOME_LIMITS = {
  maxTitleChars: 200,
  maxSubtitleChars: 500,
  maxDisplayChars: 200,
  maxPromptChars: 4096,
  maxHintChars: 500,
};

/**
 * One allow-list entry: a hostname or a URL, with `*` allowed anywhere and any
 * number of times (`abc.com`, `*.abc.com`, `api.*.acme.io`,
 * `https://xxx/abc.com/*`, `x.com/abc/*`, or a bare `*` for "everything").
 *
 * The same grammar the ORG's copilotFirewallAllowlist uses, deliberately: the
 * two lists are unioned at the egress seam (resolveEgressPolicy), so one
 * matcher — matchesEgressPattern in egress.js — has to read both, and an author
 * should not have to know which list an entry came from. Every entry that was
 * valid under the old exact-host/`*.suffix` rule still is, and still matches
 * exactly what it matched before.
 *
 * Shape only: printable ASCII minus whitespace, quotes, and backslash (a URL
 * pattern legitimately carries `:/?#[]@!$&'()+,;=%~`). What an entry MEANS is
 * decided at egress, not here.
 */
const WHITELIST_PATTERN_RE = /^[A-Za-z0-9*._~:/?#[\]@!$&'()+,;=%-]+$/;

/**
 * Validate a proxy_whitelist / proxyWhitelist value: an array of egress globs.
 * DENY-ALL SEMANTICS live at the egress seam — this only checks shape.
 *
 * @param {unknown} raw
 * @param {string} label
 * @returns {string[]}
 */
function validateWhitelist(raw, label) {
  if (!Array.isArray(raw)) throw new BundleValidationError(`${label} must be an array of host/URL globs`);
  if (raw.length > AGENT_LIMITS.maxWhitelistHosts) {
    throw new BundleValidationError(`${label}: too many hosts (${raw.length} > ${AGENT_LIMITS.maxWhitelistHosts})`);
  }
  for (const host of raw) {
    if (typeof host !== 'string' || host.length === 0 || host.length > 255 || !WHITELIST_PATTERN_RE.test(host)) {
      throw new BundleValidationError(
        `${label}: invalid glob: ${String(host)} (a hostname or URL, '*' allowed anywhere, no whitespace)`,
      );
    }
  }
  return raw;
}

/**
 * Validate a welcome / welcome-card value (see the AgentWelcome typedef).
 * Shape and string-length checks only; section/prompt COUNTS are unbounded.
 *
 * @param {unknown} raw
 * @param {string} label
 * @returns {AgentWelcome}
 */
function validateWelcome(raw, label) {
  const { maxTitleChars, maxSubtitleChars, maxDisplayChars, maxPromptChars, maxHintChars } = WELCOME_LIMITS;
  const checkString = (value, name, max, required) => {
    if (value === undefined && !required) return;
    if (typeof value !== 'string' || value.length === 0 || value.length > max) {
      throw new BundleValidationError(`${label}: ${name} must be a non-empty string of at most ${max} chars`);
    }
  };
  const checkObject = (value, name, allowed) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BundleValidationError(`${label}: ${name} must be a JSON object`);
    }
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        throw new BundleValidationError(`${label}: ${name} has unknown key: ${key} (allowed: ${allowed.join(', ')})`);
      }
    }
    return /** @type {Record<string, unknown>} */ (value);
  };

  const welcome = checkObject(raw, 'welcome', ['title', 'subtitle', 'sections']);
  checkString(welcome.title, 'welcome title', maxTitleChars, true);
  checkString(welcome.subtitle, 'welcome subtitle', maxSubtitleChars, false);
  if (welcome.sections !== undefined) {
    if (!Array.isArray(welcome.sections)) {
      throw new BundleValidationError(`${label}: sections must be an array`);
    }
    for (const rawSection of welcome.sections) {
      const section = checkObject(rawSection, 'section', ['title', 'subtitle', 'prompts']);
      checkString(section.title, 'section title', maxTitleChars, true);
      checkString(section.subtitle, 'section subtitle', maxSubtitleChars, false);
      if (!Array.isArray(section.prompts) || section.prompts.length === 0) {
        throw new BundleValidationError(`${label}: section "${section.title}" must have a non-empty prompts array`);
      }
      for (const rawPrompt of section.prompts) {
        const prompt = checkObject(rawPrompt, 'prompt', ['display', 'prompt', 'prefill', 'hint']);
        checkString(prompt.display, 'prompt display', maxDisplayChars, true);
        checkString(prompt.prompt, 'prompt text', maxPromptChars, false);
        checkString(prompt.hint, 'prompt hint', maxHintChars, false);
        if (prompt.prefill !== undefined && typeof prompt.prefill !== 'boolean') {
          throw new BundleValidationError(`${label}: prompt prefill must be a boolean when present`);
        }
      }
    }
  }
  return /** @type {AgentWelcome} */ (welcome);
}

/**
 * Model prefix rule: a specifier whose first path segment is a known provider
 * is used as-is; anything else gets the default `openrouter/` prefix, so plain
 * OpenRouter ids like `deepseek/deepseek-v4-flash` work unqualified.
 *
 * @param {string} model
 * @returns {string} full provider/model specifier
 */
export function normalizeModelSpecifier(model) {
  const first = model.split('/', 1)[0];
  return KNOWN_MODEL_PROVIDERS.includes(first) ? model : `openrouter/${model}`;
}

/**
 * Validate a parsed agent.jsonc against the contract in
 * agents/agent.schema.json. Unknown keys are rejected so typos and
 * not-yet-supported keys (future egress allow list etc.) fail at bundle time.
 *
 * @param {unknown} raw
 * @returns {{ instructions?: string, model?: string, model_base_url?: string, welcome?: AgentWelcome }}
 */
export function validateAgentConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BundleValidationError('agent.jsonc must be a JSON object');
  }
  const config = /** @type {Record<string, unknown>} */ (raw);
  const allowed = ['$schema', 'instructions', 'model', 'model_base_url', 'proxy_whitelist', 'welcome'];
  for (const key of Object.keys(config)) {
    if (!allowed.includes(key)) {
      throw new BundleValidationError(`agent.jsonc has unknown key: ${key} (allowed: ${allowed.join(', ')})`);
    }
  }
  if (config.instructions !== undefined && (typeof config.instructions !== 'string' || config.instructions.length === 0)) {
    throw new BundleValidationError('agent.jsonc "instructions" must be a non-empty string when present');
  }
  if (config.model !== undefined && (typeof config.model !== 'string' || config.model.length === 0)) {
    throw new BundleValidationError('agent.jsonc "model" must be a non-empty string when present');
  }
  if (config.model_base_url !== undefined && (typeof config.model_base_url !== 'string' || !/^https?:\/\//.test(config.model_base_url))) {
    throw new BundleValidationError('agent.jsonc "model_base_url" must be an http(s) URL when present');
  }
  if (config.proxy_whitelist !== undefined) {
    validateWhitelist(config.proxy_whitelist, 'agent.jsonc "proxy_whitelist"');
  }
  if (config.welcome !== undefined) {
    validateWelcome(config.welcome, 'agent.jsonc "welcome"');
  }
  return config;
}

/**
 * Merge agent.jsonc instructions with the optional INSTRUCTIONS.md text
 * (appended after). An agent must end up with SOME instructions.
 *
 * @param {string | undefined} configInstructions
 * @param {string | undefined} instructionsMd
 * @returns {string}
 */
export function mergeInstructions(configInstructions, instructionsMd) {
  const merged = [configInstructions, instructionsMd]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join('\n\n');
  if (!merged) {
    throw new BundleValidationError('agent has no instructions (agent.jsonc "instructions" and INSTRUCTIONS.md both absent/empty)');
  }
  return merged;
}

/**
 * Validate an untrusted agent bundle before storing or reconstructing it —
 * the server-side gate on backend B's ingest route. Same defensive posture as
 * the old single-skill validateBundle: path traversal, caps, required
 * SKILL.md per skill, plus agent-level shape (instructions, model,
 * modelBaseUrl) and the ustar 100-char entry-name limit so a hostile path
 * fails here (422) instead of inside makeTar (500).
 *
 * @param {unknown} raw bundle object or its JSON string
 * @returns {AgentBundle} the validated bundle (same object, narrowed)
 */
export function validateAgentBundle(raw) {
  if (typeof raw === 'string') raw = JSON.parse(raw);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BundleValidationError('agent bundle must be a JSON object');
  }
  const bundle = /** @type {Record<string, unknown>} */ (raw);

  const agentName = bundle.agentName;
  if (typeof agentName !== 'string' || agentName.length === 0 || agentName.length > 64 || !SKILL_NAME_RE.test(agentName)) {
    throw new BundleValidationError('agentName must be lowercase letters/numbers/hyphens, 1-64 chars, no leading/trailing/consecutive hyphens');
  }
  if (typeof bundle.version !== 'string' || bundle.version.length === 0 || bundle.version.length > 128) {
    throw new BundleValidationError('version must be a non-empty string');
  }
  if (typeof bundle.baseImage !== 'string' || bundle.baseImage.length === 0 || bundle.baseImage.length > 64) {
    throw new BundleValidationError('baseImage must be a non-empty string');
  }
  if (typeof bundle.instructions !== 'string' || bundle.instructions.trim().length === 0) {
    throw new BundleValidationError('instructions must be a non-empty string');
  }
  if (utf8Length(bundle.instructions) > AGENT_LIMITS.maxInstructionsBytes) {
    throw new BundleValidationError(`instructions too large (> ${AGENT_LIMITS.maxInstructionsBytes} bytes)`);
  }
  if (bundle.model !== undefined) {
    if (typeof bundle.model !== 'string' || !bundle.model.includes('/') || bundle.model.startsWith('/')) {
      throw new BundleValidationError('model must be a provider/model specifier (normalize before bundling)');
    }
  }
  if (bundle.modelBaseUrl !== undefined) {
    if (
      typeof bundle.modelBaseUrl !== 'string' ||
      !/^https?:\/\//.test(bundle.modelBaseUrl) ||
      bundle.modelBaseUrl.length > AGENT_LIMITS.maxBaseUrlChars
    ) {
      throw new BundleValidationError('modelBaseUrl must be an http(s) URL');
    }
  }
  if (bundle.proxyWhitelist !== undefined) {
    validateWhitelist(bundle.proxyWhitelist, 'proxyWhitelist');
  }
  if (bundle.welcome !== undefined) {
    validateWelcome(bundle.welcome, 'welcome');
  }

  const skills = bundle.skills;
  if (skills === null || typeof skills !== 'object' || Array.isArray(skills)) {
    throw new BundleValidationError('skills must be an object of skillName -> files map');
  }
  const skillEntries = Object.entries(skills);
  if (skillEntries.length > AGENT_LIMITS.maxSkills) {
    throw new BundleValidationError(`too many skills (${skillEntries.length} > ${AGENT_LIMITS.maxSkills})`);
  }
  let total = 0;
  for (const [skillName, files] of skillEntries) {
    if (skillName.length === 0 || skillName.length > 64 || !SKILL_NAME_RE.test(skillName)) {
      throw new BundleValidationError(`invalid skill name: ${skillName}`);
    }
    total += validateFilesMap(files, {
      label: `skill ${skillName}`,
      // tar entries are named `<skillName>/<relPath>` by provisionAgentSkills
      tarPrefix: `${skillName}/`,
    });
  }
  if (total > AGENT_LIMITS.maxAgentTotalBytes) {
    throw new BundleValidationError(`agent bundle too large (${total} > ${AGENT_LIMITS.maxAgentTotalBytes})`);
  }

  return /** @type {AgentBundle} */ (bundle);
}

function utf8Length(str) {
  return new TextEncoder().encode(str).length;
}
