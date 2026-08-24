import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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

const InitializeRequest = jsonRpcRequest("initialize", AcpSchema.InitializeRequest);
const InitializeResponse = jsonRpcResponse(AcpSchema.InitializeResponse);
const InitializeRequestV1 = jsonRpcRequest("initialize", AcpSchemaV1.InitializeRequest);
const InitializeResponseV1 = jsonRpcResponse(AcpSchemaV1.InitializeResponse);
const NewSessionRequestV1 = jsonRpcRequest("session/new", AcpSchemaV1.NewSessionRequest);
const NewSessionResponseV1 = jsonRpcResponse(AcpSchemaV1.NewSessionResponse);
const PromptRequestV1 = jsonRpcRequest("session/prompt", AcpSchemaV1.PromptRequest);
const PromptResponseV1 = jsonRpcResponse(AcpSchemaV1.PromptResponse);
const ExtRequest = jsonRpcRequest("x/test", Schema.Struct({ hello: Schema.String }));
const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));
const PromptRequest = jsonRpcRequest("session/prompt", AcpSchema.PromptRequest);
const PromptResponse = jsonRpcResponse(AcpSchema.PromptResponse);
const SessionUpdateNotification = jsonRpcNotification(
  "session/update",
  AcpSchema.UpdateSessionNotification,
);
const PermissionRequest = jsonRpcRequest(
  "session/request_permission",
  AcpSchema.RequestPermissionRequest,
);
const PermissionResponse = jsonRpcResponse(AcpSchema.RequestPermissionResponse);
const ElicitationRequest = jsonRpcRequest("elicitation/create", AcpSchema.CreateElicitationRequest);
const ElicitationResponse = jsonRpcResponse(AcpSchema.CreateElicitationResponse);
const decodePromptRequestLine = Schema.decodeEffect(Schema.fromJsonString(PromptRequest));
const XAiPromptCompleteNotification = jsonRpcNotification(
  "_x.ai/session/prompt_complete",
  Schema.Struct({
    sessionId: Schema.String,
    promptId: Schema.String,
    stopReason: Schema.String,
    agentResult: Schema.NullOr(Schema.Unknown),
  }),
);
const XAiQueueChangedNotification = jsonRpcNotification(
  "_x.ai/queue/changed",
  Schema.Struct({
    sessionId: Schema.String,
    entries: Schema.Array(Schema.Unknown),
  }),
);
const XAiSessionsChangedNotification = jsonRpcNotification(
  "_x.ai/sessions/changed",
  Schema.Struct({
    upserted: Schema.Array(Schema.Unknown),
    removed: Schema.Array(Schema.Unknown),
  }),
);
const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

