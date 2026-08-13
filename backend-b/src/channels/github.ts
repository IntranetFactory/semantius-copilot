/**
 * GitHub channel — issues on the connected repo become agent conversations
 * (https://flueframework.com/docs/ecosystem/channels/github/).
 *
 * Ingress: the channel verifies X-Hub-Signature-256 against
 * GITHUB_WEBHOOK_SECRET over the raw delivery bytes before the handler runs,
 * so its /webhook route is mounted OUTSIDE the API-key guard in app.ts.
 * `issues.opened` and `issue_comment.created` dispatch to the Main agent
 * (running the trip-planner definition directly — GITHUB_AGENT_NAME below,
 * `agentdef:hoth-trip-planner`, the same entry chat sessions ingest by name;
 * no alias key) keyed by the canonical instance id (one conversation per
 * issue), so follow-up comments continue the same session.
 *
 * Egress: the agent posts replies through the comment_on_github_issue tool
 * (Octokit + GITHUB_TOKEN). Every reply carries AGENT_MARKER and the webhook
 * skips marked/bot comments — that is the loop guard: without it the agent's
 * own comment would re-trigger a dispatch forever.
 */
import { env } from 'cloudflare:workers';
import { createGitHubChannel, type GitHubIssueRef } from '@flue/github';
import { defineTool, dispatch } from '@flue/runtime';
import { AGENT_DEF_KEY_PREFIX, putSessionIndex, readSession } from '@semantius-copilot/core';
import { Octokit } from '@octokit/rest';
import * as v from 'valibot';
import { Main } from '../agents/main';

const secrets = env as Record<string, string | undefined>;

/** Appended (as an invisible HTML comment) to every agent reply. */
const AGENT_MARKER = '<!-- semantius-copilot-agent-reply -->';

/**
 * The named definition GitHub conversations run — the trip-planner agent,
 * read straight from `agentdef:hoth-trip-planner` (no alias key: the KV
 * namespace holds exactly one definition per agents/ folder). Also consumed
 * by main.ts to pick the bundle key for issue-bound conversations.
 */
export const GITHUB_AGENT_NAME = 'hoth-trip-planner';

export const channel = createGitHubChannel({
  webhookSecret: secrets.GITHUB_WEBHOOK_SECRET ?? '',
  async webhook({ delivery }) {
    if (delivery.name === 'issues' && delivery.payload.action === 'opened') {
      const { repository, issue } = delivery.payload;
      await dispatchToAgent(
        { owner: repository.owner.login, repo: repository.name, issueNumber: issue.number },
        {
          type: 'github.issue.opened',
          deliveryId: delivery.deliveryId,
          issue: { number: issue.number, title: issue.title, body: issue.body ?? '', author: issue.user?.login ?? 'unknown' },
        },
      );
      return { status: 'dispatched' };
    }

    if (delivery.name === 'issue_comment' && delivery.payload.action === 'created') {
      const { repository, issue, comment } = delivery.payload;
      // Loop guard: never re-dispatch the agent's own replies.
      if (comment.user?.type === 'Bot' || comment.body.includes(AGENT_MARKER)) {
        return { status: 'skipped: agent or bot comment' };
      }
      await dispatchToAgent(
        { owner: repository.owner.login, repo: repository.name, issueNumber: issue.number },
        {
          type: 'github.issue_comment.created',
          deliveryId: delivery.deliveryId,
          issue: { number: issue.number, title: issue.title },
          comment: { id: comment.id, body: comment.body, author: comment.user?.login ?? 'unknown' },
        },
      );
      return { status: 'dispatched' };
    }
  },
});

async function dispatchToAgent(
  ref: GitHubIssueRef,
  input: { type: string; deliveryId: string } & Record<string, unknown>,
): Promise<void> {
  const id = channel.instanceId(ref);
  // v2 dispatch takes the agent function and a structured signal message. The
  // body carries the same JSON event the beta passed as raw input, so the
  // agent instructions ("each input is a JSON event") keep working unchanged.
  // initialData seeds the instance-creating dispatch with the default agent
  // bundle's meta so even the FIRST model turn runs on its instructions —
  // state persisted in useAgentStart lands only after turn 1. Flue ignores it
  // on every later dispatch to the same instance.
  await dispatch(Main, {
    id,
    message: {
      kind: 'signal',
      type: input.type,
      body: JSON.stringify(input),
      attributes: { deliveryId: input.deliveryId },
    },
    ...(await githubAgentSeed()),
  });
  await indexConversation(id, ref).catch(() => {});
}

/** `{ initialData }` from the GitHub agent's named definition, or {}. */
async function githubAgentSeed(): Promise<{ initialData?: Record<string, unknown> }> {
  try {
    const raw = await (env as unknown as { STORE: KVNamespace }).STORE.get(`${AGENT_DEF_KEY_PREFIX}${GITHUB_AGENT_NAME}`);
    if (!raw) return {};
    const bundle = JSON.parse(raw) as Record<string, unknown>;
    return {
      initialData: {
        agentName: bundle.agentName,
        version: bundle.version,
        baseImage: bundle.baseImage,
        instructions: bundle.instructions,
        ...(bundle.model ? { model: bundle.model } : {}),
        ...(bundle.modelBaseUrl ? { modelBaseUrl: bundle.modelBaseUrl } : {}),
        ...(typeof bundle.maxTokens === 'number' ? { maxTokens: bundle.maxTokens } : {}),
        ...(typeof bundle.contextWindow === 'number' ? { contextWindow: bundle.contextWindow } : {}),
      },
    };
  } catch {
    return {};
  }
}

/**
 * Record the conversation in the data browser's session index (plan: the
 * `session:<id>` KV entry is the only enumerable record of a conversation).
 * Ingest-route sessions are indexed at provisioning; GitHub conversations are
 * born here at dispatch, so this is their indexing site. Refreshes keep the
 * original createdAt (and extend the 24 h TTL) so the newest-first sort
 * reflects when the issue conversation started, not its latest comment.
 */
async function indexConversation(id: string, ref: GitHubIssueRef): Promise<void> {
  const store = (env as { STORE: KVNamespace }).STORE;
  const existing = await readSession(store, id);
  // Spread the existing record first: refreshes must not drop fields other
  // writers merged in meanwhile (session_state from the response-finish seam).
  await putSessionIndex(store, id, {
    ...(existing ?? {}),
    backend: 'b',
    channel: 'github',
    repo: `${ref.owner}/${ref.repo}`,
    issueNumber: ref.issueNumber,
    createdAt:
      existing && typeof existing.createdAt === 'string' ? existing.createdAt : new Date().toISOString(),
  });
}

/** The GitHub issue bound to this agent instance, or null for non-GitHub sessions. */
export function gitHubRefFromConversation(id: string): GitHubIssueRef | null {
  try {
    return channel.parseInstanceId(id);
  } catch {
    return null;
  }
}

export function commentOnIssue(ref: GitHubIssueRef) {
  return defineTool({
    name: 'comment_on_github_issue',
    description: `Post a Markdown comment as your answer on GitHub issue #${ref.issueNumber} in ${ref.owner}/${ref.repo}.`,
    input: v.object({ body: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { body } }) {
      const client = new Octokit({ auth: secrets.GITHUB_TOKEN });
      const result = await client.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body: `${body}\n\n${AGENT_MARKER}`,
      });
      return { commentId: result.data.id, url: result.data.html_url };
    },
  });
}
