'use agent';
/**
 * Backend B agent — the generic MULTI-AGENT host (dynamic bundle delivery,
 * plan §6). Which agent a session runs is not code: it is the agent bundle
 * (instructions + model + skills) POSTed at session creation and stored under
 * `agent:<sessionId>`. This one Flue agent hosts them all.
 *
 * Per-session provisioning is LAZY (lazy-env.ts): Flue's init-time workspace
 * discovery runs at the start of every submission BEFORE the start hook, and
 * on @cloudflare/sandbox its first RPC would boot the container — so instead
 * of provisioning eagerly, the sandbox env is wrapped. Discovery and SKILL.md
 * reads are answered from the KV bundle (byte-identical to the disk copy);
 * the container boots at the first exec/write, which provisions skills +
 * Semantius env right there (the per-submission cold-container self-heal).
 * useAgentStart keeps only the KV-side work: meta migration and the egress
 * policy. The ingest route only STORES the bundle.
 *
 * A bundle is immutable per session id, so reconstruction is always
 * absent→write, never overwrite (plan §6/§8).
 *
 * ONE host, many channels: bundle-driven instructions, model, and skill
 * provisioning are shared; a channel only changes where the bundle comes from
 * and how the answer is delivered. Chat sessions read `agent:<sessionId>`
 * (snapshotted by the ingest route from the named `agentdef:<name>`
 * definition) and reply in the conversation; GitHub-issue conversations read
 * the trip-planner definition directly (`agentdef:<GITHUB_AGENT_NAME>` — no
 * alias key) and must deliver through the comment tool.
 */
import { getSandbox } from '@cloudflare/sandbox';
import { env } from 'cloudflare:workers';
import {
  type AgentProps,
  useAgentStart,
  useInitialData,
  useModel,
  usePersistentState,
  useResponseFinish,
  useSandbox,
  useSkill,
  useTool,
} from '@flue/runtime';
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import {
  AGENT_DEF_KEY_PREFIX,
  ensureEgressPolicy,
  mergeSessionRecord,
  provisionAgentSkills,
  provisionSemantiusEnv,
  readSession,
  resolveSandboxBinding,
  sandboxNameForSession,
  skillCatalogFromBundle,
  SKILLS_DIR,
  validateAgentBundle,
} from '@semantius-copilot/core';
import * as v from 'valibot';
import {
  drainWorkspaceTouched,
  markWorkspaceTouched,
  persistWorkspaceBackup,
  restoreWorkspaceBackup,
  type BackupEnv,
  type BackupSandbox,
} from '../backups';
import { commentOnIssue, gitHubRefFromConversation, GITHUB_AGENT_NAME } from '../channels/github';
import { lazySessionEnv } from '../lazy-env';
import { askUserQuestion } from '../tools/ask-user-question';
import { agentModelSpecifier } from '../llm';
import { drainTitleTranscript, maybeGenerateTitle } from '../title';
import { drainLlmCalls } from '../usage';

type Env = {
  Sandbox: DurableObjectNamespace;
  STORE: KVNamespace;
};

/** Sessions whose bundle is missing (expired TTL, pre-ingest message). */
const DEFAULT_INSTRUCTIONS =
  'You are a helpful assistant. Use the skills available in your workspace for any task they cover.';

/**
 * The per-session agent identity the render needs but cannot await from KV:
 * instructions, model overrides, and the Sandbox binding derived from
 * baseImage. It reaches the render on two paths:
 *  - `useInitialData` — the meta the creating send carried (frontend chat /
 *    GitHub dispatch), present from the FIRST render on. Load-bearing:
 *    `usePersistentState` writes made in `useAgentStart` only land after the
 *    submission's first model turn (the system prompt is rebuilt BEFORE the
 *    start seam runs; Flue then narrates "System instructions updated."), so
 *    without a seed, turn 1 would run on the generic default instructions.
 *  - `usePersistentState` — set by the start callback from the KV bundle
 *    (authoritative; covers instances created without a seed, and channel
 *    conversations whose named definition is redeployable). Preferred once
 *    present. The `version` field is the change detector.
 */
