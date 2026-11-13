import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as AcpClient from "./client.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpError from "./errors.ts";
import type * as AcpCompat from "./compat.ts";
import type * as AcpProtocol from "./protocol.ts";
import {
  encodeJsonl,
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

  it.effect("transforms fragmented stdout before parsing and preserves UTF-8", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_STDOUT_PREFIX: `${mockStartupNotice}\n` });
      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        const initialized = yield* acp.agent.initialize({ protocolVersion: 1 });
        assert.equal(initialized.protocolVersion, 2);

        const echoed = yield* acp.raw.request("x/echo", { message: "café" });
        assert.deepEqual(echoed, {
          echoedMethod: "x/echo",
          echoedParams: { message: "café" },
        });
      }).pipe(
        Effect.provide(
          AcpClient.layerChildProcess(handle, {
            transformStdout: (stdout) =>
              stdout.pipe(
                Stream.flatMap((chunk) =>
                  Stream.fromIterable(Array.from(chunk, (byte) => Uint8Array.of(byte))),
                ),
                stripMockStartupNotice,
              ),
          }),
        ),
      );
    }),
  );

  it.effect("preserves stdout transform errors without logging rejected input", () =>
    Effect.gen(function* () {
      const privateNotice = "Mock sign-in URL: https://example.test/login?token=mock-private-token";
      const handle = yield* makeHandle({ ACP_MOCK_STDOUT_PREFIX: `${privateNotice}\n` });
      const termination = yield* Deferred.make<AcpError.AcpError>();
      const logs = yield* Ref.make<Array<unknown>>([]);
      const expectedError = new AcpError.AcpTransportError({
        operation: "read-input-stream",
        detail: "Sign in to the mock agent.",
        cause: undefined,
      });
      const error = yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        const failure = yield* acp.agent.initialize({ protocolVersion: 1 }).pipe(Effect.flip);
        assert.strictEqual(yield* Deferred.await(termination), expectedError);
        return failure;
      }).pipe(
        Effect.provide(
          AcpClient.layerChildProcess(handle, {
            logIncoming: true,
            logger: (event) => Ref.update(logs, (current) => [...current, event]),
            transformStdout: (stdout) =>
              stdout.pipe(
                Stream.decodeText,
                Stream.splitLines,
                Stream.mapEffect((line) =>
                  line === privateNotice ? Effect.fail(expectedError) : Effect.succeed(`${line}\n`),
                ),
                Stream.encodeText,
              ),
            onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
          }),
        ),
      );

      assert.strictEqual(error, expectedError);
      assert.isEmpty(yield* Ref.get(logs));
    }),
  );

  it.effect("retains only transformed session updates in raw notifications and handlers", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const delivered = yield* Deferred.make<import("./compat.ts").SessionNotification>();
      const imageData = "A".repeat(1_048_576);
      const normalized = {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Image data omitted." },
        },
      } satisfies import("./compat.ts").SessionNotification;
      let transformCalls = 0;
      const acp = yield* AcpClient.make(stdio, {
        transformSessionUpdate: (notification) => {
          if (
            notification.update.sessionUpdate !== "agent_message_chunk" ||
            notification.update.content.type !== "image"
          ) {
            return notification;
          }
          assert.equal(notification.update.content.data, imageData);
          transformCalls += 1;
          return normalized;
        },
      });
      yield* acp.handleSessionUpdate((notification) =>
        Deferred.succeed(delivered, notification).pipe(Effect.asVoid),
      );

      yield* Queue.offer(
        input,
        yield* encodeJsonl(SessionUpdateNotification, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "image", data: imageData, mimeType: "image/png" },
            },
          },
        }),
      );

      assert.strictEqual(yield* Deferred.await(delivered), normalized);
      const [retained] = yield* acp.raw.notifications.pipe(Stream.take(1), Stream.runCollect);
      assert.deepEqual(retained, {
        _tag: "SessionUpdate",
        method: "session/update",
        params: normalized,
      });
      assert.equal(transformCalls, 1);
    }),
  );

  it.effect("keeps the JSON-RPC error of a failed v2 idle", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const delivered = yield* Deferred.make<AcpCompat.SessionNotification>();
      const acp = yield* AcpClient.make(stdio);
      yield* acp.handleSessionUpdate((notification) =>
        Deferred.succeed(delivered, notification).pipe(Effect.asVoid),
      );
      const error = { code: -32000, message: "Please sign in to Claude", data: { retry: false } };
      const idle = {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "error",
        error,
      } as const;

      yield* Queue.offer(
        input,
        yield* encodeJsonl(SessionUpdateNotification, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: idle,
          },
        }),
      );

      const { update } = yield* Deferred.await(delivered);
      assert.deepEqual(
        update.sessionUpdate === "state_update" && update.state === "idle" ? update : undefined,
        idle,
      );
    }),
  );

  it.effect("reports idle child termination and rejects later requests and notifications", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle();
      const termination = yield* Deferred.make<AcpError.AcpError>();
      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        yield* acp.agent.initialize({ protocolVersion: 1 });
        yield* handle.kill();

        const error = yield* Deferred.await(termination);
        if (error._tag !== "AcpProcessExitedError") {
          return assert.fail(`Expected a process exit, got ${error._tag}`);
        }
        assert.equal(error.pid, handle.pid);
        assert.equal(error.code, yield* handle.exitCode);
        const rawRequestError = yield* acp.raw.request("x/echo", {}).pipe(
          Effect.match({
            onFailure: (failure) => failure,
            onSuccess: () => assert.fail("Expected the request to fail after process exit"),
          }),
        );
        assert.strictEqual(rawRequestError, error);
        assert.strictEqual(yield* acp.raw.notify("x/notify", {}).pipe(Effect.flip), error);
        assert.strictEqual(
          yield* acp.agent.cancel({ sessionId: "mock-session-1" }).pipe(Effect.flip),
          error,
        );

        const requestError = yield* acp.agent
          .createSession({ cwd: process.cwd(), mcpServers: [] })
          .pipe(Effect.flip);
        assert.strictEqual(requestError, error);
      }).pipe(
        Effect.provide(
          AcpClient.layerChildProcess(handle, {
            onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
          }),
        ),
      );
    }),
  );

  it.effect("initializes, prompts, receives updates, and handles permission requests", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<Array<unknown>>([]);
      const elicitationCompletions = yield* Ref.make<Array<unknown>>([]);
      const typedRequests = yield* Ref.make<Array<unknown>>([]);
      const typedNotifications = yield* Ref.make<Array<unknown>>([]);
      const requestContexts = yield* Ref.make<Array<AcpProtocol.AcpRequestContext>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const layerAcp = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerAcp, scope);

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
        // ACP v2 removed session/set_mode; modes are config options there.
        const setMode = yield* acp.agent
          .setSessionMode({ sessionId: session.sessionId, modeId: "code" })
          .pipe(Effect.flip);
        assert.equal(setMode._tag === "AcpRequestError" ? setMode.code : undefined, -32601);

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
        const layerAcp = AcpClient.layerChildProcess(handle);
        const context = yield* Layer.buildWithScope(layerAcp, scope);

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

  it.effect("does not turn unsupported ACP v2 auth methods into agent login", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_CUSTOM_AUTH: "1" });
      const response = yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        return yield* acp.agent.initialize({ protocolVersion: 2 });
      }).pipe(Effect.provide(AcpClient.layerChildProcess(handle)));
      assert.deepEqual(response.authMethods, []);
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
      const layerAcp = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(layerAcp, scope);

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

  it.effect("keeps RPC ids within int32 and apart from extension ids", () =>
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
      // Keep locally generated ids compatible with SDKs that decode signed int32.
      assert.typeOf(initializeRequest.id, "number");
      assert.equal(initializeRequest.id, 2 ** 30);
      assert.isAtMost(Number(initializeRequest.id), 2 ** 31 - 1);
      assert.equal(extRequest.id, 1);

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

      const sessionFiber = yield* acp.agent
        .createSession({ cwd: "/tmp", mcpServers: [] })
        .pipe(Effect.forkScoped);
      const sessionRequest = yield* Schema.decodeEffect(
        Schema.fromJsonString(jsonRpcRequest("session/new", AcpSchema.NewSessionRequest)),
      )(yield* Queue.take(output));
      assert.equal(sessionRequest.id, 2 ** 30 + 1);
      yield* Queue.offer(
        input,
        yield* encodeJsonl(jsonRpcResponse(AcpSchema.NewSessionResponse), {
          jsonrpc: "2.0",
          id: sessionRequest.id,
          result: { sessionId: "session-1" },
        }),
      );
      assert.equal((yield* Fiber.join(sessionFiber)).sessionId, "session-1");
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
