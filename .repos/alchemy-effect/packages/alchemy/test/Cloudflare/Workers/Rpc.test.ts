import {
  RpcDecodeError,
  RpcCallError,
  RpcRemoteStreamError,
  encodeRpcError,
  decodeRpcResult,
  decodeRpcValue,
  ErrorTag,
  StreamTag,
  StreamErrorTag,
  isRpcErrorEnvelope,
  isRpcStreamEnvelope,
  fromRpcReadableStream,
  fromRpcStreamEnvelope,
  toRpcStream,
  makeRpcStub,
  type RpcErrorEnvelope,
  type RpcStreamEnvelope,
} from "@/Cloudflare/Workers/Rpc";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";

class MyError extends Data.TaggedError("MyError")<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// RpcDecodeError
// ---------------------------------------------------------------------------

describe("RpcDecodeError", () => {
  it.effect("message delegates to Error.message when cause is an Error", () =>
    Effect.gen(function* () {
      const err = new RpcDecodeError({ cause: new Error("inner") });
      expect(err._tag).toBe("RpcDecodeError");
      expect(err.message).toBe("inner");
    }),
  );

  it.effect("message stringifies non-Error cause", () =>
    Effect.gen(function* () {
      const err = new RpcDecodeError({ cause: 42 });
      expect(err.message).toBe("42");
    }),
  );
});

// ---------------------------------------------------------------------------
// RpcCallError
// ---------------------------------------------------------------------------

describe("RpcCallError", () => {
  it.effect("message includes method name and Error.message", () =>
    Effect.gen(function* () {
      const err = new RpcCallError({
        method: "doStuff",
        cause: new Error("boom"),
      });
      expect(err._tag).toBe("RpcCallError");
      expect(err.message).toBe('RPC call to "doStuff" failed: boom');
    }),
  );

  it.effect("message stringifies non-Error cause", () =>
    Effect.gen(function* () {
      const err = new RpcCallError({ method: "doStuff", cause: "oops" });
      expect(err.message).toBe('RPC call to "doStuff" failed: oops');
    }),
  );
});

// ---------------------------------------------------------------------------
// isRpcErrorEnvelope
// ---------------------------------------------------------------------------

describe("isRpcErrorEnvelope", () => {
  it.effect("detects valid envelope", () =>
    Effect.gen(function* () {
      const envelope: RpcErrorEnvelope = {
        _tag: ErrorTag,
        error: { message: "boom" },
      };
      expect(isRpcErrorEnvelope(envelope)).toBe(true);
    }),
  );

  it.effect("rejects non-envelope values", () =>
    Effect.gen(function* () {
      expect(isRpcErrorEnvelope(null)).toBe(false);
      expect(isRpcErrorEnvelope(undefined)).toBe(false);
      expect(isRpcErrorEnvelope(42)).toBe(false);
      expect(isRpcErrorEnvelope("hello")).toBe(false);
      expect(isRpcErrorEnvelope({ _tag: "Other" })).toBe(false);
      expect(isRpcErrorEnvelope({ _tag: ErrorTag })).toBe(false);
    }),
  );
});

// ---------------------------------------------------------------------------
// isRpcStreamEnvelope
// ---------------------------------------------------------------------------

describe("isRpcStreamEnvelope", () => {
  it.effect("detects valid bytes envelope", () =>
    Effect.gen(function* () {
      const envelope: RpcStreamEnvelope = {
        _tag: StreamTag,
        encoding: "bytes",
        body: new ReadableStream(),
      };
      expect(isRpcStreamEnvelope(envelope)).toBe(true);
    }),
  );

  it.effect("detects valid jsonl envelope", () =>
    Effect.gen(function* () {
      const envelope: RpcStreamEnvelope = {
        _tag: StreamTag,
        encoding: "jsonl",
        body: new ReadableStream(),
      };
      expect(isRpcStreamEnvelope(envelope)).toBe(true);
    }),
  );

  it.effect("rejects missing or wrong fields", () =>
    Effect.gen(function* () {
      expect(isRpcStreamEnvelope(null)).toBe(false);
      expect(isRpcStreamEnvelope(42)).toBe(false);
      expect(isRpcStreamEnvelope({ _tag: StreamTag })).toBe(false);
      expect(
        isRpcStreamEnvelope({
          _tag: StreamTag,
          encoding: "xml",
          body: new ReadableStream(),
        }),
      ).toBe(false);
      expect(
        isRpcStreamEnvelope({
          _tag: StreamTag,
          encoding: "jsonl",
          body: "not a stream",
        }),
      ).toBe(false);
    }),
  );
});

