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

  it.effect("acknowledges outgoing responses and reports encoding failures by request id", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const acknowledged = yield* Deferred.make<string>();
      const failed = yield* Deferred.make<readonly [string, AcpError.AcpError]>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onOutgoingResponse: (requestId) =>
          Deferred.succeed(acknowledged, requestId).pipe(Effect.asVoid),
        onOutgoingResponseFailure: (requestId, error) =>
          Deferred.succeed(failed, [requestId, error]).pipe(Effect.asVoid),
      });

      yield* transport.serverProtocol.send(0, {
        _tag: "Exit",
        requestId: "success-1",
        exit: { _tag: "Success", value: { ok: true } },
      });
      assert.equal(yield* Deferred.await(acknowledged), "success-1");

      const circular: { self?: unknown } = {};
      circular.self = circular;
      yield* transport.serverProtocol
        .send(0, {
          _tag: "Exit",
          requestId: "failure-1",
          exit: { _tag: "Success", value: circular },
        })
        .pipe(Effect.exit);
      const [requestId, error] = yield* Deferred.await(failed);
      assert.equal(requestId, "failure-1");
      assert.instanceOf(error, AcpError.AcpProtocolParseError);
    }),
  );

  it.effect("acknowledges a response only after the stdout write completes", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>();
      const releaseWrite = yield* Deferred.make<void>();
      const acknowledged = yield* Deferred.make<string>();
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.never,
        stdout: () =>
          Sink.forEach(() =>
            Deferred.succeed(writeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseWrite)),
            ),
          ),
        stderr: () => Sink.drain,
      });
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onOutgoingResponse: (requestId) =>
          Deferred.succeed(acknowledged, requestId).pipe(Effect.asVoid),
      });
      const sendFiber = yield* transport.serverProtocol
        .send(0, {
          _tag: "Exit",
          requestId: "held-write",
          exit: { _tag: "Success", value: { ok: true } },
        })
        .pipe(Effect.forkScoped);

      yield* Deferred.await(writeStarted);
      assert.isUndefined(sendFiber.pollUnsafe());
      assert.isFalse(yield* Deferred.isDone(acknowledged));
      yield* Deferred.succeed(releaseWrite, undefined);
      yield* Fiber.join(sendFiber);
      assert.equal(yield* Deferred.await(acknowledged), "held-write");
    }),
  );

  it.effect("fails current, queued, and future responses when the stdout writer fails", () =>
    Effect.gen(function* () {
      const writeStarted = yield* Deferred.make<void>();
      const releaseFailure = yield* Deferred.make<void>();
      const failures = yield* Queue.unbounded<string>();
      const terminated = yield* Deferred.make<AcpError.AcpError>();
      const stdio = Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.never,
        stdout: () =>
          Sink.forEach(() =>
            Deferred.succeed(writeStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFailure)),
              Effect.andThen(Effect.die("stdout failed")),
            ),
          ),
        stderr: () => Sink.drain,
      });
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onOutgoingResponseFailure: (requestId) => Queue.offer(failures, requestId),
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
      });
      const send = (requestId: string) =>
        transport.serverProtocol
          .send(0, {
            _tag: "Exit",
            requestId,
            exit: { _tag: "Success", value: { ok: true } },
          })
          .pipe(Effect.exit);
      const current = yield* send("current").pipe(Effect.forkScoped);
      yield* Deferred.await(writeStarted);
      const queued = yield* send("queued").pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(current.pollUnsafe());
      assert.isUndefined(queued.pollUnsafe());
      yield* Deferred.succeed(releaseFailure, undefined);
      assert.instanceOf(yield* Deferred.await(terminated), AcpError.AcpTransportError);
      yield* Fiber.join(current);
      yield* Fiber.join(queued);
      yield* send("future");

      assert.deepEqual(
        new Set(yield* Queue.takeN(failures, 3)),
        new Set(["current", "queued", "future"]),
      );
    }),
  );

  it.effect(
    "atomically rejects an admitted response when the writer closes before queue offer",
    () =>
      Effect.gen(function* () {
        const admitted = yield* Deferred.make<void>();
        const releaseAdmission = yield* Deferred.make<void>();
        const failures = yield* Queue.unbounded<string>();
        const protocolScope = yield* Scope.make();
        const stdio = Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.never,
          stdout: () => Sink.drain,
          stderr: () => Sink.drain,
        });
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
          onOutgoingResponseFailure: (requestId) => Queue.offer(failures, requestId),
          testHooks: {
            onOutgoingWriteAdmitted: () =>
              Deferred.succeed(admitted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseAdmission)),
              ),
          },
        }).pipe(Effect.provideService(Scope.Scope, protocolScope));
        const send = (requestId: string) =>
          transport.serverProtocol
            .send(0, {
              _tag: "Exit",
              requestId,
              exit: { _tag: "Success", value: { ok: true } },
            })
            .pipe(Effect.exit);
        const admittedSend = yield* send("admitted").pipe(Effect.forkScoped);

        yield* Deferred.await(admitted);
        yield* Scope.close(protocolScope, Exit.void);
        yield* Deferred.succeed(releaseAdmission, undefined);
        yield* Fiber.join(admittedSend);
        yield* send("future");

        assert.deepEqual(yield* Queue.takeN(failures, 2), ["admitted", "future"]);
      }),
  );

  it.effect("drops agent-internal JSON-RPC responses with non-numeric request ids", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const notifications =
        yield* Deferred.make<ReadonlyArray<AcpProtocol.AcpIncomingNotification>>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      yield* transport.incoming.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.flatMap((notificationChunk) => Deferred.succeed(notifications, notificationChunk)),
        Effect.forkScoped,
      );

      yield* Queue.offer(
        input,
        encoder.encode(
          `${encodeUnknownJsonString({
            jsonrpc: "2.0",
            id: "skills-reload",
            result: {
              reloaded: true,
            },
          })}\n`,
        ),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(SessionUpdateNotification, {
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "plan",
              entries: [
                {
                  content: "Reload skills",
                  priority: "high",
                  status: "in_progress",
                },
              ],
            },
          },
        }),
      );

      const [update] = yield* Deferred.await(notifications);
      assert.equal(update?._tag, "SessionUpdate");
    }),
  );

  it.effect("cleans up interrupted extension requests before a late response arrives", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const lateResponse = yield* Deferred.make<unknown>();

      yield* transport.clientProtocol
        .run(0, (message) => Deferred.succeed(lateResponse, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      const response = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      const outbound = yield* Queue.take(output);
      assert.deepEqual(yield* decodeExtRequest(outbound), {
        jsonrpc: "2.0",
        id: 1,
        method: "x/test",
        params: {
          hello: "world",
        },
        headers: [],
      });

      yield* Fiber.interrupt(response);
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: 1,
          result: {
            ok: true,
          },
        }),
      );

      const message = yield* Deferred.await(lateResponse);
      assert.deepEqual(message, {
        _tag: "Exit",
        requestId: 1,
        exit: {
          _tag: "Success",
          value: {
            ok: true,
          },
        },
      });
    }),
  );

  it.effect("fails pending and later requests when input ends before the process exits", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<AcpError.AcpError>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        terminationError: Effect.never,
        serverRequestMethods: new Set(),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });
      const pending = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.flip, Effect.orDie, Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(input, encoder.encode('{"jsonrpc":"2.0","id":1,"result":'));
      yield* Queue.end(input);

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, AcpError.AcpInputStreamEndedError);
      assert.strictEqual(yield* Fiber.join(pending), error);
      assert.strictEqual(
        yield* transport.request("x/test", { hello: "later" }).pipe(Effect.flip, Effect.orDie),
        error,
      );
      assert.strictEqual(
        yield* transport.notify("session/cancel", { sessionId: "session-1" }).pipe(Effect.flip),
        error,
      );
    }),
  );

  it.effect("answers a pending request from a final response without a trailing newline", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });
      const pending = yield* transport
        .request("x/test", { hello: "world" })
        .pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encoder.encode(encodeUnknownJsonString({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
      );
      yield* Queue.end(input);

      assert.deepEqual(yield* Fiber.join(pending), { ok: true });
    }),
  );

  it.effect("propagates the real child exit code when the input stream ends", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({ ACP_MOCK_EXIT_IMMEDIATELY_CODE: "7" });
      const firstMessage = yield* Deferred.make<unknown>();
      const termination = yield* Deferred.make<AcpError.AcpError>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio: makeChildStdio(handle),
        terminationError: makeTerminationError(handle),
        serverRequestMethods: new Set(),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* transport.clientProtocol
        .run(0, (message) => Deferred.succeed(firstMessage, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      const message = yield* Deferred.await(firstMessage);
      const exitError = yield* Deferred.await(termination);
      assert.instanceOf(exitError, AcpError.AcpProcessExitedError);
      assert.equal((exitError as AcpError.AcpProcessExitedError).code, 7);
      assert.equal((message as { readonly _tag?: string })._tag, "ClientProtocolError");
      const defect = (message as { readonly error: { readonly reason: unknown } }).error.reason as {
        readonly _tag: string;
        readonly message: string;
        readonly cause: unknown;
      };
      assert.equal(defect._tag, "RpcClientDefect");
      assert.equal(defect.message, "ACP protocol terminated.");
      assert.instanceOf(defect.cause, AcpError.AcpProcessExitedError);
      assert.equal((defect.cause as AcpError.AcpProcessExitedError).code, 7);
    }),
  );

  it.effect("does not treat intentional serverProtocol.end as a transport failure", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const terminations = yield* Ref.make(0);
      const writerExit = yield* Deferred.make<{ readonly intentionalEnd: boolean }>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onTermination: () => Ref.update(terminations, (count) => count + 1),
        testHooks: {
          onOutgoingWriterExit: (detail) =>
            Deferred.succeed(writerExit, detail).pipe(Effect.asVoid),
        },
      });

      yield* transport.serverProtocol.end(0);
      const exitDetail = yield* Deferred.await(writerExit);
      assert.isTrue(exitDetail.intentionalEnd);
      assert.equal(yield* Ref.get(terminations), 0);

      yield* Queue.end(input);
    }),
  );

  it.effect("does not emit a second process-exit error after a decode failure", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        ACP_MOCK_MALFORMED_OUTPUT: "1",
        ACP_MOCK_MALFORMED_OUTPUT_EXIT_CODE: "23",
      });
      const terminationCalls = yield* Ref.make(0);
      const firstMessage = yield* Deferred.make<unknown>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio: makeChildStdio(handle),
        terminationError: makeTerminationError(handle),
        serverRequestMethods: new Set(),
        onTermination: () => Ref.update(terminationCalls, (count) => count + 1),
      });

      yield* transport.clientProtocol
        .run(0, (message) => Deferred.succeed(firstMessage, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      const message = yield* Deferred.await(firstMessage);
      assert.equal(yield* Ref.get(terminationCalls), 1);
      assert.equal((message as { readonly _tag?: string })._tag, "ClientProtocolError");
      const defect = (message as { readonly error: { readonly reason: unknown } }).error.reason as {
        readonly _tag: string;
        readonly message: string;
        readonly cause: unknown;
      };
      assert.equal(defect._tag, "RpcClientDefect");
      assert.equal(defect.message, "ACP protocol terminated.");
      assert.instanceOf(defect.cause, AcpError.AcpProtocolParseError);
    }),
  );

  it.effect.each(["request", "notification"] as const)(
    "rejects a %s if the connection ends while its logger is running",
    (operation) =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const writeStarted = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const terminated = yield* Deferred.make<AcpError.AcpError>();
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
          logOutgoing: true,
          logger: (event) =>
            event.stage === "raw"
              ? Deferred.succeed(writeStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseWrite)),
                )
              : Effect.void,
          onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
        });
        const send = yield* (
          operation === "request"
            ? transport.request("x/test", { hello: "world" })
            : transport.notify("session/cancel", { sessionId: "session-1" })
        ).pipe(Effect.forkScoped);

        yield* Deferred.await(writeStarted);
        yield* Queue.end(input);
        const error = yield* Deferred.await(terminated);
        yield* Deferred.succeed(releaseWrite, undefined);

        const failure = yield* Fiber.join(send).pipe(
          Effect.match({
            onFailure: (failure) => failure,
            onSuccess: () => assert.fail("Expected the send to fail after termination"),
          }),
        );
        assert.strictEqual(failure, error);
        assert.equal(yield* Queue.size(output), 0);
      }),
  );
});
