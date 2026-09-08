import {
  EventId,
  type HarnessSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
} from "../Errors.ts";
import type { HarnessAdapterShape } from "../Services/HarnessAdapter.ts";

const PROVIDER = ProviderDriverKind.make("harness");
const HARNESS_RESUME_VERSION = 1 as const;

function normalizeBaseUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "http://127.0.0.1:8765";
}

function parseResume(raw: unknown): { readonly nodeId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== HARNESS_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.nodeId !== "string" || record.nodeId.trim().length === 0) {
    return undefined;
  }
  return { nodeId: record.nodeId.trim() };
}

interface HarnessSessionContext {
  readonly threadId: ThreadId;
  nodeId: string;
  session: ProviderSession;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  stopped: boolean;
}

export interface HarnessAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
}

export const makeHarnessAdapter = Effect.fn("makeHarnessAdapter")(function* (
  settings: HarnessSettings,
  options?: HarnessAdapterLiveOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const baseUrl = normalizeBaseUrl(settings.serverUrl);
  const sessionsRef = yield* Ref.make(new Map<ThreadId, HarnessSessionContext>());
  const eventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Harness runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(eventPubSub, event).pipe(Effect.asVoid);

  const requireSession = (threadId: ThreadId) =>
    Ref.get(sessionsRef).pipe(
      Effect.flatMap((sessions) => {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) {
          return new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        return Effect.succeed(ctx);
      }),
    );

  const postJson = <T>(path: string, body: unknown, threadId: ThreadId) =>
    http
      .execute(
        HttpClientRequest.post(`${baseUrl}${path}`).pipe(
          HttpClientRequest.bodyText(JSON.stringify(body), "application/json"),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: `Harness request failed: ${String(cause)}`,
              cause,
            }),
        ),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.json.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: path,
                      detail: `Harness ${path} returned invalid JSON`,
                      cause,
                    }),
                ),
              )
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: path,
                detail: `Harness ${path} returned HTTP ${response.status}`,
              }),
        ),
        Effect.map((json) => json as T),
      );

  const adapter: HarnessAdapterShape = {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },

    startSession: (input: ProviderSessionStartInput) =>
      Effect.gen(function* () {
        const resume = parseResume(input.resumeCursor);
        const payload = yield* postJson<{
          readonly sessionId: string;
          readonly nodeId: string;
          readonly title?: string;
        }>(
          "/api/provider/session",
          {
            threadId: input.threadId,
            title: input.title ?? "t3-thread",
            cwd: input.cwd,
            ...(resume ? { resumeNodeId: resume.nodeId } : {}),
          },
          input.threadId,
        );

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          threadId: input.threadId,
          provider: PROVIDER,
          ...(options?.instanceId ? { providerInstanceId: options.instanceId } : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          createdAt,
          updatedAt: createdAt,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          resumeCursor: {
            schemaVersion: HARNESS_RESUME_VERSION,
            nodeId: payload.nodeId,
          },
        };

        const ctx: HarnessSessionContext = {
          threadId: input.threadId,
          nodeId: payload.nodeId,
          session,
          turns: [],
          stopped: false,
        };
        yield* Ref.update(sessionsRef, (map) => {
          const next = new Map(map);
          next.set(input.threadId, ctx);
          return next;
        });

        const stamp = yield* makeEventStamp();
        yield* publish({
          type: "session.started",
          ...stamp,
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { message: "Harness session ready" },
          raw: { source: "harness.http", method: "session", payload },
        });
        return session;
      }),

    sendTurn: (input: ProviderSendTurnInput) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const turnId = TurnId.make(yield* randomUUIDv4);
        const text = input.input?.trim() ?? "";
        if (!text) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "sendTurn",
            detail: "Harness turn requires non-empty input.",
          });
        }

        ctx.turns = [...ctx.turns, { id: turnId, items: [] }];
        const startedStamp = yield* makeEventStamp();
        yield* publish({
          type: "turn.started",
          ...startedStamp,
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: {},
          raw: { source: "harness.http", method: "turn.started", payload: { turnId } },
        });

        const result = yield* postJson<{
          readonly assistantText: string;
          readonly route?: unknown;
        }>(
          "/api/provider/turn",
          {
            sessionId: ctx.nodeId,
            input: text,
          },
          input.threadId,
        );

        const itemId = RuntimeItemId.make(yield* randomUUIDv4);
        const deltaStamp = yield* makeEventStamp();
        yield* publish({
          type: "content.delta",
          ...deltaStamp,
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: {
            streamKind: "assistant_text",
            delta: result.assistantText,
          },
          raw: {
            source: "harness.http",
            method: "turn",
            payload: result,
          },
        });

        const completedStamp = yield* makeEventStamp();
        yield* publish({
          type: "turn.completed",
          ...completedStamp,
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { state: "completed" as const },
          raw: { source: "harness.http", method: "turn.completed", payload: result.route ?? {} },
        });

        const turnResult: ProviderTurnStartResult = {
          threadId: input.threadId,
          turnId,
          resumeCursor: {
            schemaVersion: HARNESS_RESUME_VERSION,
            nodeId: ctx.nodeId,
          },
        };
        return turnResult;
      }),

    interruptTurn: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((ctx) =>
          Effect.gen(function* () {
            const stamp = yield* makeEventStamp();
            yield* publish({
              type: "turn.aborted",
              ...stamp,
              provider: PROVIDER,
              threadId,
              payload: { reason: "interrupted" },
              raw: {
                source: "harness.http",
                method: "interrupt",
                payload: { nodeId: ctx.nodeId },
              },
            });
          }),
        ),
      ),

    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,

    stopSession: (threadId) =>
      Ref.update(sessionsRef, (map) => {
        const next = new Map(map);
        next.delete(threadId);
        return next;
      }),

    listSessions: () =>
      Ref.get(sessionsRef).pipe(
        Effect.map((sessions) =>
          Array.from(sessions.values())
            .filter((ctx) => !ctx.stopped)
            .map((ctx) => ctx.session),
        ),
      ),

    hasSession: (threadId) =>
      Ref.get(sessionsRef).pipe(Effect.map((sessions) => sessions.has(threadId))),

    readThread: (threadId) =>
      requireSession(threadId).pipe(
        Effect.map((ctx) => ({
          threadId,
          turns: ctx.turns,
        })),
      ),

    rollbackThread: (threadId, numTurns) =>
      requireSession(threadId).pipe(
        Effect.map((ctx) => {
          ctx.turns = ctx.turns.slice(0, Math.max(0, ctx.turns.length - numTurns));
          return { threadId, turns: ctx.turns };
        }),
      ),

    stopAll: () => Ref.set(sessionsRef, new Map()),

    streamEvents: Stream.fromPubSub(eventPubSub),
  };

  return adapter;
});
