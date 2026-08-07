import type {
  ProviderDriverKind,
  RuntimeErrorClass,
  ThreadId,
  ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import { parseSentryDsn } from "@t3tools/shared/sentryAgentMonitoring";
import { httpHeaderRedactionLayer } from "@t3tools/shared/httpObservability";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as OtlpExporter from "effect/unstable/observability/OtlpExporter";
import * as OtlpResource from "effect/unstable/observability/OtlpResource";
import * as OtlpSerialization from "effect/unstable/observability/OtlpSerialization";
import type * as OtlpTracer from "effect/unstable/observability/OtlpTracer";

import { ServerSettingsService } from "../serverSettings.ts";

type TurnCompletionState = "completed" | "failed" | "interrupted" | "cancelled";
type SpanAttributeValue = string | number | boolean;

export type SentryAgentMonitoringEvent =
  | {
      readonly type: "turn.started";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly createdAt: string;
      readonly model?: string | undefined;
    }
  | {
      readonly type: "turn.usage";
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly usage: ThreadTokenUsageSnapshot;
    }
  | {
      readonly type: "turn.tool-used";
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly toolUseId: string;
    }
  | {
      readonly type: "turn.completed";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly createdAt: string;
      readonly state: TurnCompletionState;
      readonly model?: string | undefined;
      readonly totalCostUsd?: number | undefined;
    }
  | {
      readonly type: "turn.error";
      readonly provider: ProviderDriverKind;
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly createdAt: string;
      readonly errorClass: RuntimeErrorClass;
      readonly model?: string | undefined;
    };

export interface SentryAgentTurnSpan {
  readonly name: "invoke_agent t3-code";
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly failed: boolean;
  readonly attributes: Readonly<Record<string, SpanAttributeValue>>;
}

interface TurnState {
  provider?: ProviderDriverKind;
  model?: string;
  startedAtMs?: number;
  usage?: ThreadTokenUsageSnapshot;
  readonly toolUseIds: Set<string>;
}

interface MakeOptions {
  readonly isExportEnabled: Effect.Effect<boolean>;
  readonly exportSpan: (span: SentryAgentTurnSpan) => Effect.Effect<void>;
}

const MAX_TRACKED_TURNS = 10_000;

const turnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function setIfDefined(
  attributes: Record<string, SpanAttributeValue>,
  key: string,
  value: SpanAttributeValue | undefined,
): void {
  if (value !== undefined) attributes[key] = value;
}

function addUsageAttributes(
  attributes: Record<string, SpanAttributeValue>,
  usage: ThreadTokenUsageSnapshot | undefined,
): void {
  if (!usage) return;

  const inputTokens = usage.lastInputTokens ?? usage.inputTokens;
  const cachedInputTokens = usage.lastCachedInputTokens ?? usage.cachedInputTokens;
  const outputTokens = usage.lastOutputTokens ?? usage.outputTokens;
  const reasoningOutputTokens = usage.lastReasoningOutputTokens ?? usage.reasoningOutputTokens;
  const totalTokens =
    usage.lastUsedTokens ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : usage.usedTokens);

  setIfDefined(attributes, "gen_ai.usage.input_tokens", inputTokens);
  setIfDefined(attributes, "gen_ai.usage.output_tokens", outputTokens);
  setIfDefined(attributes, "gen_ai.usage.total_tokens", totalTokens);
  setIfDefined(attributes, "gen_ai.usage.cache_read.input_tokens", cachedInputTokens);
  setIfDefined(attributes, "gen_ai.usage.reasoning.output_tokens", reasoningOutputTokens);
}

