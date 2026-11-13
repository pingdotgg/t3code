import * as Path from "effect/Path";
import * as AcpError from "./errors.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { it, assert, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AcpSchema from "./schema.ts";
import * as AcpProtocol from "./protocol.ts";
import {
  encodeJsonl,
  jsonRpcNotification,
  jsonRpcRequest,
  jsonRpcResponse,
} from "./_internal/shared.ts";
import { makeInMemoryStdio, makeTerminationError, makeChildStdio } from "./_internal/stdio.ts";
import { ElicitationCompleteNotification, ExtRequest, ExtResponse, JsonRpcErrorResponse, RequestPermissionRequest, RequestPermissionResponse, SessionCancelNotification, SessionUpdateNotification, decodeExtRequest, decodeRequestPermissionResponse, decodeSessionCancelNotification, encodeUnknownJsonString, encoder, makeHandle, mockPeerArgs, mockPeerPath } from "./protocol.helpers2.testkit.ts";

it.layer(NodeServices.layer)("effect-acp protocol", (it) => {
  it.effect(
    "emits exact JSON-RPC notifications and decodes inbound session/update and elicitation completion",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
        });

        const notifications =
          yield* Deferred.make<ReadonlyArray<AcpProtocol.AcpIncomingNotification>>();
        yield* transport.incoming.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.flatMap((notificationChunk) => Deferred.succeed(notifications, notificationChunk)),
          Effect.forkScoped,
        );

        yield* transport.notify("session/cancel", { sessionId: "session-1" });
        const outbound = yield* Queue.take(output);
        assert.deepEqual(yield* decodeSessionCancelNotification(outbound), {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId: "session-1",
          },
        });

        const updateFrame = yield* encodeJsonl(SessionUpdateNotification, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "plan",
              entries: [
                {
                  content: "Inspect repository",
                  priority: "high",
                  status: "in_progress",
                },
              ],
            },
          },
        });
        const completionFrame = yield* encodeJsonl(ElicitationCompleteNotification, {
          jsonrpc: "2.0",
          method: "elicitation/complete",
          params: {
            elicitationId: "elicitation-1",
          },
        });

        // Frames split across reads, with one read ending one frame and starting the next.
        const wire = new Uint8Array([...updateFrame, ...completionFrame]);
        const splits = [10, updateFrame.length + 10, wire.length];
        let start = 0;
        for (const end of splits) {
          yield* Queue.offer(input, wire.subarray(start, end));
          start = end;
        }

        const [update, completion] = yield* Deferred.await(notifications);
        assert.equal(update?._tag, "SessionUpdate");
        assert.equal(completion?._tag, "ElicitationComplete");
      }),
  );

  // clanka once sent a usage_update without `used` and `size`. One bad update
  // must not end a session whose later updates are fine.
  it.effect("drops a session/update that fails to decode and keeps reading", () =>
    Effect.gen(function* () {
      const secret = "acp-core-notification-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const warnings: Array<unknown> = [];
      let terminated = false;
      let transformCalls = 0;
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logIncoming: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        transformSessionUpdate: (notification) => {
          transformCalls += 1;
          return notification;
        },
        onTermination: () =>
          Effect.sync(() => {
            terminated = true;
          }),
      }).pipe(
        Effect.provide(
          Logger.layer([
            Logger.make(({ logLevel, fiber }) => {
              if (logLevel === "Warn")
                warnings.push(fiber.getRef(References.CurrentLogAnnotations));
            }),
          ]),
        ),
      );
      const received = yield* Deferred.make<AcpProtocol.AcpIncomingNotification>();
      yield* transport.incoming.pipe(
        Stream.runForEach((notification) => Deferred.succeed(received, notification)),
        Effect.forkScoped,
      );

      const send = (params: unknown) =>
        Queue.offer(
          input,
          encoder.encode(
            `${encodeUnknownJsonString({ jsonrpc: "2.0", method: "session/update", params })}\n`,
          ),
        );
      const malformed = {
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", cost: { amount: 1, currency: secret } },
      };
      yield* send(malformed);
      yield* send(malformed);
      yield* send({
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", used: 10, size: 100 },
      });

      const notification = yield* TestClock.withLive(
        Deferred.await(received).pipe(Effect.timeout("2 seconds")),
      );
      assert.equal(notification._tag, "SessionUpdate");
      assert.deepEqual(notification.params, {
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", used: 10, size: 100 },
      });
      assert.isFalse(terminated);
      assert.equal(transformCalls, 1);

      const decodeFailed = events.find(({ stage }) => stage === "decode_failed");
      expect(decodeFailed?.payload).toMatchObject({
        operation: "decode-notification-payload",
        method: "session/update",
        issueSummary: expect.stringContaining("update.used missing"),
      });
      assert.lengthOf(
        events.filter(({ stage }) => stage === "decode_failed"),
        2,
      );
      assert.lengthOf(warnings, 1);
      expect(warnings[0]).toMatchObject({
        issueSummary: expect.stringContaining("update.used missing"),
      });
      assert.notInclude(encodeUnknownJsonString({ decodeFailed, warnings }), secret);
    }),
  );

  it.effect("terminates when a callback on the reader dies", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<AcpError.AcpError>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        transformSessionUpdate: () => {
          throw new Error("normalizer bug");
        },
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encoder.encode(
          `${encodeUnknownJsonString({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-1",
              update: { sessionUpdate: "plan", entries: [] },
            },
          })}\n`,
        ),
      );

      const error = yield* TestClock.withLive(
        Deferred.await(termination).pipe(Effect.timeout("2 seconds")),
      );
      assert.instanceOf(error, AcpError.AcpTransportError);
      assert.equal((error as AcpError.AcpTransportError).operation, "read-input-stream");
    }),
  );

  // regression: #9154 notifications went out with `id` and `headers`, which Grok CLI drops
  it.effect("logs outgoing notifications when logOutgoing is enabled", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logOutgoing: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      yield* transport.notify("session/cancel", { sessionId: "session-1" });

      // A notification must not carry `id` or `headers`. Grok CLI drops frames that do.
      assert.deepEqual(events, [
        {
          direction: "outgoing",
          stage: "decoded",
          payload: {
            _tag: "Notification",
            tag: "session/cancel",
            payload: {
              sessionId: "session-1",
            },
          },
        },
        {
          direction: "outgoing",
          stage: "raw",
          payload:
            '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session-1"}}\n',
        },
      ]);
    }),
  );

  it.effect("logs decode failures without copying the cause or wire payload", () =>
    Effect.gen(function* () {
      const secret = "acp-wire-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const termination = yield* Deferred.make<AcpError.AcpError>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logIncoming: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(input, encoder.encode(`{"secret":"${secret}"\n`));
      yield* Deferred.await(termination);

      const event = events.find(({ stage }) => stage === "decode_failed");
      assert.deepEqual(event, {
        direction: "incoming",
        stage: "decode_failed",
        payload: {
          operation: "decode-wire-message",
        },
      });
      assert.notInclude(encodeUnknownJsonString(event), secret);
    }),
  );

  it.effect("fails notification encoding through the declared ACP error channel", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, AcpError.AcpProtocolParseError);
      assert.equal(bigintError.operation, "encode-message");
      assert.equal(bigintError.method, "x/test");
      assert.isDefined(bigintError.cause);
      assert.equal(
        bigintError.message,
        "ACP protocol operation 'encode-message' failed for method 'x/test'.",
      );

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, AcpError.AcpProtocolParseError);
      assert.equal(circularError.operation, "encode-message");
      assert.equal(circularError.method, "x/test");
      assert.isDefined(circularError.cause);

      const requestError = yield* transport.request("x/request", 1n).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected request encoding to fail"),
        }),
      );
      assert.instanceOf(requestError, AcpError.AcpProtocolParseError);
      assert.deepInclude(requestError, {
        operation: "encode-message",
        method: "x/request",
        requestId: 1,
      });
    }),
  );

  it.effect("does not correlate a string response id with a numeric extension request id", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encoder.encode(
          `${encodeUnknownJsonString({
            jsonrpc: "2.0",
            id: "1",
            result: { ok: false },
          })}\n`,
        ),
      );
      yield* Effect.yieldNow;
      assert.isUndefined(response.pollUnsafe());

      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: 1,
          result: { ok: true },
        }),
      );
      assert.deepEqual(yield* Fiber.join(response), { ok: true });
    }),
  );

  it.effect("correlates extension response errors with the originating request", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const response = yield* transport
        .request("x/private", { hello: "world" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encoder.encode(
          `${encodeUnknownJsonString({
            jsonrpc: "2.0",
            id: 1,
            error: {
              _tag: "Cause",
              code: -32602,
              message: "Invalid params",
              data: [
                {
                  _tag: "Fail",
                  error: {
                    code: -32602,
                    message: "Invalid params",
                    data: { field: "hello" },
                  },
                },
              ],
            },
          })}\n`,
        ),
      );

      const error = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected extension request to fail"),
        }),
      );
      assert.instanceOf(error, AcpError.AcpRequestError);
      assert.deepInclude(error, {
        code: -32602,
        errorMessage: "Invalid params",
        method: "x/private",
        requestId: 1,
        operation: "receive-response",
      });
    }),
  );

  it.effect("answers an extension request whose handler also dies as an internal error", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onExtRequest: () =>
          Effect.fail(AcpError.AcpRequestError.invalidParams("bad params")).pipe(
            Effect.ensuring(Effect.die(new Error("cleanup bug"))),
          ),
      });

      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtRequest, {
          jsonrpc: "2.0",
          id: 9,
          method: "x/test",
          params: { hello: "world" },
          headers: [],
        }),
      );
      const decodeJsonRpcErrorResponse = Schema.decodeEffect(
        Schema.fromJsonString(JsonRpcErrorResponse),
      );

      const response = yield* decodeJsonRpcErrorResponse(yield* Queue.take(output));
      assert.equal(response.id, 9);
      assert.equal(response.error.code, -32603);
    }),
  );

  it.effect("preserves zero-valued ids for inbound core client requests", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(["session/request_permission"]),
      });
      const inboundRequest = yield* Deferred.make<unknown>();

      yield* transport.serverProtocol
        .run((_clientId, message) => Deferred.succeed(inboundRequest, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      yield* Queue.offer(
        input,
        yield* encodeJsonl(RequestPermissionRequest, {
          jsonrpc: "2.0",
          id: 0,
          method: "session/request_permission",
          params: {
            sessionId: "session-1",
            title: "Allow mock action",
            subject: {
              type: "tool_call",
              toolCall: {
                toolCallId: "tool-1",
                title: "Allow mock action",
              },
            },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
          headers: [],
        }),
      );

      const message = yield* Deferred.await(inboundRequest);
      assert.deepEqual(message, {
        _tag: "Request",
        id: 0,
        tag: "session/request_permission",
        payload: {
          sessionId: "session-1",
          title: "Allow mock action",
          subject: {
            type: "tool_call",
            toolCall: {
              toolCallId: "tool-1",
              title: "Allow mock action",
            },
          },
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        headers: [],
      });

      yield* transport.serverProtocol.send(0, {
        _tag: "Exit",
        requestId: 0,
        exit: {
          _tag: "Success",
          value: {
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          },
        },
      });

      const outbound = yield* Queue.take(output);
      assert.deepEqual(yield* decodeRequestPermissionResponse(outbound), {
        jsonrpc: "2.0",
        id: 0,
        result: {
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        },
      });
    }),
  );
});

