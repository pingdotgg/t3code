import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { isSameOpenCodeDirectory, makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";

interface RequestCall {
  readonly method: OpenCodeRuntime.OpenCodeHttpMethod;
  readonly path: string;
  readonly operation: string;
  readonly body?: unknown;
}

interface Harness {
  readonly adapter: OpenCodeAdapterShape;
  readonly calls: Array<RequestCall>;
  readonly attachCount: () => number;
  readonly failNextRequest: (operation: string) => void;
  readonly failNextEventId: () => void;
  readonly missNextRequest: (operation: string) => void;
  readonly blockNextRequest: (operation: string, blocker: Effect.Effect<void>) => void;
  readonly queueSessionIds: (...sessionIds: ReadonlyArray<string>) => void;
  readonly setSessionDirectory: (sessionId: string, directory: string) => void;
  readonly publish: (event: OpenCodeRuntime.OpenCodeEvent) => Effect.Effect<void>;
  readonly failEvents: (error: OpenCodeRuntime.OpenCodeRuntimeFailure) => Effect.Effect<void>;
}

const settings = Schema.decodeSync(OpenCodeSettings)({
  enabled: true,
  binaryPath: "fake-opencode2",
  customModels: [],
});

const threadId = ThreadId.make("thread-opencode2-test");

function event(id: string, type: string, data: unknown): OpenCodeRuntime.OpenCodeEvent {
  return { id, type, data };
}

function withHarness<A, E>(
  promptShape: "flat" | "nested",
  run: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>,
  enabled = true,
  failFirstHandshake = false,
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const events = yield* Queue.unbounded<
      OpenCodeRuntime.OpenCodeEvent | OpenCodeRuntime.OpenCodeRuntimeFailure
    >();
    const calls: Array<RequestCall> = [];
    const failedOperations = new Set<string>();
    const missingOperations = new Set<string>();
    const blockedOperations = new Map<string, Effect.Effect<void>>();
    const queuedSessionIds: Array<string> = [];
    const sessionDirectories = new Map<string, string>();
    let shouldFailNextEventId = false;
    let attachCalls = 0;
    const request = ((
      method: OpenCodeRuntime.OpenCodeHttpMethod,
      path: string,
      input: OpenCodeRuntime.OpenCodeRequestInput<Schema.Top>,
    ) =>
      Effect.gen(function* () {
        calls.push({
          method,
          path,
          operation: input.operation,
          ...(input.body !== undefined ? { body: input.body } : {}),
        });
        const blocker = blockedOperations.get(input.operation);
        if (blocker) {
          blockedOperations.delete(input.operation);
          yield* blocker;
        }
        if (failedOperations.delete(input.operation)) {
          return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: input.operation,
            reason: "transport",
          });
        }
        if (missingOperations.delete(input.operation)) {
          return yield* new OpenCodeRuntime.OpenCodeRuntimeError({
            operation: input.operation,
            reason: "http-status",
            status: 404,
          });
        }
        if (path === "/api/session" || (method === "GET" && path.startsWith("/api/session/"))) {
          const id =
            path === "/api/session"
              ? (queuedSessionIds.shift() ?? "ses_test")
              : path.slice("/api/session/".length);
          return {
            data: {
              id,
              ...(method === "GET"
                ? { location: { directory: sessionDirectories.get(id) ?? process.cwd() } }
                : {}),
            },
          };
        }
        if (path.endsWith("/message")) return { data: [], cursor: {} };
        if (path.endsWith("/prompt")) return { data: { id: "msg_user" } };
        return undefined;
      })) as OpenCodeRuntime.OpenCodeConnection["request"];
    const connection: OpenCodeRuntime.OpenCodeConnection = {
      url: "http://127.0.0.1:4096",
      protocol: { promptShape },
      request,
      globalEvents: Stream.make(event("connected", "server.connected", {})).pipe(
        Stream.concat(
          Stream.fromQueue(events).pipe(
            Stream.mapEffect((next) =>
              OpenCodeRuntime.isOpenCodeRuntimeError(next) ||
              OpenCodeRuntime.isOpenCodeUnsupportedPreviewError(next) ||
              OpenCodeRuntime.isOpenCodeCommandNotFoundError(next) ||
              OpenCodeRuntime.isOpenCodeTimeoutError(next)
                ? Effect.fail(next)
                : Effect.succeed(next),
            ),
          ),
        ),
      ),
    };
    const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
      attach: () =>
        Effect.sync(() => {
          attachCalls += 1;
          return attachCalls;
        }).pipe(
          Effect.map((attempt) =>
            failFirstHandshake && attempt === 1
              ? {
                  ...connection,
                  globalEvents: Stream.fail(
                    new OpenCodeRuntime.OpenCodeRuntimeError({
                      operation: "event.subscribe",
                      reason: "connection-ended",
                    }),
                  ),
                }
              : connection,
          ),
        ),
    };
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const testCrypto = {
      ...crypto,
      randomUUIDv4: Effect.suspend(() => {
        if (!shouldFailNextEventId) return crypto.randomUUIDv4;
        shouldFailNextEventId = false;
        return Effect.fail(uuidError);
      }),
    };
    const adapter = yield* makeOpenCodeAdapter({ ...settings, enabled }).pipe(
      Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
      Effect.provideService(Crypto.Crypto, testCrypto),
      Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode2-adapter-" })),
    );
    yield* Effect.yieldNow;
    return yield* run({
      adapter,
      calls,
      attachCount: () => attachCalls,
      failNextRequest: (operation) => failedOperations.add(operation),
      failNextEventId: () => {
        shouldFailNextEventId = true;
      },
      missNextRequest: (operation) => missingOperations.add(operation),
      blockNextRequest: (operation, blocker) => blockedOperations.set(operation, blocker),
      queueSessionIds: (...sessionIds) => queuedSessionIds.push(...sessionIds),
      setSessionDirectory: (sessionId, directory) => sessionDirectories.set(sessionId, directory),
      publish: (next) => Queue.offer(events, next).pipe(Effect.asVoid),
      failEvents: (error) => Queue.offer(events, error).pipe(Effect.asVoid),
    });
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
}

