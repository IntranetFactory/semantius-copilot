/**
 * The model registry (backend-b/agents_config.jsonc): the whitelist of model
 * ids agents may list in agent.jsonc `models`, each with its display name,
 * provider and optional limits/routing/reasoning efforts. The id IS the
 * upstream model id at the provider (`deepseek/deepseek-v4.1-flash-1017`), so
 * the id a session records is exactly what ran; `<id>@<level>` is the same
 * model at a fixed thinking level (withVariant).
 * Parsed and validated once at worker module init (backend-b/src/llm.ts).
 *
 * @typedef {'openrouter' | 'openai'} ModelProvider
 *
 * @typedef {Object} ModelEntry
 * @property {string} name          display name shown in the chat UI's model dropdown
 * @property {ModelProvider} provider openrouter (LLM_API_KEY) | openai (OPENAI_API_KEY)
 * @property {string} model         upstream model id at that provider: the registry id, minus any `@<level>`
 * @property {number} [maxTokens]   output-token cap, wins over catalog metadata
 * @property {number} [contextWindow] context window in tokens, wins over catalog metadata
 * @property {Record<string, unknown>} [openRouterRouting] OpenRouter provider-routing object
 * @property {string[]} [reasoningEfforts] the OpenRouter reasoning efforts the model accepts
 * @property {string} [thinkingLevel] the effort every turn runs at (one of reasoningEfforts);
 *   unset = Flue's default "medium", clamped to the nearest listed effort
 * @property {string} [systemPrompt] model-specific text appended to the agent's
 *   system prompt in sessions running this model (main.ts); inherited by `@` variants
 *
 * @typedef {Record<string, ModelEntry>} ModelRegistry  model id -> entry
 */

import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

import { checkRouting, checkTokenLimit } from './agent.js';
import { BundleValidationError } from './bundle.js';

const MODEL_PROVIDERS = ['openrouter', 'openai'];
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Model-specific behaviour rules, not a second agent prompt: kept small so a
// registry edit cannot silently balloon every turn of every agent on the model.
const MAX_SYSTEM_PROMPT_CHARS = 8 * 1024;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A `<base>@<level>` id is a variant: the `<base>` entry run at thinking
 * level `<level>`. It starts as a copy of the base entry, then its own keys
 * replace the base's. Shallow on purpose: an own `openrouter_routing` or
 * `reasoning_efforts` replaces the base's whole value. The level comes only
 * from the suffix (an own `thinking_level` is rejected, so the id can never
 * disagree with what runs), and the variant must set its own `name` so the
 * model dropdown never shows two identical labels. The merged entry is then
 * validated like any other (the level must be one of its reasoning_efforts).
 *
 * @param {Record<string, unknown>} models the raw `models` object
 * @param {string} id
 * @param {Record<string, unknown>} own
 * @param {string} label
 */
function withVariant(models, id, own, label) {
  const at = id.indexOf('@');
  if (at === -1) return own;
  const base = id.slice(0, at);
  if (!Object.hasOwn(models, base) || !isObject(models[base])) {
    throw new BundleValidationError(`${label}: "${base}" (the part before "@") must be another model id in agents_config.jsonc`);
  }
  if (own.thinking_level !== undefined) {
    throw new BundleValidationError(`${label}: the thinking level comes from the "@" suffix; drop "thinking_level"`);
  }
  if (own.name === undefined) {
    throw new BundleValidationError(`${label}: an "@" variant must set its own "name"`);
  }
  return { ...models[base], ...own, thinking_level: id.slice(at + 1) };
}

/**
 * Parse and validate agents_config.jsonc text. Throws BundleValidationError
 * on the first problem, naming the model id.
 *
 * @param {string} text
 * @returns {ModelRegistry}
 */
