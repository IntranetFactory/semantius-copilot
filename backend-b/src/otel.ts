// flue-blueprint: tooling/opentelemetry — OTLP trace export to Arize AX and
// Langfuse.
//
// Observability sinks next to Braintrust (src/braintrust.ts). Flue's own OTel
// adapter (@flue/opentelemetry) projects runtime observations onto OTel GenAI
// semconv spans (invoke_agent / chat / execute_tool / flue.operation …); the
// shared enrichSpan() below closes the mapping gaps each vendor has, and one
// generic fetch-based exporter POSTs the same spans to every configured sink.
//
// Cloudflare constraints (why this file exists instead of a stock exporter):
//  - The official OTLP exporters transport over node:http / XHR, neither of
//    which exists in workerd. OtlpFetchExporter serializes with
//    ProtobufTraceSerializer and POSTs via fetch (application/x-protobuf).
//  - No global registration: the tracer is handed straight to the Flue
//    instrumentation, so the global OTel context/propagation stays untouched
//    (parenting is explicit inside @flue/opentelemetry — no
//    AsyncLocalStorage context manager required).
//  - Delivery is best-effort like Braintrust: the observer can't waitUntil,
//    so spans ending right before the isolate idles can be lost.
//
// Missing secrets => that sink is a no-op (same contract as braintrust.ts):
// Arize needs ARIZE_SPACE_ID + ARIZE_API_KEY, Langfuse needs
// LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY (+ optional LANGFUSE_BASE_URL,
// default US cloud). Traces carry full prompts/outputs/tool args (Flue's
// default content policy); fine for this POC — pass `content: { transform }`
// to createOpenTelemetryInstrumentation before pointing real tenant data at it.
//
// REVERTED (2026-07-26): an earlier iteration synthesized a "turn activity"
// log (reasoning + tool one-liners) and appended it to the ROOT span's
// output.value and gen_ai.output.messages so Arize's Session-Conversation tab
// would show it. Arize renders the LAST assistant message of the root, so the
// log REPLACED the final answer and rendered as one unreadable line. Message
// attributes must stay exactly what the model produced — turn-by-turn
// inspection belongs to the trace tree (Arize) / observation tree (Langfuse).
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';

const SERVICE_NAME = 'semantius-copilot-backend-b';
const ARIZE_ENDPOINT = 'https://otlp.arize.com/v1/traces';

/** Concatenated text parts of a gen_ai.*.messages JSON attribute, or undefined. */
function messageText(messagesJson: unknown): string | undefined {
  if (typeof messagesJson !== 'string') return undefined;
  try {
    const messages: unknown = JSON.parse(messagesJson);
    if (!Array.isArray(messages)) return undefined;
    const text = messages
      .flatMap((m: { parts?: unknown }) => (Array.isArray(m?.parts) ? m.parts : []))
      .filter((p: { type?: unknown; content?: unknown }) => p?.type === 'text' && typeof p.content === 'string')
      .map((p: { content: string }) => p.content)
      .join('\n');
    return text || undefined;
  } catch {
    return undefined;
  }
}

type ProviderCost = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };

/**
 * turn identity -> that model call's cost from the runtime `turn` event
 * (pi-ai usage.cost: billed TOTAL for OpenRouter via the pi-ai patch,
 * catalog-derived components). The Flue OTel adapter doesn't project cost
 * onto spans, so the observe wrapper below records it BEFORE delegating
 * (the adapter ends the chat span inside its handler, and the simple span
 * processor exports synchronously on end), and enrichSpan stamps
 * OpenInference `llm.cost.*` (Arize uses client-set cost as-is) plus
 * `gen_ai.usage.cost` (Langfuse maps it to cost_details.total).
 */
const costByTurn = new Map<string, ProviderCost>();
const turnCostKey = (parts: unknown[]) => parts.map((value) => value ?? '').join('|');

