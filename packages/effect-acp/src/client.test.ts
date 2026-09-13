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
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";

import * as AcpClient from "./client.ts";
import * as AcpSchema from "./_generated/schema.gen.ts";
import * as AcpError from "./errors.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const InitializeRequest = jsonRpcRequest("initialize", AcpSchema.InitializeRequest);
const InitializeResponse = jsonRpcResponse(AcpSchema.InitializeResponse);
const ExtRequest = jsonRpcRequest("x/test", Schema.Struct({ hello: Schema.String }));
const ExtResponse = jsonRpcResponse(Schema.Struct({ ok: Schema.Boolean }));
const PromptRequest = jsonRpcRequest("session/prompt", AcpSchema.PromptRequest);
const PromptResponse = jsonRpcResponse(AcpSchema.PromptResponse);
const SessionUpdateNotification = jsonRpcNotification(
  "session/update",
  AcpSchema.SessionNotification,
);
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
const mockStartupNotice = "Mock ACP startup notice";
const stripMockStartupNotice = (stdout: ChildProcessSpawner.ChildProcessHandle["stdout"]) =>
  stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line !== mockStartupNotice),
    Stream.map((line) => `${line}\n`),
    Stream.encodeText,
  );

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

  it.effect("transforms fragmented stdout before parsing and preserves UTF-8", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_STDOUT_PREFIX: `${mockStartupNotice}\n` });
      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;
        const initialized = yield* acp.agent.initialize({ protocolVersion: 1 });
        assert.equal(initialized.protocolVersion, 1);

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

  it.effect("reports malformed JSON that remains after a stdout transform", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        ACP_MOCK_STDOUT_PREFIX: `${mockStartupNotice}\n`,
        ACP_MOCK_MALFORMED_OUTPUT: "1",
      });
      const termination = yield* Deferred.make<AcpError.AcpError>();
      const error = yield* Deferred.await(termination).pipe(
        Effect.provide(
          AcpClient.layerChildProcess(handle, {
            transformStdout: stripMockStartupNotice,
            onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
          }),
        ),
      );

      if (error._tag !== "AcpProtocolParseError") {
        return assert.fail(`Expected a parse error, got ${error._tag}`);
      }
      assert.equal(error.operation, "decode-wire-message");
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
      const delivered = yield* Deferred.make<AcpSchema.SessionNotification>();
      const imageData = "A".repeat(1_048_576);
      const normalized = {
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Image data omitted." },
        },
      } satisfies AcpSchema.SessionNotification;
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
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const acpLayer = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(acpLayer, scope);

      const ext = yield* Effect.gen(function* () {
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
            action: {
              action: "accept",
              content: {
                approved: true,
              },
            },
          }),
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
        assert.equal(init.protocolVersion, 1);

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
        assert.equal((yield* Ref.get(updates)).length, 1);
        assert.equal((yield* Ref.get(elicitationCompletions)).length, 1);
        assert.deepEqual(yield* Ref.get(typedRequests), [{ message: "hello from typed request" }]);
        assert.deepEqual(yield* Ref.get(typedNotifications), [{ count: 2 }]);

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
              action: {
                action: "accept",
                content: {
                  approved: true,
                },
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
            action: {
              action: "accept",
              content: {
                approved: true,
              },
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

        assert.equal((yield* Ref.get(updates)).length, 1);
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
            action: {
              action: "accept",
              content: {
                approved: true,
              },
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

        assert.equal(yield* Ref.get(successfulHandlers), 1);
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
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: {
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
              result: {
                stopReason: "end_turn",
                _meta: {
                  sessionId: "grok-session-1",
                  requestId: "prompt-1",
                  promptId: "prompt-1",
                  modelId: "grok-composer-2.5-fast",
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
});
