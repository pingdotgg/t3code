import {
  unwrapRpcHandlers,
  wrapRpcHandlers,
  type RpcWrapped,
} from "@/Local/RpcSerialization.ts";
import * as Output from "@/Output.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

/**
 * Builds a client whose wrap→unwrap path mirrors the production wire:
 * `unwrapRpcEffectHandler` serializes its args; capnweb JSON-encodes them
 * over the websocket; `wrapRpcEffectHandler` deserializes them on the other
 * end. We thread `JSON.parse(JSON.stringify(...))` between the wrap and
 * unwrap layers to model that hop. Streams skip the JSON hop because they
 * are bridged via a real `ReadableStream`.
 */
const roundTrip = <T extends Record<string, any>>(
  handlers: T,
  streamKeys?: Array<keyof T>,
): T => {
  const wrapped = wrapRpcHandlers(handlers, streamKeys);
  const piped = Object.fromEntries(
    Object.entries(wrapped).map(([key, value]) => {
      if (typeof value !== "function") {
        return [key, value];
      }
      if (streamKeys?.includes(key as keyof T)) {
        // Streams bypass JSON; the underlying ReadableStream is shipped.
        return [key, value];
      }
      const fn = value as (args: Array<unknown>) => Promise<unknown>;
      const piped = async (args: Array<unknown>) => {
        const wireArgs = JSON.parse(JSON.stringify(args));
        const result = await fn(wireArgs);
        return JSON.parse(JSON.stringify(result));
      };
      return [key, piped];
    }),
  ) as RpcWrapped<T>;
  return unwrapRpcHandlers<T>(piped, streamKeys) as T;
};

describe("Local.RpcSerialization", () => {
  describe("argument serialization", () => {
    it.effect("round-trips a top-level Redacted argument", () =>
      Effect.gen(function* () {
        const handlers = {
          echo: (s: Redacted.Redacted<string>) =>
            Effect.succeed(Redacted.value(s)),
        };
        const client = roundTrip(handlers);
        expect(yield* client.echo(Redacted.make("hush"))).toBe("hush");
      }),
    );

    it.effect("round-trips a Redacted nested inside an object", () =>
      Effect.gen(function* () {
        const handlers = {
          password: (env: { password: Redacted.Redacted<string> }) =>
            Effect.succeed(Redacted.value(env.password)),
        };
        const client = roundTrip(handlers);
        expect(
          yield* client.password({ password: Redacted.make("hush") }),
        ).toBe("hush");
      }),
    );

    it.effect("preserves objects with their own toJSON (Date)", () =>
      Effect.gen(function* () {
        const handlers = {
          withDate: (env: { when: Date | string }) =>
            Effect.succeed(String(env.when)),
        };
        const client = roundTrip(handlers);
        const d = new Date("2026-05-16T12:00:00.000Z");
        expect(yield* client.withDate({ when: d })).toBe(d.toISOString());
      }),
    );

    it.effect("drops function-valued args (replaced with null)", () =>
      Effect.gen(function* () {
        const handlers = {
          take: (arg: { cb: (() => void) | null }) =>
            Effect.succeed(arg.cb === null ? "null" : typeof arg.cb),
        };
        const client = roundTrip(handlers);
        expect(yield* client.take({ cb: () => {} })).toBe("null");
      }),
    );

    it.effect("serializes arrays element-wise", () =>
      Effect.gen(function* () {
        const handlers = {
          sum: (xs: ReadonlyArray<Redacted.Redacted<number>>) =>
            Effect.succeed(xs.reduce((a, x) => a + Redacted.value(x), 0)),
        };
        const client = roundTrip(handlers);
        const result = yield* client.sum([
          Redacted.make(1),
          Redacted.make(2),
          Redacted.make(3),
        ]);
        expect(result).toBe(6);
      }),
    );

    it.effect("converts Output sentinel into a NamedExpr", () =>
      Effect.gen(function* () {
        let received: unknown;
        const handlers = {
          take: (arg: { val: Output.Output<string> }) =>
            Effect.sync(() => {
              received = arg.val;
              return "ok";
            }),
        };
        const client = roundTrip(handlers);
        const fakeOutput = new Output.NamedExpr(
          new Output.EffectExpr(Output.VoidExpr, () => Effect.succeed("x")),
          "myBinding",
        );
        const result = yield* client.take({
          val: fakeOutput as unknown as Output.Output<string>,
        });
        expect(result).toBe("ok");
        expect(Output.isOutput(received)).toBe(true);
        expect((received as Output.NamedExpr<unknown>).kind).toBe("NamedExpr");
      }),
    );
  });

  describe("effect exit serialization", () => {
    it.effect("propagates success", () =>
      Effect.gen(function* () {
        const handlers = {
          ok: () => Effect.succeed(42),
        };
        expect(yield* roundTrip(handlers).ok()).toBe(42);
      }),
    );

    it.effect("propagates Fail (typed error)", () =>
      Effect.gen(function* () {
        const handlers = {
          boom: (): Effect.Effect<never, { _tag: "Boom"; msg: string }> =>
            Effect.fail({ _tag: "Boom" as const, msg: "kaboom" }),
        };
        const exit = yield* Effect.exit(roundTrip(handlers).boom());
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasFails(exit.cause)).toBe(true);
          const found = Cause.findErrorOption(exit.cause);
          expect(found._tag).toBe("Some");
          if (found._tag === "Some") {
            expect(found.value).toEqual({ _tag: "Boom", msg: "kaboom" });
          }
        }
      }),
    );

    it.effect("propagates Die (defect)", () =>
      Effect.gen(function* () {
        const handlers = {
          boom: () => Effect.die(new Error("defect")),
        };
        const exit = yield* Effect.exit(roundTrip(handlers).boom());
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
        }
      }),
    );

    it.effect("propagates Interrupt", () =>
      Effect.gen(function* () {
        const handlers = {
          boom: () => Effect.interrupt,
        };
        const exit = yield* Effect.exit(roundTrip(handlers).boom());
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }),
    );
  });

  describe("streams", () => {
    it.effect("round-trips a stream when streamKeys is honored", () =>
      Effect.gen(function* () {
        const handlers = {
          tail: (_n: number) => Stream.fromIterable([1, 2, 3, 4]),
        };
        const client = roundTrip(handlers, ["tail"] as const);
        const out: Array<number> = [];
        yield* Stream.runForEach(client.tail(0), (x) =>
          Effect.sync(() => {
            out.push(x);
          }),
        );
        expect(out).toEqual([1, 2, 3, 4]);
      }),
    );
  });

  describe("nested handlers", () => {
    it.effect("recurses into nested handler objects", () =>
      Effect.gen(function* () {
        const handlers = {
          group: {
            echo: (s: Redacted.Redacted<string>) =>
              Effect.succeed(Redacted.value(s)),
          },
        };
        const client = roundTrip(handlers);
        expect(yield* client.group.echo(Redacted.make("nested"))).toBe(
          "nested",
        );
      }),
    );
  });
});
