/**
 * LLM provider wiring (runs once at module init). A session's model is an id
 * from the model registry (../agents_config.jsonc): openrouter models use the
 * LLM_API_KEY secret, openai models the OPENAI_API_KEY secret (.dev.vars in
 * local dev). The env default (LLM_PROVIDER / LLM_MODEL / LLM_BASE_URL wrangler
 * vars, see @semantius-copilot/core configureLlm) only serves sessions without
 * a model id.
 *
 * Flue v2 removed the beta registerProvider(name, opts) API in favor of Pi
 * provider objects (setProvider + createProvider). This adapter keeps
 * @semantius-copilot/core's configureLlm contract: it is invoked only when the env
 * overrides a provider's transport/auth.
 */
import { env } from 'cloudflare:workers';
import { setProvider, type ThinkingLevel } from '@flue/runtime';
import { createProvider, type OpenRouterRouting } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import {
  applyModelLimits,
  configureLlm,
  parseModelsConfig,
  resolveCatalogModel,
  thinkingLevelMap,
} from '@semantius-copilot/core';
import modelsConfigText from '../agents_config.jsonc?raw';

const vars = env as Record<string, string | undefined>;

function registerProvider(id: string, opts: { api?: string; baseUrl?: string; apiKey?: string }): void {
  const auth = {
    apiKey: {
      name: 'LLM_API_KEY',
      resolve: async () => ({ auth: opts.apiKey ? { apiKey: opts.apiKey } : {} }),
    },
  };

  if (id === 'openrouter') {
    // Built-in provider: keeps its model catalog, overrides transport/auth.
    const models = openrouterProvider()
      .getModels()
      .map((model) => (opts.baseUrl ? { ...model, baseUrl: opts.baseUrl } : model));
    setProvider(createProvider({ id, auth, models, api: openAICompletionsApi() }));
    return;
  }

  // 'custom': any OpenAI-compatible endpoint at LLM_BASE_URL — a one-model
  // catalog built from the env (the beta API needed no catalog; Pi does).
  const model = vars.LLM_MODEL ?? '';
  setProvider(
    createProvider({
      id,
      auth,
      models: [
        {
          id: model,
          name: model,
          api: 'openai-completions',
          provider: id,
          baseUrl: opts.baseUrl ?? '',
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
        },
      ],
      api: openAICompletionsApi(),
    }),
  );
}

// openrouter: Pi's built-in catalog with the LLM_API_KEY secret, whatever the
// env default is (registry models with provider "openrouter" resolve here).
// configureLlm below re-registers it when the env overrides its transport.
registerProvider('openrouter', { apiKey: vars.LLM_API_KEY });

export const MODEL_SPECIFIER: string = configureLlm(registerProvider, vars);

type ModelEntry = {
  name: string;
  provider: 'openrouter' | 'openai';
  model: string;
  maxTokens?: number;
  contextWindow?: number;
  openRouterRouting?: Record<string, unknown>;
  reasoningEfforts?: string[];
  /** Fixed effort for every turn, one of reasoningEfforts (parseModelsConfig). */
  thinkingLevel?: ThinkingLevel;
};

/** The model registry: model id -> entry. Validated once here, at module init. */
export const MODELS: Record<string, ModelEntry> = parseModelsConfig(modelsConfigText);

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** The key each registry provider authenticates with. */
const PROVIDER_KEYS: Record<ModelEntry['provider'], string | undefined> = {
  openrouter: vars.LLM_API_KEY,
  openai: vars.OPENAI_API_KEY,
};

// openai: Pi's built-in catalog and Responses API, authenticated with the
// OPENAI_API_KEY secret. Registry models with provider "openai" resolve here
// as `openai/<model>` (always exact catalog ids, see parseModelsConfig).
setProvider(
  createProvider({
    id: 'openai',
    auth: {
      apiKey: {
        name: 'OPENAI_API_KEY',
        resolve: async () => ({ auth: vars.OPENAI_API_KEY ? { apiKey: vars.OPENAI_API_KEY } : {} }),
      },
    },
    models: openaiProvider().getModels(),
    api: openAIResponsesApi(),
  }),
);

/** The Pi catalog of a registry provider, for resolveCatalogModel. */
function catalogFor(provider: ModelEntry['provider']) {
  return provider === 'openai' ? openaiProvider().getModels() : openrouterProvider().getModels();
}