function collectEvents(
  adapter: OpenCodeAdapterShape,
  target: Array<ProviderRuntimeEvent>,
  onEvent?: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
) {
  return adapter.streamEvents.pipe(
    Stream.runForEach((next) =>
      Effect.sync(() => {
        target.push(next);
      }).pipe(Effect.andThen(onEvent?.(next) ?? Effect.void)),
    ),
    Effect.forkScoped,
  );
}

it.effect("matches symlink-equivalent OpenCode session directories", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode2-cwd-" });
    const directory = path.join(root, "directory");
    const alias = path.join(root, "alias");
    yield* fileSystem.makeDirectory(directory);
    yield* fileSystem.symlink(directory, alias);

    NodeAssert.equal(yield* isSameOpenCodeDirectory(fileSystem, path, directory, alias), true);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("generates unique event ids when an adapter is recreated", () =>
  withHarness("flat", ({ adapter: first }) =>
    withHarness("flat", ({ adapter: second }) =>
      Effect.gen(function* () {
        const firstEventId = yield* Deferred.make<string>();
        const secondEventId = yield* Deferred.make<string>();
        yield* collectEvents(first, [], (next) =>
          next.type === "session.started"
            ? Deferred.succeed(firstEventId, next.eventId).pipe(Effect.ignore)
            : Effect.void,
        );
        yield* collectEvents(second, [], (next) =>
          next.type === "session.started"
            ? Deferred.succeed(secondEventId, next.eventId).pipe(Effect.ignore)
            : Effect.void,
        );

        yield* first.startSession({ threadId, runtimeMode: "full-access" });
        yield* second.startSession({ threadId, runtimeMode: "full-access" });

        NodeAssert.notEqual(
          yield* Deferred.await(firstEventId),
          yield* Deferred.await(secondEventId),
        );
      }),
    ),
  ),
);

it.effect("attaches once and maps native deltas, tools, and terminal events", () =>
  withHarness("flat", ({ adapter, attachCount, calls, publish }) =>
    Effect.gen(function* () {
      const observed: Array<ProviderRuntimeEvent> = [];
      const firstCompleted = yield* Deferred.make<void>();
      const secondCompleted = yield* Deferred.make<void>();
      const publicDelta = yield* Deferred.make<void>();
      let completedCount = 0;
      yield* collectEvents(adapter, observed, (next) =>
        Effect.gen(function* () {
          if (next.type === "turn.completed") {
            completedCount += 1;
            yield* Deferred.succeed(
              completedCount === 1 ? firstCompleted : secondCompleted,
              undefined,
            ).pipe(Effect.ignore);
          }
          if (next.type === "content.delta" && next.payload.delta === "public") {
            yield* Deferred.succeed(publicDelta, undefined).pipe(Effect.ignore);
          }
        }),
      );
      NodeAssert.equal(attachCount(), 0);
      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: "/tmp/opencode2-project",
      });
      NodeAssert.equal(attachCount(), 1);
      const turn = yield* adapter.sendTurn({ threadId, input: "hello" });

      const promptCall = calls.find((call) => call.operation === "session.prompt");
      NodeAssert.deepEqual(promptCall?.body, { text: "hello", delivery: "steer" });
      NodeAssert.equal(session.resumeCursor !== undefined, true);

      yield* publish(
        event("foreign", "session.next.text.delta", {
          sessionID: "ses_foreign",
          textID: "txt_foreign",
          delta: "ignore me",
        }),
      );
      yield* publish(
        event("reasoning-started", "session.next.reasoning.started", {
          sessionID: "ses_test",
          reasoningID: "reasoning-1",
        }),
      );
      yield* publish(
        event("reasoning", "session.next.reasoning.delta", {
          sessionID: "ses_test",
          reasoningID: "reasoning-1",
          delta: "thinking",
        }),
      );
      yield* publish(
        event("reasoning-ended", "session.next.reasoning.ended", {
          sessionID: "ses_test",
          reasoningID: "reasoning-1",
          text: "thinking",
        }),
      );
      yield* publish(
        event("text-started", "session.next.text.started", {
          sessionID: "ses_test",
          textID: "text-1",
        }),
      );
      yield* publish(
        event("text", "session.next.text.delta", {
          sessionID: "ses_test",
          textID: "text-1",
          delta: "answer",
        }),
      );
      yield* publish(
        event("tool-input-started", "session.next.tool.input.started", {
          sessionID: "ses_test",
          callID: "call-1",
          name: "shell",
        }),
      );
      yield* publish(
        event("tool-input-delta", "session.next.tool.input.delta", {
          sessionID: "ses_test",
          callID: "call-1",
          delta: '{"command":',
        }),
      );
      yield* publish(
        event("tool-input-ended", "session.next.tool.input.ended", {
          sessionID: "ses_test",
          callID: "call-1",
          text: '{"command":"pwd"}',
        }),
      );
      yield* publish(
        event("tool-called", "session.next.tool.called", {
          sessionID: "ses_test",
          callID: "call-1",
          tool: "shell",
          input: { command: "pwd" },
        }),
      );
      yield* publish(
        event("tool-progress", "session.next.tool.progress", {
          sessionID: "ses_test",
          callID: "call-1",
          content: [{ type: "text", text: "/tmp" }],
        }),
      );
      yield* publish(
        event("tool-success", "session.next.tool.success", {
          sessionID: "ses_test",
          callID: "call-1",
          content: [{ type: "text", text: "done" }],
        }),
      );
      yield* publish(
        event("settled", "session.next.execution.settled", {
          sessionID: "ses_test",
          outcome: "success",
        }),
      );
      yield* Deferred.await(firstCompleted);

      const deltas = observed.filter((next) => next.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((next) => next.payload),
        [
          { streamKind: "reasoning_text", delta: "thinking" },
          { streamKind: "assistant_text", delta: "answer" },
        ],
      );
      NodeAssert.equal(
        observed.some((next) => next.type === "item.started"),
        true,
      );
      NodeAssert.equal(
        observed.some((next) => next.type === "item.updated"),
        true,
      );
      NodeAssert.equal(
        observed.some((next) => next.type === "item.completed"),
        true,
      );
      NodeAssert.equal(
        observed.some((next) => next.type === "turn.completed" && next.turnId === turn.turnId),
        true,
      );

      yield* adapter.sendTurn({ threadId, input: "public dev alias" });
      NodeAssert.equal(attachCount(), 1);
      yield* publish(
        event("public-text", "session.text.delta", {
          sessionID: "ses_test",
          assistantMessageID: "msg_public",
          ordinal: 0,
          delta: "public",
        }),
      );
      yield* publish(
        event("public-terminal", "session.execution.succeeded", {
          sessionID: "ses_test",
        }),
      );
      yield* Deferred.await(publicDelta);
      yield* Deferred.await(secondCompleted);
      NodeAssert.equal(
        observed.some((next) => next.type === "content.delta" && next.payload.delta === "public"),
        true,
      );
      NodeAssert.equal(observed.filter((next) => next.type === "turn.completed").length, 2);
    }),
  ),
);

