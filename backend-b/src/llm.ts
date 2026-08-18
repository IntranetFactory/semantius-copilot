/**
 * LLM provider wiring (runs once at module init). LLM_PROVIDER / LLM_MODEL /
 * LLM_BASE_URL come from wrangler vars, LLM_API_KEY from the worker secret
 * (.dev.vars in local dev). See @semantius-copilot/core configureLlm.
 *
 * Flue v2 removed the beta registerProvider(name, opts) API in favor of Pi
 * provider objects (setProvider + createProvider). This adapter keeps
 * @semantius-copilot/core's configureLlm contract: it is invoked only when the env
 * overrides a provider's transport/auth.
 */
import { env } from 'cloudflare:workers';
import { setProvider } from '@flue/runtime';
import { createProvider, type OpenRouterRouting } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { applyModelLimits, configureLlm, resolveCatalogModel } from '@semantius-copilot/core';

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

export const MODEL_SPECIFIER: string = configureLlm(registerProvider, vars);

/** Default endpoints for providers an agent may select via its `model` prefix. */
const PROVIDER_BASE_URLS: Record<string, string | undefined> = {
  openrouter: 'https://openrouter.ai/api/v1',
  custom: vars.LLM_BASE_URL,
};

export type AgentLlm = {
  agentName: string;
  model?: string;
  modelBaseUrl?: string;
  /** agent.jsonc max_tokens — explicit output cap, wins over catalog metadata. */
  maxTokens?: number;
  /** agent.jsonc context_window — explicit window, wins over catalog metadata. */
  contextWindow?: number;
  /** agent.jsonc openrouter_routing — OpenRouter provider-routing preferences,
   * forwarded verbatim as the request-body `provider` object (pi-ai's
   * `compat.openRouterRouting`) on every model turn and the title side call. */
  openRouterRouting?: Record<string, unknown>;
};

/** Attach the agent's routing preferences to a catalog/placeholder entry:
 * pi-ai's openai-completions API sends `model.compat.openRouterRouting` as the
 * request-body `provider` field verbatim, so this is the whole forwarding —
 * no key mapping, no pi-ai patch. Untouched when the agent set none. The cast
 * only satisfies pi-ai's advisory type: the object is whatever agent.jsonc
 * declared, and OpenRouter (not this code) validates its fields. */
function withRouting<T extends { compat?: object }>(entry: T, agent: AgentLlm): T {
  if (agent.openRouterRouting === undefined) return entry;
  return {
    ...entry,
    compat: { ...(entry.compat ?? {}), openRouterRouting: agent.openRouterRouting as OpenRouterRouting },
  };
}

/**
 * The one predicate for "this agent's model resolves through the degrading
 * placeholder path" (agentModelSpecifier case 3), phrased as the warning to
 * show. Shared by the deploy route (PUT /agents/:name answers it to the
 * deploy script) and the runtime warn in agentModelSpecifier, so deploy-time
 * detection can never drift from what resolution actually does. Undefined =
 * full catalog metadata applies (or the env default / AI binding, which are
 * not the agent's doing).
 *
 * Why it exists: a catalog-miss override silently runs sessions with the
 * conservative placeholder (128k window, 8k output cap), and the cap
 * truncates long single-pass writes mid-response (stop_reason "length") —
 * the UI shows the agent announcing work and then going silent. Root-caused
 * 2026-08-12 on `deepseek/deepseek-v4-flash-0731` (dated slug; only the
 * undated `deepseek/deepseek-v4-flash` is in the catalog). Since then a
 * dated slug resolves to the undated base entry's metadata
 * (resolveCatalogModel), so this warns only for misses the fallback also
 * cannot resolve — and not when agent.jsonc pins an explicit `max_tokens`,
 * because then the placeholder's 8k bite (the harm warned about) is
 * overridden by a consciously chosen budget.
 */
export function modelCatalogWarning(agent: AgentLlm): string | undefined {
  if (!agent.model && !agent.modelBaseUrl) return undefined;
  const spec = agent.model ?? MODEL_SPECIFIER;
  const slash = spec.indexOf('/');
  const upstreamProvider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  if (upstreamProvider === 'cloudflare') return undefined;
  const known =
    upstreamProvider === 'openrouter' &&
    resolveCatalogModel(openrouterProvider().getModels(), modelId).entry !== undefined;
  if (known) return undefined;
  if (agent.maxTokens !== undefined) return undefined;
  return (
    `model "${spec}" is not in Pi's catalog — sessions will run with the conservative placeholder ` +
    `(128k context window, 8k output cap), and the cap truncates long single-pass responses ` +
    `(stop_reason "length": the agent announces work, then goes silent). ` +
    `Use an exact catalog id or a dated variant of one (a trailing -MMDD resolves to the base ` +
    `entry's metadata), or set explicit "max_tokens"/"context_window" in agent.jsonc.`
  );
}

/** One warning per specifier per isolate — resolution runs on every render. */
const warnedPlaceholderSpecs = new Set<string>();

/**
 * The raw OpenAI-compatible chat-completions endpoint for a session's model —
 * for one-shot side calls (session title generation) that must not run
 * through the Flue harness. Same resolution order as agentModelSpecifier:
 * agent model override -> env default; agent model_base_url -> LLM_BASE_URL
 * -> the provider's stock endpoint. `routing` is the agent's OpenRouter
 * routing object for the caller to send as the body's `provider` field, so a
 * side call honors the same provider preferences as the agent's turns. Null
 * when there is no HTTP endpoint (cloudflare AI binding) or no key — callers
 * skip the feature.
 */
