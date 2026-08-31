import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  DROID_SESSION_REQUEST_TIMEOUT_MS,
  DroidRpcError,
  makeDroidRpcProtocol,
} from "./DroidRpcProtocol.ts";

const envelope = (message: Record<string, unknown>) =>
  JSON.stringify({
    jsonrpc: "2.0",
    factoryApiVersion: "1.0.0",
    factoryProtocolVersion: "1.187.0",
    ...message,
  });
const response = (id: string, result: unknown) => envelope({ type: "response", id, result });
const notification = (value: Record<string, unknown>, sessionId = "session-1") =>
  envelope({
    type: "notification",
    method: "droid.session_notification",
    params: { sessionId, notification: value },
  });
const assistantDelta = (messageId: string, textDelta = "hello") => ({
  type: "assistant_text_delta",
  messageId,
  blockIndex: 0,
  textDelta,
});
const question = {
  index: 0,
  topic: "Scope",
  question: "Which scope?",
  options: ["workspace"],
};
const askRequest = (index: number) =>
  envelope({
    type: "request",
    id: `ask-${index}`,
    method: "droid.ask_user",
    params: {
      toolCallId: `tool-${index}`,
      questions: [question],
    },
  });
const take = <A>(stream: Stream.Stream<A>) =>
  Stream.runHead(stream).pipe(
    Effect.map((result) => {
      assert.isTrue(Option.isSome(result));
      if (Option.isNone(result)) throw new Error("stream ended");
      return result.value;
    }),
  );
const parse = (encoded: string) =>
  JSON.parse(encoded) as {
    readonly id: string;
    readonly jsonrpc: string;
    readonly factoryApiVersion: string;
    readonly factoryProtocolVersion: string;
    readonly type: string;
    readonly result?: unknown;
  };
const pendingRequest = (
  method = "droid.list_models",
  timeoutMs: number | undefined | "default" = undefined,
) =>
  Effect.gen(function* () {
    const protocol = yield* makeDroidRpcProtocol();
    const effect =
      timeoutMs === "default"
        ? protocol.request(method, {})
        : protocol.request(method, {}, { timeoutMs });
    const fiber = yield* effect.pipe(Effect.forkChild({ startImmediately: true }));
    const request = parse(yield* take(protocol.outgoing));
    return { fiber, protocol, request };
  });

