/**
 * The model registry (backend-b/agents_config.jsonc): the whitelist of model
 * ids agents may list in agent.jsonc `models`, each with its display name,
 * provider, upstream model and optional limits/routing/reasoning efforts.
 * Parsed and validated once at worker module init (backend-b/src/llm.ts).
 *
 * @typedef {'openrouter' | 'openai'} ModelProvider
 *
 * @typedef {Object} ModelEntry
 * @property {string} name          display name shown in the chat UI's model dropdown
 * @property {ModelProvider} provider openrouter (LLM_API_KEY) | openai (OPENAI_API_KEY)
 * @property {string} model         upstream model id at that provider
 * @property {number} [maxTokens]   output-token cap, wins over catalog metadata
 * @property {number} [contextWindow] context window in tokens, wins over catalog metadata
 * @property {Record<string, unknown>} [openRouterRouting] OpenRouter provider-routing object
 * @property {string[]} [reasoningEfforts] the OpenRouter reasoning efforts the model accepts
 *
 * @typedef {Record<string, ModelEntry>} ModelRegistry  model id -> entry
 */

import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

import { checkRouting, checkTokenLimit } from './agent.js';
import { BundleValidationError } from './bundle.js';

const MODEL_PROVIDERS = ['openrouter', 'openai'];
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

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
  for (const [id, entry] of Object.entries(models)) {
    const label = `agents_config.jsonc model "${id}"`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BundleValidationError(`${label} must be an object`);
    }
    const allowed = ['name', 'provider', 'model', 'max_tokens', 'context_window', 'openrouter_routing', 'reasoning_efforts'];
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
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      throw new BundleValidationError(`${label}: "model" must be a non-empty string`);
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
      model: entry.model,
      ...(entry.max_tokens !== undefined ? { maxTokens: entry.max_tokens } : {}),
      ...(entry.context_window !== undefined ? { contextWindow: entry.context_window } : {}),
      ...(entry.openrouter_routing !== undefined ? { openRouterRouting: entry.openrouter_routing } : {}),
      ...(efforts !== undefined ? { reasoningEfforts: efforts } : {}),
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