/**
 * traceId -> latest chat span's gen_ai.output.messages. The pinned nightly
 * emits conversation-prompt `operation` results that the Flue OTel adapter
 * cannot project into gen_ai.output.messages (agentOutput is absent; a
 * structured `data` result is dropped too), so the root invoke_agent span
 * arrives here WITHOUT output — and Arize's session conversation view,
 * which reads the ROOT span's input/output, shows an empty AI side
 * (observed + root-caused 2026-07-26). Children end before their root, so
 * by the time the root exports, this cache holds the trace's final
 * assistant message; enrichSpan stamps it on the root when missing.
 */
const lastChatOutputByTrace = new Map<string, string>();

/**
 * Vendor-gap enrichment, shared by every sink. Mutates the span's attributes
 * in place and is IDEMPOTENT (every stamp is guarded on `=== undefined`):
 * with several sinks configured, whichever exporter runs first does the work
 * and the rest see the already-enriched attributes.
 */
function enrichSpan(span: ReadableSpan): void {
  const attrs = span.attributes;
  // Session grouping: Arize's session view groups by `session.id`; Langfuse
  // maps the same key to its sessionId and wants it on EVERY span. Flue
  // stamps the conversation id on agent/chat/tool spans; fall back to the
  // instance id so internal spans (compaction, operations) land in the same
  // session.
  if (attrs['session.id'] === undefined) {
    const sessionId = attrs['gen_ai.conversation.id'] ?? attrs['flue.instance.id'];
    if (sessionId !== undefined) attrs['session.id'] = sessionId;
  }
  const operation = attrs['gen_ai.operation.name'];
  if (operation === 'chat') {
    const costKey = turnCostKey([attrs['flue.instance.id'], attrs['flue.task.id'], attrs['flue.operation.id'], attrs['flue.turn.id']]);
    const cost = costByTurn.get(costKey);
    if (cost) costByTurn.delete(costKey);
    if (cost && attrs['llm.cost.total'] === undefined) {
      attrs['llm.cost.prompt'] = cost.input + cost.cacheRead + cost.cacheWrite;
      attrs['llm.cost.completion'] = cost.output;
      attrs['llm.cost.prompt_details.cache_read'] = cost.cacheRead;
      attrs['llm.cost.prompt_details.cache_write'] = cost.cacheWrite;
      attrs['llm.cost.total'] = cost.total;
      // Langfuse's documented cost attribute (mapped to cost_details.total).
      attrs['gen_ai.usage.cost'] = cost.total;
    }
    // Token counts: Arize's ingestion normalization maps the gen_ai
    // input/output totals but drops the cache split (the adapter's
    // gen_ai.usage.cache_read/cache_creation spelling is not stable
    // semconv), so Arize showed no cached-token separation while
    // Braintrust did. Stamp the OpenInference token-count attributes
    // explicitly — client-set OpenInference wins over derived mappings.
    // `prompt` stays cache-INCLUSIVE, matching the adapter's
    // input_tokens; prompt_details.* is the breakdown of it.
    if (attrs['llm.token_count.prompt'] === undefined) {
      const input = attrs['gen_ai.usage.input_tokens'];
      const outputTokens = attrs['gen_ai.usage.output_tokens'];
      const cacheRead = attrs['gen_ai.usage.cache_read.input_tokens'];
      const cacheWrite = attrs['gen_ai.usage.cache_creation.input_tokens'];
      if (typeof input === 'number') attrs['llm.token_count.prompt'] = input;
      if (typeof outputTokens === 'number') attrs['llm.token_count.completion'] = outputTokens;
      if (typeof cacheRead === 'number') attrs['llm.token_count.prompt_details.cache_read'] = cacheRead;
      if (typeof cacheWrite === 'number') attrs['llm.token_count.prompt_details.cache_write'] = cacheWrite;
      if (typeof input === 'number' && typeof outputTokens === 'number') {
        attrs['llm.token_count.total'] = input + outputTokens;
      }
    }
    const output = attrs['gen_ai.output.messages'];
    if (typeof output === 'string') {
      lastChatOutputByTrace.set(span.spanContext().traceId, output);
      // Bound isolate memory; entries are per in-flight trace only.
      if (lastChatOutputByTrace.size > 500) {
        const oldest = lastChatOutputByTrace.keys().next().value;
        if (oldest !== undefined) lastChatOutputByTrace.delete(oldest);
      }
    }
    // Langfuse observation input/output: its documented mapping reads
    // langfuse.observation.* / gen_ai.prompt / OpenInference input.value —
    // NOT the adapter's gen_ai.input.messages — so without these stamps a
    // Langfuse generation shows empty input/output. langfuse.* attributes
    // take precedence over every generic convention there.
    if (attrs['langfuse.observation.input'] === undefined && typeof attrs['gen_ai.input.messages'] === 'string') {
      attrs['langfuse.observation.input'] = attrs['gen_ai.input.messages'];
    }
    if (attrs['langfuse.observation.output'] === undefined && typeof output === 'string') {
      attrs['langfuse.observation.output'] = output;
    }
  } else if (operation === 'execute_tool') {
    // Tool results: the adapter writes string-shaped results to the
    // flue-private `flue.tool.call.result` (only object-shaped ones land
    // on semconv `gen_ai.tool.call.result`), and Arize maps neither onto
    // the tool span's OpenInference output — so the trace view showed
    // tool arguments (derived input.value) but empty results. Stamp
    // output.value explicitly; client-set OpenInference wins.
    const args = attrs['gen_ai.tool.call.arguments'] ?? attrs['flue.tool.call.arguments'];
    const result = attrs['flue.tool.call.result'] ?? attrs['gen_ai.tool.call.result'];
    if (attrs['output.value'] === undefined && typeof result === 'string' && result.length > 0) {
      attrs['output.value'] = result;
    }
    // Langfuse: type the observation as a tool (drives the observation tree
    // and Agent Graph) and mirror args/result into its authoritative attrs.
    if (attrs['langfuse.observation.type'] === undefined) attrs['langfuse.observation.type'] = 'tool';
    if (attrs['langfuse.observation.input'] === undefined && typeof args === 'string') {
      attrs['langfuse.observation.input'] = args;
    }
    if (attrs['langfuse.observation.output'] === undefined && typeof result === 'string' && result.length > 0) {
      attrs['langfuse.observation.output'] = result;
    }
  } else if (operation === 'invoke_agent') {
    if (attrs['gen_ai.output.messages'] === undefined) {
      const cached = lastChatOutputByTrace.get(span.spanContext().traceId);
      if (cached !== undefined) attrs['gen_ai.output.messages'] = cached;
    }
    // Plain-text OpenInference input/output on the ROOT span: this is
    // what Arize's session conversation renders (explicitly-set
    // OpenInference attributes take precedence over Arize's derived
    // GenAI mappings, which left the agent span's output empty), and
    // Langfuse maps input.value/output.value to the root observation.
    if (attrs['input.value'] === undefined) {
      const text = messageText(attrs['gen_ai.input.messages']);
      if (text !== undefined) attrs['input.value'] = text;
    }
    if (attrs['output.value'] === undefined) {
      const text = messageText(attrs['gen_ai.output.messages']);
      if (text !== undefined) attrs['output.value'] = text;
    }
    // Langfuse: the root IS the agent execution (Agent Graph node).
    if (attrs['langfuse.observation.type'] === undefined) attrs['langfuse.observation.type'] = 'agent';
  }
}

