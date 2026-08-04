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
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { configureLlm } from '@semantius-copilot/core';

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

export type AgentLlm = { agentName: string; model?: string; modelBaseUrl?: string };

/**
 * The raw OpenAI-compatible chat-completions endpoint for a session's model —
 * for one-shot side calls (session title generation) that must not run
 * through the Flue harness. Same resolution order as agentModelSpecifier:
 * agent model override -> env default; agent model_base_url -> LLM_BASE_URL
 * -> the provider's stock endpoint. Null when there is no HTTP endpoint
 * (cloudflare AI binding) or no key — callers skip the feature.
 */
export function chatCompletionsTarget(
  agent?: AgentLlm | null,
): { baseUrl: string; model: string; apiKey: string } | null {
  const spec = agent?.model ?? MODEL_SPECIFIER;
  const slash = spec.indexOf('/');
  const provider = spec.slice(0, slash);
  const model = spec.slice(slash + 1);
  if (provider === 'cloudflare') return null;
  const baseUrl = agent?.modelBaseUrl ?? vars.LLM_BASE_URL ?? PROVIDER_BASE_URLS[provider];
  const apiKey = vars.LLM_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return { baseUrl, model, apiKey };
}

/**
 * Per-agent model resolution. No overrides -> the env-derived default.
 * Overrides resolve metadata-preservingly — Flue trusts catalog metadata
 * blindly (`reasoning` gates thinking, `contextWindow` sets the compaction
 * threshold, `maxTokens` caps output, cost rates price usage), so a
 * synthesized entry silently degrades a capable model:
 *  1. openrouter model known to Pi's catalog, stock endpoint -> return the
 *     specifier unchanged; it resolves against the `openrouter` provider
 *     (re-registered by configureLlm with the LLM_API_KEY secret) and keeps
 *     the full catalog entry.
 *  2. catalog-known model + model_base_url -> dedicated one-model provider
 *     `agent-<name>` reusing the catalog entry, only the transport swapped.
 *  3. catalog miss (custom endpoints, models newer than the catalog) ->
 *     dedicated provider with a conservative placeholder entry (no
 *     reasoning, 128k window, 8k output) — the only degrading path.
 * The `agent-<name>` id is unique per agent so concurrent agents in one
 * isolate never clobber each other; setProvider replaces same-id
 * registrations, so re-registering on every render is idempotent. Auth
 * stays the worker-wide LLM_API_KEY secret — model_base_url overrides
 * transport only.
 */
export function agentModelSpecifier(agent?: AgentLlm | null): string {
  if (!agent || (!agent.model && !agent.modelBaseUrl)) return MODEL_SPECIFIER;
  // The bundler pre-normalizes `model` to a full provider/model specifier.
  const spec = agent.model ?? MODEL_SPECIFIER;
  const slash = spec.indexOf('/');
  const upstreamProvider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  if (upstreamProvider === 'cloudflare') return spec; // AI binding; no base-url override

  const catalogEntry =
    upstreamProvider === 'openrouter'
      ? openrouterProvider()
          .getModels()
          .find((model) => model.id === modelId)
      : undefined;
  if (catalogEntry && !agent.modelBaseUrl) return spec;

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
        catalogEntry
          ? { ...catalogEntry, provider: id, baseUrl: agent.modelBaseUrl ?? catalogEntry.baseUrl }
          : {
              id: modelId,
              name: modelId,
              api: 'openai-completions',
              provider: id,
              baseUrl: agent.modelBaseUrl ?? vars.LLM_BASE_URL ?? PROVIDER_BASE_URLS[upstreamProvider] ?? '',
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
  return `${id}/${modelId}`;
}