it.effect("replies to permissions and forms and interrupts through native routes", () =>
  withHarness("nested", ({ adapter, calls, publish }) =>
    Effect.gen(function* () {
      const observed: Array<ProviderRuntimeEvent> = [];
      const permissionOpened = yield* Deferred.make<void>();
      const formOpened = yield* Deferred.make<void>();
      const turnAborted = yield* Deferred.make<void>();
      yield* collectEvents(adapter, observed, (next) => {
        if (next.type === "request.opened") {
          return Deferred.succeed(permissionOpened, undefined).pipe(Effect.ignore);
        }
        if (next.type === "user-input.requested") {
          return Deferred.succeed(formOpened, undefined).pipe(Effect.ignore);
        }
        if (next.type === "turn.aborted") {
          return Deferred.succeed(turnAborted, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      });
      yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
      yield* adapter.sendTurn({ threadId, input: "inspect" });

      const promptCall = calls.find((call) => call.operation === "session.prompt");
      NodeAssert.deepEqual(promptCall?.body, {
        prompt: { text: "inspect" },
        delivery: "steer",
      });

      yield* publish(
        event("permission", "permission.asked", {
          id: "per_test",
          sessionID: "ses_test",
          action: "read",
          resources: [".env"],
        }),
      );
      yield* publish(
        event("form", "form.created", {
          form: {
            id: "frm_test",
            sessionID: "ses_test",
            title: "Choose",
            fields: [
              {
                key: "choice",
                type: "string",
                title: "Choice",
                description: "Pick one",
                options: [{ value: "one", label: "One" }],
              },
            ],
          },
        }),
      );
      yield* Deferred.await(permissionOpened);
      yield* Deferred.await(formOpened);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("per_test"),
        "acceptForSession",
      );
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("frm_test"), {
        choice: "one",
      });
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.await(turnAborted);

      NodeAssert.deepEqual(
        calls.find((call) => call.operation === "permission.reply"),
        {
          method: "POST",
          path: "/api/session/ses_test/permission/per_test/reply",
          operation: "permission.reply",
          body: { reply: "always" },
        },
      );
      NodeAssert.deepEqual(
        calls.find((call) => call.operation === "form.reply"),
        {
          method: "POST",
          path: "/api/session/ses_test/form/frm_test/reply",
          operation: "form.reply",
          body: { answer: { choice: "one" } },
        },
      );
      NodeAssert.equal(
        calls.some(
          (call) =>
            call.operation === "session.interrupt" &&
            call.path === "/api/session/ses_test/interrupt",
        ),
        true,
      );
      NodeAssert.equal(
        observed.some((next) => next.type === "request.opened"),
        true,
      );
      NodeAssert.equal(
        observed.some((next) => next.type === "user-input.requested"),
        true,
      );
      NodeAssert.equal(
        observed.some((next) => next.type === "turn.aborted"),
        true,
      );
    }),
  ),
);

