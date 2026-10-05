import * as Alchemy from "@/index.ts";
import * as Deploy from "@/Deploy.ts";
import * as Destroy from "@/Destroy.ts";
import * as Plan from "@/Plan.ts";
import * as Cause from "effect/Cause";
import * as EffectExit from "effect/Exit";
import { TestLayers, TestResource } from "./test.resources.ts";
import { Stage } from "@/Stage.ts";
import * as State from "@/State/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import * as TestCore from "@/Test/Core.ts";
import type { TestApi as BunTestApi } from "@/Test/Bun.ts";
import type { TestApi as VitestTestApi } from "@/Test/Vitest.ts";
import { describe, expect, it } from "alchemy-test";
import type { ConfigError } from "effect/Config";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// These tests are compile-time assertions: they verify that the
// `Alchemy.Stack` effect permits a `ConfigError` in its body without
// forcing the user to `Effect.orDie`. See
// https://github.com/alchemy-run/alchemy/issues/479
describe("Alchemy.Stack error channel", { tags: ["unit", "local"] }, () => {
  it("allows ConfigError in the stack body", () => {
    // A stack body that reads from `effect/Config` fails with `ConfigError`.
    // Before #479 this required `Effect.orDie`; now it type-checks directly.
    const stack = Alchemy.Stack(
      "ConfigErrorStack",
      {
        providers: Layer.empty as any,
        state: Layer.empty as any,
      },
      Effect.gen(function* () {
        const value = yield* Config.String("SOME_CONFIG");
        return { value };
      }),
    );

    // The resulting effect surfaces `ConfigError` in its error channel rather
    // than `never` — the whole point of the change.
    type ErrorOf<T> = T extends Effect.Effect<any, infer E, any> ? E : never;
    const _assertError: ErrorOf<typeof stack> extends ConfigError
      ? true
      : false = true;
    expect(_assertError).toBe(true);
  });

  it("still accepts an infallible stack body", () => {
    const stack = Alchemy.Stack(
      "InfallibleStack",
      {
        providers: Layer.empty as any,
        state: Layer.empty as any,
      },
      Effect.succeed({ value: "ok" }),
    );

    const _stackName: string = stack.stackName;
    expect(_stackName).toBe("InfallibleStack");
    expect(typeof stack).toBe("object");
  });
});

describe("Alchemy.Stack runtime metadata", { tags: ["unit", "local"] }, () => {
  it("exposes stackName, providers, and state on a configured stack", () => {
    const providers = Layer.empty;
    const state = State.inMemoryState();
    const stack = Alchemy.Stack(
      "MetaStack",
      { providers, state },
      Effect.succeed({ value: "ok" }),
    );

    expect(stack.stackName).toBe("MetaStack");
    expect(stack.providers).toBe(providers);
    expect(stack.state).toBe(state);
  });

  it("exposes stackName on a class reference", () => {
    class NamedStack extends Alchemy.Stack<NamedStack, { value: string }>()(
      "NamedStack",
    ) {}

    expect(NamedStack.stackName).toBe("NamedStack");
  });

  it("exposes configured metadata identities on a class reference's make result", () => {
    class NamedStack extends Alchemy.Stack<NamedStack, { value: string }>()(
      "MadeStack",
    ) {}
    const providers = Layer.empty;
    const state = State.inMemoryState();
    const stack = NamedStack.make(
      { providers, state },
      Effect.succeed({ value: "ok" }),
    );

    expect(stack.stackName).toBe("MadeStack");
    expect(stack.providers).toBe(providers);
    expect(stack.state).toBe(state);
  });

  it("exposes only name metadata on the inline class reference form", () => {
    class InlineStack extends Alchemy.Stack<InlineStack>()(
      "InlineStack",
      { providers: Layer.empty, state: State.inMemoryState() },
      Effect.succeed({ value: "ok" }),
    ) {}

    expect(InlineStack.stackName).toBe("InlineStack");
    expect(InlineStack).toHaveProperty("providers", undefined);
    expect(InlineStack).toHaveProperty("state", undefined);
  });
});

