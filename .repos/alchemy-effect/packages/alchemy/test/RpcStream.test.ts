import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Rpc from "@/Rpc";

const bytes = (text: string) => new TextEncoder().encode(text);
const jsonBytes = (b64: unknown) =>
  bytes(JSON.stringify({ _tag: "~alchemy/rpc/bytes", b64 }) + "\n");
const decoders = {
  jsonl: (input: Stream.Stream<Uint8Array>) => Rpc.decodeRpcByteStream(input, "jsonl"),
  response: Rpc.decodeRpcResponseStream,
};

const expectedBase64 = (value: unknown): Uint8Array => {
  const binary = atob(value as string);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const withNativeDecoder = <A, E, R>(
  decode: ((value: string) => Uint8Array) | undefined,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
      Object.defineProperty(Uint8Array, "fromBase64", {
        configurable: true,
        writable: true,
        value: decode,
      });
      return descriptor;
    }),
    () => effect,
    (descriptor) =>
      Effect.sync(() => {
        if (descriptor === undefined) Reflect.deleteProperty(Uint8Array, "fromBase64");
        else Object.defineProperty(Uint8Array, "fromBase64", descriptor);
      }),
  );

describe("RPC stream codecs", { tags: ["unit", "local"] }, () => {
  for (const [name, decode] of Object.entries(decoders)) {
    it.effect(`${name}: decodes split UTF-8 and frames, ignoring empty lines`, () =>
      Effect.gen(function* () {
        const encoded = bytes('{"text":"café 😀"}\n\n{"n":2}\n');
        const fragments = Array.from(encoded, (_, index) => encoded.subarray(index, index + 1));
        const result = yield* decode(Stream.fromIterable(fragments)).pipe(Stream.runCollect);
        expect(result).toEqual([{ text: "café 😀" }, { n: 2 }]);
      }),
    );

    it.effect(`${name}: malformed JSON stays in RpcDecodeError`, () =>
      Effect.gen(function* () {
        const exit = yield* decode(Stream.make(bytes("{broken}\n"))).pipe(
          Stream.runCollect,
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          expect(reason?.error).toBeInstanceOf(Rpc.RpcDecodeError);
        }
      }),
    );

    it.effect(`${name}: a split error marker preserves the remote failure`, () =>
      Effect.gen(function* () {
        const error = { _tag: "Boom", code: 7 };
        const line = JSON.stringify({ _tag: Rpc.StreamErrorTag, error }) + "\n";
        const result = yield* decode(
          Stream.make(bytes(line.slice(0, 9)), bytes(line.slice(9))),
        ).pipe(Stream.runCollect, Effect.flip);
        expect(result).toBeInstanceOf(Rpc.RpcRemoteStreamError);
        if (result instanceof Rpc.RpcRemoteStreamError) expect(result.error).toEqual(error);
      }),
    );

    it.effect(`${name}: taking a prefix releases the upstream scope`, () =>
      Effect.gen(function* () {
        let finalized = false;
        const source = Stream.unwrap(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                finalized = true;
              }),
            );
            return Stream.iterate(0, (n) => n + 1).pipe(
              Stream.map((n) => bytes(JSON.stringify(n) + "\n")),
            );
          }),
        );
        const result = yield* decode(source).pipe(Stream.take(3), Stream.runCollect);
        expect(result).toEqual([0, 1, 2]);
        expect(finalized).toBe(true);
      }),
    );
  }

  it.effect("raw bytes pass through without framing or copying", () =>
    Effect.gen(function* () {
      const value = new Uint8Array([0, 255, 10]);
      const source = Stream.make(value);
      const decoded = Rpc.decodeRpcByteStream(source, "bytes");
      expect(decoded).toBe(source);
      const result = yield* decoded.pipe(Stream.runCollect);
      expect(result[0]).toBe(value);
    }),
  );

  it.effect("native and fallback encoding preserve byte offsets and empty chunks", () =>
    Effect.gen(function* () {
      const backing = new Uint8Array([99, 98, 0, 128, 255, 10, 97]);
      const view = backing.subarray(2, 6);
      const fallbackView = backing.subarray(2, 6);
      let nativeCalls = 0;
      // Exercise both capabilities without mutating the global prototype.
      Object.defineProperty(view, "toBase64", {
        value: function (this: Uint8Array) {
          expect(this).toBe(view);
          nativeCalls++;
          return btoa(String.fromCharCode(...this));
        },
      });
      Object.defineProperty(fallbackView, "toBase64", { value: undefined });
      const values = [
        view,
        fallbackView,
        new Uint8Array(0),
        Uint8Array.from({ length: 256 }, (_, n) => n),
      ];
      // The encoder erases R to any, but this fixture has no runtime services.
      const encoded = Rpc.encodeRpcResponseStream(
        Stream.fromIterable(values),
      ) as Stream.Stream<Uint8Array>;
      const result = yield* encoded.pipe(Rpc.decodeRpcResponseStream, Stream.runCollect);
      expect(result.map((value: Uint8Array) => Array.from(value))).toEqual(
        values.map((value) => Array.from(value)),
      );
      expect(nativeCalls).toBe(1);
    }),
  );

  it.effect(
    "uses the native decoder for strings while retaining legacy wire-value coercion",
    () => {
      const calls: string[] = [];
      return withNativeDecoder(
        function (this: Uint8ArrayConstructor, value) {
          expect(this).toBe(Uint8Array);
          calls.push(value);
          return expectedBase64(value);
        },
        Effect.gen(function* () {
          for (const value of ["", "AP8=", 1234, null]) {
            const decoded = yield* Rpc.decodeRpcResponseStream(Stream.make(jsonBytes(value))).pipe(
              Stream.runCollect,
            );
            expect(Array.from(decoded[0])).toEqual(Array.from(expectedBase64(value)));
          }
          expect(calls).toEqual(["", "AP8="]);
        }),
      );
    },
    { exclusive: true },
  );

  for (const fallback of [false, true]) {
    it.effect(
      `base64 ${fallback ? "fallback" : "native when available"}: matches atob acceptance`,
      () => {
        const program = Effect.gen(function* () {
          // Missing padding, nonzero unused bits, ASCII whitespace, and legacy
          // non-string wire values all retain atob's forgiving behavior.
          for (const encoded of [
            "",
            "AA==",
            "AA",
            "AB==",
            "AB",
            "Zm8=",
            "Zm8",
            " Zm\t9v\n",
            "Zg=\r\n=",
            1234,
            null,
          ]) {
            const decoded = yield* Rpc.decodeRpcResponseStream(
              Stream.make(jsonBytes(encoded)),
            ).pipe(Stream.runCollect);
            expect(decoded).toHaveLength(1);
            expect(Array.from(decoded[0])).toEqual(Array.from(expectedBase64(encoded)));
          }
        });
        return fallback ? withNativeDecoder(undefined, program) : program;
      },
      { exclusive: fallback },
    );

    it.effect(
      `base64 ${fallback ? "fallback" : "native when available"}: invalid input remains an atob defect`,
      () => {
        const program = Effect.gen(function* () {
          for (const encoded of [
            "A",
            "=",
            "Zg=",
            "Zg===",
            "Zm9v=",
            "_w==",
            "AA!A",
            "AA\u000b==",
            "AA\u00a0==",
          ]) {
            let expected: unknown;
            try {
              atob(encoded);
            } catch (error) {
              expected = error;
            }
            expect(expected).toBeInstanceOf(DOMException);
            const exit = yield* Rpc.decodeRpcResponseStream(Stream.make(jsonBytes(encoded))).pipe(
              Stream.runCollect,
              Effect.exit,
            );
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const reason = exit.cause.reasons.find(Cause.isDieReason);
              expect(reason?.defect).toBeInstanceOf(DOMException);
              expect((reason?.defect as DOMException).name).toBe((expected as DOMException).name);
              expect((reason?.defect as DOMException).message).toBe(
                (expected as DOMException).message,
              );
            }
          }
        });
        return fallback ? withNativeDecoder(undefined, program) : program;
      },
      { exclusive: fallback },
    );
  }
});