it.effect("auto-accepts native permissions and falls back to approval on failure", () =>
  withHarness("flat", ({ adapter, attachCount, calls, failNextRequest, publish }) =>
    Effect.gen(function* () {
      const observed: Array<ProviderRuntimeEvent> = [];
      const permissionResolved = yield* Deferred.make<void>();
      const fallbackOpened = yield* Deferred.make<void>();
      yield* collectEvents(adapter, observed, (next) => {
        if (next.type === "request.resolved") {
          return Deferred.succeed(permissionResolved, undefined).pipe(Effect.ignore);
        }
        if (next.type === "request.opened") {
          return Deferred.succeed(fallbackOpened, undefined).pipe(Effect.ignore);
        }
        return Effect.void;
      });
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "edit this" });

      yield* publish(
        event("permission", "permission.asked", {
          id: "per_test",
          sessionID: "ses_test",
          action: "edit",
          resources: ["src/index.ts"],
        }),
      );
      yield* publish(
        event("permission-replied", "permission.replied", {
          requestID: "per_test",
          sessionID: "ses_test",
          reply: "once",
        }),
      );
      yield* Deferred.await(permissionResolved);

      NodeAssert.deepEqual(
        calls.find((call) => call.operation === "permission.reply"),
        {
          method: "POST",
          path: "/api/session/ses_test/permission/per_test/reply",
          operation: "permission.reply",
          body: { reply: "once" },
        },
      );
      NodeAssert.equal(
        observed.some((next) => next.type === "request.opened"),
        false,
      );
      failNextRequest("permission.reply");
      yield* publish(
        event("fallback-permission", "permission.asked", {
          id: "per_fallback",
          sessionID: "ses_test",
          action: "edit",
          resources: ["src/other.ts"],
        }),
      );
      yield* Deferred.await(fallbackOpened);

      NodeAssert.equal(attachCount(), 1);
      NodeAssert.equal(calls.filter((call) => call.operation === "permission.reply").length, 2);
    }),
  ),
);