/** Attach a registry entry's routing preferences to a catalog/placeholder entry:
 * pi-ai's openai-completions API sends `model.compat.openRouterRouting` as the
 * request-body `provider` field verbatim, so this is the whole forwarding —
 * no key mapping, no pi-ai patch. Untouched when the entry set none. The cast
 * only satisfies pi-ai's advisory type: the object is whatever the registry
 * declared, and OpenRouter (not this code) validates its fields. */
function withRouting<T extends { compat?: object }>(entry: T, model: ModelEntry): T {
  if (model.openRouterRouting === undefined) return entry;
  return {
    ...entry,
    compat: { ...(entry.compat ?? {}), openRouterRouting: model.openRouterRouting as OpenRouterRouting },
  };
}

/** A registry entry's `reasoning_efforts` onto a catalog/placeholder entry:
 * `reasoning: true` plus core's thinkingLevelMap (listed efforts only, never
 * "none"). pi-ai clamps Flue's thinking level to the nearest listed effort
 * and, on an openrouter.ai base URL, sends it as `reasoning: {effort}`.
 * Untouched when the entry set none. */
function withReasoning<T extends object>(entry: T, model: ModelEntry): T {
  if (model.reasoningEfforts === undefined) return entry;
  return { ...entry, reasoning: true, thinkingLevelMap: thinkingLevelMap(model.reasoningEfforts) };
}

/**
 * The one predicate for "this model resolves through the degrading
 * placeholder path" (modelSpecifierFor case 3), phrased as the warning to
 * show. Shared by the deploy route (PUT /agents/:name answers it to the
 * deploy script, per listed model) and the runtime warn in modelSpecifierFor,
 * so deploy-time detection can never drift from what resolution actually
 * does. Undefined = full catalog metadata applies.
 *
 * Why it exists: a catalog miss silently runs sessions with the
 * conservative placeholder (128k context window, 8k output cap), and the cap
 * truncates long single-pass writes mid-response (stop_reason "length") —
 * the UI shows the agent announcing work and then going silent. Root-caused
 * 2026-08-12 on `deepseek/deepseek-v4-flash-0731` (dated slug; only the
 * undated `deepseek/deepseek-v4-flash` is in the catalog). Since then a
 * dated slug resolves to the undated base entry's metadata
 * (resolveCatalogModel), so this warns only for misses the fallback also
 * cannot resolve — and not when the registry pins an explicit `max_tokens`,
 * because then the placeholder's 8k bite (the harm warned about) is
 * overridden by a consciously chosen budget.
 */
export function modelCatalogWarning(modelId: string): string | undefined {
  const model = MODELS[modelId];
  if (!model) return undefined;
  const { entry, exact } = resolveCatalogModel(catalogFor(model.provider), model.model);
  // openai models resolve against the stock catalog only (no placeholder
  // path): anything but an exact id fails every turn.
  if (model.provider === 'openai') {
    return exact
      ? undefined
      : `model "${modelId}" (openai/${model.model}) is not an exact id in Pi's openai catalog — every turn will fail.`;
  }
  if (entry !== undefined) return undefined;
  if (model.maxTokens !== undefined) return undefined;
  return (
    `model "${modelId}" (${model.provider}/${model.model}) is not in Pi's catalog — sessions will run with the ` +
    `conservative placeholder (128k context window, 8k output cap), and the cap truncates long single-pass ` +
    `responses (stop_reason "length": the agent announces work, then goes silent). ` +
    `Use an exact catalog id or a dated variant of one (a trailing -MMDD resolves to the base ` +
    `entry's metadata), or set explicit "max_tokens"/"context_window" in agents_config.jsonc.`
  );
}

/** One warning per model id per isolate — resolution runs on every render. */
const warnedPlaceholderModels = new Set<string>();

/**
 * The raw OpenAI-compatible chat-completions endpoint for a session's model —
 * for one-shot side calls (session title generation) that must not run
 * through the Flue harness. Always the session's own model and provider, so a
 * transcript never goes to a provider the user didn't pick; no model id ->
 * the env default. `routing` is the entry's OpenRouter routing object for the
 * caller to send as the body's `provider` field, so a side call honors the
 * same provider preferences as the model turns. Null when there is no HTTP
 * endpoint (cloudflare AI binding) or no key — callers skip the feature.
 */
