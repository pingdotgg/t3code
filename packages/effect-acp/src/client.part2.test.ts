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

  it.effect.each([1, 2])("keeps legacy wire behavior with version %s", (protocolVersion) =>
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
            ...antigravityInitialize,
            protocolVersion,
          },
        }),
      );
      const initialized = yield* Fiber.join(initializeFiber);
      assert.equal(initialized.protocolVersion, protocolVersion);
      assert.equal(initialized.agentInfo?.name, "antigravity-acp");

      const exchange = <A, E>(effect: Effect.Effect<A, E>, method: string) =>
        Effect.gen(function* () {
          const fiber = yield* effect.pipe(Effect.forkScoped);
          const request = yield* Queue.take(output).pipe(
            Effect.flatMap(
              Schema.decodeEffect(Schema.fromJsonString(jsonRpcRequest(method, Schema.Unknown))),
            ),
          );
          yield* Queue.offer(
            input,
            yield* encodeJsonl(jsonRpcResponse(Schema.Unknown), {
              jsonrpc: "2.0",
              id: request.id,
              result: {},
            }),
          );
          yield* Fiber.join(fiber);
          return request.params;
        });
      assert.deepEqual(
        yield* exchange(acp.agent.authenticate({ methodId: "oauth-personal" }), "authenticate"),
        { methodId: "oauth-personal" },
      );
      const mcpServers = [{ name: "fixture", command: "fixture-only", args: [], env: [] }];

      const sessionFiber = yield* acp.agent
        .createSession({ cwd: process.cwd(), mcpServers })
        .pipe(Effect.forkScoped);
      const sessionRequest = yield* Queue.take(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(NewSessionRequestV1))),
      );
      assert.deepEqual(sessionRequest.params.mcpServers, mcpServers);
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcResponse(Schema.Unknown), {
          jsonrpc: "2.0",
          id: sessionRequest.id,
          result: {
            sessionId: "pi-session-1",
            models: {
              currentModelId: "native-model",
              availableModels: [{ modelId: "native-model", name: "Native model" }],
            },
          },
        }),
      );
      const session = yield* Fiber.join(sessionFiber);
      assert.equal(session.sessionId, "pi-session-1");
      assert.equal(session.models?.currentModelId, "native-model");
      const resume = { sessionId: session.sessionId, cwd: process.cwd(), mcpServers };
      assert.deepEqual(yield* exchange(acp.agent.resumeSession(resume), "session/resume"), resume);
      assert.deepEqual(yield* exchange(acp.agent.loadSession(resume), "session/load"), resume);
      const selectModel = yield* acp.agent
        .setSessionModel({ sessionId: session.sessionId, modelId: "native-model" })
        .pipe(Effect.forkScoped);
      const selection = yield* Queue.take(output).pipe(
        Effect.flatMap(
          Schema.decodeEffect(
            Schema.fromJsonString(
              jsonRpcRequest(
                "session/set_model",
                Schema.Struct({ sessionId: Schema.String, modelId: Schema.String }),
              ),
            ),
          ),
        ),
      );
      assert.equal(selection.params.modelId, "native-model");
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcResponse(Schema.Unknown), {
          jsonrpc: "2.0",
          id: selection.id,
          result: {},
        }),
      );
      yield* Fiber.join(selectModel);
      const selectMode = yield* acp.agent
        .setSessionMode({ sessionId: session.sessionId, modeId: "yolo" })
        .pipe(Effect.forkScoped);
      const modeSelection = yield* Queue.take(output).pipe(
        Effect.flatMap(
          Schema.decodeEffect(
            Schema.fromJsonString(
              jsonRpcRequest(
                "session/set_mode",
                Schema.Struct({ sessionId: Schema.String, modeId: Schema.String }),
              ),
            ),
          ),
        ),
      );
      assert.equal(modeSelection.params.modeId, "yolo");
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcResponse(Schema.Unknown), {
          jsonrpc: "2.0",
          id: modeSelection.id,
          result: {},
        }),
      );
      yield* Fiber.join(selectMode);

      yield* acp.handleElicitation(() =>
        Effect.succeed({ action: "accept", content: { branch: "main" } }),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcRequest("session/elicitation", Schema.Unknown), {
          jsonrpc: "2.0",
          id: "legacy-question",
          headers: [],
          method: "session/elicitation",
          params: {
            sessionId: session.sessionId,
            mode: "form",
            message: "Choose a branch",
            requestedSchema: { type: "object", properties: {} },
          },
        }),
      );
      const answer = yield* Queue.take(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(jsonRpcResponse(Schema.Unknown)))),
      );
      assert.deepEqual(answer.result, {
        action: { action: "accept", content: { branch: "main" } },
      });
      // Recorded Devin 2026-09-10 called the older underscore method.
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcRequest("_session/elicitation", Schema.Unknown), {
          jsonrpc: "2.0",
          id: "devin-question",
          headers: [],
          method: "_session/elicitation",
          params: {
            sessionId: session.sessionId,
            mode: "form",
            message: "Proceed?",
            requestedSchema: { type: "object", properties: {} },
          },
        }),
      );
      const devinAnswer = yield* Queue.take(output).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(jsonRpcResponse(Schema.Unknown)))),
      );
      assert.deepEqual(devinAnswer.result, {
        action: { action: "accept", content: { branch: "main" } },
      });
      const completed = yield* Deferred.make<void>();
      yield* acp.handleElicitationComplete(() =>
        Deferred.succeed(completed, undefined).pipe(Effect.asVoid),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcNotification("session/elicitation/complete", Schema.Unknown), {
          jsonrpc: "2.0",
          method: "session/elicitation/complete",
          params: { elicitationId: "legacy-login" },
        }),
      );
      yield* Deferred.await(completed);

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
      yield* exchange(acp.agent.logout({}), "logout");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect.each([
    { shape: "v1", deleteCapability: {} },
    { shape: "v2", deleteCapability: {} },
    { shape: "v2", deleteCapability: undefined },
    { shape: "v2", deleteCapability: null },
  ])(
    "gates session/delete for $shape with delete=$deleteCapability",
    ({ shape, deleteCapability }) =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const scope = yield* Scope.make();
        const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));
        const deleteSession = acp.agent.deleteSession({ sessionId: "kiro-session-1" });

        const initializeFiber = yield* acp.agent
          .initialize({
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: { name: "effect-acp-test", version: "0.0.0" },
          })
          .pipe(Effect.forkScoped);
        const initializeRequest = yield* Queue.take(output).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(InitializeRequestV1))),
        );
        yield* Queue.offer(
          input,
          shape === "v1"
            ? yield* encodeJsonl(InitializeResponseV1, {
                jsonrpc: "2.0",
                id: initializeRequest.id,
                result: {
                  protocolVersion: 1,
                  agentInfo: { name: "kiro-acp", version: "0.0.0" },
                  agentCapabilities: {
                    sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} },
                  },
                },
              })
            : yield* encodeJsonl(InitializeResponse, {
                jsonrpc: "2.0",
                id: initializeRequest.id,
                result: {
                  protocolVersion: 2,
                  info: { name: "v2-agent", version: "0.0.0" },
                  capabilities: {
                    session: deleteCapability === undefined ? {} : { delete: deleteCapability },
                  },
                },
              }),
        );
        yield* Fiber.join(initializeFiber);

        const deleteFailed = yield* Deferred.make<AcpError.AcpError>();
        const deleteFiber = yield* deleteSession.pipe(
          Effect.tapError((error) => Deferred.succeed(deleteFailed, error)),
          Effect.forkScoped,
        );
        const outcome = yield* Effect.raceFirst(
          Queue.take(output).pipe(Effect.map((line) => ({ line }))),
          Deferred.await(deleteFailed).pipe(Effect.map((error) => ({ error }))),
        );
        if ("error" in outcome) {
          if (deleteCapability != null) {
            return yield* outcome.error;
          }
          assert.equal(outcome.error._tag, "AcpRequestError");
          assert.equal(
            outcome.error._tag === "AcpRequestError" ? outcome.error.code : undefined,
            -32601,
          );
          yield* Scope.close(scope, Exit.void);
          return;
        }
        assert.exists(deleteCapability, "session/delete reached transport without its capability");
        const deleteRequest = yield* Schema.decodeEffect(
          Schema.fromJsonString(jsonRpcRequest("session/delete", AcpSchemaV1.DeleteSessionRequest)),
        )(outcome.line);
        assert.equal(deleteRequest.params.sessionId, "kiro-session-1");
        yield* Queue.offer(
          input,
          yield* encodeJsonl(jsonRpcResponse(Schema.Unknown), {
            jsonrpc: "2.0",
            id: deleteRequest.id,
            result: {},
          }),
        );
        assert.deepEqual(yield* Fiber.join(deleteFiber), {});
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
          yield* Effect.forEach(["permission-a", "permission-b"], (id) =>
            encodeJsonl(PermissionRequest, {
              jsonrpc: "2.0",
              id,
              method: "session/request_permission",
              params: payload,
              headers: [],
            }),
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
});