it.effect("resumes existing sessions and detaches without stop or delete requests", () =>
  withHarness("flat", ({ adapter, calls }) =>
    Effect.gen(function* () {
      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_existing" },
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/claude-sonnet",
          [{ id: "variant", value: "low" }],
        ),
      });
      NodeAssert.equal(
        calls.some((call) => call.method === "GET" && call.path === "/api/session/ses_existing"),
        true,
      );
      yield* adapter.sendTurn({
        threadId,
        input: "change effort",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/claude-sonnet",
          [{ id: "variant", value: "high" }],
        ),
      });
      NodeAssert.deepEqual(
        calls.findLast((call) => call.operation === "session.switchModel")?.body,
        {
          model: {
            providerID: "anthropic",
            id: "claude-sonnet",
            variant: "high",
          },
        },
      );
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId: ThreadId.make("thread-opencode2-second"),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId: ThreadId.make("thread-opencode2-second"),
        input: "active",
      });
      yield* adapter.stopAll();

      NodeAssert.equal(
        calls.some((call) => call.method === "DELETE"),
        false,
      );
      NodeAssert.equal(
        calls.some((call) => call.path.includes("/service/stop")),
        false,
      );
      NodeAssert.equal(calls.filter((call) => call.operation === "session.interrupt").length, 2);
      NodeAssert.deepEqual(yield* adapter.listSessions(), []);
    }),
  ),
);

it.effect("starts a fresh native session when a stored resume cursor no longer exists", () =>
  withHarness("flat", ({ adapter, attachCount, calls, missNextRequest }) =>
    Effect.gen(function* () {
      missNextRequest("session.get");
      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_from_v1" },
      });

      NodeAssert.deepEqual(
        calls
          .filter((call) => call.operation === "session.get" || call.operation === "session.create")
          .map((call) => [call.method, call.path]),
        [
          ["GET", "/api/session/ses_from_v1"],
          ["POST", "/api/session"],
        ],
      );
      NodeAssert.deepEqual(session.resumeCursor, { schemaVersion: 1, sessionId: "ses_test" });
      NodeAssert.equal(attachCount(), 1);
    }),
  ),
);