export function parseModelsConfig(text) {
  const errors = [];
  const raw = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    const { error, offset } = errors[0];
    throw new BundleValidationError(`agents_config.jsonc: JSONC parse error ${printParseErrorCode(error)} at offset ${offset}`);
  }
  const models = raw?.models;
  if (models === null || typeof models !== 'object' || Array.isArray(models)) {
    throw new BundleValidationError('agents_config.jsonc: "models" must be an object of model id -> entry');
  }
  /** @type {ModelRegistry} */
  const registry = {};
  for (const [id, own] of Object.entries(models)) {
    const label = `agents_config.jsonc model "${id}"`;
    if (!isObject(own)) {
      throw new BundleValidationError(`${label} must be an object`);
    }
    const entry = withVariant(models, id, own, label);
    const allowed = [
      'name',
      'provider',
      'max_tokens',
      'context_window',
      'openrouter_routing',
      'reasoning_efforts',
      'thinking_level',
      'system_prompt',
    ];
    for (const key of Object.keys(entry)) {
      if (!allowed.includes(key)) {
        throw new BundleValidationError(`${label} has unknown key: ${key} (allowed: ${allowed.join(', ')})`);
      }
    }
    if (typeof entry.name !== 'string' || entry.name.length === 0) {
      throw new BundleValidationError(`${label}: "name" must be a non-empty string`);
    }
    if (!MODEL_PROVIDERS.includes(entry.provider)) {
      throw new BundleValidationError(`${label}: "provider" must be one of ${MODEL_PROVIDERS.join(', ')}`);
    }
    const model = id.split('@')[0];
    if (model.length === 0) {
      throw new BundleValidationError(`${label}: the id must be the provider's model id`);
    }
    checkTokenLimit(entry.max_tokens, `${label} "max_tokens"`);
    checkTokenLimit(entry.context_window, `${label} "context_window"`);
    checkRouting(entry.openrouter_routing, `${label} "openrouter_routing"`);
    const efforts = entry.reasoning_efforts;
    if (
      efforts !== undefined &&
      (!Array.isArray(efforts) || efforts.length === 0 || efforts.some((e) => !REASONING_EFFORTS.includes(e)))
    ) {
      throw new BundleValidationError(`${label}: "reasoning_efforts" must be a non-empty subset of ${REASONING_EFFORTS.join(', ')}`);
    }
    // A fixed effort must be one the model accepts: a level outside
    // reasoning_efforts would silently clamp to a neighbour instead.
    const level = entry.thinking_level;
    if (level !== undefined && (efforts === undefined || !efforts.includes(level))) {
      throw new BundleValidationError(`${label}: "thinking_level" must be one of its "reasoning_efforts"`);
    }
    const systemPrompt = entry.system_prompt;
    if (
      systemPrompt !== undefined &&
      (typeof systemPrompt !== 'string' || systemPrompt.trim().length === 0 || systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS)
    ) {
      throw new BundleValidationError(`${label}: "system_prompt" must be a non-empty string of at most ${MAX_SYSTEM_PROMPT_CHARS} characters`);
    }
    // An openai model must be an exact pi-ai catalog id: its limits and
    // reasoning come from the catalog, so it always resolves through the
    // stock provider (Responses API) and never needs a dedicated one.
    if (
      entry.provider !== 'openrouter' &&
      ['max_tokens', 'context_window', 'openrouter_routing', 'reasoning_efforts'].some((k) => entry[k] !== undefined)
    ) {
      throw new BundleValidationError(
        `${label}: max_tokens, context_window, openrouter_routing and reasoning_efforts are openrouter-only`,
      );
    }
    registry[id] = {
      name: entry.name,
      provider: entry.provider,
      model,
      ...(entry.max_tokens !== undefined ? { maxTokens: entry.max_tokens } : {}),
      ...(entry.context_window !== undefined ? { contextWindow: entry.context_window } : {}),
      ...(entry.openrouter_routing !== undefined ? { openRouterRouting: entry.openrouter_routing } : {}),
      ...(efforts !== undefined ? { reasoningEfforts: efforts } : {}),
      ...(level !== undefined ? { thinkingLevel: level } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt: systemPrompt.trim() } : {}),
    };
  }
  return registry;
}

/**
 * pi-ai `thinkingLevelMap` for a registry entry's `reasoning_efforts`: each
 * listed effort maps to itself, every other level (off/minimal included) to
 * null. pi-ai then clamps Flue's thinking level to the nearest listed effort
 * (clampThinkingLevel), and `off: null` keeps it from ever sending `effort:
 * "none"`, which a mandatory-reasoning model rejects.
 *
 * @param {string[]} efforts
 * @returns {Record<string, string | null>}
 */
export function thinkingLevelMap(efforts) {
  /** @type {Record<string, string | null>} */
  const map = { off: null, minimal: null };
  for (const level of REASONING_EFFORTS) map[level] = efforts.includes(level) ? level : null;
  return map;
}

/**
 * The dropdown options for an agent's `models`, in its order. Ids missing
 * from the registry are skipped (the deploy route rejects them up front).
 *
 * @param {ModelRegistry} registry
 * @param {string[]} ids
 * @returns {{ id: string, name: string }[]}
 */
export function modelOptions(registry, ids) {
  return ids.filter((id) => registry[id]).map((id) => ({ id, name: registry[id].name }));
}
