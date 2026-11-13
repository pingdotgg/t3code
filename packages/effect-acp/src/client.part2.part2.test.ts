import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as AcpClient from "./client.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpSchemaV1 from "./_generated/schema-v1.gen.ts";
import * as AcpError from "./errors.ts";
import type * as AcpCompat from "./compat.ts";
import type * as AcpProtocol from "./protocol.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import antigravityInitialize from "../test/fixtures/antigravity-initialize.json" with { type: "json" };
import { DieResponse, ErrorResponse, ExtRequest, ExtResponse, InitializeRequest, InitializeRequestV1, InitializeResponse, InitializeResponseV1, NewSessionRequestV1, PermissionRequest, PermissionResponse, PromptRequest, PromptRequestV1, PromptResponse, PromptResponseV1, SessionUpdateNotification, XAiPromptCompleteNotification, XAiQueueChangedNotification, XAiSessionsChangedNotification, concatBytes, decodePromptRequestLine, decodeWireError, decodeWireResponse, elicitationForm, mockPeerArgs, mockPeerPath, mockStartupNotice, stripMockStartupNotice } from "./client.helpers2.testkit.ts";

it.layer(NodeServices.layer)("effect-acp client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: path.join(import.meta.dirname, ".."),
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("answers each request whose handler dies, and keeps reading", () =>
    Effect.gen(function* () {
      const errorLogs = yield* Queue.unbounded<string>();
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Error") Queue.offerUnsafe(errorLogs, String([message].flat()[0]));
      });
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(Logger.layer([logger])),
      );
      const bug = () => Effect.die(new Error("handler bug"));
      yield* acp.handleRequestPermission(bug);
      yield* acp.handleExtRequest("x/dies", Schema.Unknown, bug);
      yield* acp.handleExtNotification("x/notification-dies", Schema.Unknown, bug);
      yield* acp.handleSessionUpdate(bug);
      const updates = yield* Queue.unbounded<string>();
      yield* acp.handleSessionUpdate((notification) =>
        Queue.offer(updates, notification.sessionId).pipe(Effect.asVoid),
      );
      yield* acp.handleExtRequest("x/test", Schema.Struct({ hello: Schema.String }), () =>
        Effect.succeed({ ok: true }),
      );
      const send = <E>(line: Effect.Effect<Uint8Array, E>) =>
        Effect.flatMap(line, (bytes) => Queue.offer(input, bytes));
      const decodeDie = Schema.decodeEffect(Schema.fromJsonString(DieResponse));
      const next = <A>(queue: Queue.Dequeue<A>) =>
        TestClock.withLive(Queue.take(queue).pipe(Effect.timeout("2 seconds")));

      yield* send(
        encodeJsonl(PermissionRequest, {
          jsonrpc: "2.0",
          id: "permission-a",
          method: "session/request_permission",
          params: {
            sessionId: "session-1",
            title: "Tool",
            subject: {
              type: "tool_call" as const,
              toolCall: { toolCallId: "tool-1", title: "Tool" },
            },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
          },
          headers: [],
        }),
      );
      assert.equal((yield* next(output).pipe(Effect.flatMap(decodeDie))).id, "permission-a");

      yield* send(
        encodeJsonl(jsonRpcRequest("x/dies", Schema.Unknown), {
          jsonrpc: "2.0",
          id: "ext-a",
          method: "x/dies",
          params: {},
          headers: [],
        }),
      );
      const extDied = yield* next(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ErrorResponse))),
      );
      assert.equal(extDied.id, "ext-a");

      yield* send(
        encodeJsonl(jsonRpcNotification("x/notification-dies", Schema.Unknown), {
          jsonrpc: "2.0",
          method: "x/notification-dies",
          params: {},
        }),
      );
      yield* send(
        encodeJsonl(SessionUpdateNotification, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
          },
        }),
      );

      assert.equal(yield* next(updates), "session-1");

      yield* send(
        encodeJsonl(ExtRequest, {
          jsonrpc: "2.0",
          id: "ext-b",
          method: "x/test",
          params: { hello: "world" },
          headers: [],
        }),
      );
      const answered = yield* next(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ExtResponse))),
      );
      assert.deepEqual([answered.id, answered.result], ["ext-b", { ok: true }]);

      assert.deepEqual((yield* Queue.clear(errorLogs)).toSorted(), [
        "ACP extension request handler failed for 'x/dies'",
        "ACP notification handler failed",
        "ACP notification handler failed",
        "ACP request handler failed for 'session/request_permission'",
      ]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "routes a standard prompt response after Grok extension notifications in the same batch",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const scope = yield* Scope.make();
        const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));

        const promptFiber = yield* acp.agent
          .prompt({
            sessionId: "grok-session-1",
            prompt: [{ type: "text", text: "run the ls command" }],
          })
          .pipe(Effect.forkScoped);

        const outbound = yield* Queue.take(output);
        const decodedPrompt = yield* decodePromptRequestLine(outbound);

        const responseBatch = concatBytes(
          yield* Effect.all([
            encodeJsonl(XAiQueueChangedNotification, {
              jsonrpc: "2.0",
              method: "_x.ai/queue/changed",
              params: { sessionId: "grok-session-1", entries: [] },
            }),
            encodeJsonl(XAiPromptCompleteNotification, {
              jsonrpc: "2.0",
              method: "_x.ai/session/prompt_complete",
              params: {
                sessionId: "grok-session-1",
                promptId: "prompt-1",
                stopReason: "end_turn",
                agentResult: null,
              },
            }),
            encodeJsonl(XAiSessionsChangedNotification, {
              jsonrpc: "2.0",
              method: "_x.ai/sessions/changed",
              params: {
                upserted: [
                  {
                    sessionId: "grok-session-1",
                    title: null,
                    cwd: process.cwd(),
                    isWorktree: false,
                    modelId: "grok-composer-2.5-fast",
                    yolo: false,
                    activity: "idle",
                    resident: true,
                    lastChangeUnixMs: 1_710_000_000_000,
                    origin: { kind: "local" },
                  },
                ],
                removed: [],
              },
            }),
            encodeJsonl(PromptResponse, {
              jsonrpc: "2.0",
              id: decodedPrompt.id,
              result: {},
            }),
            encodeJsonl(SessionUpdateNotification, {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "grok-session-1",
                update: {
                  sessionUpdate: "state_update",
                  state: "idle",
                  stopReason: "end_turn",
                  _meta: {
                    sessionId: "grok-session-1",
                    requestId: "prompt-1",
                    promptId: "prompt-1",
                    modelId: "grok-composer-2.5-fast",
                  },
                },
              },
            }),
          ]),
        );
        yield* Queue.offer(input, responseBatch);

        assert.deepEqual(yield* Fiber.join(promptFiber), {
          stopReason: "end_turn",
          _meta: {
            sessionId: "grok-session-1",
            requestId: "prompt-1",
            promptId: "prompt-1",
            modelId: "grok-composer-2.5-fast",
          },
        });
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect("returns the ACP v2 idle error as the prompt result", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const acp = yield* AcpClient.make(stdio);
      const error = { code: -32000, message: "Missing Authentication header" };
      const prompt = yield* acp.agent
        .prompt({ sessionId: "idle-error", prompt: [{ type: "text", text: "Hello" }] })
        .pipe(Effect.forkScoped);
      const request = yield* decodePromptRequestLine(yield* Queue.take(output));
      yield* Queue.offer(
        input,
        concatBytes([
          yield* encodeJsonl(jsonRpcResponse(Schema.Unknown), {
            jsonrpc: "2.0",
            id: request.id,
            result: { messageId: `user-${request.id}` },
          }),
          yield* encodeJsonl(SessionUpdateNotification, {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "idle-error",
              update: { sessionUpdate: "state_update", state: "idle", stopReason: "error", error },
            },
          }),
        ]),
      );
      assert.deepEqual(yield* Fiber.join(prompt), { stopReason: "error", error });
    }).pipe(Effect.scoped),
  );

  it.effect("routes MCP-over-ACP connect, message, notification, and disconnect callbacks", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_MCP_OVER_ACP: "1" });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(AcpClient.layerChildProcess(handle), scope);
      const methods = yield* Ref.make<Array<string>>([]);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        yield* acp.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "selected", optionId: "allow" } }),
        );
        yield* acp.handleElicitation(() => Effect.succeed({ action: "decline" }));
        yield* acp.handleExtRequest(
          "x/typed_request",
          Schema.Struct({ message: Schema.String }),
          () => Effect.succeed({ ok: true }),
        );
        yield* acp.handleExtNotification(
          "x/typed_notification",
          Schema.Struct({ count: Schema.Number }),
          () => Effect.void,
        );
        yield* acp.handleMcpConnect(() =>
          Ref.update(methods, (current) => [...current, "connect"]).pipe(
            Effect.as({ connectionId: "connection-1" }),
          ),
        );
        yield* acp.handleMcpMessage(() =>
          Ref.update(methods, (current) => [...current, "message"]).pipe(Effect.as({ tools: [] })),
        );
        yield* acp.handleMcpNotification(() =>
          Ref.update(methods, (current) => [...current, "notification"]),
        );
        yield* acp.handleMcpDisconnect(() =>
          Ref.update(methods, (current) => [...current, "disconnect"]).pipe(Effect.as({})),
        );
        yield* acp.agent.initialize({
          protocolVersion: 2,
          clientCapabilities: {},
          clientInfo: { name: "effect-acp-test", version: "0.0.0" },
        });
        const session = yield* acp.agent.createSession({ cwd: process.cwd(), mcpServers: [] });
        yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "exercise MCP" }],
        });
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.deepEqual(yield* Ref.get(methods), [
        "connect",
        "message",
        "notification",
        "disconnect",
      ]);
    }),
  );

  it.effect("preserves future content and session-update variants", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_UNKNOWN_VARIANTS: "1" });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(AcpClient.layerChildProcess(handle), scope);
      const updates = yield* Ref.make<Array<AcpCompat.SessionNotification>>([]);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        yield* acp.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "selected", optionId: "allow" } }),
        );
        yield* acp.handleElicitation(() => Effect.succeed({ action: "decline" }));
        yield* acp.handleExtRequest(
          "x/typed_request",
          Schema.Struct({ message: Schema.String }),
          () => Effect.succeed({ ok: true }),
        );
        yield* acp.handleExtNotification(
          "x/typed_notification",
          Schema.Struct({ count: Schema.Number }),
          () => Effect.void,
        );
        yield* acp.handleSessionUpdate((update) =>
          Ref.update(updates, (current) => [...current, update]),
        );
        yield* acp.agent.initialize({
          protocolVersion: 2,
          clientCapabilities: {},
          clientInfo: { name: "effect-acp-test", version: "0.0.0" },
        });
        const session = yield* acp.agent.createSession({ cwd: process.cwd(), mcpServers: [] });
        yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "exercise future variants" }],
        });
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      const received = yield* Ref.get(updates);
      assert.deepEqual(received[0]?.update, {
        sessionUpdate: "agent_message_chunk",
        messageId: "future-content",
        content: {
          type: "_t3_unknown",
          originalType: "chart",
          raw: { type: "chart", points: [] },
        },
      });
      assert.deepEqual(received[1]?.update, {
        sessionUpdate: "_t3_unknown",
        originalSessionUpdate: "timeline_update",
        raw: { sessionUpdate: "timeline_update", entries: [] },
      });
    }),
  );

  it.effect("delivers ACP v1 session notices, which the pinned v1 schema predates", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));
      const initializeFiber = yield* acp.agent
        .initialize({ protocolVersion: 1, clientCapabilities: { session: { notices: {} } } })
        .pipe(Effect.forkScoped);
      const initializeRequest = yield* Queue.take(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(InitializeRequestV1))),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(InitializeResponseV1, {
          jsonrpc: "2.0",
          id: initializeRequest.id,
          result: { protocolVersion: 1 },
        }),
      );
      yield* Fiber.join(initializeFiber);

      const notice = {
        sessionUpdate: "notice",
        severity: "warning",
        title: "MCP server unavailable",
        description: "Continuing without it.",
      } as const;
      const untitled = { sessionUpdate: "notice", severity: "info" } as const;
      for (const update of [notice, untitled]) {
        yield* Queue.offer(
          input,
          yield* encodeJsonl(SessionUpdateNotification, {
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: "session-1", update },
          }),
        );
      }
      const received = yield* acp.raw.notifications.pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(
        Array.from(received, (event) =>
          event._tag === "SessionUpdate" ? event.params.update : undefined,
        ),
        [notice, { sessionUpdate: "_t3_unknown", originalSessionUpdate: "notice", raw: untitled }],
      );
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