describe("Test.make configured stack", { tags: ["unit", "local"] }, () => {
  const store = State.InMemoryService();
  const configured = Alchemy.Stack(
    "TestMetadataStack",
    { providers: Layer.empty, state: Layer.succeed(State.State, store) },
    Effect.map(Stage, (stage) => ({ stage })),
  );
  const defaults = Test.make(configured);
  const explicit = Test.make({ ...configured, stage: "metadata-explicit" });

  defaults.test(
    "uses a default stage string instead of the stack reference proxy",
    Effect.gen(function* () {
      expect(yield* State.State).toBe(store);
      const output = yield* defaults.deploy(configured);
      expect(typeof output.stage).toBe("string");
      expect(output.stage).toBe(Test.defaultStage());
      const state = yield* store;
      expect(
        yield* state.getOutput({
          stack: configured.stackName,
          stage: output.stage,
        }),
      ).toEqual(output);
    }).pipe(Effect.ensuring(defaults.destroy(configured).pipe(Effect.orDie))),
  );

  explicit.test(
    "honors file-level and per-call stage overrides",
    Effect.gen(function* () {
      const output = yield* explicit.deploy(configured);
      expect(output.stage).toBe("metadata-explicit");
      const override = yield* explicit.deploy(configured, {
        stage: "metadata-call",
      });
      expect(override.stage).toBe("metadata-call");
    }).pipe(
      Effect.ensuring(
        explicit
          .destroy(configured, { stage: "metadata-call" })
          .pipe(Effect.orDie),
      ),
      Effect.ensuring(explicit.destroy(configured).pipe(Effect.orDie)),
    ),
  );
});