type AgentMeta = {
  agentName: string;
  version: string;
  instructions: string;
  model?: string;
  modelBaseUrl?: string;
  /** agent.jsonc max_tokens/context_window — explicit model limits, winning
   * over catalog metadata (see AgentLlm in ../llm.ts). */
  maxTokens?: number;
  contextWindow?: number;
  binding: string;
  /**
   * Explicit skill catalog (name + SKILL.md description) mounted via
   * useSkill() every render. The files are ALSO provisioned on disk for
   * execution, but the model-visible catalog must not depend on Flue's
   * init-time workspace discovery observing the sandbox filesystem — on B it
   * measurably does not (provisioned sessions composed system prompts with an
   * empty catalog; see README "Skill delivery to the model").
   */
  skillCatalog?: SkillCatalogEntry[];
};

type SkillCatalogEntry = { name: string; description: string };

/** The creating send's `initialData` — bundle meta with baseImage, no files,
 * plus an optional opaque per-session `payload` surfaced to the agent. */
type AgentSeed = Omit<AgentMeta, 'binding'> & { baseImage?: string; payload?: unknown };

const PAYLOAD_MAX_CHARS = 16 * 1024;

/**
 * The seed's per-session payload as JSON text for the instructions, or null.
 * Read from the RECORDED initialData (constant for the instance's life), never
 * persisted into AgentMeta — the payload is session data, not agent identity.
 * Untrusted: unserializable or oversize payloads are dropped, not fatal.
 */
function payloadFromSeed(seed: AgentSeed | undefined): string | null {
  if (!seed || seed.payload === undefined) return null;
  try {
    const text = JSON.stringify(seed.payload);
    return typeof text === 'string' && text.length > 0 && text.length <= PAYLOAD_MAX_CHARS ? text : null;
  } catch {
    return null;
  }
}

/**
 * Per-session runtime aggregation (session_state): token/cost/call counters
 * accumulated across every response at the useResponseFinish seam. Durable in
 * the instance's record stream (usePersistentState) — the KV session-index
 * mirror and the response metadata are projections of this.
 */
type SessionState = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  cost_total: number;
  tool_calls_count: number;
  llm_calls_count: number;
  responses_count: number;
};

const ZERO_SESSION_STATE: SessionState = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  total_tokens: 0,
  cost_total: 0,
  tool_calls_count: 0,
  llm_calls_count: 0,
  responses_count: 0,
};

/** Untrusted (client-supplied) seed -> AgentMeta, or null when unusable. */
function metaFromSeed(seed: AgentSeed | undefined): AgentMeta | null {
  if (!seed || typeof seed.instructions !== 'string' || seed.instructions.length === 0) return null;
  let binding = 'Sandbox';
  try {
    binding = resolveSandboxBinding(seed.baseImage);
  } catch {
    // Unknown baseImage in a hand-crafted seed: fall back to the default
    // binding instead of failing every render of this conversation forever.
  }
  // The seed is untrusted: keep only well-shaped catalog entries so a
  // hand-crafted seed cannot crash the render inside useSkill().
  const skillCatalog = Array.isArray(seed.skillCatalog)
    ? seed.skillCatalog.filter(
        (s): s is SkillCatalogEntry =>
          !!s && typeof s.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.name) &&
          typeof s.description === 'string' && s.description.length > 0 && s.description.length <= 1024,
      )
    : undefined;
  return {
    agentName: String(seed.agentName ?? 'unknown'),
    version: String(seed.version ?? ''),
    instructions: seed.instructions,
    ...(typeof seed.model === 'string' ? { model: seed.model } : {}),
    ...(typeof seed.modelBaseUrl === 'string' ? { modelBaseUrl: seed.modelBaseUrl } : {}),
    ...(typeof seed.maxTokens === 'number' ? { maxTokens: seed.maxTokens } : {}),
    ...(typeof seed.contextWindow === 'number' ? { contextWindow: seed.contextWindow } : {}),
    ...(skillCatalog && skillCatalog.length > 0 ? { skillCatalog } : {}),
    binding,
  };
}

/**
 * Appended to every chat-channel system prompt (never the GitHub channel —
 * issue-derived conversation ids fail the /workspace route's session-id
 * check). STATIC on purpose: the literal {sessionId} placeholder keeps the
 * prompt prefix identical across sessions, so provider-side prefix caching
 * keeps working; the chat client substitutes the real id at render time and
 * performs the authenticated download.
 */
const WORKSPACE_LINK_INSTRUCTIONS = `

## Handing files to the user

Your /workspace is user-visible: files the user uploads appear at its top
level, and you can hand files back as download links. Save the file at the
TOP level of /workspace (the download route serves flat names only, max
25 MB), then link it in your reply exactly as:

[display name](/workspace/{sessionId}/file-name)

Write the literal placeholder {sessionId} — the chat client replaces it with
the real session id. Percent-encode spaces and parentheses in the file-name
segment (e.g. report (1).pdf -> report%20%281%29.pdf). Files inside
subdirectories cannot be linked — copy them to the top level first.`;