it.effect("starts a fresh native session when the stored session uses another directory", () =>
  withHarness("flat", ({ adapter, calls, queueSessionIds, setSessionDirectory }) =>
    Effect.gen(function* () {
      setSessionDirectory("ses_from_v1", "/tmp/opencode2-old");
      queueSessionIds("ses_fresh");
      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: "/tmp/opencode2-new",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_from_v1" },
      });

      NodeAssert.deepEqual(
        calls
          .filter((call) => call.operation === "session.get" || call.operation === "session.create")
          .map((call) => [call.method, call.path]),
        [
          ["GET", "/api/session/ses_from_v1"],
          ["POST", "/api/session"],
        ],
      );
      NodeAssert.deepEqual(calls.find((call) => call.operation === "session.create")?.body, {
        location: { directory: "/tmp/opencode2-new" },
      });
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_fresh",
      });
    }),
  ),
);

it.effect("serializes concurrent starts for the same thread", () =>
  withHarness("flat", ({ adapter, blockNextRequest, calls, queueSessionIds }) =>
    Effect.gen(function* () {
      const firstCreateStarted = yield* Deferred.make<void>();
      const releaseFirstCreate = yield* Deferred.make<void>();
      queueSessionIds("ses_first", "ses_second");
      blockNextRequest(
        "session.create",
        Deferred.succeed(firstCreateStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirstCreate)),
        ),
      );

      const first = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstCreateStarted);
      const second = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      NodeAssert.equal(calls.filter((call) => call.operation === "session.create").length, 1);

      yield* Deferred.succeed(releaseFirstCreate, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      const sessions = yield* adapter.listSessions();
      NodeAssert.equal(sessions.length, 1);
      NodeAssert.deepEqual(sessions[0]?.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_second",
      });
      yield* adapter.stopSession(threadId);
      NodeAssert.deepEqual(yield* adapter.listSessions(), []);
    }),
  ),
);

it.effect("does not attach when OpenCode 2 is disabled", () =>
  withHarness(
    "flat",
    ({ adapter, attachCount }) =>
      Effect.gen(function* () {
        const result = yield* adapter
          .startSession({ threadId, runtimeMode: "full-access" })
          .pipe(Effect.exit);
        NodeAssert.equal(Exit.isFailure(result), true);
        NodeAssert.equal(attachCount(), 0);
      }),
    false,
  ),
);

it.effect("retries after the initial event handshake fails", () =>
  withHarness(
    "flat",
    ({ adapter, attachCount }) =>
      Effect.gen(function* () {
        const first = yield* adapter
          .startSession({ threadId, runtimeMode: "full-access" })
          .pipe(Effect.exit);
        NodeAssert.equal(Exit.isFailure(first), true);

        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        NodeAssert.equal(attachCount(), 2);
      }),
    true,
    true,
  ),
);

it.effect("reconnects after the native event stream fails", () =>
  withHarness("flat", ({ adapter, attachCount, failEvents }) =>
    Effect.gen(function* () {
      const runtimeError = yield* Deferred.make<void>();
      const secondTurnStarted = yield* Deferred.make<void>();
      const observed: Array<ProviderRuntimeEvent> = [];
      let startedTurns = 0;
      yield* collectEvents(adapter, observed, (next) =>
        Effect.gen(function* () {
          if (next.type === "runtime.error") {
            yield* Deferred.succeed(runtimeError, undefined).pipe(Effect.ignore);
          }
          if (next.type === "turn.started") {
            startedTurns += 1;
            if (startedTurns === 2) {
              yield* Deferred.succeed(secondTurnStarted, undefined).pipe(Effect.ignore);
            }
          }
        }),
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const firstTurn = yield* adapter.sendTurn({ threadId, input: "before disconnect" });
      yield* failEvents(
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation: "event.subscribe",
          reason: "connection-ended",
        }),
      );
      yield* Deferred.await(runtimeError);
      NodeAssert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);
      NodeAssert.equal(
        observed.some(
          (event) =>
            event.type === "turn.completed" &&
            event.turnId === firstTurn.turnId &&
            event.payload.state === "failed",
        ),
        true,
      );

      yield* adapter.sendTurn({ threadId, input: "reconnect" });
      yield* Deferred.await(secondTurnStarted);
      NodeAssert.equal(attachCount(), 2);
      NodeAssert.equal(observed.filter((event) => event.type === "turn.started").length, 2);
    }),
  ),
);

