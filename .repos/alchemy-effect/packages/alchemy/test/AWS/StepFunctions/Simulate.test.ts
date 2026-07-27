/**
 * In-process unit tests for the Step Functions program DSL: `Sfn.simulate`
 * interprets the SAME program the live `FromProgram.test.ts` deploys, plus
 * the ASL error semantics (`catchTag`, `retry`, `match`) and compile
 * determinism (the `normalizeDefinition` drift obligation).
 */
import { Sfn } from "@/AWS/StepFunctions";
import { describe, expect, it } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  makeOrderProgram,
  OrderRejected,
  type OrderInput,
} from "./fixtures/order-program.ts";

const doubler: Sfn.InvokableFunction = {
  LogicalId: "SfnDoubler",
  functionArn: "arn:aws:lambda:us-east-1:000000000000:function:doubler",
};

const doublerHandlers: Sfn.SimulateHandlers = {
  SfnDoubler: (payload) =>
    Effect.succeed({
      doubled: ((payload as { value: number }).value ?? 0) * 2,
    }),
};

describe("Sfn.simulate", () => {
  it.effect("runs the order program in-process", () =>
    Effect.gen(function* () {
      const result = yield* Sfn.simulate(
        makeOrderProgram(doubler),
        { value: 6, items: [1, 2, 3] } satisfies OrderInput,
        { handlers: doublerHandlers },
      );
      expect(result).toEqual({
        doubled: 12,
        items: [2, 4, 6],
        size: "big",
        recovered: "no stock",
      });
    }),
  );

  it.effect("takes the false Choice branch for small inputs", () =>
    Effect.gen(function* () {
      const result = yield* Sfn.simulate(
        makeOrderProgram(doubler),
        { value: 2, items: [] } satisfies OrderInput,
        { handlers: doublerHandlers },
      );
      expect(result.size).toBe("small");
      expect(result.items).toEqual([]);
    }),
  );

  it.effect("uncaught Sfn.fail surfaces as the typed failure", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Sfn.simulate(Sfn.fail(new OrderRejected({ reason: "nope" })), {}),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (
        Result.isFailure(result) &&
        !(result.failure instanceof Sfn.SimulateError)
      ) {
        expect(result.failure._tag).toBe("OrderRejected");
        expect(result.failure.reason).toBe("nope");
      }
    }),
  );

  it.effect("catchTag ignores non-matching tags", () =>
    Effect.gen(function* () {
      const program = Sfn.fail(new OrderRejected({ reason: "nope" })).pipe(
        Sfn.catchTag("SomethingElse", () => Sfn.succeed("recovered")),
      );
      const result = yield* Effect.result(Sfn.simulate(program, {}));
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("retry re-runs matching tags up to maxAttempts", () =>
    Effect.gen(function* () {
      class Transient extends Data.TaggedError("Transient")<{}> {}
      let calls = 0;
      const program = Sfn.invoke<{ ok: boolean }, Transient>(doubler).pipe(
        Sfn.retry({ while: "Transient", maxAttempts: 5 }),
      );
      const result = yield* Sfn.simulate(program, null, {
        handlers: {
          SfnDoubler: () =>
            Effect.suspend(() => {
              calls++;
              return calls < 3
                ? Effect.fail(new Transient())
                : Effect.succeed({ ok: true });
            }),
        },
      });
      expect(result).toEqual({ ok: true });
      expect(calls).toBe(3);
    }),
  );

  it.effect("retry does not retry non-matching tags", () =>
    Effect.gen(function* () {
      let calls = 0;
      const program = Sfn.invoke(doubler).pipe(
        Sfn.retry({ while: "Transient", maxAttempts: 5 }),
      );
      const result = yield* Effect.result(
        Sfn.simulate(program, null, {
          handlers: {
            SfnDoubler: () =>
              Effect.suspend(() => {
                calls++;
                return Effect.fail(new OrderRejected({ reason: "permanent" }));
              }),
          },
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(calls).toBe(1);
    }),
  );

  it.effect("match dispatches on literal cases with a fallback", () =>
    Effect.gen(function* () {
      const program = Sfn.gen(function* (input: Sfn.Expr<{ kind: string }>) {
        return yield* Sfn.match(
          input.kind,
          { a: Sfn.succeed(1), b: Sfn.succeed(2) },
          Sfn.succeed(0),
        );
      });
      expect(yield* Sfn.simulate(program, { kind: "b" })).toBe(2);
      expect(yield* Sfn.simulate(program, { kind: "z" })).toBe(0);
    }),
  );

  it.effect("all runs branches and returns the tuple", () =>
    Effect.gen(function* () {
      const program = Sfn.all([
        Sfn.succeed("left"),
        Sfn.invoke<{ doubled: number }>(doubler, { value: 4 }),
      ]);
      const result = yield* Sfn.simulate(program, null, {
        handlers: doublerHandlers,
      });
      expect(result).toEqual(["left", { doubled: 8 }]);
    }),
  );

  it.effect("waitForTaskToken dispatches to the integration handler", () =>
    Effect.gen(function* () {
      const program = Sfn.waitForTaskToken<{ approved: boolean }>({
        resource: "arn:aws:states:::sqs:sendMessage",
        arguments: { MessageBody: { token: Sfn.taskToken } },
      });
      const result = yield* Sfn.simulate(program, null, {
        taskToken: "tok-123",
        handlers: {
          "arn:aws:states:::sqs:sendMessage.waitForTaskToken": (payload) =>
            Effect.succeed({
              approved:
                (payload as { MessageBody: { token: string } }).MessageBody
                  .token === "tok-123",
            }),
        },
      });
      expect(result).toEqual({ approved: true });
    }),
  );

  it.effect("missing handler fails with SimulateError", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        Sfn.simulate(Sfn.invoke(doubler), null),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("SimulateError");
      }
    }),
  );
});

describe("Sfn.compileProgram", () => {
  it("compiles deterministically (drift-stable definitions)", () => {
    const first = Sfn.compileProgram(makeOrderProgram(doubler));
    const second = Sfn.compileProgram(makeOrderProgram(doubler));
    expect(JSON.stringify(first.definition)).toBe(
      JSON.stringify(second.definition),
    );
    expect(first.definition.QueryLanguage).toBe("JSONata");
    expect(typeof first.definition.StartAt).toBe("string");
    // one lambda:InvokeFunction statement per invoked function (deduped)
    expect(first.policyStatements).toHaveLength(1);
  });

  it("rejects unreachable steps after an unconditional Sfn.fail", () => {
    const program = Sfn.gen(function* () {
      yield* Sfn.fail(new OrderRejected({ reason: "always" }));
      yield* Sfn.succeed("unreachable");
      return null;
    });
    expect(() => Sfn.compileProgram(program)).toThrow(/unreachable steps/);
  });

  it("rejects yielding a non-Sfn value at compile time", () => {
    const program = Sfn.gen(function* () {
      // a real Effect is a compile-time type error; simulate the runtime
      // guard with a plain value smuggled past the types
      yield* Effect.succeed(1) as unknown as Sfn.SfnEffect<number>;
      return null;
    });
    expect(() => Sfn.compileProgram(program)).toThrow(
      /may only yield Sfn effects/,
    );
  });
});