describe("DroidRpcProtocol", () => {
  it.effect("emits strict Factory requests with string ids and the shared timeout", () =>
    Effect.gen(function* () {
      const { fiber, protocol, request } = yield* pendingRequest("droid.list_models", "default");
      assert.equal(
        [
          request.jsonrpc,
          request.factoryApiVersion,
          request.factoryProtocolVersion,
          request.type,
          typeof request.id,
        ].join("|"),
        "2.0|1.0.0|1.187.0|request|string",
      );
      assert.equal(DROID_SESSION_REQUEST_TIMEOUT_MS, 75_000);
      yield* protocol.acceptChunk(`${response(request.id, { models: [] })}\n`);
      assert.deepStrictEqual(yield* Fiber.join(fiber), { models: [] });
    }),
  );

  it.effect("rejects loose envelopes and non-authoritative response variants", () =>
    Effect.gen(function* () {
      const { fiber, protocol, request } = yield* pendingRequest();
      const metadata = {
        jsonrpc: "2.0",
        factoryApiVersion: "1.0.0",
        factoryProtocolVersion: "1.187.0",
        type: "response",
      };
      yield* protocol.acceptChunk(
        `${[
          { type: "response", id: request.id, result: { invalid: "missing metadata" } },
          { ...metadata, id: 1, result: { invalid: "numeric id" } },
          { ...metadata, id: request.id },
          {
            ...metadata,
            id: request.id,
            result: {},
            error: { code: -32603, message: "both variants" },
          },
        ]
          .map((value) => JSON.stringify(value))
          .join("\n")}\n`,
      );
      yield* protocol.acceptChunk(`${response(request.id, { accepted: true })}\n`);
      assert.deepStrictEqual(yield* Fiber.join(fiber), { accepted: true });
    }),
  );

  it.effect("logs structural diagnostics for malformed Droid frames", () => {
    const logs: Array<{
      readonly message: string;
      readonly details: object;
    }> = [];
    const logger = Logger.make(({ message }) => {
      const parts = Array.isArray(message) ? message : [message];
      const details = typeof parts[1] === "object" && parts[1] !== null ? parts[1] : {};
      logs.push({
        message: String(parts[0]),
        details,
      });
    });
    return Effect.gen(function* () {
      const protocol = yield* makeDroidRpcProtocol();
      const secretFrame = "not-json credential=secret-value";

      yield* protocol.acceptChunk(`${secretFrame}\n`);

      const diagnostic = logs.find(
        (entry) => entry.message === "Unable to parse Droid JSON-RPC line",
      );
      assert.isDefined(diagnostic);
      assert.deepInclude(diagnostic?.details, {
        lineBytes: new TextEncoder().encode(secretFrame).byteLength,
        errorTag: "SchemaError",
      });
      assert.notProperty(diagnostic?.details, "line");
      assert.notProperty(diagnostic?.details, "cause");
      const loggedText = [
        diagnostic?.message,
        ...Object.values(diagnostic?.details ?? {}).filter(
          (value): value is string => typeof value === "string",
        ),
      ].join(" ");
      assert.notInclude(loggedText, secretFrame);
      assert.notInclude(loggedText, "secret-value");
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("decodes strict failure responses", () =>
    Effect.gen(function* () {
      const { fiber, protocol, request } = yield* pendingRequest();
      yield* protocol.acceptChunk(
        `${envelope({
          type: "response",
          id: request.id,
          error: { code: -32004, message: "not found", data: { sessionId: "missing" } },
        })}\n`,
      );
      const result = yield* Effect.result(Fiber.join(fiber));
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.kind, "rpc");
        assert.equal(result.failure.code, -32004);
        assert.deepStrictEqual(result.failure.data, { sessionId: "missing" });
      }
    }),
  );

  it.effect("assembles fragments, CR delimiters, and a final remainder exactly once", () =>
    Effect.gen(function* () {
      const { fiber, protocol, request } = yield* pendingRequest();
      const encoded = response(request.id, { complete: true });
      const splitAt = Math.floor(encoded.length / 2);
      yield* protocol.acceptChunk(encoded.slice(0, splitAt));
      yield* protocol.acceptChunk(
        `${encoded.slice(splitAt)}\r${notification(assistantDelta("after-cr"))}\r\n`,
      );
      assert.deepStrictEqual(yield* Fiber.join(fiber), { complete: true });
      const first = yield* take(protocol.notifications);
      assert.equal(first.notification.type, "assistant_text_delta");

      yield* protocol.acceptChunk(notification(assistantDelta("final")));
      yield* protocol.endInput;
      const final = yield* take(protocol.notifications);
      assert.equal(final.notification.type, "assistant_text_delta");
      if (final.notification.type === "assistant_text_delta") {
        assert.equal(final.notification.messageId, "final");
      }
    }),
  );

  it.effect("assembles a message from many small fragments", () =>
    Effect.gen(function* () {
      const { fiber, protocol, request } = yield* pendingRequest();
      const encoded = response(request.id, { text: "x".repeat(20_000) });
      for (const fragment of encoded) {
        yield* protocol.acceptChunk(fragment);
      }
      yield* protocol.acceptChunk("\n");
      assert.deepStrictEqual(yield* Fiber.join(fiber), { text: "x".repeat(20_000) });
    }),
  );

  it.effect("skips malformed lines and unknown notifications", () =>
    Effect.gen(function* () {
      const protocol = yield* makeDroidRpcProtocol();
      yield* protocol.acceptChunk(
        [
          "{malformed",
          notification({ type: "future_notification", payload: "ignored" }),
          notification(assistantDelta("known")),
          "",
        ].join("\n"),
      );
      const delivered = yield* take(protocol.notifications);
      assert.equal(delivered.notification.type, "assistant_text_delta");
      if (delivered.notification.type === "assistant_text_delta") {
        assert.equal(delivered.notification.messageId, "known");
      }
    }),
  );

  it.effect("decodes server requests and permits one strict response", () =>
    Effect.gen(function* () {
      const protocol = yield* makeDroidRpcProtocol();
      yield* protocol.acceptChunk(
        `${envelope({
          type: "request",
          id: "ask-1",
          method: "droid.ask_user",
          params: {
            sessionId: "session-ask",
            toolCallId: "tool-ask",
            questions: [question],
          },
        })}\n`,
      );
      const delivered = yield* take(protocol.serverRequests);
      assert.equal(delivered.id, "ask-1");
      assert.equal(delivered.sessionId, "session-ask");
      const answers = [{ index: 0, question: "Which scope?", answer: "workspace" }];
      yield* delivered.respond({ answers });
      const encoded = parse(yield* take(protocol.outgoing));
      assert.equal(encoded.type, "response");
      assert.equal(encoded.id, "ask-1");
      assert.deepStrictEqual(encoded.result, { answers });
      const duplicate = yield* Effect.result(delivered.fail(-32603, "too late"));
      assert.equal(duplicate._tag, "Failure");
      if (duplicate._tag === "Failure") {
        assert.equal(duplicate.failure.kind, "duplicate-server-response");
      }
    }),
  );

  for (const { queue, count, messages } of [
    {
      queue: "notifications",
      count: 65,
      messages: Array.from({ length: 65 }, (_, index) =>
        notification(assistantDelta(`queued-${index}`, String(index))),
      ),
    },
    {
      queue: "server requests",
      count: 17,
      messages: Array.from({ length: 17 }, (_, index) => askRequest(index)),
    },
  ] as const) {
    it.effect(`correlates responses behind a lossless ${queue} backlog`, () =>
      Effect.gen(function* () {
        const { fiber, protocol, request } = yield* pendingRequest();
        yield* protocol.acceptChunk(
          `${[...messages, response(request.id, { alive: true })].join("\n")}\n`,
        );
        assert.deepStrictEqual(yield* Fiber.join(fiber), { alive: true });
        const delivered =
          queue === "notifications"
            ? yield* Stream.runCollect(protocol.notifications.pipe(Stream.take(count)))
            : yield* Stream.runCollect(protocol.serverRequests.pipe(Stream.take(count)));
        assert.equal(delivered.length, count);
      }),
    );
  }

  it.effect("bounds lossless backlogs independently by encoded bytes and item count", () =>
    Effect.gen(function* () {
      const first = notification(assistantDelta("first", "x".repeat(200)));
      const second = notification(assistantDelta("second", "y".repeat(200)));
      const byBytes = yield* makeDroidRpcProtocol({
        maxMessageBytes: 1024,
        maxBacklogBytes: Buffer.byteLength(first, "utf8") + 32,
      });
      yield* byBytes.acceptChunk(`${first}\n`);
      const byteOverflow = yield* Effect.result(byBytes.acceptChunk(`${second}\n`));
      assert.equal(byteOverflow._tag, "Failure");
      if (byteOverflow._tag === "Failure") {
        assert.equal(byteOverflow.failure.kind, "backlog-overflow");
        assert.isAbove(
          byteOverflow.failure.actualBytes ?? 0,
          byteOverflow.failure.limitBytes ?? Number.MAX_SAFE_INTEGER,
        );
      }

      const maxBacklogItems = 2;
      const byItems = yield* makeDroidRpcProtocol({ maxBacklogItems });
      const burst = Array.from({ length: 3 }, (_, index) =>
        notification(assistantDelta(`queued-${index}`, "x")),
      );
      const itemOverflow = yield* Effect.result(byItems.acceptChunk(`${burst.join("\n")}\n`));
      assert.equal(itemOverflow._tag, "Failure");
      if (itemOverflow._tag === "Failure") {
        assert.equal(itemOverflow.failure.kind, "backlog-overflow");
        assert.deepStrictEqual(itemOverflow.failure.data, {
          queue: "notifications",
          backlog: maxBacklogItems,
          limit: maxBacklogItems,
        });
      }
    }),
  );

  it.effect("releases lossless item and byte reservations when delivery begins", () =>
    Effect.gen(function* () {
      const first = notification(assistantDelta("first", "x".repeat(200)));
      const second = notification(assistantDelta("second", "y".repeat(200)));
      const protocol = yield* makeDroidRpcProtocol({
        maxBacklogItems: 1,
        maxBacklogBytes: Math.max(
          Buffer.byteLength(first, "utf8"),
          Buffer.byteLength(second, "utf8"),
        ),
      });

      yield* protocol.acceptChunk(`${first}\n`);
      assert.equal((yield* take(protocol.notifications)).notification.type, "assistant_text_delta");
      yield* protocol.acceptChunk(`${second}\n`);
      assert.equal((yield* take(protocol.notifications)).notification.type, "assistant_text_delta");
    }),
  );

  it.effect("keeps prefetched lossless deliveries inside the backlog limit", () =>
    Effect.gen(function* () {
      const protocol = yield* makeDroidRpcProtocol({ maxBacklogItems: 2 });
      const frames = ["first", "second", "third", "fourth"].map((id) =>
        notification(assistantDelta(id, "x")),
      );

      yield* protocol.acceptChunk(`${frames[0]}\n${frames[1]}\n`);
      assert.equal((yield* take(protocol.notifications)).notification.type, "assistant_text_delta");
      yield* protocol.acceptChunk(`${frames[2]}\n`);

      const overflow = yield* Effect.result(protocol.acceptChunk(`${frames[3]}\n`));
      assert.equal(overflow._tag, "Failure");
      if (overflow._tag === "Failure") {
        assert.equal(overflow.failure.kind, "backlog-overflow");
      }
    }),
  );

  it.effect("bounds UTF-8 remainders and outbound encoded frames", () =>
    Effect.gen(function* () {
      const inbound = yield* makeDroidRpcProtocol({ maxMessageBytes: 8 });
      yield* inbound.acceptChunk("éé");
      const frame = yield* Effect.result(inbound.acceptChunk("ééé"));
      assert.equal(frame._tag, "Failure");
      if (frame._tag === "Failure") {
        assert.equal(frame.failure.kind, "frame-too-large");
        assert.equal(frame.failure.actualBytes, 10);
        assert.equal(frame.failure.limitBytes, 8);
      }

      const outbound = yield* makeDroidRpcProtocol({ maxMessageBytes: 256 });
      const message = yield* Effect.result(
        outbound.request(
          "droid.add_user_message",
          { text: "x".repeat(512) },
          { timeoutMs: undefined },
        ),
      );
      assert.equal(message._tag, "Failure");
      if (message._tag === "Failure") {
        assert.equal(message.failure.kind, "message-too-large");
        assert.isAbove(message.failure.actualBytes ?? 0, 256);
      }
    }),
  );

  it.effect("times out backpressure and diagnoses retained late responses", () => {
    const logs: string[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(String(Array.isArray(message) ? message[0] : message));
    });
    return Effect.gen(function* () {
      const protocol = yield* makeDroidRpcProtocol();
      const fiber = yield* protocol
        .request("droid.first", {}, { timeoutMs: 10 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      const request = parse(yield* take(protocol.outgoing));
      yield* TestClock.adjust("11 millis");
      const timedOut = yield* Effect.result(Fiber.join(fiber));
      assert.equal(timedOut._tag, "Failure");
      if (timedOut._tag === "Failure") assert.equal(timedOut.failure.kind, "timeout");
      yield* protocol.acceptChunk(`${response(request.id, { late: true })}\n`);
      assert.include(logs, "Droid request droid.first responded after timing out");
      assert.equal(
        new DroidRpcError({
          kind: "timeout",
          method: "droid.list_models",
          requestId: "7",
          timeoutMs: 25,
        }).message,
        "Droid request droid.list_models timed out after 25ms",
      );
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("drops timed-out request frames that are still queued", () => {
    const logs: string[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(String(Array.isArray(message) ? message[0] : message));
    });
    return Effect.gen(function* () {
      const protocol = yield* makeDroidRpcProtocol();
      yield* protocol.acceptChunk(`${askRequest(1)}\n`);
      const serverResponse = yield* take(protocol.serverRequests);
      yield* serverResponse.respond({ accepted: true });

      const requestFiber = yield* protocol
        .request("droid.queued", {}, { timeoutMs: 10 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("11 millis");
      const timedOut = yield* Effect.result(Fiber.join(requestFiber));
      assert.equal(timedOut._tag, "Failure");
      if (timedOut._tag === "Failure") assert.equal(timedOut.failure.kind, "timeout");

      yield* protocol.closeOutgoing;
      const outgoing = yield* Stream.runCollect(protocol.outgoing);
      assert.deepStrictEqual(
        Array.from(outgoing, (encoded) => parse(encoded).id),
        ["ask-1"],
      );
      yield* protocol.acceptChunk(`${response("1", { late: true })}\n`);
      assert.include(logs, "Ignoring response for unknown Droid request 1");
      assert.notInclude(logs, "Droid request droid.queued responded after timing out");
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("bounds timeout tombstones while retaining recent diagnostics", () => {
    const logs: string[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(String(Array.isArray(message) ? message[0] : message));
    });
    return Effect.gen(function* () {
      const protocol = yield* makeDroidRpcProtocol({ timedOutRequestRetentionLimit: 2 });
      const outgoing = yield* Stream.runDrain(protocol.outgoing).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const results = yield* Effect.forEach(["first", "second", "third"], (method) =>
        Effect.result(protocol.request(`droid.${method}`, {}, { timeoutMs: 1 })),
      );
      assert.isTrue(
        results.every((result) => result._tag === "Failure" && result.failure.kind === "timeout"),
      );
      yield* protocol.acceptChunk(
        `${response("1", { late: true })}\n${response("3", { late: true })}\n`,
      );
      assert.include(logs, "Ignoring response for unknown Droid request 1");
      assert.include(logs, "Droid request droid.third responded after timing out");
      yield* Fiber.interrupt(outgoing);
    }).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      TestClock.withLive,
    );
  });

  it.effect("fails pending and future requests immediately after process exit", () =>
    Effect.gen(function* () {
      const { fiber: pending, protocol, request } = yield* pendingRequest();
      const exit = { code: 7, description: "Droid process exited with code 7" };
      yield* protocol.handleExit(exit);
      const pendingResult = yield* Effect.result(Fiber.join(pending));
      assert.equal(pendingResult._tag, "Failure");
      if (pendingResult._tag === "Failure") {
        assert.equal(pendingResult.failure.kind, "process-exit");
        assert.equal(pendingResult.failure.requestId, request.id);
      }
      const future = yield* Effect.result(
        protocol.request("droid.list_models", {}, { timeoutMs: undefined }),
      );
      assert.equal(future._tag, "Failure");
      if (future._tag === "Failure") {
        assert.equal(future.failure.kind, "process-exit");
        assert.deepStrictEqual(future.failure.data, exit);
      }
    }),
  );

  it.effect("rejects completed turns without correlation ids", () =>
    Effect.gen(function* () {
      const protocol = yield* makeDroidRpcProtocol();
      const result = yield* Effect.result(
        protocol.acceptChunk(
          `${notification({
            type: "agent_turn_completed",
            reason: "completed",
            tokenUsage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              thinkingTokens: 0,
            },
          })}\n`,
        ),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure.kind, "protocol");
        assert.equal(
          result.failure.message,
          "Droid agent_turn_completed notification is missing turnId",
        );
      }
    }),
  );
});
