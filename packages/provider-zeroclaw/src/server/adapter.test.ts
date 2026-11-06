// @effect-diagnostics nodeBuiltinImport:off -- Adapter tests drive a fake daemon over a real socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

import { makeZeroClawAdapterV2 } from "./adapter.ts";
import {
  type ZeroClawInboundRequest,
  type ZeroClawNotification,
  type ZeroClawRpcConnection,
  ZeroClawRpcError,
} from "./rpc.ts";
import { AGENT_MISMATCH_MESSAGE, DEFAULT_RESTORE_MESSAGE } from "./projection.ts";
import type { ZeroClawSettings } from "../settings.ts";

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

function settings(): ZeroClawSettings {
  return {
    enabled: true,
    socketPath: "",
    defaultAgentAlias: "coder",
    customModels: [],
  } as ZeroClawSettings;
}

function selection(model: string, agent?: string): ModelSelection {
  return {
    instanceId: ProviderInstanceId.make("zc"),
    model,
    ...(agent === undefined ? {} : { options: [{ id: "agent", value: agent }] }),
  } as ModelSelection;
}

const withDaemon = <A, E>(
  use: (
    socketPath: string,
    calls: Queue.Dequeue<RecordedCall>,
    sessionScope: Scope.Scope,
  ) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zc-adapter-")),
    );
    const socketPath = NodePath.join(dir, "daemon.sock");
    const calls = yield* Queue.unbounded<RecordedCall>();
    const sockets: NodeNet.Socket[] = [];
    const server = NodeNet.createServer((socket) => {
      socket.on("error", () => {
        // The client closing the socket races with a read.
      });
      sockets.push(socket);
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.length === 0) continue;
          const frame = JSON.parse(line) as { id?: string; method?: string; params?: unknown };
          if (frame.method === undefined) continue;
          Queue.offerUnsafe(calls, { method: frame.method, params: frame.params });
          const result =
            frame.method === "initialize"
              ? { protocol_version: 1, server_version: "0.4.0", server_pid: 1, commands: [] }
              : frame.method === "agents/list"
                ? { agents: [{ alias: "coder" }, { alias: "reviewer" }] }
                : frame.method === "session/new"
                  ? {
                      session_id: "session-1",
                      agent_alias: "coder",
                      message_count: 0,
                      workspace_dir: "/w",
                    }
                  : {};
          // session/prompt's response may arrive after startTurn returns (the
          // terminal session/update is authoritative), so leave it outstanding.
          if (frame.method !== "session/prompt") {
            socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
          }
        }
      });
    });
    yield* Effect.callback<void>((resume) => {
      server.listen(socketPath, () => resume(Effect.void));
      return Effect.sync(() => server.close());
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
      }).pipe(
        Effect.andThen(Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }))),
        Effect.ignore,
      ),
    );
    const sessionScope = yield* Scope.fork(yield* Effect.scope);
    return yield* use(socketPath, calls, sessionScope);
  }).pipe(Effect.scoped);