/**
 * Minimal OTLP/HTTP-protobuf exporter over fetch, one instance per sink.
 * Runs the shared enrichment, then POSTs. Failures are logged and reported
 * to the processor but never crash the request path.
 */
class OtlpFetchExporter implements SpanExporter {
  constructor(
    readonly label: string,
    readonly endpoint: string,
    readonly headers: Record<string, string>,
  ) {}

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) enrichSpan(span);
    const body = ProtobufTraceSerializer.serializeRequest(spans);
    if (!body) {
      resultCallback({ code: ExportResultCode.FAILED, error: new Error('OTLP serialization returned nothing') });
      return;
    }
    fetch(this.endpoint, { method: 'POST', headers: this.headers, body }).then(
      (response) => {
        if (!response.ok) console.warn(`${this.label}: OTLP export rejected with HTTP ${response.status}`);
        resultCallback(
          response.ok
            ? { code: ExportResultCode.SUCCESS }
            : { code: ExportResultCode.FAILED, error: new Error(`HTTP ${response.status}`) },
        );
      },
      (error: unknown) => {
        console.warn(`${this.label}: OTLP export failed`, error);
        resultCallback({ code: ExportResultCode.FAILED, error: error as Error });
      },
    );
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// Simple (per-span) processors, not batch: batching relies on timers that
// may never fire before the isolate idles; per-span fetches lose less.
const spanProcessors: SpanProcessor[] = [];

