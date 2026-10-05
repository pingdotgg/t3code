import * as Alchemist from "@/Alchemist";
import { describe, expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";

describe("Alchemist runtime", { tags: ["unit", "local"] }, () => {
  test("provides every service required by the programmatic stack API", () => {
    const deploy = Effect.gen(function* () {
      const snapshot = yield* Alchemist.Stack.plan({
        operation: "deploy",
        target: { entrypoint: "./alchemy.run.ts", stage: "prod" },
      });
      yield* Alchemist.Stack.apply(snapshot);
    });
    const runnable: Effect.Effect<void, unknown, never> = deploy.pipe(
      Effect.provide(Alchemist.layer()),
      Effect.scoped,
    );

    expect(Effect.isEffect(runnable)).toBe(true);
  });

  test("infers apply output from an explicitly supplied stack module", () => {
    type Module = {
      readonly default: Effect.Effect<{
        readonly output: { readonly url: string };
      }>;
    };

    const deploy = Effect.gen(function* () {
      const snapshot = yield* Alchemist.Stack.plan<Module>({
        operation: "deploy",
        target: { entrypoint: "./alchemy.run.ts", stage: "prod" },
      });
      const output = yield* Alchemist.Stack.apply(snapshot);
      const url: string = output.url;
      return url;
    });

    expect(Effect.isEffect(deploy)).toBe(true);
  });

  test("filtered apply exposes no stack output", () => {
    type Module = {
      readonly default: Effect.Effect<{
        readonly output: { readonly url: string };
      }>;
    };
    const deploy = Effect.gen(function* () {
      const snapshot = yield* Alchemist.Stack.plan<Module>({
        operation: "deploy",
        target: { entrypoint: "./alchemy.run.ts", stage: "prod" },
        include: ["Branch"],
      });
      const output: undefined = yield* Alchemist.Stack.apply(snapshot);
      return output;
    });
    expect(Effect.isEffect(deploy)).toBe(true);
  });

  test("legacy PlanInput stays full and optional filter inputs stay optional", () => {
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    type Output = { readonly url: string };
    type Module = {
      readonly default: Effect.Effect<{ readonly output: Output }>;
    };
    const input: Alchemist.Stack.PlanInput = {
      operation: "deploy",
      target: { entrypoint: "./alchemy.run.ts", stage: "prod" },
      force: true,
    };
    const full = Alchemist.Stack.plan<Module>(input);
    const excluded = Alchemist.Stack.plan<Module>({
      ...input,
      exclude: ["Other"],
    });
    const absent = Alchemist.Stack.plan<Module>({
      ...input,
      include: undefined,
      exclude: undefined,
    });
    const optional = (input: Alchemist.Stack.FilteredPlanInput) =>
      Alchemist.Stack.plan<Module>(input);
    const optionalExclude = (exclude?: ReadonlyArray<string>) =>
      Alchemist.Stack.plan<Module>({ ...input, exclude });
    const assertions: [
      Equal<Effect.Success<typeof full>["native"]["output"], Output>,
      Equal<Effect.Success<typeof excluded>["native"]["output"], undefined>,
      Equal<Effect.Success<typeof absent>["native"]["output"], Output>,
      Equal<
        Effect.Success<ReturnType<typeof optional>>["native"]["output"],
        Output | undefined
      >,
      Equal<
        Effect.Success<ReturnType<typeof optionalExclude>>["native"]["output"],
        Output | undefined
      >,
    ] = [true, true, true, true, true];
    expect(assertions.every(Boolean)).toBe(true);
  });

  test("full Alchemist inputs cannot erase known or optional filters", () => {
    type Assignable<A, B> = [A] extends [B] ? true : false;
    type Full = Alchemist.Stack.PlanInput;
    type Base = Omit<Full, "include" | "exclude">;
    const assignable: [
      Assignable<Base & { include: ReadonlyArray<string> }, Full>,
      Assignable<Base & { exclude: ReadonlyArray<string> }, Full>,
      Assignable<Base & { include?: ReadonlyArray<string> }, Full>,
      Assignable<Base & { exclude?: ReadonlyArray<string> }, Full>,
      Assignable<Alchemist.Stack.FilteredPlanInput, Full>,
    ] = [false, false, false, false, false];
    expect(assignable.some(Boolean)).toBe(false);
  });

  test("preserves explicit module output inference through higher-order planning", () => {
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    type Output = { readonly url: string };
    type Module = {
      readonly default: Effect.Effect<{ readonly output: Output }>;
    };
    const input: Alchemist.Stack.PlanInput = {
      operation: "deploy",
      target: { entrypoint: "./alchemy.run.ts", stage: "prod" },
      force: true,
    };
    const included = { ...input, include: ["Branch"] };
    const excluded = { ...input, exclude: ["Other"] };
    const optionalInput: Alchemist.Stack.FilteredPlanInput = input;
    const full = Effect.succeed(input).pipe(
      Effect.flatMap(Alchemist.Stack.plan<Module>),
    );
    const selected = Effect.succeed(included).pipe(
      Effect.flatMap(Alchemist.Stack.plan<Module, typeof included>),
    );
    const excludedPlan = Effect.succeed(excluded).pipe(
      Effect.flatMap(Alchemist.Stack.plan<Module, typeof excluded>),
    );
    const optional = Effect.succeed(optionalInput).pipe(
      Effect.flatMap(
        Alchemist.Stack.plan<Module, Alchemist.Stack.FilteredPlanInput>,
      ),
    );
    const selectedCallback = Effect.succeed(included).pipe(
      Effect.flatMap((input) => Alchemist.Stack.plan<Module>(input)),
    );
    const optionalCallback = Effect.succeed(optionalInput).pipe(
      Effect.flatMap((input) => Alchemist.Stack.plan<Module>(input)),
    );
    const fullApply = full.pipe(Effect.flatMap(Alchemist.Stack.apply));
    const selectedApply = selected.pipe(Effect.flatMap(Alchemist.Stack.apply));
    const optionalApply = optional.pipe(Effect.flatMap(Alchemist.Stack.apply));
    const assertions: [
      Equal<Effect.Success<typeof full>["native"]["output"], Output>,
      Equal<Effect.Success<typeof selected>["native"]["output"], undefined>,
      Equal<Effect.Success<typeof excludedPlan>["native"]["output"], undefined>,
      Equal<
        Effect.Success<typeof optional>["native"]["output"],
        Output | undefined
      >,
      Equal<
        Effect.Success<typeof selectedCallback>["native"]["output"],
        undefined
      >,
      Equal<
        Effect.Success<typeof optionalCallback>["native"]["output"],
        Output | undefined
      >,
      Equal<Effect.Success<typeof fullApply>, Output>,
      Equal<Effect.Success<typeof selectedApply>, undefined>,
      Equal<Effect.Success<typeof optionalApply>, Output | undefined>,
    ] = [true, true, true, true, true, true, true, true, true];
    expect(assertions.every(Boolean)).toBe(true);
  });
});