// ---------------------------------------------------------------------------
// encodeRpcError
// ---------------------------------------------------------------------------

describe("encodeRpcError", () => {
  it.effect("preserves tagged error fields", () =>
    Effect.gen(function* () {
      const error = new MyError({ message: "BOOF" });
      const encoded = encodeRpcError(error) as Record<string, unknown>;
      expect(encoded._tag).toBe("MyError");
      expect(encoded.message).toBe("BOOF");
    }),
  );

  it.effect("normalizes plain Error to name/message/stack", () =>
    Effect.gen(function* () {
      const error = new Error("plain failure");
      const encoded = encodeRpcError(error) as Record<string, unknown>;
      expect(encoded.name).toBe("Error");
      expect(encoded.message).toBe("plain failure");
      expect(encoded.stack).toBeDefined();
    }),
  );

  it.effect("passes through primitives", () =>
    Effect.gen(function* () {
      expect(encodeRpcError("string error")).toBe("string error");
      expect(encodeRpcError(42)).toBe(42);
      expect(encodeRpcError(null)).toBe(null);
      expect(encodeRpcError(undefined)).toBe(undefined);
    }),
  );

  it.effect("passes through plain objects", () =>
    Effect.gen(function* () {
      const obj = { code: 404, detail: "not found" };
      expect(encodeRpcError(obj)).toBe(obj);
    }),
  );
});

// ---------------------------------------------------------------------------
// Helper: create a ReadableStream from a string
// ---------------------------------------------------------------------------

const textToReadableStream = (text: string): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
};