function concatBytes(chunks: ReadonlyArray<Uint8Array>): Uint8Array {
  const batch = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    batch.set(chunk, offset);
    offset += chunk.length;
  }
  return batch;
}

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

  it.effect("initializes, prompts, receives updates, and handles permission requests", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<Array<unknown>>([]);
      const elicitationCompletions = yield* Ref.make<Array<unknown>>([]);
      const typedRequests = yield* Ref.make<Array<unknown>>([]);
      const typedNotifications = yield* Ref.make<Array<unknown>>([]);
      const requestContexts = yield* Ref.make<Array<AcpProtocol.AcpRequestContext>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const acpLayer = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(acpLayer, scope);

      const ext = yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;

        yield* acp.handleRequestPermission((_request, requestContext) =>
          Ref.update(requestContexts, (current) => [...current, requestContext]).pipe(
            Effect.as({
              outcome: {
                outcome: "selected",
                optionId: "allow",
              },
            }),
          ),
        );
        yield* acp.handleElicitation((_request, requestContext) =>
          Ref.update(requestContexts, (current) => [...current, requestContext]).pipe(
            Effect.as({
              action: "accept",
              content: {
                approved: true,
              },
            }),
          ),
        );
        yield* acp.handleSessionUpdate((notification) =>
          Ref.update(updates, (current) => [...current, notification]),
        );
        yield* acp.handleElicitationComplete((notification) =>
          Ref.update(elicitationCompletions, (current) => [...current, notification]),
        );
        yield* acp.handleExtRequest(
          "x/typed_request",
          Schema.Struct({ message: Schema.String }),
          (payload, requestContext) =>
            Ref.update(typedRequests, (current) => [...current, payload]).pipe(
              Effect.andThen(
                Ref.update(requestContexts, (current) => [...current, requestContext]),
              ),
              Effect.as({
                ok: true,
                echoedMessage: payload.message,
              }),
            ),
        );
        yield* acp.handleExtNotification(
          "x/typed_notification",
          Schema.Struct({ count: Schema.Number }),
          (payload) => Ref.update(typedNotifications, (current) => [...current, payload]),
        );

        const init = yield* acp.agent.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        });
        assert.equal(init.protocolVersion, 2);

        yield* acp.agent.authenticate({ methodId: "cursor_login" });

        const session = yield* acp.agent.createSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        assert.equal(session.sessionId, "mock-session-1");

        const prompt = yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        });
        assert.equal(prompt.stopReason, "end_turn");

        const streamed = yield* Stream.runCollect(Stream.take(acp.raw.notifications, 2));
        assert.equal(streamed.length, 2);
        assert.equal(streamed[0]?._tag, "SessionUpdate");
        assert.equal(streamed[1]?._tag, "ElicitationComplete");
        assert.equal((yield* Ref.get(updates)).length, 2);
        assert.equal((yield* Ref.get(elicitationCompletions)).length, 1);
        assert.deepEqual(yield* Ref.get(typedRequests), [{ message: "hello from typed request" }]);
        assert.deepEqual(yield* Ref.get(typedNotifications), [{ count: 2 }]);
        const observedRequestContexts = yield* Ref.get(requestContexts);
        assert.deepEqual(
          observedRequestContexts.map((requestContext) => requestContext.method),
          ["session/request_permission", "elicitation/create", "x/typed_request"],
        );
        assert.equal(
          new Set(observedRequestContexts.map((requestContext) => requestContext.requestId)).size,
          observedRequestContexts.length,
        );

        return yield* acp.raw.request("x/echo", {
          hello: "world",
        });
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.deepEqual(ext, {
        echoedMethod: "x/echo",
        echoedParams: {
          hello: "world",
        },
      });
    }),
  );

  it.effect(
    "returns structured invalid params without exposing values from typed extension request payloads",
    () =>
      Effect.gen(function* () {
        const handle = yield* makeHandle({ ACP_MOCK_BAD_TYPED_REQUEST: "1" });
        const scope = yield* Scope.make();
        const acpLayer = AcpClient.layerChildProcess(handle);
        const context = yield* Layer.buildWithScope(acpLayer, scope);

        const result = yield* Effect.gen(function* () {
          const acp = yield* AcpClient.AcpClient;

          yield* acp.handleRequestPermission(() =>
            Effect.succeed({
              outcome: {
                outcome: "selected",
                optionId: "allow",
              },
            }),
          );
          yield* acp.handleElicitation(() =>
            Effect.succeed({
              action: "accept",
              content: {
                approved: true,
              },
            }),
          );
          yield* acp.handleExtRequest(
            "x/typed_request",
            Schema.Struct({ message: Schema.String }),
            () => Effect.succeed({ ok: true }),
          );

          yield* acp.agent.initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: {
              name: "effect-acp-test",
              version: "0.0.0",
            },
          });

          yield* acp.agent.authenticate({ methodId: "cursor_login" });

          const session = yield* acp.agent.createSession({
            cwd: process.cwd(),
            mcpServers: [],
          });

          return yield* Effect.exit(
            acp.agent.prompt({
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "hello" }],
            }),
          );
        }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

        if (result._tag !== "Failure") {
          assert.fail("Expected prompt to fail for invalid typed extension payload");
        }
        const rendered = Cause.pretty(result.cause);
        assert.include(rendered, "Invalid payload for ACP extension method 'x/typed_request'.");
        assert.notInclude(rendered, "Expected string, got 123");
      }),
  );

  it.effect("preserves ACP v2 structured diff semantics", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<Array<AcpCompat.SessionNotification>>([]);
      const handle = yield* makeHandle({ ACP_MOCK_V2_DIFF: "1" });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(AcpClient.layerChildProcess(handle), scope);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        yield* acp.handleRequestPermission(() =>
          Effect.succeed({ outcome: { outcome: "selected", optionId: "allow" } }),
        );
        yield* acp.handleElicitation(() =>
          Effect.succeed({ action: "accept", content: { approved: true } }),
        );
        yield* acp.handleExtRequest(
          "x/typed_request",
          Schema.Struct({ message: Schema.String }),
          () => Effect.succeed({ ok: true }),
        );
        yield* acp.handleSessionUpdate((notification) =>
          Ref.update(updates, (current) => [...current, notification]),
        );

        yield* acp.agent.initialize({ protocolVersion: 2 });
        yield* acp.agent.authenticate({ methodId: "cursor_login" });
        const session = yield* acp.agent.createSession({ cwd: process.cwd(), mcpServers: [] });
        yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "show the diff" }],
        });
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      const diffUpdate = (yield* Ref.get(updates)).find(
        (notification) => notification.update.sessionUpdate === "tool_call_update",
      );
      assert.deepEqual(diffUpdate?.update, {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-diff",
        content: [
          {
            type: "diff",
            changes: [
              {
                operation: "move",
                oldPath: "/workspace/old.ts",
                path: "/workspace/new.ts",
                fileType: "text",
                mimeType: "text/typescript",
              },
            ],
            patch: {
              format: "git_patch",
              text: "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n",
            },
          },
        ],
      });
    }),
  );

  it.effect("preserves registry env-var authentication extensions", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_ENV_VAR_AUTH: "1" });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(AcpClient.layerChildProcess(handle), scope);

      const response = yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        return yield* acp.agent.initialize({ protocolVersion: 2 });
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.deepEqual(response.authMethods, [
        {
          id: "api_key",
          name: "API key",
          type: "env_var",
          vars: [{ name: "MOCK_API_KEY", label: "Mock API key" }],
          link: "https://example.test/keys",
        },
      ]);
    }),
  );

  it.effect("replays buffered notifications to handlers registered after they arrive", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<Array<unknown>>([]);
      const elicitationCompletions = yield* Ref.make<Array<unknown>>([]);
      const typedRequests = yield* Ref.make<Array<unknown>>([]);
      const typedNotifications = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const acpLayer = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(acpLayer, scope);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;

        yield* acp.handleRequestPermission(() =>
          Effect.succeed({
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          }),
        );
        yield* acp.handleElicitation(() =>
          Effect.succeed({
            action: "accept",
            content: {
              approved: true,
            },
          }),
        );
        yield* acp.handleExtRequest(
          "x/typed_request",
          Schema.Struct({ message: Schema.String }),
          (payload) =>
            Ref.update(typedRequests, (current) => [...current, payload]).pipe(
              Effect.as({
                ok: true,
                echoedMessage: payload.message,
              }),
            ),
        );
        yield* acp.handleExtNotification(
          "x/typed_notification",
          Schema.Struct({ count: Schema.Number }),
          (payload) => Ref.update(typedNotifications, (current) => [...current, payload]),
        );

        yield* acp.agent.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        });
        yield* acp.agent.authenticate({ methodId: "cursor_login" });

        const session = yield* acp.agent.createSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        });

        yield* acp.handleSessionUpdate((notification) =>
          Ref.update(updates, (current) => [...current, notification]),
        );
        yield* acp.handleElicitationComplete((notification) =>
          Ref.update(elicitationCompletions, (current) => [...current, notification]),
        );

        assert.equal((yield* Ref.get(updates)).length, 2);
        assert.equal((yield* Ref.get(elicitationCompletions)).length, 1);
        assert.deepEqual(yield* Ref.get(typedRequests), [{ message: "hello from typed request" }]);
        assert.deepEqual(yield* Ref.get(typedNotifications), [{ count: 2 }]);
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
  );

  it.effect("continues dispatching session updates after one handler fails", () =>
    Effect.gen(function* () {
      const successfulHandlers = yield* Ref.make(0);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const acpLayer = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(acpLayer, scope);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;

        yield* acp.handleRequestPermission(() =>
          Effect.succeed({
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          }),
        );
        yield* acp.handleElicitation(() =>
          Effect.succeed({
            action: "accept",
            content: {
              approved: true,
            },
          }),
        );
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
        yield* acp.handleSessionUpdate(() =>
          Effect.fail(AcpError.AcpRequestError.internalError("session update handler failed")),
        );
        yield* acp.handleSessionUpdate(() => Ref.update(successfulHandlers, (count) => count + 1));

        yield* acp.agent.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        });
        yield* acp.agent.authenticate({ methodId: "cursor_login" });

        const session = yield* acp.agent.createSession({
          cwd: process.cwd(),
          mcpServers: [],
        });
        yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        });

        assert.equal(yield* Ref.get(successfulHandlers), 2);
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
  );

  it.effect("uses distinct ids for RPC calls and extension requests", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));

      const initializeFiber = yield* acp.agent
        .initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        })
        .pipe(Effect.forkScoped);
      const extFiber = yield* acp.raw.request("x/test", { hello: "world" }).pipe(Effect.forkScoped);

      const firstOutbound = yield* Queue.take(output);
      const secondOutbound = yield* Queue.take(output);

      const decodedInitialize = Schema.decodeEffect(Schema.fromJsonString(InitializeRequest));
      const decodedExt = Schema.decodeEffect(Schema.fromJsonString(ExtRequest));
      const firstIsInitialize = yield* decodedInitialize(firstOutbound).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: () => true,
        }),
      );

      const initializeRequest = firstIsInitialize
        ? yield* decodedInitialize(firstOutbound)
        : yield* decodedInitialize(secondOutbound);
      const extRequest = firstIsInitialize
        ? yield* decodedExt(secondOutbound)
        : yield* decodedExt(firstOutbound);

      assert.notEqual(initializeRequest.id, extRequest.id);

      yield* Queue.offer(
        input,
        yield* encodeJsonl(InitializeResponse, {
          jsonrpc: "2.0",
          id: initializeRequest.id,
          result: {
            protocolVersion: 2,
            capabilities: {},
            info: {
              name: "mock-agent",
              version: "0.0.0",
            },
          },
        }),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: extRequest.id,
          result: { ok: true },
        }),
      );

      yield* Fiber.join(initializeFiber);
      assert.deepEqual(yield* Fiber.join(extFiber), { ok: true });
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("classifies a legacy response by shape when its protocol version is 2", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));
      const initializeFiber = yield* acp.agent
        .initialize({
          protocolVersion: 2,
          clientInfo: { name: "effect-acp-test", version: "0.0.0" },
        })
        .pipe(Effect.forkScoped);
      const decodeInitialize = Schema.decodeEffect(Schema.fromJsonString(InitializeRequestV1));
      const initializeRequest = yield* decodeInitialize(yield* Queue.take(output));
      yield* Queue.offer(
        input,
        yield* encodeJsonl(InitializeResponseV1, {
          jsonrpc: "2.0",
          id: initializeRequest.id,
          result: {
            protocolVersion: 2,
            agentInfo: { name: "antigravity", version: "1.0.0" },
            agentCapabilities: {},
          },
        }),
      );

      const initialized = yield* Fiber.join(initializeFiber);
      assert.equal(initialized.protocolVersion, 2);
      assert.equal(initialized.agentInfo?.name, "antigravity");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("negotiates ACP v1 for registry agents while preferring v2", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));
      const updates = yield* Ref.make<Array<unknown>>([]);
      yield* acp.handleSessionUpdate((notification) =>
        Ref.update(updates, (current) => [...current, notification]),
      );

      const initializeFiber = yield* acp.agent
        .initialize({
          protocolVersion: 2,
          clientInfo: { name: "effect-acp-test", version: "0.0.0" },
          clientCapabilities: { _meta: { "terminal-auth": true } },
        })
        .pipe(Effect.forkScoped);
      const initializeRequest = yield* Queue.take(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(InitializeRequestV1))),
      );
      assert.equal(initializeRequest.params.protocolVersion, 2);
      assert.equal(initializeRequest.params.clientCapabilities?._meta?.["terminal-auth"], true);
      yield* Queue.offer(
        input,
        yield* encodeJsonl(InitializeResponseV1, {
          jsonrpc: "2.0",
          id: initializeRequest.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: "pi-acp", version: "0.0.33" },
            agentCapabilities: { loadSession: true },
          },
        }),
      );
      const initialized = yield* Fiber.join(initializeFiber);
      assert.equal(initialized.protocolVersion, 1);
      assert.equal(initialized.agentInfo?.name, "pi-acp");

      const sessionFiber = yield* acp.agent
        .createSession({ cwd: process.cwd(), mcpServers: [] })
        .pipe(Effect.forkScoped);
      const sessionRequest = yield* Queue.take(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(NewSessionRequestV1))),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(NewSessionResponseV1, {
          jsonrpc: "2.0",
          id: sessionRequest.id,
          result: { sessionId: "pi-session-1" },
        }),
      );
      assert.equal((yield* Fiber.join(sessionFiber)).sessionId, "pi-session-1");

      const promptFiber = yield* acp.agent
        .prompt({
          sessionId: "pi-session-1",
          prompt: [{ type: "text", text: "hello" }],
        })
        .pipe(Effect.forkScoped);
      const promptRequest = yield* Queue.take(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PromptRequestV1))),
      );
      yield* Queue.offer(
        input,
        concatBytes([
          yield* encodeJsonl(
            jsonRpcNotification("session/update", AcpSchemaV1.SessionNotification),
            {
              jsonrpc: "2.0",
              method: "session/update",
              params: {
                sessionId: "pi-session-1",
                update: {
                  sessionUpdate: "available_commands_update",
                  availableCommands: [
                    { name: "review", description: "Review changes", input: { hint: "scope" } },
                  ],
                },
              },
            },
          ),
          yield* encodeJsonl(PromptResponseV1, {
            jsonrpc: "2.0",
            id: promptRequest.id,
            result: { stopReason: "end_turn" },
          }),
        ]),
      );
      assert.deepEqual(yield* Fiber.join(promptFiber), { stopReason: "end_turn" });
      assert.deepEqual(yield* Ref.get(updates), [
        {
          sessionId: "pi-session-1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              {
                name: "review",
                description: "Review changes",
                input: { type: "text", hint: "scope" },
              },
            ],
          },
        },
      ]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("preserves exact ids for parallel requests with identical payloads", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));
      const contexts = yield* Ref.make<Array<AcpProtocol.AcpRequestContext>>([]);
      yield* acp.handleRequestPermission((_request, context) =>
        Ref.update(contexts, (current) => [...current, context]).pipe(
          Effect.as({ outcome: { outcome: "selected", optionId: "allow" } } as const),
        ),
      );
      const payload = {
        sessionId: "session-1",
        title: "Shared tool",
        subject: {
          type: "tool_call" as const,
          toolCall: { toolCallId: "shared-tool", title: "Shared tool" },
        },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" as const }],
      };
      yield* Queue.offer(
        input,
        concatBytes(
          yield* Effect.all(
            ["permission-a", "permission-b"].map((id) =>
              encodeJsonl(PermissionRequest, {
                jsonrpc: "2.0",
                id,
                method: "session/request_permission",
                params: payload,
                headers: [],
              }),
            ),
          ),
        ),
      );

      const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(PermissionResponse));
      const responses = yield* Effect.all([
        Queue.take(output).pipe(Effect.flatMap(decodeResponse)),
        Queue.take(output).pipe(Effect.flatMap(decodeResponse)),
      ]);
      assert.deepEqual(responses.map((response) => response.id).toSorted(), [
        "permission-a",
        "permission-b",
      ]);
      assert.deepEqual(
        (yield* Ref.get(contexts))
          .map(({ requestId, method }) => ({ requestId, method }))
          .toSorted((left, right) => left.requestId.localeCompare(right.requestId)),
        [
          { requestId: "permission-a", method: "session/request_permission" },
          { requestId: "permission-b", method: "session/request_permission" },
        ],
      );
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("answers elicitation/create with the flat action shape", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));
      yield* acp.handleElicitation(() =>
        Effect.succeed({ action: "accept" as const, content: { approved: true } }),
      );

      yield* Queue.offer(
        input,
        yield* encodeJsonl(ElicitationRequest, {
          jsonrpc: "2.0",
          id: "elicitation",
          method: "elicitation/create",
          params: {
            sessionId: "session-1",
            mode: "form" as const,
            message: "Approve this call?",
            requestedSchema: {
              type: "object" as const,
              properties: { approved: { type: "boolean" as const } },
            },
          },
          headers: [],
        }),
      );
      const response = yield* Queue.take(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ElicitationResponse))),
      );
      assert.deepEqual(response.result, {
        action: "accept",
        content: { approved: true },
      });
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

  it.effect("calls ACP v2 session deletion and provider-management methods", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_V2_MANAGEMENT: "1" });
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(AcpClient.layerChildProcess(handle), scope);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        const initialized = yield* acp.agent.initialize({
          protocolVersion: 2,
          clientCapabilities: {},
          clientInfo: { name: "effect-acp-test", version: "0.0.0" },
        });
        assert.ok(initialized.agentCapabilities?.sessionCapabilities?.delete);
        assert.ok(initialized.agentCapabilities?.providers);

        assert.deepEqual(yield* acp.agent.deleteSession({ sessionId: "mock-session-1" }), {});
        assert.deepEqual(yield* acp.agent.listProviders({}), {
          providers: [
            {
              providerId: "mock-provider",
              supported: ["openai"],
              required: false,
              current: null,
            },
          ],
        });
        assert.deepEqual(
          yield* acp.agent.setProvider({
            providerId: "mock-provider",
            apiType: "openai",
            baseUrl: "https://api.example.test/v1",
            headers: { Authorization: "Bearer secret" },
          }),
          {},
        );
        assert.deepEqual(yield* acp.agent.disableProvider({ providerId: "mock-provider" }), {});
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
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
});
