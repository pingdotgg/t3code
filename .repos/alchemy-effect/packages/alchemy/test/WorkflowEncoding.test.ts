import { describe, expect, it } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { Workflow } from "effect/workflow";
import { decodeResult, encodeResult } from "@/WorkflowEncoding.ts";

const workflow = <Success extends Schema.Top, Error extends Schema.Top = Schema.Never>(
  success: Success,
  error?: Error,
) =>
  Workflow.make("Encoding", {
    payload: {},
    success,
    error: error ?? Schema.Never,
    idempotencyKey: () => "test",
  });

class Denied extends Schema.TaggedError<Denied>()("Denied", {
  code: Schema.NumberFromString,
}) {}

class Offset extends Context.Service<Offset, number>()("WorkflowEncoding/Offset") {}

const transformed = Schema.NumberFromString.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transformEffect((value: number) =>
      Offset.pipe(Effect.map((offset) => value + offset)),
    ),
    encode: SchemaGetter.transformEffect((value: number) =>
      Offset.pipe(Effect.map((offset) => value - offset)),
    ),
  }),
);

describe("Workflow result encoding", { tags: ["unit", "local"] }, () => {
  it.effect("preserves the wire format and returns fresh values on repeated decoding", () =>
    Effect.gen(function* () {
      const definition = workflow(Schema.Struct({ items: Schema.Array(Schema.String) }));
      const exit = Exit.succeed({ items: ["first"] });
      const codec = Schema.toCodecJson(
        Schema.Exit(definition.successSchema, definition.errorSchema, Schema.Defect()),
      );
      const expected = JSON.stringify(yield* Schema.encodeEffect(codec)(exit));
      for (let i = 0; i < 3; i++) {
        const text = yield* encodeResult(definition, exit);
        expect(text).toBe(expected);
        const first = yield* decodeResult(definition, text);
        const second = yield* decodeResult(definition, text);
        expect(first.exit).toEqual(exit);
        expect(second.exit).toEqual(exit);
        expect(first).not.toBe(second);
        if (Exit.isSuccess(first.exit) && Exit.isSuccess(second.exit)) {
          expect(first.exit.value).not.toBe(second.exit.value);
        }
      }
    }),
  );

  it.effect("preserves transformed successes and typed failures with a warm codec", () =>
    Effect.gen(function* () {
      const definition = workflow(
        Schema.Struct({ count: Schema.NumberFromString, date: Schema.DateFromString }),
        Denied,
      );
      const value = { count: 42, date: new Date("2026-01-02T03:04:05.000Z") };
      for (let i = 0; i < 3; i++) {
        const success = yield* encodeResult(definition, Exit.succeed(value));
        expect(success).toContain('"count":"42"');
        expect((yield* decodeResult(definition, success)).exit).toEqual(Exit.succeed(value));
        const failure = yield* encodeResult(definition, Exit.fail(new Denied({ code: 7 })));
        expect(failure).toContain('"code":"7"');
        const decoded = yield* decodeResult(definition, failure);
        expect(Exit.isFailure(decoded.exit)).toBe(true);
        if (Exit.isFailure(decoded.exit)) {
          const error = Cause.squash(decoded.exit.cause);
          expect(error).toBeInstanceOf(Denied);
          expect(error).toMatchObject({ _tag: "Denied", code: 7 });
        }
      }
    }),
  );

  it.effect("preserves defects and interruption after caching a successful result", () =>
    Effect.gen(function* () {
      const definition = workflow(Schema.String);
      yield* encodeResult(definition, Exit.succeed("warm"));
      for (let i = 0; i < 3; i++) {
        const defect = yield* encodeResult(definition, Exit.die(new Error("broken")));
        const decoded = yield* decodeResult(definition, defect);
        expect(Exit.isFailure(decoded.exit)).toBe(true);
        if (Exit.isFailure(decoded.exit)) {
          expect(Cause.hasDies(decoded.exit.cause)).toBe(true);
          expect(Cause.squash(decoded.exit.cause)).toMatchObject({ message: "broken" });
        }
        const interrupted = yield* encodeResult(definition, Exit.interrupt());
        const decodedInterrupt = yield* decodeResult(definition, interrupted);
        expect(Exit.isFailure(decodedInterrupt.exit)).toBe(true);
        if (Exit.isFailure(decodedInterrupt.exit)) {
          expect(Cause.hasInterrupts(decodedInterrupt.exit.cause)).toBe(true);
        }
      }
    }),
  );

  it.effect("keeps same-name definitions with different schema pairs independent", () =>
    Effect.gen(function* () {
      const text = workflow(Schema.String, Schema.String);
      const number = workflow(Schema.NumberFromString, Schema.String);
      const numericError = workflow(Schema.String, Schema.NumberFromString);
      for (let i = 0; i < 3; i++) {
        expect(
          (yield* decodeResult(text, yield* encodeResult(text, Exit.succeed("42")))).exit,
        ).toEqual(Exit.succeed("42"));
        expect(
          (yield* decodeResult(number, yield* encodeResult(number, Exit.succeed(42)))).exit,
        ).toEqual(Exit.succeed(42));
        const encoded = yield* encodeResult(numericError, Exit.fail(7));
        expect((yield* decodeResult(numericError, encoded)).exit).toEqual(Exit.fail(7));
      }
    }),
  );

  it.effect("uses replacement schema references on an existing workflow definition", () =>
    Effect.gen(function* () {
      const definition = workflow(Schema.String, Schema.String);
      yield* encodeResult(definition, Exit.succeed("warm"));
      // Workflow fields are readonly in TypeScript, but runtime adapters can replace them.
      Object.assign(definition, {
        successSchema: Schema.NumberFromString,
        errorSchema: Schema.NumberFromString,
      });
      const success = yield* encodeResult(definition, Exit.succeed(42));
      expect((yield* decodeResult(definition, success)).exit).toEqual(Exit.succeed(42));
      const failure = yield* encodeResult(definition, Exit.fail(7));
      expect((yield* decodeResult(definition, failure)).exit).toEqual(Exit.fail(7));
    }),
  );

  it.effect("evaluates cached transformations in each call's current context", () =>
    Effect.gen(function* () {
      const definition = workflow(transformed);
      for (const offset of [1, 2, 10]) {
        const text = yield* encodeResult(definition, Exit.succeed(42)).pipe(
          Effect.provideService(Offset, offset),
        );
        expect(text).toContain(`"value":"${42 - offset}"`);
        const result = yield* decodeResult(definition, text).pipe(
          Effect.provideService(Offset, offset),
        );
        expect(result.exit).toEqual(Exit.succeed(42));
      }
    }),
  );

  it.effect("still rejects invalid values after warming the codec", () =>
    Effect.gen(function* () {
      const definition = workflow(Schema.String);
      const valid = yield* encodeResult(definition, Exit.succeed("warm"));
      const encoded = yield* Effect.exit(encodeResult(definition, Exit.succeed(42)));
      expect(Exit.isFailure(encoded)).toBe(true);
      const invalid = valid.replace('"warm"', "42");
      const decoded = yield* Effect.exit(decodeResult(definition, invalid));
      expect(Exit.isFailure(decoded)).toBe(true);
    }),
  );
});
