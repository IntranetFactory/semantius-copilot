'use agent';
/**
 * Backend B agent — the generic MULTI-AGENT host (dynamic bundle delivery,
 * plan §6). Which agent a session runs is not code: it is the agent bundle
 * (instructions + model + skills) POSTed at session creation and stored under
 * `agent:<sessionId>`. This one Flue agent hosts them all.
 *
 * All per-session provisioning happens INSIDE the useAgentStart callback,
 * which Flue awaits on every delivered message before the model runs (and
 * before init-time skill discovery reads the sandbox) — so B self-heals on
 * every cold container. The ingest route only STORES the bundle; this is the
 * reconstruction site.
 *
 * A bundle is immutable per session id, so reconstruction is always
 * absent→write, never overwrite (plan §6/§8).
 *
 * ONE host, many channels: bundle-driven instructions, model, and skill
 * provisioning are shared; a channel only changes where the bundle comes from
 * and how the answer is delivered. Chat sessions read `agent:<sessionId>`
 * (snapshotted by the ingest route from the named `agentdef:<name>`
 * definition) and reply in the conversation; GitHub-issue conversations read
 * the shared `agentdef:github-default` and must deliver through the comment
 * tool.
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
  kvSecretBroker,
  provisionAgentSkills,
  putEgressWhitelist,
  resolveSandboxBinding,
  skillCatalogFromBundle,
  SKILLS_DIR,
  validateAgentBundle,
} from '@hoth/core';
import { commentOnIssue, gitHubRefFromConversation } from '../channels/github';
import { agentModelSpecifier } from '../llm';

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
 *    (authoritative; covers instances created without a seed, and the
 *    re-deployable `agentdef:github-default`). Preferred once present. The
 *    `version` field is the change detector.
 */
type AgentMeta = {
  agentName: string;
  version: string;
  instructions: string;
  model?: string;
  modelBaseUrl?: string;
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

/** The creating send's `initialData` — bundle meta with baseImage, no files. */
type AgentSeed = Omit<AgentMeta, 'binding'> & { baseImage?: string };

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
    ...(skillCatalog && skillCatalog.length > 0 ? { skillCatalog } : {}),
    binding,
  };
}

export function Main({ id }: AgentProps) {
  const { STORE } = env as unknown as Env;

  // GitHub is just another channel: same bundle-driven identity (from the
  // shared default bundle), one conversation per issue — plus the delivery
  // rule that answers must be posted back to the issue thread. Chat sessions
  // get their egress bearer from the ingest route (24 h TTL stays fail-closed,
  // plan §13 C5); channel conversations never pass ingest, so they self-heal
  // the mapping here — mint-if-absent, never rotating a warm one.
  const issueRef = gitHubRefFromConversation(id);
  const bundleKey = issueRef ? `${AGENT_DEF_KEY_PREFIX}github-default` : `agent:${id}`;
  const bearerTag = issueRef ? 'github' : undefined;

  // Two-path identity resolution (see AgentMeta docs): the persisted meta is
  // authoritative once the start callback lands it; the creation seed covers
  // the first submission's renders. Null (env-default model, 'Sandbox'
  // binding, generic instructions) covers sessions with neither.
  const seed = useInitialData<AgentSeed | undefined>();
  const [meta, setMeta] = usePersistentState<AgentMeta | null>('agentMeta', null);
  const active = meta ?? metaFromSeed(seed);
  const specifier = agentModelSpecifier(active);
  useModel(specifier);

  // Flue v2 dropped per-message usage/model from the conversation read
  // projection (beta attached metadata.usage to every assistant message);
  // response metadata is the v2 seam that reaches clients and the data
  // browser's Raw JSON. Catalog-known model overrides keep an openrouter/
  // specifier (llm.ts resolves them against the Pi catalog with real
  // per-token rates), so this gate covers them; only the agent-<name>
  // placeholder/custom providers register zero rates — $0 would read as
  // "free", so those attach nothing. cost.total is OpenRouter's BILLED
  // amount (the pi-ai patch requests usage accounting and prefers the
  // inline usage.cost over the catalog estimate); the per-component costs
  // remain pi-ai's catalog-rate computation, so components may not sum
  // exactly to the total.
  if (specifier.startsWith('openrouter/')) {
    useResponseFinish(({ response }) => ({ usage: response.usage, model: specifier }));
  }
  const namespace = (env as unknown as Record<string, DurableObjectNamespace>)[active?.binding ?? 'Sandbox'];
  useSandbox(cloudflareSandbox(getSandbox(namespace, id)), { cwd: '/workspace' });

  // Explicit catalog mounting — the second leg of skill delivery (see
  // AgentMeta.skillCatalog). The definition's instructions POINT AT the
  // on-disk SKILL.md rather than inlining it: the per-message self-heal in
  // useAgentStart guarantees the files exist by the time tools run, keeps
  // this state small, and keeps every relative reference inside the skill
  // resolvable from a real directory. When workspace discovery ALSO finds
  // the disk copy, the discovered skill wins the name merge — same content.
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
        ...(skillCatalog.length > 0 ? { skillCatalog } : {}),
        binding,
      });
    }
    const ns = (env as unknown as Record<string, DurableObjectNamespace>)[binding];
    const containerId = ns.idFromName(id).toString();

    // Absent→write self-heal: no-op on a warm container, reconstructs after
    // sleep/eviction reset the disk. Zero-skill agents provision nothing.
    await provisionAgentSkills(getSandbox(ns, id), bundle);

    // Egress-whitelist self-heal: re-map the bundle's proxy_whitelist for this
    // container (covers channel conversations that never pass ingest, and
    // expired TTLs on long-lived sessions). Deleted sessions never reach here
    // — their bundle is gone, so the early return above keeps them deny-all.
    await putEgressWhitelist(STORE, containerId, bundle.proxyWhitelist ?? []);

    if (bearerTag) {
      const broker = kvSecretBroker(STORE);
      if (!(await broker.resolve(containerId))) {
        await broker.put(containerId, `hoth-b-bearer-${bearerTag}-${crypto.randomUUID()}`, bearerTag);
      }
    }
  });

  const instructions = active?.instructions ?? DEFAULT_INSTRUCTIONS;

  if (issueRef) {
    useTool(commentOnIssue(issueRef));
    return (
      `${instructions} ` +
      `This conversation is bound to GitHub issue #${issueRef.issueNumber} in ${issueRef.owner}/${issueRef.repo}; ` +
      'each input is a JSON event (a newly opened issue or a new comment). ' +
      'IMPORTANT: the issue author can ONLY see comments you post with the comment_on_github_issue tool — a plain text ' +
      'reply reaches nobody. You MUST finish every event by calling comment_on_github_issue exactly once with your full ' +
      'answer in Markdown. If the request is unclear, post a comment asking for clarification.'
    );
  }

  return instructions;
}

// The generic multi-agent host: durable identity `main` (generated DO class
// FlueMainAgent, wrangler migration v4) and the /agents/main mount name.
Main.agentName = 'main';