const arizeSpaceId = process.env.ARIZE_SPACE_ID;
const arizeApiKey = process.env.ARIZE_API_KEY;
if (arizeSpaceId && arizeApiKey) {
  // Arize's docs are inconsistent about the header spelling for the HTTP
  // endpoint (hyphenated `arize-space-id` in the transport callout,
  // underscored `space_id` in the JS example) and warn the wrong form fails
  // SILENTLY. Send both; extras are ignored.
  spanProcessors.push(
    new SimpleSpanProcessor(
      new OtlpFetchExporter('arize', ARIZE_ENDPOINT, {
        'content-type': 'application/x-protobuf',
        'arize-space-id': arizeSpaceId,
        'arize-api-key': arizeApiKey,
        space_id: arizeSpaceId,
        api_key: arizeApiKey,
      }),
    ),
  );
}

const langfusePublicKey = process.env.LANGFUSE_PUBLIC_KEY;
const langfuseSecretKey = process.env.LANGFUSE_SECRET_KEY;
if (langfusePublicKey && langfuseSecretKey) {
  const baseUrl = (process.env.LANGFUSE_BASE_URL ?? 'https://us.cloud.langfuse.com').replace(/\/$/, '');
  spanProcessors.push(
    new SimpleSpanProcessor(
      // Signal-specific OTLP traces endpoint; Basic auth is pk:sk. The
      // x-langfuse-ingestion-version header opts into the v4 data model's
      // real-time ingestion (without it, direct OTel data can lag ~10 min).
      new OtlpFetchExporter('langfuse', `${baseUrl}/api/public/otel/v1/traces`, {
        'content-type': 'application/x-protobuf',
        authorization: `Basic ${btoa(`${langfusePublicKey}:${langfuseSecretKey}`)}`,
        'x-langfuse-ingestion-version': '4',
      }),
    ),
  );
}

if (spanProcessors.length > 0) {
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      'service.name': SERVICE_NAME,
      // Arize's project selector (openinference.project.name); without it
      // traces land in a project named after service.name. Langfuse ignores
      // it (projects are selected by API key there).
      'openinference.project.name': process.env.ARIZE_PROJECT_NAME ?? 'semantius-copilot',
    }),
    spanProcessors,
  });

  const instrumentation = createOpenTelemetryInstrumentation({ tracer: provider.getTracer('@flue/opentelemetry') });
  instrument({
    ...instrumentation,
    // Record each turn's cost BEFORE the adapter handles the event — the
    // adapter ends the chat span inside its handler and the span exports
    // synchronously on end, so the cache must be filled first.
    observe: (event, ctx) => {
      if (event.type === 'turn') {
        const turn = event as {
          instanceId?: string;
          taskId?: string;
          operationId?: string;
          turnId?: string;
          response?: { usage?: { cost?: ProviderCost } };
        };
        const cost = turn.response?.usage?.cost;
        if (cost && cost.total > 0) {
          costByTurn.set(turnCostKey([turn.instanceId, turn.taskId, turn.operationId, turn.turnId]), cost);
          // Bound isolate memory; entries are deleted as spans export.
          if (costByTurn.size > 500) {
            const oldest = costByTurn.keys().next().value;
            if (oldest !== undefined) costByTurn.delete(oldest);
          }
        }
      }
      instrumentation.observe(event, ctx);
    },
  });
}