it.effect("reconnects after native event processing fails", () =>
  withHarness("flat", ({ adapter, attachCount, failNextEventId, publish }) =>
    Effect.gen(function* () {
      const runtimeError = yield* Deferred.make<void>();
      const observed: Array<ProviderRuntimeEvent> = [];
      yield* collectEvents(adapter, observed, (next) =>
        next.type === "runtime.error"
          ? Deferred.succeed(runtimeError, undefined).pipe(Effect.ignore)
          : Effect.void,
      );
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const firstTurn = yield* adapter.sendTurn({ threadId, input: "before event failure" });
      failNextEventId();
      yield* publish(
        event("text", "session.text.delta", {
          sessionID: "ses_test",
          assistantMessageID: "msg_assistant",
          ordinal: 0,
          delta: "partial",
        }),
      );
      yield* Deferred.await(runtimeError);

      NodeAssert.equal((yield* adapter.listSessions())[0]?.activeTurnId, undefined);
      NodeAssert.equal(
        observed.some(
          (next) =>
            next.type === "turn.completed" &&
            next.turnId === firstTurn.turnId &&
            next.payload.state === "failed",
        ),
        true,
      );
      yield* adapter.sendTurn({ threadId, input: "after event failure" });
      NodeAssert.equal(attachCount(), 2);
    }),
  ),
);

it.effect("restores the regular agent after a plan turn", () =>
  withHarness("flat", ({ adapter, calls }) =>
    Effect.gen(function* () {
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      yield* adapter.sendTurn({
        threadId,
        input: "plan this",
        interactionMode: "plan",
      });
      yield* adapter.sendTurn({ threadId, input: "build this" });

      NodeAssert.deepEqual(
        calls.filter((call) => call.operation === "session.switchAgent").map((call) => call.body),
        [{ agent: "plan" }, { agent: "build" }],
      );
    }),
  ),
);

it.effect("moves a resumed provider session to its latest T3 thread", () =>
  withHarness("flat", ({ adapter }) =>
    Effect.gen(function* () {
      const firstThread = ThreadId.make("thread-opencode2-first");
      const secondThread = ThreadId.make("thread-opencode2-second");
      const resumeCursor = { schemaVersion: 1, sessionId: "ses_shared" } as const;
      yield* adapter.startSession({
        threadId: firstThread,
        runtimeMode: "full-access",
        resumeCursor,
      });
      yield* adapter.startSession({
        threadId: secondThread,
        runtimeMode: "full-access",
        resumeCursor,
      });

      NodeAssert.deepEqual(
        (yield* adapter.listSessions()).map((session) => session.threadId),
        [secondThread],
      );
      yield* adapter.stopSession(secondThread);
      NodeAssert.deepEqual(yield* adapter.listSessions(), []);
    }),
  ),
);

it.effect("keeps the existing session when resumed setup fails", () =>
  withHarness("flat", ({ adapter, failNextRequest }) =>
    Effect.gen(function* () {
      const firstThread = ThreadId.make("thread-opencode2-first");
      const secondThread = ThreadId.make("thread-opencode2-second");
      const resumeCursor = { schemaVersion: 1, sessionId: "ses_shared" } as const;
      yield* adapter.startSession({
        threadId: firstThread,
        runtimeMode: "full-access",
        resumeCursor,
      });
      failNextRequest("session.switchModel");
      const error = yield* Effect.flip(
        adapter.startSession({
          threadId: secondThread,
          runtimeMode: "full-access",
          resumeCursor,
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet",
          ),
        }),
      );

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        NodeAssert.equal(error.method, "session.switchModel");
      }
      NodeAssert.deepEqual(
        (yield* adapter.listSessions()).map((session) => session.threadId),
        [firstThread],
      );
    }),
  ),
);