export function Main({ id }: AgentProps) {
  const { STORE } = env as unknown as Env;

  // GitHub is just another channel: same bundle-driven identity (from the
  // trip-planner named definition), one conversation per issue — plus the
  // delivery rule that answers must be posted back to the issue thread.
  // No session type gets `egress_secrets` minted anywhere — downstream
  // credentials come only from the future secret-retrieval layer (see the
  // TODO in app.ts's ingest route); until then credential-required hosts
  // fail closed at egress.
  const issueRef = gitHubRefFromConversation(id);
  const bundleKey = issueRef ? `${AGENT_DEF_KEY_PREFIX}${GITHUB_AGENT_NAME}` : `agent:${id}`;

  // Two-path identity resolution (see AgentMeta docs): the persisted meta is
  // authoritative once the start callback lands it; the creation seed covers
  // the first submission's renders. Null (env-default model, 'Sandbox'
  // binding, generic instructions) covers sessions with neither.
  const seed = useInitialData<AgentSeed | undefined>();
  const [meta, setMeta] = usePersistentState<AgentMeta | null>('agentMeta', null);
  const active = meta ?? metaFromSeed(seed);
  const specifier = agentModelSpecifier(active);
  useModel(specifier);

  // session_state aggregation + response metadata. Flue v2 dropped
  // per-message usage/model from the conversation read projection; response
  // metadata is the v2 seam that reaches clients and the data browser's Raw
  // JSON. The callback MUST stay synchronous (a returned promise fails the
  // submission): the persistent-state updater runs at call time, and the KV
  // mirror is fire-and-forget (best-effort like the observability sinks —
  // healed at the next response finish if lost).
  //
  // session_state attaches on EVERY response; the per-response `usage`/`model`
  // fields keep the openrouter/ gate: catalog-known model overrides resolve to
  // openrouter/ specifiers with real per-token rates, while the agent-<name>
  // placeholder/custom providers register zero rates — $0 would read as
  // "free". cost.total is OpenRouter's BILLED amount (the pi-ai patch
  // requests usage accounting and prefers the inline usage.cost over the
  // catalog estimate); the per-component costs remain pi-ai's catalog-rate
  // computation, so components may not sum exactly to the total.
  // Agent-writable session memory, hoisted above the finish hook so the KV
  // mirror below ships what THIS response's tool calls stored (persistent
  // state writes only become readable next render — agentDataNow tracks them
  // live within the current one).
  const [agentData, setAgentData] = usePersistentState<Record<string, unknown>>('agentData', {});
  let agentDataNow = agentData;

  // Hoisted above useResponseFinish: the finish callback closes over it for
  // the workspace-backup persist (declaration-before-use; the render below
  // reuses the same value for the lazy sandbox env).
  const namespace = (env as unknown as Record<string, DurableObjectNamespace>)[active?.binding ?? 'Sandbox'];

  const [, setSessionState] = usePersistentState<SessionState>('sessionState', ZERO_SESSION_STATE);
  useResponseFinish(({ response }) => {
    const { usage } = response;
    const llmCalls = drainLlmCalls(id);
    let next = ZERO_SESSION_STATE;
    setSessionState(
      (prev) =>
        (next = {
          input_tokens: prev.input_tokens + usage.input,
          output_tokens: prev.output_tokens + usage.output,
          cache_read_tokens: prev.cache_read_tokens + usage.cacheRead,
          cache_write_tokens: prev.cache_write_tokens + usage.cacheWrite,
          total_tokens: prev.total_tokens + usage.totalTokens,
          // Round to micro-dollars: stops float noise accumulating over turns.
          cost_total: Math.round((prev.cost_total + usage.cost.total) * 1e6) / 1e6,
          tool_calls_count: prev.tool_calls_count + response.toolCalls.length,
          llm_calls_count: prev.llm_calls_count + llmCalls,
          // ?? 0: sessions persisted before this field existed.
          responses_count: (prev.responses_count ?? 0) + 1,
        }),
    );
    // Mirror every agent-side data channel into THE session record in one
    // best-effort write: counters, the agent's stored facts, and the creation
    // payload (idempotent). Authoritative copies live in the DO record stream.
    const patch: Record<string, unknown> = { session_state: next };
    if (Object.keys(agentDataNow).length > 0) patch.session_data = agentDataNow;
    if (payloadFromSeed(seed) !== null) patch.payload = seed?.payload;
    mergeSessionRecord(STORE, id, patch).catch(() => {});
    // Sidebar title (session record `title`): void, fire-and-forget — the
    // callback stays synchronous and the response is never delayed.
    maybeGenerateTitle(STORE, id, drainTitleTranscript(id), active, next.responses_count);
    // Workspace backup (fire-and-forget, same posture): only when THIS
    // submission actually touched the container — chat-only turns never boot
    // one just to archive it. persistWorkspaceBackup never throws; the catch
    // is belt-and-braces.
    if (drainWorkspaceTouched(id)) {
      persistWorkspaceBackup({ env: env as unknown as BackupEnv, namespace, sessionId: id }).catch(() => {});
    }
    return {
      session_state: next,
      ...(specifier.startsWith('openrouter/') ? { usage, model: specifier } : {}),
    };
  });
  // Lazy boot (see lazy-env.ts): the wrapper serves discovery + skills-tree
  // reads from the KV bundle and only boots the container at the first
  // exec/write — which then provisions skills + Semantius env (absent→write,
  // no-op on a warm container). getSandbox() is deferred with it: on a cold
  // per-isolate cache it fires a `configure` RPC that wakes the sandbox DO
  // (seen live 2026-08-02 as `SemantiusCopilotSandbox.configure` on a chat-only turn), so
  // it must not run at render.
  const loadBundle = async () => {
    const raw = await STORE.get(bundleKey);
    return raw ? (validateAgentBundle(raw) as { skills?: Record<string, Record<string, string>> }) : null;
  };
  const provisionWorkspace = async () => {
    markWorkspaceTouched(id);
    const sandbox = getSandbox(namespace, sandboxNameForSession(id));
    const record = await readSession(STORE, id);
    // Workspace restore FIRST: the session's backed-up files must be on disk
    // before the agent's first read. Its marker probe is now the exec that
    // creates the container session the later setEnvVars needs; `.agents` is
    // excluded from archives, so the skills sentinel below is unaffected.
    await restoreWorkspaceBackup(sandbox as unknown as BackupSandbox, env as unknown as BackupEnv, record);
    const raw = await STORE.get(bundleKey);
    if (raw) await provisionAgentSkills(sandbox, validateAgentBundle(raw));
    // Same env heal as before: a cold container starts from the image's baked
    // sentinel, so re-point the CLI at THIS session's org (chat sessions
    // always have one; channel conversations no-op).
    const org = (record?.session_context as { semantius_org?: unknown } | undefined)?.semantius_org;
    await provisionSemantiusEnv(sandbox, typeof org === 'string' ? org : undefined);
  };
  useSandbox(
    {
      // `createSandbox` since Flue 2.0.3 — the 2.0.x `createSessionEnv` name is
      // deprecated on the factory we PASS (the runtime still calls it, with a
      // console warning) and is simply GONE from the one `cloudflareSandbox()`
      // RETURNS, so the inner call below must use the new name or throw.
      createSandbox: async (opts) =>
        lazySessionEnv(
          '/workspace',
          // Deferred: this is the first sandbox-DO contact, and it only runs
          // on the provision/delegation path (never for bundle-served reads).
          () => cloudflareSandbox(getSandbox(namespace, sandboxNameForSession(id))).createSandbox(opts),
          loadBundle,
          provisionWorkspace,
        ),
    },
    { cwd: '/workspace' },
  );

  // Explicit catalog mounting — the second leg of skill delivery (see
  // AgentMeta.skillCatalog). The definition's instructions POINT AT the
  // on-disk SKILL.md rather than inlining it: the lazy env serves that read
  // from the KV bundle before the container exists and from disk after (same
  // bytes), keeps this state small, and keeps every relative reference inside
  // the skill resolvable from a real directory. When workspace discovery ALSO
  // finds the disk copy (it reads the same bundle view), the discovered skill
  // wins the name merge — same content.
  for (const skill of active?.skillCatalog ?? []) {
    useSkill({
      name: skill.name,
      description: skill.description,
      instructions:
        `This skill's full instructions are provisioned on disk. ` +
        `Read ${SKILLS_DIR}/${skill.name}/SKILL.md now and follow it exactly; ` +
        `resolve its relative references against ${SKILLS_DIR}/${skill.name}/.`,
    });
  }

  useAgentStart(async () => {
    const raw = await STORE.get(bundleKey);
    if (!raw) return;
    const bundle = validateAgentBundle(raw);
    const binding = resolveSandboxBinding(bundle.baseImage);
    const skillCatalog = skillCatalogFromBundle(bundle);
    // The catalog leg migrates sessions whose meta predates the explicit
    // catalog field (bundle version unchanged); zero-skill agents must not
    // re-trigger it every message, hence the length gate.
    const catalogMissing = meta?.skillCatalog === undefined && skillCatalog.length > 0;
    if (meta?.version !== bundle.version || meta?.binding !== binding || catalogMissing) {
      setMeta({
        agentName: bundle.agentName,
        version: bundle.version,
        instructions: bundle.instructions,
        ...(bundle.model ? { model: bundle.model } : {}),
        ...(bundle.modelBaseUrl ? { modelBaseUrl: bundle.modelBaseUrl } : {}),
        ...(bundle.maxTokens !== undefined ? { maxTokens: bundle.maxTokens } : {}),
        ...(bundle.contextWindow !== undefined ? { contextWindow: bundle.contextWindow } : {}),
        ...(skillCatalog.length > 0 ? { skillCatalog } : {}),
        binding,
      });
    }
    const ns = (env as unknown as Record<string, DurableObjectNamespace>)[binding];
    const containerId = ns.idFromName(sandboxNameForSession(id)).toString();

    // NO container work here: skills + Semantius env are provisioned lazily by
    // the SessionEnv wrapper at the first op that needs the container (see
    // provisionWorkspace above) — an eager heal here would boot a container
    // even for turns that never touch the workspace.

    // Egress-policy self-heal: ensure the container pointer + egress record
    // carry the bundle's proxy_whitelist (covers channel conversations that
    // never pass ingest, and expired TTLs on long-lived sessions). Downstream
    // credentials are never created here — `egress_secrets` comes only from
    // the future secret-retrieval layer (TODO in app.ts's ingest route) — and
    // the client-provided context is preserved, never reconstructed.
    // Deleted sessions never reach here — their bundle is gone, so the early
    // return above keeps them deny-all. Writes only on change.
    await ensureEgressPolicy(STORE, containerId, id, {
      whitelist: bundle.proxyWhitelist ?? [],
    });
  });

  // The agent's write path into its session memory (agentData, declared above
  // the finish hook): durable in the instance's record stream, mirrored into
  // the session record at response finish, surfaced back into instructions.
  useTool({
    name: 'update_session_data',
    description:
      'Persist one session fact as a key/value pair. Stored durably for this session; ' +
      'current values appear under "Session data" in your instructions on later turns.',
    input: v.object({
      key: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
      value: v.pipe(v.string(), v.maxLength(4096)),
    }),
    run({ data: { key, value } }) {
      setAgentData((prev) => (agentDataNow = { ...prev, [key]: value }));
      return { ok: true, key };
    },
  });

  const instructions = active?.instructions ?? DEFAULT_INSTRUCTIONS;

  // Per-session context the model should see: the creating send's payload
  // (immutable initialData) and the agent's own stored facts (mutable).
  const payload = payloadFromSeed(seed);
  const suffix =
    (payload ? `\n\nSession payload (provided at session creation):\n${payload}` : '') +
    (Object.keys(agentData).length > 0
      ? `\n\nSession data (stored via update_session_data):\n${JSON.stringify(agentData, null, 2)}`
      : '');

  if (issueRef) {
    useTool(commentOnIssue(issueRef));
    return (
      `${instructions} ` +
      `This conversation is bound to GitHub issue #${issueRef.issueNumber} in ${issueRef.owner}/${issueRef.repo}; ` +
      'each input is a JSON event (a newly opened issue or a new comment). ' +
      'IMPORTANT: the issue author can ONLY see comments you post with the comment_on_github_issue tool — a plain text ' +
      'reply reaches nobody. You MUST finish every event by calling comment_on_github_issue exactly once with your full ' +
      'answer in Markdown. If the request is unclear, post a comment asking for clarification.' +
      suffix
    );
  }

  // Web/chat sessions only: GitHub-issue conversations have no browser to
  // render the question card, so the tool is not mounted there at all.
  useTool(askUserQuestion);

  return instructions + WORKSPACE_LINK_INSTRUCTIONS + suffix;
}

// The generic multi-agent host: durable identity `main` (generated DO class
// FlueMainAgent, wrangler migration v4) and the /agents/main mount name.
Main.agentName = 'main';