export function chatCompletionsTarget(
  agent?: AgentLlm | null,
): { baseUrl: string; model: string; apiKey: string; routing?: Record<string, unknown> } | null {
  const spec = agent?.model ?? MODEL_SPECIFIER;
  const slash = spec.indexOf('/');
  const provider = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  if (provider === 'cloudflare') return null;
  const baseUrl = agent?.modelBaseUrl ?? vars.LLM_BASE_URL ?? PROVIDER_BASE_URLS[provider];
  const apiKey = vars.LLM_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, model, apiKey, ...(agent?.openRouterRouting ? { routing: agent.openRouterRouting } : {}) };
}

/**
 * Per-agent model resolution. No overrides -> the env-derived default.
 * Overrides resolve metadata-preservingly — Flue trusts catalog metadata
 * blindly (`reasoning` gates thinking, `contextWindow` sets the compaction
 * threshold, `maxTokens` caps output, cost rates price usage), so a
 * synthesized entry silently degrades a capable model:
 *  1. openrouter model known to Pi's catalog VERBATIM, stock endpoint, no
 *     limit overrides -> return the specifier unchanged; it resolves against
 *     the `openrouter` provider (re-registered by configureLlm with the
 *     LLM_API_KEY secret) and keeps the full catalog entry.
 *  2. catalog-resolvable model + model_base_url, explicit limits and/or
 *     openrouter_routing -> dedicated one-model provider `agent-<name>`
 *     reusing the catalog entry, only the transport/limits/routing swapped.
 *     "Catalog-resolvable" includes the dated-slug fallback
 *     (resolveCatalogModel): a pinned `…-0731` slug reuses the undated base
 *     entry's metadata while the request keeps the dated model id, so
 *     snapshot pinning no longer degrades to the placeholder (the 2026-08-12
 *     truncation incident).
 *  3. catalog miss (custom endpoints, models newer than the catalog) ->
 *     dedicated provider with a conservative placeholder entry (no
 *     reasoning, 128k window, 8k output) — the only degrading path, and
 *     agent.jsonc max_tokens/context_window override even that.
 * openrouter_routing rides along on paths 2 and 3 as the entry's
 * `compat.openRouterRouting` (withRouting) — pi-ai sends it verbatim as the
 * request-body `provider` object; it is forwarded for any HTTP provider
 * (openrouter, custom — an OpenRouter-compatible proxy is the agent author's
 * call) and silently ignored for the cloudflare AI binding.
 * The `agent-<name>` id is unique per agent so concurrent agents in one
 * isolate never clobber each other; setProvider replaces same-id
 * registrations, so re-registering on every render is idempotent. Auth
 * stays the worker-wide LLM_API_KEY secret — model_base_url overrides
 * transport only.
 */
export function agentModelSpecifier(agent?: AgentLlm | null): string {
  if (
    !agent ||
    (!agent.model &&
      !agent.modelBaseUrl &&
      agent.maxTokens === undefined &&
      agent.contextWindow === undefined &&
      agent.openRouterRouting === undefined)
  ) {
    return MODEL_SPECIFIER;
  }
  // The bundler pre-normalizes `model` to a full provider/model specifier.
  const spec = agent.model ?? MODEL_SPECIFIER;
  const slash = spec.indexOf('/');
  const upstreamProvider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  if (upstreamProvider === 'cloudflare') return spec; // AI binding; no base-url/routing override

  const { entry: catalogEntry, exact } =
    upstreamProvider === 'openrouter'
      ? resolveCatalogModel(openrouterProvider().getModels(), modelId)
      : { entry: undefined, exact: false };
  const hasLimitOverride = agent.maxTokens !== undefined || agent.contextWindow !== undefined;
  const hasRouting = agent.openRouterRouting !== undefined;
  if (exact && catalogEntry && !agent.modelBaseUrl && !hasLimitOverride && !hasRouting) return spec;

  // modelCatalogWarning is the single predicate for "this resolution
  // degrades" — it already accounts for the dated-slug fallback and an
  // explicit max_tokens override, so warn exactly when it says to.
  if (!catalogEntry && !warnedPlaceholderSpecs.has(spec)) {
    const warning = modelCatalogWarning(agent);
    if (warning) {
      warnedPlaceholderSpecs.add(spec);
      console.warn(`[llm] agent "${agent.agentName}": ${warning}`);
    }
  }

  const id = `agent-${agent.agentName}`;
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
        withRouting(
          applyModelLimits(
            catalogEntry
              ? { ...catalogEntry, provider: id, baseUrl: agent.modelBaseUrl ?? catalogEntry.baseUrl }
              : {
                  id: modelId,
                  name: modelId,
                  api: 'openai-completions' as const,
                  provider: id,
                  baseUrl: agent.modelBaseUrl ?? vars.LLM_BASE_URL ?? PROVIDER_BASE_URLS[upstreamProvider] ?? '',
                  reasoning: false,
                  input: ['text' as const],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 8192,
                },
            agent,
          ),
          agent,
        ),
      ],
      api: openAICompletionsApi(),
    }),
  );
  return `${id}/${modelId}`;
}