describe("ZeroClaw adapter reconnect", () => {
  it.live("reattaches its sessions after the daemon drops the socket", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "zc-reconnect-")),
      );
      const socketPath = NodePath.join(dir, "daemon.sock");
      const calls = yield* Queue.unbounded<RecordedCall>();
      const clients = yield* Queue.unbounded<NodeNet.Socket>();
      const reply = (socket: NodeNet.Socket, frame: { id?: string; method?: string }) => {
        if (frame.method === undefined || frame.id === undefined) return;
        Queue.offerUnsafe(calls, { method: frame.method, params: undefined });
        const result =
          frame.method === "initialize"
            ? { protocol_version: 1, server_version: "0.4.0", server_pid: 1, commands: [] }
            : frame.method === "agents/list"
              ? { agents: [{ alias: "coder" }, { alias: "reviewer" }] }
              : frame.method === "session/new"
                ? { session_id: "session-1", agent_alias: "coder", message_count: 0 }
                : {};
        socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result })}\n`);
      };
      const server = NodeNet.createServer((socket) => {
        socket.on("error", () => {});
        Queue.offerUnsafe(clients, socket);
        let buffer = "";
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (line.length === 0) continue;
            reply(socket, JSON.parse(line) as { id?: string; method?: string });
          }
        });
      });
      yield* Effect.callback<void>((resume) => {
        server.listen(socketPath, () => resume(Effect.void));
        return Effect.sync(() => server.close());
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => server.close()).pipe(
          Effect.andThen(Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }))),
          Effect.ignore,
        ),
      );

      const sessionScope = yield* Scope.fork(yield* Effect.scope);
      const runtime = yield* openRuntime(socketPath, sessionScope);
      yield* runtime.ensureThread({
        threadId: ThreadId.make("thread-1"),
        modelSelection: selection("default"),
        runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: "/w" },
      } as ProviderAdapter.ProviderAdapterV2EnsureThreadInput);

      (yield* Queue.take(clients)).destroy();

      // The drop fails the in-flight handshake; the reconnect retries it.
      const seen: string[] = [];
      while (seen.filter((method) => method === "session/new").length < 2) {
        seen.push((yield* Queue.take(calls)).method);
      }
      expect(seen.filter((method) => method === "initialize").length).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.scoped),
  );
});

function openRuntime(socketPath: string, scope?: Scope.Scope, config = settings()) {
  return Effect.gen(function* () {
    const adapter = yield* makeZeroClawAdapterV2({
      instanceId: ProviderInstanceId.make("zc"),
      settings: config,
      resolveSocketPath: () => Effect.succeed(socketPath),
    });
    const opened = adapter.openSession({
      threadId: ThreadId.make("thread-1"),
      providerSessionId: ProviderSessionId.make("psession-1"),
      modelSelection: selection("default"),
      runtimePolicy: { runtimeMode: "approval-required", interactionMode: "default", cwd: "/w" },
    } as ProviderAdapter.ProviderAdapterV2OpenSessionInput);
    return yield* scope === undefined
      ? opened.pipe(Effect.scoped)
      : opened.pipe(Effect.provideService(Scope.Scope, scope));
  });
}

describe("ZeroClaw adapter prompt lifetime", () => {
  it.effect("keeps prompts alive and ignores late failures after completion or a newer turn", () =>
    Effect.gen(function* () {
      const calls = yield* Queue.unbounded<RecordedCall>();
      const interrupted = yield* Ref.make(0);
      const prompts = yield* Queue.unbounded<{
        readonly reply: Deferred.Deferred<unknown, ZeroClawRpcError>;
        readonly fiber: Fiber.Fiber<unknown, unknown>;
      }>();
      const events = yield* Queue.unbounded<ZeroClawNotification, ZeroClawRpcError>();
      const inboundRequests = yield* Queue.unbounded<ZeroClawInboundRequest, ZeroClawRpcError>();
      const connection: ZeroClawRpcConnection = {
        request: (method, params) => {
          Queue.offerUnsafe(calls, { method, params });
          if (method === "session/prompt") {
            return Effect.gen(function* () {
              const reply = yield* Deferred.make<unknown, ZeroClawRpcError>();
              yield* Queue.offer(prompts, { reply, fiber: yield* Effect.fiber });
              return yield* Deferred.await(reply);
            }).pipe(Effect.onInterrupt(() => Ref.update(interrupted, (count) => count + 1)));
          }
          if (method === "initialize") {
            return Effect.succeed({
              protocol_version: 1,
              server_version: "0.4.0",
              server_pid: 1,
              commands: [],
            });
          }
          if (method === "agents/list") return Effect.succeed({ agents: [{ alias: "coder" }] });
          if (method === "session/new") {
            return Effect.succeed({
              session_id: "session-1",
              agent_alias: "coder",
              message_count: 0,
              workspace_dir: "/w",
            });
          }
          return Effect.succeed({});
        },
        notify: () => Effect.void,
        events,
        inboundRequests,
        respond: () => Effect.void,
        closed: Effect.never,
        terminate: Effect.void,
      };
      const sessionScope = yield* Scope.fork(yield* Effect.scope);
      const adapter = yield* makeZeroClawAdapterV2({
        instanceId: ProviderInstanceId.make("zc"),
        settings: settings(),
        resolveSocketPath: () => Effect.succeed("unused"),
        connect: () => Effect.succeed(connection),
      });
      const runtime = yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-1"),
          providerSessionId: ProviderSessionId.make("psession-1"),
          modelSelection: selection("default"),
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/w",
          },
        } as ProviderAdapter.ProviderAdapterV2OpenSessionInput)
        .pipe(Effect.provideService(Scope.Scope, sessionScope));
      const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(emitted, event)),
        Effect.forkScoped,
      );
      const thread = yield* runtime.ensureThread({
        threadId: ThreadId.make("thread-1"),
        modelSelection: selection("default", "coder"),
        runtimePolicy: {
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/w",
        },
      } as ProviderAdapter.ProviderAdapterV2EnsureThreadInput);
      const runScope = yield* Scope.fork(yield* Effect.scope);
      const call = {
        threadId: ThreadId.make("thread-1"),
        runId: RunId.make("run-1"),
        runOrdinal: 7,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-1"),
        rootNodeId: NodeId.make("node-1"),
        providerThread: thread,
        appThread: {} as never,
        message: {
          messageId: "message-prompt" as never,
          text: "send this to the model",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: selection("default", "coder"),
        runtimePolicy: {
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: "/w",
        },
      };
      const withAttachment = {
        ...call,
        message: { ...call.message, attachments: [{ type: "file" }] },
      } as unknown as ProviderAdapter.ProviderAdapterV2TurnInput;
      const rejected = yield* runtime.startTurn(withAttachment).pipe(Effect.flip);
      expect(rejected.message).toContain("attachments");
      const rejectedSteer = yield* runtime
        .steerTurn(withAttachment as unknown as ProviderAdapter.ProviderAdapterV2SteerInput)
        .pipe(Effect.flip);
      expect(rejectedSteer.message).toContain("attachments");
      yield* runtime
        .startTurn(call as ProviderAdapter.ProviderAdapterV2TurnInput)
        .pipe(Effect.provideService(Scope.Scope, runScope));
      yield* Scope.close(runScope, Exit.void);

      let prompt: RecordedCall | undefined;
      while (prompt === undefined) {
        const next = yield* Queue.take(calls);
        if (next.method === "session/prompt") prompt = next;
      }
      expect(prompt.params).toEqual({
        session_id: "session-1",
        prompt: "send this to the model",
      });
      // Closing the run scope must not cancel the JSON-RPC response wait; it
      // remains owned by the provider session until its stream reports a turn.
      expect(yield* Ref.get(interrupted)).toBe(0);

      const firstPrompt = yield* Queue.take(prompts);
      expect(yield* Queue.take(emitted)).toMatchObject({ type: "provider_turn.updated" });
      const completeTurn = Queue.offer(events, {
        method: "session/update",
        params: { session_id: "session-1", type: "turn_complete", outcome: "completed" },
      });
      yield* completeTurn;
      expect(yield* Queue.take(emitted)).toMatchObject({
        type: "turn.terminal",
        runOrdinal: 7,
        status: "completed",
      });
      const dropped = new ZeroClawRpcError({ operation: "read", detail: "Connection closed" });
      yield* Deferred.fail(firstPrompt.reply, dropped);
      expect(Exit.isSuccess(yield* Fiber.await(firstPrompt.fiber))).toBe(true);

      yield* runtime.startTurn({
        ...call,
        providerTurnOrdinal: 2,
      } as ProviderAdapter.ProviderAdapterV2TurnInput);
      expect(yield* Queue.take(emitted)).toMatchObject({
        type: "provider_turn.updated",
        providerTurn: { ordinal: 2, status: "running" },
      });
      const secondPrompt = yield* Queue.take(prompts);
      yield* completeTurn;
      expect(yield* Queue.take(emitted)).toMatchObject({
        type: "turn.terminal",
        runOrdinal: 7,
        status: "completed",
      });

      yield* runtime.startTurn({
        ...call,
        providerTurnOrdinal: 3,
      } as ProviderAdapter.ProviderAdapterV2TurnInput);
      expect(yield* Queue.take(emitted)).toMatchObject({
        type: "provider_turn.updated",
        providerTurn: { ordinal: 3, status: "running" },
      });
      yield* Queue.take(prompts);
      yield* Deferred.fail(secondPrompt.reply, dropped);
      expect(Exit.isSuccess(yield* Fiber.await(secondPrompt.fiber))).toBe(true);
      yield* completeTurn;
      expect(yield* Queue.take(emitted)).toMatchObject({
        type: "turn.terminal",
        providerTurnId: "zc-turn-session-1-3",
        status: "completed",
      });
    }),
  );
});

describe("ZeroClaw adapter turn start", () => {
  it.live(
    "resolves the saved agent on cold resume and refuses an ambiguous missing selection",
    () =>
      withDaemon((socketPath, calls, scope) =>
        Effect.gen(function* () {
          const initial = yield* openRuntime(socketPath, scope);
          const thread = yield* initial.ensureThread({
            threadId: ThreadId.make("thread-1"),
            modelSelection: selection("default", "coder"),
            runtimePolicy: {
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: "/w",
            },
          } as ProviderAdapter.ProviderAdapterV2EnsureThreadInput);
          const resumed = yield* openRuntime(socketPath, scope, {
            ...settings(),
            defaultAgentAlias: "",
          });
          yield* Queue.takeAll(calls);
          yield* resumed.resumeThread({
            providerThread: thread,
            modelSelection: selection("default", "reviewer"),
          });
          expect(
            (yield* Queue.takeAll(calls)).find((call) => call.method === "session/new")?.params,
          ).toMatchObject({ agent_alias: "reviewer" });
          const missing = yield* openRuntime(socketPath, scope, {
            ...settings(),
            defaultAgentAlias: "",
          });
          const failure = yield* missing.resumeThread({ providerThread: thread }).pipe(Effect.exit);
          expect(Exit.isFailure(failure)).toBe(true);
        }),
      ),
  );

  it.live("refuses an agent that differs from the session agent", () =>
    withDaemon((socketPath, calls, scope) =>
      Effect.gen(function* () {
        const runtime = yield* openRuntime(socketPath, scope);
        const thread = yield* runtime.ensureThread({
          threadId: ThreadId.make("thread-1"),
          modelSelection: selection("default", "coder"),
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/w",
          },
        } as ProviderAdapter.ProviderAdapterV2EnsureThreadInput);
        const error = yield* runtime
          .startTurn({
            threadId: ThreadId.make("thread-1"),
            runId: RunId.make("run-1"),
            providerTurnOrdinal: 1,
            attemptId: RunAttemptId.make("attempt-1"),
            rootNodeId: NodeId.make("node-1"),
            providerThread: thread,
            appThread: {} as never,
            runOrdinal: 1,
            message: {
              text: "hi",
              attachments: [],
              messageId: "m" as never,
              createdBy: "user",
              creationSource: "web",
            },
            modelSelection: selection("default", "reviewer"),
            runtimePolicy: {
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: "/w",
            },
          } as ProviderAdapter.ProviderAdapterV2TurnInput)
          .pipe(Effect.flip);
        expect(error.message).toContain(AGENT_MISMATCH_MESSAGE("coder", "reviewer"));
        const methods = (yield* Queue.takeAll(calls)).map((call) => call.method);
        expect(methods).not.toContain("session/prompt");
      }),
    ),
  );

  it.live("configures a changed model before prompting, and refuses to restore default", () =>
    withDaemon((socketPath, calls, scope) =>
      Effect.gen(function* () {
        const runtime = yield* openRuntime(socketPath, scope);
        const thread = yield* runtime.ensureThread({
          threadId: ThreadId.make("thread-1"),
          modelSelection: selection("default"),
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/w",
          },
        } as ProviderAdapter.ProviderAdapterV2EnsureThreadInput);
        const turn = {
          threadId: ThreadId.make("thread-1"),
          runId: RunId.make("run-1"),
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-1"),
          rootNodeId: NodeId.make("node-1"),
          providerThread: thread,
          appThread: {} as never,
          runOrdinal: 1,
          message: {
            text: "hi",
            attachments: [],
            messageId: "m" as never,
            createdBy: "user",
            creationSource: "web",
          },
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: "/w",
          },
        };
        yield* runtime.startTurn({
          ...turn,
          modelSelection: selection("openai/gpt"),
        } as ProviderAdapter.ProviderAdapterV2TurnInput);
        const seen: string[] = [];
        while (!seen.includes("session/prompt")) {
          seen.push((yield* Queue.take(calls)).method);
        }
        expect(seen).toContain("session/configure");
        expect(seen.indexOf("session/configure")).toBeLessThan(seen.indexOf("session/prompt"));

        const error = yield* runtime
          .startTurn({
            ...turn,
            providerTurnOrdinal: 2,
            modelSelection: selection("default"),
          } as ProviderAdapter.ProviderAdapterV2TurnInput)
          .pipe(Effect.flip);
        expect(error.message).toContain(DEFAULT_RESTORE_MESSAGE("openai/gpt"));
      }),
    ),
  );
});