export function chatCompletionsTarget(modelId?: string | null): {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  routing?: Record<string, unknown>;
  reasoningEfforts?: string[];
} | null {
  const entry = modelId ? MODELS[modelId] : undefined;
  if (entry) {
    const apiKey = PROVIDER_KEYS[entry.provider];
    if (!apiKey) return null;
    return {
      provider: entry.provider,
      baseUrl: entry.provider === 'openai' ? OPENAI_BASE_URL : OPENROUTER_BASE_URL,
      model: entry.model,
      apiKey,
      ...(entry.openRouterRouting ? { routing: entry.openRouterRouting } : {}),
      ...(entry.reasoningEfforts ? { reasoningEfforts: entry.reasoningEfforts } : {}),
    };
  }
  const slash = MODEL_SPECIFIER.indexOf('/');
  const provider = MODEL_SPECIFIER.slice(0, slash);
  if (provider === 'cloudflare') return null;
  const baseUrl = vars.LLM_BASE_URL ?? (provider === 'openrouter' ? OPENROUTER_BASE_URL : undefined);
  const apiKey = vars.LLM_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { provider, baseUrl, model: MODEL_SPECIFIER.slice(slash + 1), apiKey };
}

/**
 * Per-session model resolution from a registry model id. No id / unknown id
 * -> the env-derived default. Registry entries resolve metadata-preservingly —
 * Flue trusts catalog metadata blindly (`reasoning` gates thinking,
 * `contextWindow` sets the compaction threshold, `maxTokens` caps output,
 * cost rates price usage), so a synthesized entry silently degrades a
 * capable model:
 *  1. model known to its provider's Pi catalog VERBATIM, no limits/routing/
 *     efforts -> `<provider>/<model>`; it resolves against the `openrouter`
 *     provider (re-registered by configureLlm with the LLM_API_KEY secret) or
 *     the `openai` provider (registered above with OPENAI_API_KEY) and keeps
 *     the full catalog entry. Every openai model takes this path.
 *  2. catalog-resolvable openrouter model with explicit limits, routing and/or
 *     efforts -> dedicated one-model provider `model-<id>` reusing the catalog
 *     entry, only limits/routing/reasoning swapped. "Catalog-resolvable"
 *     includes the dated-slug fallback (resolveCatalogModel): a pinned
 *     `…-0731` slug reuses the undated base entry's metadata while the
 *     request keeps the dated model id (the 2026-08-12 truncation incident).
 *  3. catalog miss (models newer than the catalog) -> dedicated provider with
 *     a conservative placeholder entry (no reasoning, 128k window, 8k output)
 *     — the only degrading path, and the entry's max_tokens/context_window/
 *     reasoning_efforts override even that.
 * The `model-<id>` provider is shared by every agent using that model;
 * setProvider replaces same-id registrations, so re-registering on every
 * render is idempotent. Auth is the LLM_API_KEY secret (openrouter only).
 */
export function modelSpecifierFor(modelId?: string | null): string {
  const model = modelId ? MODELS[modelId] : undefined;
  if (!modelId || !model) return MODEL_SPECIFIER;
  const hasOverride =
    model.maxTokens !== undefined ||
    model.contextWindow !== undefined ||
    model.openRouterRouting !== undefined ||
    model.reasoningEfforts !== undefined;
  const { entry: catalogEntry, exact } = resolveCatalogModel(catalogFor(model.provider), model.model);
  if (model.provider === 'openai' || (exact && catalogEntry && !hasOverride)) return `${model.provider}/${model.model}`;

  // modelCatalogWarning is the single predicate for "this resolution
  // degrades" — it already accounts for the dated-slug fallback and an
  // explicit max_tokens override, so warn exactly when it says to.
  if (!catalogEntry && !warnedPlaceholderModels.has(modelId)) {
    const warning = modelCatalogWarning(modelId);
    if (warning) {
      warnedPlaceholderModels.add(modelId);
      console.warn(`[llm] ${warning}`);
    }
  }

  const id = `model-${modelId}`;
  const auth = {
    apiKey: {
      name: 'LLM_API_KEY',
      resolve: async () => ({ auth: vars.LLM_API_KEY ? { apiKey: vars.LLM_API_KEY } : {} }),
    },
  };
  setProvider(
    createProvider({
      id,
      auth,
      models: [
        withReasoning(
          withRouting(
            applyModelLimits(
              catalogEntry
                ? { ...catalogEntry, provider: id }
                : {
                    id: model.model,
                    name: model.model,
                    api: 'openai-completions' as const,
                    provider: id,
                    baseUrl: OPENROUTER_BASE_URL,
                    reasoning: false,
                    input: ['text' as const],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128000,
                    maxTokens: 8192,
                  },
              model,
            ),
            model,
          ),
          model,
        ),
      ],
      api: openAICompletionsApi(),
    }),
  );
  return `${id}/${model.model}`;
}