const bytesToReadableStream = (
  chunks: Uint8Array[],
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

// ---------------------------------------------------------------------------
// fromRpcReadableStream
// ---------------------------------------------------------------------------

describe("fromRpcReadableStream", () => {
  it.effect("bytes encoding passes raw Uint8Array chunks through", () =>
    Effect.gen(function* () {
      const data = new TextEncoder().encode("hello");
      const body = bytesToReadableStream([data]);
      const stream = fromRpcReadableStream(body, "bytes");
      const chunks = yield* Stream.runCollect(stream);
      expect(chunks).toEqual([data]);
    }),
  );

  it.effect("jsonl encoding parses JSON lines", () =>
    Effect.gen(function* () {
      const body = textToReadableStream('{"a":1}\n{"b":2}\n');
      const stream = fromRpcReadableStream(body, "jsonl");
      const chunks = yield* Stream.runCollect(stream);
      expect(chunks).toEqual([{ a: 1 }, { b: 2 }]);
    }),
  );

  it.effect("jsonl encoding produces RpcDecodeError on malformed JSON", () =>
    Effect.gen(function* () {
      const body = textToReadableStream("not json\n");
      const stream = fromRpcReadableStream(body, "jsonl");
      const exit = yield* Effect.exit(Stream.runCollect(stream));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("jsonl encoding skips empty lines", () =>
    Effect.gen(function* () {
      const body = textToReadableStream('{"x":1}\n\n\n{"y":2}\n');
      const stream = fromRpcReadableStream(body, "jsonl");
      const chunks = yield* Stream.runCollect(stream);
      expect(chunks).toEqual([{ x: 1 }, { y: 2 }]);
    }),
  );
});

// ---------------------------------------------------------------------------
// fromRpcStreamEnvelope
// ---------------------------------------------------------------------------

describe("fromRpcStreamEnvelope", () => {
  it.effect("delegates to fromRpcReadableStream", () =>
    Effect.gen(function* () {
      const body = textToReadableStream('{"v":99}\n');
      const envelope: RpcStreamEnvelope = {
        _tag: StreamTag,
        encoding: "jsonl",
        body,
      };
      const chunks = yield* Stream.runCollect(fromRpcStreamEnvelope(envelope));
      expect(chunks).toEqual([{ v: 99 }]);
    }),
  );
});

// ---------------------------------------------------------------------------
// decodeRpcValue
// ---------------------------------------------------------------------------

describe("decodeRpcValue", () => {
  it.effect("passes through plain values", () =>
    Effect.gen(function* () {
      expect(decodeRpcValue("hello")).toBe("hello");
      expect(decodeRpcValue(42)).toBe(42);
      expect(decodeRpcValue(null)).toBe(null);
    }),
  );

  it.effect("converts stream envelope to Effect Stream", () =>
    Effect.gen(function* () {
      const body = textToReadableStream('{"k":1}\n');
      const envelope: RpcStreamEnvelope = {
        _tag: StreamTag,
        encoding: "jsonl",
        body,
      };
      const result = decodeRpcValue(envelope);
      expect(Stream.isStream(result)).toBe(true);
      const chunks = yield* Stream.runCollect(result as Stream.Stream<any>);
      expect(chunks).toEqual([{ k: 1 }]);
    }),
  );

  it.effect("converts bare ReadableStream to bytes Effect Stream", () =>
    Effect.gen(function* () {
      const data = new TextEncoder().encode("raw");
      const body = bytesToReadableStream([data]);
      const result = decodeRpcValue(body);
      expect(Stream.isStream(result)).toBe(true);
      const chunks = yield* Stream.runCollect(result as Stream.Stream<any>);
      expect(chunks).toEqual([data]);
    }),
  );
});

// ---------------------------------------------------------------------------
// decodeRpcResult
// ---------------------------------------------------------------------------

describe("decodeRpcResult", () => {
  it.effect("succeeds for plain values", () =>
    Effect.gen(function* () {
      const result = yield* decodeRpcResult("hello");
      expect(result).toBe("hello");
    }),
  );

  it.effect("succeeds for numeric values", () =>
    Effect.gen(function* () {
      const result = yield* decodeRpcResult(42);
      expect(result).toBe(42);
    }),
  );

  it.effect("fails for error envelopes with tagged error", () =>
    Effect.gen(function* () {
      const envelope: RpcErrorEnvelope = {
        _tag: ErrorTag,
        error: { _tag: "MyError", message: "BOOF" },
      };
      const exit = yield* Effect.exit(decodeRpcResult(envelope));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReason = exit.cause.reasons.find((r) => r._tag === "Fail");
        expect(failReason).toBeDefined();
        const error = (failReason as any).error as Record<string, unknown>;
        expect(error._tag).toBe("MyError");
        expect(error.message).toBe("BOOF");
      }
    }),
  );

  it.effect("fails with plain Error shape for error envelopes", () =>
    Effect.gen(function* () {
      const envelope: RpcErrorEnvelope = {
        _tag: ErrorTag,
        error: { name: "Error", message: "plain failure" },
      };
      const exit = yield* Effect.exit(decodeRpcResult(envelope));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReason = exit.cause.reasons.find((r) => r._tag === "Fail");
        const error = (failReason as any).error as Record<string, unknown>;
        expect(error.message).toBe("plain failure");
      }
    }),
  );

  it.effect("wraps stream envelopes in succeed (stream passthrough)", () =>
    Effect.gen(function* () {
      const body = textToReadableStream('{"s":1}\n');
      const envelope: RpcStreamEnvelope = {
        _tag: StreamTag,
        encoding: "jsonl",
        body,
      };
      const result = yield* decodeRpcResult(envelope);
      expect(Stream.isStream(result)).toBe(true);
      const chunks = yield* Stream.runCollect(result as Stream.Stream<any>);
      expect(chunks).toEqual([{ s: 1 }]);
    }),
  );
});

// ---------------------------------------------------------------------------
// toRpcStream
// ---------------------------------------------------------------------------

describe("toRpcStream", () => {
  it.effect("selects jsonl encoding for non-byte data", () =>
    Effect.gen(function* () {
      const stream = Stream.fromIterable([{ a: 1 }]);
      const envelope = yield* toRpcStream(stream);
      expect(envelope._tag).toBe(StreamTag);
      expect(envelope.encoding).toBe("jsonl");
      expect(envelope.body).toBeInstanceOf(ReadableStream);
    }),
  );

  it.effect("roundtrips a single-element jsonl stream", () =>
    Effect.gen(function* () {
      const stream = Stream.fromIterable([{ a: 1 }]);
      const envelope = yield* toRpcStream(stream);
      const decoded = fromRpcReadableStream(envelope.body, "jsonl");
      const chunks = yield* Stream.runCollect(decoded);
      expect(chunks).toEqual([{ a: 1 }]);
    }),
  );

  it.effect("selects bytes encoding for Uint8Array data", () =>
    Effect.gen(function* () {
      const data = new Uint8Array([1, 2, 3]);
      const stream = Stream.fromIterable([data]);
      const envelope = yield* toRpcStream(stream);
      expect(envelope._tag).toBe(StreamTag);
      expect(envelope.encoding).toBe("bytes");
      expect(envelope.body).toBeInstanceOf(ReadableStream);
    }),
  );

  it.effect("roundtrips a single-element bytes stream", () =>
    Effect.gen(function* () {
      const data = new Uint8Array([1, 2, 3]);
      const stream = Stream.fromIterable([data]);
      const envelope = yield* toRpcStream(stream);
      const decoded = fromRpcReadableStream(envelope.body, "bytes");
      const chunks = yield* Stream.runCollect(decoded);
      expect(chunks).toEqual([data]);
    }),
  );

  it.effect("handles empty stream as jsonl", () =>
    Effect.gen(function* () {
      const stream = Stream.empty;
      const envelope = yield* toRpcStream(stream);
      expect(envelope._tag).toBe(StreamTag);
      expect(envelope.encoding).toBe("jsonl");

      const decoded = fromRpcReadableStream(envelope.body, envelope.encoding);
      const chunks = yield* Stream.runCollect(decoded);
      expect(chunks).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// makeRpcStub
// ---------------------------------------------------------------------------

describe("makeRpcStub", () => {
  it.effect("proxies successful calls", () =>
    Effect.gen(function* () {
      const mockStub = {
        greet: async (name: string) => `hello ${name}`,
      };
      const stub = makeRpcStub<{
        greet: (name: string) => Effect.Effect<string>;
      }>(mockStub);

      const result = yield* stub.greet("world");
      expect(result).toBe("hello world");
    }),
  );

  it.effect("wraps rejected promises as RpcCallError", () =>
    Effect.gen(function* () {
      const mockStub = {
        boom: async () => {
          throw new Error("kaboom");
        },
      };
      const stub = makeRpcStub<{
        boom: () => Effect.Effect<never, RpcCallError>;
      }>(mockStub);

      const exit = yield* Effect.exit(stub.boom());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReason = exit.cause.reasons.find((r) => r._tag === "Fail");
        expect(failReason).toBeDefined();
        const error = (failReason as any).error;
        expect(error._tag).toBe("RpcCallError");
        expect(error.method).toBe("boom");
      }
    }),
  );

  it.effect("decodes error envelopes into Effect.fail", () =>
    Effect.gen(function* () {
      const mockStub = {
        failMe: async () => ({
          _tag: ErrorTag,
          error: { _tag: "MyError", message: "remote fail" },
        }),
      };
      const stub = makeRpcStub<{
        failMe: () => Effect.Effect<never, { _tag: string; message: string }>;
      }>(mockStub);

      const exit = yield* Effect.exit(stub.failMe());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failReason = exit.cause.reasons.find((r) => r._tag === "Fail");
        const error = (failReason as any).error as Record<string, unknown>;
        expect(error._tag).toBe("MyError");
        expect(error.message).toBe("remote fail");
      }
    }),
  );

  it.effect("decodes stream envelopes from successful calls", () =>
    Effect.gen(function* () {
      const body = textToReadableStream('{"n":42}\n');
      const mockStub = {
        streamMe: async () => ({
          _tag: StreamTag,
          encoding: "jsonl" as const,
          body,
        }),
      };
      const stub = makeRpcStub<{
        streamMe: () => Effect.Effect<Stream.Stream<{ n: number }>>;
      }>(mockStub);

      const stream = yield* stub.streamMe();
      expect(Stream.isStream(stream)).toBe(true);
      const chunks = yield* Stream.runCollect(stream);
      expect(chunks).toEqual([{ n: 42 }]);
    }),
  );
});

// ---------------------------------------------------------------------------
// Stream error transport
// ---------------------------------------------------------------------------

describe("stream errors", () => {
  it.effect("toRpcStream encodes a stream that fails immediately", () =>
    Effect.gen(function* () {
      const stream = Stream.fail(new MyError({ message: "immediate" }));
      const envelope = yield* toRpcStream(stream);
      expect(envelope._tag).toBe(StreamTag);
      expect(envelope.encoding).toBe("jsonl");

      const decoded = fromRpcReadableStream(envelope.body, "jsonl");
      const exit = yield* Effect.exit(Stream.runCollect(decoded));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find(Cause.isFailReason);
        expect(reason).toBeDefined();
        const err = reason!.error;
        expect(err).toBeInstanceOf(RpcRemoteStreamError);
        expect((err as RpcRemoteStreamError).error).toEqual({
          _tag: "MyError",
          message: "immediate",
        });
      }
    }),
  );

  it.effect("toRpcStream encodes a stream that fails after elements", () =>
    Effect.gen(function* () {
      const stream = Stream.make(1, 2).pipe(
        Stream.concat(Stream.fail(new MyError({ message: "mid" }))),
      );
      const envelope = yield* toRpcStream(stream);
      expect(envelope._tag).toBe(StreamTag);
      expect(envelope.encoding).toBe("jsonl");

      const decoded = fromRpcReadableStream(envelope.body, "jsonl");
      const exit = yield* Effect.exit(Stream.runCollect(decoded));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find(Cause.isFailReason);
        expect(reason).toBeDefined();
        const err = reason!.error;
        expect(err).toBeInstanceOf(RpcRemoteStreamError);
        expect((err as RpcRemoteStreamError).error).toEqual({
          _tag: "MyError",
          message: "mid",
        });
      }
    }),
  );

  it.effect("fromRpcReadableStream decodes error marker in JSONL", () =>
    Effect.gen(function* () {
      const errorLine = JSON.stringify({
        _tag: StreamErrorTag,
        error: { _tag: "MyError", message: "wire" },
      });
      const body = textToReadableStream(`${errorLine}\n`);
      const stream = fromRpcReadableStream(body, "jsonl");
      const exit = yield* Effect.exit(Stream.runCollect(stream));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find(Cause.isFailReason);
        const err = reason!.error;
        expect(err).toBeInstanceOf(RpcRemoteStreamError);
        expect((err as RpcRemoteStreamError).error).toEqual({
          _tag: "MyError",
          message: "wire",
        });
      }
    }),
  );

  it.effect("fromRpcReadableStream yields elements before error marker", () =>
    Effect.gen(function* () {
      const errorLine = JSON.stringify({
        _tag: StreamErrorTag,
        error: { message: "after elements" },
      });
      const body = textToReadableStream(`{"v":1}\n{"v":2}\n${errorLine}\n`);
      const stream = fromRpcReadableStream(body, "jsonl");
      const collected: unknown[] = [];
      const exit = yield* Effect.exit(
        Stream.runForEach(stream, (item) =>
          Effect.sync(() => {
            collected.push(item);
          }),
        ),
      );
      expect(collected).toEqual([{ v: 1 }, { v: 2 }]);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect(
    "makeRpcStub preserves stream errors (not collapsed to RpcCallError)",
    () =>
      Effect.gen(function* () {
        const errorLine = JSON.stringify({
          _tag: StreamErrorTag,
          error: { _tag: "MyError", message: "remote stream err" },
        });
        const body = textToReadableStream(`{"n":1}\n${errorLine}\n`);
        const mockStub = {
          streamFail: async () => ({
            _tag: StreamTag,
            encoding: "jsonl" as const,
            body,
          }),
        };
        const stub = makeRpcStub<{
          streamFail: () => Effect.Effect<
            Stream.Stream<unknown, RpcRemoteStreamError>
          >;
        }>(mockStub);

        const stream = yield* stub.streamFail();
        const exit = yield* Effect.exit(Stream.runCollect(stream));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          expect(reason).toBeDefined();
          expect(reason!.error).toBeInstanceOf(RpcRemoteStreamError);
        }
      }),
  );
});