function trimMap<TKey, TValue>(map: Map<TKey, TValue>): void {
  while (map.size > MAX_TRACKED_TURNS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function trimSet<TValue>(set: Set<TValue>): void {
  while (set.size > MAX_TRACKED_TURNS) {
    const oldest = set.values().next().value;
    if (oldest === undefined) return;
    set.delete(oldest);
  }
}

export const make = ({ isExportEnabled, exportSpan }: MakeOptions) =>
  Effect.sync(() => {
    const activeTurns = new Map<string, TurnState>();
    const endedTurns = new Set<string>();

    const getOrCreateTurn = (key: string): TurnState => {
      const current = activeTurns.get(key);
      if (current) return current;
      const created: TurnState = { toolUseIds: new Set() };
      activeTurns.set(key, created);
      trimMap(activeTurns);
      return created;
    };

    const record = (event: SentryAgentMonitoringEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        const key = turnKey(event.threadId, event.turnId);
        if (endedTurns.has(key)) return;

        if (event.type === "turn.started") {
          const state = getOrCreateTurn(key);
          state.provider = event.provider;
          state.startedAtMs = parseTimestamp(event.createdAt);
          if (event.model) state.model = event.model;
          return;
        }

        if (event.type === "turn.usage") {
          getOrCreateTurn(key).usage = event.usage;
          return;
        }

        if (event.type === "turn.tool-used") {
          getOrCreateTurn(key).toolUseIds.add(event.toolUseId);
          return;
        }

        const state = activeTurns.get(key);
        const endedAtMs = parseTimestamp(event.createdAt);
        const usage = state?.usage;
        const startedAtMs = state?.startedAtMs ?? Math.max(0, endedAtMs - (usage?.durationMs ?? 0));
        const provider = state?.provider ?? event.provider;
        const model = event.model ?? state?.model;
        const completionState = event.type === "turn.error" ? "failed" : event.state;
        const failed = completionState === "failed";
        const attributes: Record<string, SpanAttributeValue> = {
          "sentry.op": "gen_ai.invoke_agent",
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.operation.type": "agent",
          "gen_ai.agent.name": "t3-code",
          "gen_ai.provider.name": provider,
          "gen_ai.conversation.id": event.threadId,
          "gen_ai.response.id": event.turnId,
          "t3.agent.thread.id": event.threadId,
          "t3.agent.turn.id": event.turnId,
          "t3.agent.turn.completion_state": completionState,
          "t3.agent.turn.duration_ms": Math.max(0, endedAtMs - startedAtMs),
        };

        if (model) {
          attributes["gen_ai.request.model"] = model;
          attributes["gen_ai.response.model"] = model;
        }
        addUsageAttributes(attributes, usage);

        const toolUseCount = Math.max(usage?.toolUses ?? 0, state?.toolUseIds.size ?? 0);
        attributes["t3.agent.tool_use.count"] = toolUseCount;

        if (event.type === "turn.completed") {
          setIfDefined(attributes, "gen_ai.cost.total_tokens", event.totalCostUsd);
        } else {
          attributes["error.type"] = event.errorClass;
        }

        activeTurns.delete(key);
        endedTurns.add(key);
        trimSet(endedTurns);

        if (!(yield* isExportEnabled)) return;
        yield* exportSpan({
          name: "invoke_agent t3-code",
          startedAtMs,
          endedAtMs,
          failed,
          attributes,
        });
      });

    return { record } satisfies SentryAgentMonitoringShape;
  });

export interface SentryAgentMonitoringShape {
  readonly record: (event: SentryAgentMonitoringEvent) => Effect.Effect<void>;
}

export class SentryAgentMonitoring extends Context.Service<
  SentryAgentMonitoring,
  SentryAgentMonitoringShape
>()("t3/observability/SentryAgentMonitoring") {}

export const layerTest = (options: MakeOptions) =>
  Layer.effect(SentryAgentMonitoring, make(options));

const noop: SentryAgentMonitoringShape = {
  record: () => Effect.void,
};

export const layerNoop = Layer.succeed(SentryAgentMonitoring, noop);

function disabled(): SentryAgentMonitoringShape {
  return noop;
}

type OtlpSpan = OtlpTracer.ScopeSpan["spans"][number];

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);
}

const unixMillisToNanos = (milliseconds: number) =>
  String(BigInt(Math.trunc(Math.max(0, milliseconds))) * 1_000_000n);

function toOtlpSpan(span: SentryAgentTurnSpan): OtlpSpan {
  return {
    traceId: randomHex(32),
    spanId: randomHex(16),
    parentSpanId: undefined,
    name: span.name,
    kind: 1,
    startTimeUnixNano: unixMillisToNanos(span.startedAtMs),
    endTimeUnixNano: unixMillisToNanos(span.endedAtMs),
    attributes: OtlpResource.entriesToAttributes(Object.entries(span.attributes)),
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    status: { code: span.failed ? 2 : 1 },
    links: [],
    droppedLinksCount: 0,
  };
}

const makeLive = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const startupSettings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
  if (startupSettings === null) return disabled();

  const startupMonitoring = startupSettings.observability.sentryAgentMonitoring;
  const sentryConfig = startupMonitoring.enabled ? parseSentryDsn(startupMonitoring.dsn) : null;
  if (!sentryConfig) return disabled();

  const serialization = yield* OtlpSerialization.OtlpSerialization;
  const resource = OtlpResource.make({
    serviceName: "t3-code-agent-monitoring",
    attributes: { "service.runtime": "t3-server" },
  });
  const exporter = yield* OtlpExporter.make({
    label: "SentryAgentMonitoring",
    url: sentryConfig.tracesUrl,
    headers: { "x-sentry-auth": sentryConfig.authHeader },
    exportInterval: "5 seconds",
    maxBatchSize: 100,
    shutdownTimeout: "3 seconds",
    body: (spans: Array<OtlpSpan>) =>
      serialization.traces({
        resourceSpans: [
          {
            resource,
            scopeSpans: [{ scope: { name: "t3-code-agent-monitoring" }, spans }],
          },
        ],
      }),
  });

  return yield* make({
    isExportEnabled: serverSettings.getSettings.pipe(
      Effect.map((settings) => {
        const current = settings.observability.sentryAgentMonitoring;
        return current.enabled && current.dsn === startupMonitoring.dsn;
      }),
      Effect.orElseSucceed(() => false),
    ),
    exportSpan: (span) => Effect.sync(() => exporter.push(toOtlpSpan(span))),
  });
});

export const layer = Layer.effect(SentryAgentMonitoring, makeLive).pipe(
  Layer.provide(OtlpExporter.layerFlusher),
  Layer.provideMerge(httpHeaderRedactionLayer),
  Layer.provideMerge(OtlpSerialization.layerJson),
);