describe("filtered deployment API", { tags: ["unit", "local"] }, () => {
  const store = State.InMemoryService();
  const state = Layer.succeed(State.State, store);
  const providers = TestLayers();
  const api = Test.make({
    providers,
    state,
    stage: "filtered-api",
    sidecar: false,
  });
  const program = Alchemy.Stack(
    "FilteredApi",
    { providers, state },
    Effect.gen(function* () {
      const branch = yield* TestResource("Branch", { string: "database" });
      const worker = yield* TestResource("Worker", { string: branch.string });
      return { branch: branch.string, worker: worker.string };
    }),
  );

  it("preserves legacy annotated options and exclude output inference across adapters", () => {
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    type Output = { branch: string; worker: string };
    type DeclaredOutput = Effect.Success<typeof program>["output"];
    const options: TestCore.DeployCallOptions = {
      stage: "override",
      force: true,
    };
    const full = api.deploy(program, options);
    const bun: BunTestApi["deploy"] = api.deploy;
    const vitest: VitestTestApi["deploy"] = api.deploy;
    const excluded = api.deploy(program, { exclude: ["Worker"] });
    const bunExcluded = bun(program, { exclude: ["Worker"] });
    const vitestExcluded = vitest(program, { exclude: ["Worker"] });
    const optional = (options?: TestCore.FilteredDeployCallOptions) =>
      api.deploy(program, options);
    const absent = api.deploy(program, {
      include: undefined,
      exclude: undefined,
    });
    const legacy: Deploy.DeployOptions<DeclaredOutput> = {
      stack: program,
      stage: "override",
      force: true,
    };
    const direct = Deploy.deploy(legacy);
    const piped = Effect.succeed(legacy).pipe(Effect.flatMap(Deploy.deploy));
    const filter = { ...legacy, exclude: ["Worker"] };
    const filtered = Effect.succeed(filter).pipe(Effect.flatMap(Deploy.deploy));
    const optionalDirect = (exclude?: ReadonlyArray<string>) =>
      Deploy.deploy({ ...legacy, exclude });
    const scratch = TestCore.scratchStack({ providers }, "ExcludedInference");
    const declaration = Effect.succeed({ value: "value" });
    const scratchExcluded = scratch.deploy(declaration, { exclude: ["Other"] });
    const scratchPlan = scratch.plan(declaration, { exclude: ["Other"] });
    const assertions: [
      Equal<Effect.Success<typeof full>, Output>,
      Equal<Effect.Success<typeof excluded>, undefined>,
      Equal<Effect.Success<typeof bunExcluded>, undefined>,
      Equal<Effect.Success<typeof vitestExcluded>, undefined>,
      Equal<Effect.Success<ReturnType<typeof optional>>, Output | undefined>,
      Equal<Effect.Success<typeof absent>, Output>,
      Equal<Effect.Success<typeof direct>, Output>,
      Equal<Effect.Success<typeof piped>, Output>,
      Equal<Effect.Success<typeof filtered>, undefined>,
      Equal<
        Effect.Success<ReturnType<typeof optionalDirect>>,
        Output | undefined
      >,
      Equal<Effect.Success<typeof scratchExcluded>, undefined>,
      Equal<Effect.Success<typeof scratchPlan>["output"], undefined>,
    ] = [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ];
    expect(assertions.every(Boolean)).toBe(true);
  });

  it("full deployment and adapter options cannot erase known or optional filters", () => {
    type Assignable<A, B> = [A] extends [B] ? true : false;
    type DeclaredOutput = Effect.Success<typeof program>["output"];
    type Full = Deploy.DeployOptions<DeclaredOutput>;
    type Base = Omit<Full, "include" | "exclude">;
    type CoreFull = TestCore.DeployCallOptions;
    type CoreBase = Omit<CoreFull, "include" | "exclude">;
    const assignable: [
      Assignable<Base & { include: ReadonlyArray<string> }, Full>,
      Assignable<Base & { exclude: ReadonlyArray<string> }, Full>,
      Assignable<Base & { include?: ReadonlyArray<string> }, Full>,
      Assignable<Base & { exclude?: ReadonlyArray<string> }, Full>,
      Assignable<Deploy.FilteredDeployOptions<DeclaredOutput>, Full>,
      Assignable<CoreBase & { include: ReadonlyArray<string> }, CoreFull>,
      Assignable<CoreBase & { exclude: ReadonlyArray<string> }, CoreFull>,
      Assignable<CoreBase & { include?: ReadonlyArray<string> }, CoreFull>,
      Assignable<CoreBase & { exclude?: ReadonlyArray<string> }, CoreFull>,
      Assignable<TestCore.FilteredDeployCallOptions, CoreFull>,
    ] = [false, false, false, false, false, false, false, false, false, false];
    expect(assignable.some(Boolean)).toBe(false);
  });

  for (const field of ["include", "exclude"]) {
    api.test(
      `destroy rejects injected ${field} before declaration or state effects`,
      Effect.gen(function* () {
        const options: { include?: never; exclude?: never } = {};
        yield* Effect.sync(() => Reflect.set(options, field, ["Branch"]));
        const blocked = Alchemy.Stack(
          "BlockedDestroy",
          { providers, state },
          Effect.die("declaration ran"),
        );
        const scratch = TestCore.scratchStack({ providers }, "BlockedScratch");
        const effects = [
          Plan.destroy({ name: "Blocked", stage: "test", ...options }).pipe(
            Effect.asVoid,
          ),
          Destroy.destroy({ stack: blocked, stage: "test", ...options }),
          api.destroy(blocked, options),
          scratch.destroy(options),
        ];
        for (const effect of effects) {
          const exit = yield* effect.pipe(Effect.exit);
          expect(EffectExit.isFailure(exit)).toBe(true);
          if (EffectExit.isFailure(exit))
            expect(Cause.pretty(exit.cause)).toContain(
              "Filtered destroy is not supported",
            );
        }
      }),
    );
  }

  it("preserves exact direct and piped output inference", () => {
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    type Output = { branch: string; worker: string };
    const full = api.deploy(program);
    const piped = program.pipe(api.deploy);
    const forced = api.deploy(program, { force: true });
    const stageOnly = api.deploy(program, { stage: "override" });
    const coreStageOnly = TestCore.deploy({ providers }, program, {
      stage: "override",
    });
    const selected = api.deploy(program, { include: ["Branch"] });
    const optional = (options: TestCore.FilteredDeployCallOptions) =>
      api.deploy(program, options);
    const core = TestCore.deploy({ providers }, program);
    const scratch = TestCore.scratchStack({ providers }, "OutputInference");
    const declaration = Effect.map(
      TestResource("Branch", { string: "database" }),
      (branch) => ({ branch: branch.string }),
    );
    const scratchFull = scratch.deploy(declaration);
    const scratchPiped = declaration.pipe(scratch.deploy);
    const scratchForced = scratch.deploy(declaration, { force: true });
    const scratchSelected = scratch.deploy(declaration, {
      include: ["Branch"],
    });
    const scratchOptional = (options: TestCore.FilteredDeployCallOptions) =>
      scratch.deploy(declaration, options);
    const plan = declaration.pipe(scratch.plan);
    const selectedPlan = scratch.plan(declaration, { include: ["Branch"] });
    const assertions: [
      Equal<Effect.Success<typeof full>, Output>,
      Equal<Effect.Success<typeof piped>, Output>,
      Equal<Effect.Success<typeof forced>, Output>,
      Equal<Effect.Success<typeof stageOnly>, Output>,
      Equal<Effect.Success<typeof coreStageOnly>, Output>,
      Equal<Effect.Success<typeof selected>, undefined>,
      Equal<Effect.Success<ReturnType<typeof optional>>, Output | undefined>,
      Equal<Effect.Success<typeof core>, Output>,
      Equal<Effect.Success<typeof scratchFull>, { branch: string }>,
      Equal<Effect.Success<typeof scratchPiped>, { branch: string }>,
      Equal<Effect.Success<typeof scratchForced>, { branch: string }>,
      Equal<Effect.Success<typeof scratchSelected>, undefined>,
      Equal<
        Effect.Success<ReturnType<typeof scratchOptional>>,
        { branch: string } | undefined
      >,
      Equal<
        Effect.Success<typeof plan>["output"],
        Effect.Success<typeof declaration>
      >,
      Equal<Effect.Success<typeof selectedPlan>["output"], undefined>,
    ] = [
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
    ];
    expect(assertions.every(Boolean)).toBe(true);
  });

  it("preserves exact direct and higher-order Deploy output types", () => {
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    type DeclaredOutput = Effect.Success<typeof program>["output"];
    type Output = { branch: string; worker: string };
    const options: Deploy.DeployOptions<DeclaredOutput> = {
      stack: program,
      stage: "override",
    };
    const direct = Deploy.deploy({ stack: program, stage: "override" });
    const piped = Effect.succeed(options).pipe(Effect.flatMap(Deploy.deploy));
    const explicit = Deploy.deploy<DeclaredOutput>({
      stack: program,
      stage: "override",
    });
    const forced = Deploy.deploy({
      stack: program,
      stage: "override",
      force: true,
    });
    const filteredOptions = {
      stack: program,
      stage: "override",
      include: ["Branch"],
    };
    const filtered = Deploy.deploy(filteredOptions);
    const filteredPiped = Effect.succeed(filteredOptions).pipe(
      Effect.flatMap(Deploy.deploy),
    );
    const optional = (options: Deploy.FilteredDeployOptions<DeclaredOutput>) =>
      Deploy.deploy(options);
    const optionalPiped = (
      options: Deploy.FilteredDeployOptions<DeclaredOutput>,
    ) => Effect.succeed(options).pipe(Effect.flatMap(Deploy.deploy));
    const assertions: [
      Equal<Effect.Success<typeof direct>, Output>,
      Equal<Effect.Success<typeof piped>, Output>,
      Equal<Effect.Success<typeof explicit>, Output>,
      Equal<Effect.Success<typeof forced>, Output>,
      Equal<Effect.Success<typeof filtered>, undefined>,
      Equal<Effect.Success<typeof filteredPiped>, undefined>,
      Equal<Effect.Success<ReturnType<typeof optional>>, Output | undefined>,
      Equal<
        Effect.Success<ReturnType<typeof optionalPiped>>,
        Output | undefined
      >,
    ] = [true, true, true, true, true, true, true, true];
    expect(assertions.every(Boolean)).toBe(true);
  });

  it("preserves explicit output types with stage options across test adapters", () => {
    type Equal<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
        ? true
        : false;
    type DeclaredOutput = Effect.Success<typeof program>["output"];
    type Output = { branch: string; worker: string };
    const bunDeploy: BunTestApi["deploy"] = api.deploy;
    const vitestDeploy: VitestTestApi["deploy"] = api.deploy;
    const adapter = api.deploy<DeclaredOutput>(program, { stage: "override" });
    const core = TestCore.deploy<DeclaredOutput>({ providers }, program, {
      stage: "override",
    });
    const bun = bunDeploy<DeclaredOutput>(program, { stage: "override" });
    const vitest = vitestDeploy<DeclaredOutput>(program, { stage: "override" });
    const full = api.deploy<DeclaredOutput>(program);
    const filtered = api.deploy<
      DeclaredOutput,
      [options: { include: ReadonlyArray<string> }]
    >(program, { include: ["Branch"] });
    const optional = (options: TestCore.FilteredDeployCallOptions) =>
      api.deploy<
        DeclaredOutput,
        [options?: TestCore.FilteredDeployCallOptions]
      >(program, options);
    const bunPiped = program.pipe(bunDeploy);
    const vitestPiped = program.pipe(vitestDeploy);
    const bunFiltered = bunDeploy(program, { include: ["Branch"] });
    const vitestFiltered = vitestDeploy(program, { include: ["Branch"] });
    const assertions: [
      Equal<Effect.Success<typeof adapter>, Output>,
      Equal<Effect.Success<typeof core>, Output>,
      Equal<Effect.Success<typeof bun>, Output>,
      Equal<Effect.Success<typeof vitest>, Output>,
      Equal<Effect.Success<typeof full>, Output>,
      Equal<Effect.Success<typeof filtered>, undefined>,
      Equal<Effect.Success<ReturnType<typeof optional>>, Output | undefined>,
      Equal<Effect.Success<typeof bunPiped>, Output>,
      Equal<Effect.Success<typeof vitestPiped>, Output>,
      Equal<Effect.Success<typeof bunFiltered>, undefined>,
      Equal<Effect.Success<typeof vitestFiltered>, undefined>,
    ] = [true, true, true, true, true, true, true, true, true, true, true];
    expect(assertions.every(Boolean)).toBe(true);
  });

  api.test(
    "selected then full deployment reuses the same persisted resource",
    Effect.gen(function* () {
      yield* api.destroy(program);
      const selected: void = yield* api.deploy(program, {
        include: ["Branch"],
      });
      expect(selected).toBeUndefined();
      const state = yield* store;
      const key = { stack: program.stackName, stage: "filtered-api" };
      const branch = yield* state.get({ ...key, fqn: "Branch" });
      expect(branch).toBeDefined();
      if (!branch || State.isActionState(branch)) {
        return yield* Effect.die("Expected a persisted Branch resource");
      }
      expect(yield* state.get({ ...key, fqn: "Worker" })).toBeUndefined();
      expect(yield* state.getOutput(key)).toBeUndefined();
      const full: { branch: string; worker: string } =
        yield* api.deploy(program);
      expect(full).toEqual({ branch: "database", worker: "database" });
      const piped: { branch: string; worker: string } = yield* program.pipe(
        api.deploy,
      );
      expect(piped).toEqual(full);
      expect(yield* state.get({ ...key, fqn: "Branch" })).toMatchObject({
        instanceId: branch.instanceId,
      });
      expect(yield* state.getOutput(key)).toEqual(full);
      const direct: void = yield* Deploy.deploy({
        stack: program,
        stage: key.stage,
        include: ["Branch"],
      });
      expect(direct).toBeUndefined();
      expect(yield* state.getOutput(key)).toEqual(full);
      const directFull: { branch: string; worker: string } =
        yield* Deploy.deploy({ stack: program, stage: key.stage });
      expect(directFull).toEqual(full);
      const invalid = yield* api
        .deploy(program, { include: [] })
        .pipe(Effect.exit);
      expect(EffectExit.isFailure(invalid)).toBe(true);
      expect(yield* state.getOutput(key)).toEqual(full);
      yield* api.destroy(program);
    }),
  );
});
