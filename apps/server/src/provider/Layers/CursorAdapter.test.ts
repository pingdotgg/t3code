import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";

import { ApprovalRequestId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { ProviderAdapterValidationError } from "../Errors.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { makeCursorAdapterLive } from "./CursorAdapter.ts";

class FakeCursorAcpProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: Array<{ method: string; params: unknown }> = [];
  killed = false;

  private readonly input = readline.createInterface({ input: this.stdin });
  private permissionRequestId = 700;
  lastPermissionSelection: string | undefined;

  constructor() {
    super();
    this.input.on("line", (line) => {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.method === "string") {
        this.handleRequest(message);
        return;
      }

      if (message.id === this.permissionRequestId) {
        const optionId =
          (message.result as { outcome?: { optionId?: unknown } } | undefined)?.outcome?.optionId;
        if (typeof optionId === "string") {
          this.lastPermissionSelection = optionId;
        }
      }
    });
  }

  kill(): boolean {
    if (this.killed) {
      return true;
    }
    this.killed = true;
    this.emit("exit", 0, null);
    return true;
  }

  emitPermissionRequest(): void {
    this.emitServerMessage({
      jsonrpc: "2.0",
      id: this.permissionRequestId,
      method: "session/request_permission",
      params: {
        sessionId: "acp-session-1",
        toolCall: {
          toolCallId: "tool-perm-1",
          kind: "execute",
          title: "`pwd`",
        },
        options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "allow-always", kind: "allow_always" },
          { optionId: "reject-once", kind: "reject_once" },
        ],
      },
    });
  }

  private handleRequest(message: Record<string, unknown>): void {
    const method = message.method;
    const id = message.id;
    if (typeof method !== "string" || (typeof id !== "string" && typeof id !== "number")) {
      return;
    }
    this.requests.push({ method, params: message.params });

    switch (method) {
      case "initialize": {
        const protocolVersion = (message.params as { protocolVersion?: unknown } | undefined)
          ?.protocolVersion;
        if (typeof protocolVersion !== "number") {
          this.emitServerMessage({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "Invalid params",
              data: {
                _errors: [],
                protocolVersion: {
                  _errors: ["Invalid input: expected number, received undefined"],
                },
              },
            },
          });
          return;
        }
        this.emitServerMessage({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              loadSession: true,
            },
            authMethods: [{ id: "cursor_login" }],
          },
        });
        return;
      }
      case "authenticate":
        this.emitServerMessage({
          jsonrpc: "2.0",
          id,
          result: {},
        });
        return;
      case "session/new":
        this.emitServerMessage({
          jsonrpc: "2.0",
          id,
          result: {
            sessionId: "acp-session-1",
            modes: {
              currentModeId: "agent",
              availableModes: [{ id: "agent" }],
            },
          },
        });
        return;
      case "session/load":
        this.emitServerMessage({
          jsonrpc: "2.0",
          id,
          result: {},
        });
        return;
      case "session/set_model":
        this.emitServerMessage({
          jsonrpc: "2.0",
          id,
          result: {},
        });
        return;
      case "session/prompt": {
        this.emitServerMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: {
                type: "text",
                text: "thinking",
              },
            },
          },
        });

        this.emitServerMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "hello",
              },
            },
          },
        });

        this.emitServerMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-1",
              kind: "execute",
              title: "`pwd`",
              rawInput: { command: "pwd" },
            },
          },
        });

        this.emitServerMessage({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "acp-session-1",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tool-1",
              status: "completed",
              rawOutput: {
                exitCode: 0,
                stdout: "/tmp/project",
                stderr: "",
              },
            },
          },
        });

        this.emitServerMessage({
          jsonrpc: "2.0",
          id,
          result: {
            stopReason: "end_turn",
          },
        });
        return;
      }
      case "session/cancel":
        this.emitServerMessage({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: "Method not found",
          },
        });
        return;
      default:
        this.emitServerMessage({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Unhandled method: ${method}`,
          },
        });
    }
  }

  private emitServerMessage(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

describe("CursorAdapterLive", () => {
  it.effect("returns validation error for non-cursor provider on startSession", () => {
    const fake = new FakeCursorAcpProcess();
    const layer = makeCursorAdapterLive({
      createProcess: () => fake as never,
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const result = yield* adapter.startSession({ provider: "codex" }).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "cursor",
          operation: "startSession",
          issue: "Expected provider 'cursor' but received 'codex'.",
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("maps ACP prompt/update events into canonical runtime events", () => {
    const fake = new FakeCursorAcpProcess();
    const layer = makeCursorAdapterLive({
      createProcess: () => fake as never,
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        provider: "cursor",
        cwd: "/tmp/project",
      });

      const turn = yield* adapter.sendTurn({
        sessionId: session.sessionId,
        input: "hello",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        [
          "session.configured",
          "auth.status",
          "auth.status",
          "session.started",
          "thread.started",
          "session.state.changed",
          "turn.started",
          "content.delta",
          "content.delta",
          "item.started",
          "item.completed",
          "item.completed",
          "turn.completed",
        ],
      );

      const turnStarted = events[6];
      assert.equal(turnStarted?.type, "turn.started");
      if (turnStarted?.type === "turn.started") {
        assert.equal(String(turnStarted.turnId), String(turn.turnId));
      }

      const completion = events[12];
      assert.equal(completion?.type, "turn.completed");
      if (completion?.type === "turn.completed") {
        assert.equal(completion.payload.state, "completed");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes requested model to ACP process startup", () => {
    const fake = new FakeCursorAcpProcess();
    let createProcessInput:
      | {
          readonly binaryPath: string;
          readonly cwd: string;
          readonly env: NodeJS.ProcessEnv;
          readonly model?: string;
        }
      | undefined;
    const layer = makeCursorAdapterLive({
      createProcess: (input) => {
        createProcessInput = input;
        return fake as never;
      },
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      yield* adapter.startSession({
        provider: "cursor",
        model: "composer-1.5",
      });

      assert.deepEqual(createProcessInput?.model, "composer-1.5");
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes provider-native observability records when enabled", () => {
    const nativeEvents: Array<{
      event?: {
        provider?: string;
        method?: string;
        sessionId?: string;
      };
    }> = [];
    const fake = new FakeCursorAcpProcess();
    const layer = makeCursorAdapterLive({
      createProcess: () => fake as never,
      nativeEventLogger: {
        filePath: "memory://cursor-native-events",
        write: (event) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const session = yield* adapter.startSession({
        provider: "cursor",
        cwd: "/tmp/project",
      });

      assert.equal(nativeEvents.length > 0, true);
      assert.equal(nativeEvents.some((record) => record.event?.provider === "cursor"), true);
      assert.equal(nativeEvents.some((record) => record.event?.sessionId === session.sessionId), true);
      assert.equal(nativeEvents.some((record) => record.event?.method === "cursor/acp/response"), true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resumes ACP session using resumeCursor.acpSessionId", () => {
    const fake = new FakeCursorAcpProcess();
    const layer = makeCursorAdapterLive({
      createProcess: () => fake as never,
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const session = yield* adapter.startSession({
        provider: "cursor",
        cwd: "/tmp/project",
        resumeCursor: {
          acpSessionId: "acp-session-resume",
        },
      });

      const methods = new Set(fake.requests.map((request) => request.method));
      assert.equal(methods.has("session/load"), true);
      assert.equal(methods.has("session/new"), false);

      const loadRequest = fake.requests.find((request) => request.method === "session/load");
      assert.deepEqual(loadRequest?.params, {
        sessionId: "acp-session-resume",
        cwd: "/tmp/project",
        mcpServers: [],
      });
      assert.equal(session.threadId, "acp-session-resume");
      assert.deepEqual(session.resumeCursor, {
        acpSessionId: "acp-session-resume",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("accepts legacy resumeCursor.sessionId for ACP session resume", () => {
    const fake = new FakeCursorAcpProcess();
    const layer = makeCursorAdapterLive({
      createProcess: () => fake as never,
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const session = yield* adapter.startSession({
        provider: "cursor",
        cwd: "/tmp/project",
        resumeCursor: {
          sessionId: "acp-session-legacy",
        },
      });

      const loadRequest = fake.requests.find((request) => request.method === "session/load");
      assert.deepEqual(loadRequest?.params, {
        sessionId: "acp-session-legacy",
        cwd: "/tmp/project",
        mcpServers: [],
      });
      assert.equal(session.threadId, "acp-session-legacy");
      assert.deepEqual(session.resumeCursor, {
        acpSessionId: "acp-session-legacy",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("bridges permission requests to request.opened/request.resolved", () => {
    const fake = new FakeCursorAcpProcess();
    const layer = makeCursorAdapterLive({
      createProcess: () => fake as never,
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;

      const session = yield* adapter.startSession({
        provider: "cursor",
      });

      // consume startup events
      yield* Stream.take(adapter.streamEvents, 6).pipe(Stream.runDrain);

      fake.emitPermissionRequest();

      const opened = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(opened._tag, "Some");
      if (opened._tag !== "Some") {
        return;
      }
      assert.equal(opened.value.type, "request.opened");
      if (opened.value.type !== "request.opened") {
        return;
      }
      const runtimeRequestId = opened.value.requestId;
      assert.equal(typeof runtimeRequestId, "string");
      if (runtimeRequestId === undefined) {
        return;
      }

      yield* adapter.respondToRequest(
        session.sessionId,
        ApprovalRequestId.makeUnsafe(runtimeRequestId),
        "acceptForSession",
      );

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }
      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }
      assert.equal(resolved.value.payload.decision, "acceptForSession");
      assert.equal(fake.lastPermissionSelection, "allow-always");
    }).pipe(Effect.provide(layer));
  });

  it.effect("auto-approves cursor permission requests when approval policy is never", () => {
    const fake = new FakeCursorAcpProcess();
    const layer = makeCursorAdapterLive({
      createProcess: () => fake as never,
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;

      yield* adapter.startSession({
        provider: "cursor",
        approvalPolicy: "never",
      });

      // consume startup events
      yield* Stream.take(adapter.streamEvents, 6).pipe(Stream.runDrain);

      fake.emitPermissionRequest();

      const resolved = yield* Stream.runHead(adapter.streamEvents);
      assert.equal(resolved._tag, "Some");
      if (resolved._tag !== "Some") {
        return;
      }

      assert.equal(resolved.value.type, "request.resolved");
      if (resolved.value.type !== "request.resolved") {
        return;
      }

      assert.equal(resolved.value.payload.decision, "acceptForSession");
      assert.equal(fake.lastPermissionSelection, "allow-always");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects empty prompt input before starting a turn", () => {
    const fake = new FakeCursorAcpProcess();
    const layer = makeCursorAdapterLive({
      createProcess: () => fake as never,
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;
      const session = yield* adapter.startSession({
        provider: "cursor",
      });

      yield* Stream.take(adapter.streamEvents, 6).pipe(Stream.runDrain);

      const result = yield* adapter
        .sendTurn({
          sessionId: session.sessionId,
          input: "   ",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        return;
      }
      assert.deepEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: "cursor",
          operation: "sendTurn",
          issue: "Turn input must be non-empty.",
        }),
      );

      assert.equal(fake.requests.some((request) => request.method === "session/prompt"), false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps tool_call item types consistent through tool_call_update", () => {
    const fake = new FakeCursorAcpProcess();
    const layer = makeCursorAdapterLive({
      createProcess: () => fake as never,
    });

    return Effect.gen(function* () {
      const adapter = yield* CursorAdapter;

      const eventsFiber = yield* Stream.take(adapter.streamEvents, 13).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      const session = yield* adapter.startSession({
        provider: "cursor",
      });

      yield* adapter.sendTurn({
        sessionId: session.sessionId,
        input: "hello",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const started = events.find(
        (event) => event.type === "item.started" && String(event.itemId) === "tool-1",
      );
      const completed = events.find(
        (event) => event.type === "item.completed" && String(event.itemId) === "tool-1",
      );

      assert.equal(started?.type, "item.started");
      assert.equal(completed?.type, "item.completed");
      if (started?.type !== "item.started" || completed?.type !== "item.completed") {
        return;
      }

      assert.equal(started.payload.itemType, "command_execution");
      assert.equal(completed.payload.itemType, "command_execution");
    }).pipe(Effect.provide(layer));
  });
});
