import { UserInputError } from "@/Cli/commands/errors.ts";
import {
  resolveConfig,
  include,
  exclude,
  validateSelectionOptions,
} from "@/Cli/commands/flags.ts";
import { DevOptions } from "@/Cli/DevOptions.ts";
import * as Stacks from "@/Alchemist/routes/stack.ts";
import * as Alchemist from "@/Alchemist/Runtime.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { describe, expect, it } from "alchemy-test";

describe("stack command config paths", { tags: ["unit", "local"] }, () => {
  it.effect("uses the positional config path", () =>
    Effect.gen(function* () {
      const args = yield* resolveConfig({
        config: undefined,
        configPath: "infra.ts",
      });
      expect(args.main).toBe("infra.ts");
    }),
  );

  it.effect("uses --config", () =>
    Effect.gen(function* () {
      const args = yield* resolveConfig({
        config: "infra.ts",
        configPath: undefined,
      });
      expect(args.main).toBe("infra.ts");
    }),
  );

  it.effect("defaults to alchemy.run.ts", () =>
    Effect.gen(function* () {
      const args = yield* resolveConfig({
        config: undefined,
        configPath: undefined,
      });
      expect(args.main).toBe("alchemy.run.ts");
    }),
  );

  it.effect("rejects using the positional path and --config together", () =>
    Effect.gen(function* () {
      const result = yield* resolveConfig({
        config: "flag.ts",
        configPath: "positional.ts",
      }).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toBeInstanceOf(UserInputError);
        expect(result.failure.message).toContain("not both");
      }
    }),
  );
});

describe("stack selection options", { tags: ["unit", "local"] }, () => {
  for (const [name, flag] of [
    ["include", include],
    ["exclude", exclude],
  ] as const) {
    for (const [values, expected] of [
      [[], undefined],
      [
        ["Branch,Password", "Namespace/**"],
        ["Branch,Password", "Namespace/**"],
      ],
      [[""], [""]],
      [["Branch,"], ["Branch,"]],
      [
        [" App/* ", "App/*", "App/*"],
        [" App/* ", "App/*", "App/*"],
      ],
    ] as const) {
      it.effect(
        `parses repeated --${name} patterns ${JSON.stringify(values)}`,
        () =>
          Effect.gen(function* () {
            const [, parsed] = yield* flag.parse({
              arguments: [],
              flags: values.length ? { [name]: [...values] } : {},
            });
            expect(parsed).toEqual(expected);
          }).pipe(Effect.provide(PlatformServices)),
      );
    }
  }

  it.effect(
    "retains include and exclude through dev reload JSON roundtrips",
    () =>
      Effect.gen(function* () {
        for (const include of [
          undefined,
          [],
          ["Branch,Password", "Namespace/**"],
        ]) {
          for (const exclude of [
            undefined,
            [],
            ["Namespace/Legacy", "**/.Private"],
          ]) {
            const options = {
              main: "alchemy.run.ts",
              stage: "test",
              envFile: Option.none(),
              force: false,
              include,
              exclude,
            };
            const wire = yield* Schema.encodeEffect(DevOptions)(options);
            const decoded = yield* Schema.decodeUnknownEffect(DevOptions)(
              JSON.parse(JSON.stringify(wire)),
            );
            expect(decoded.include).toEqual(include);
            expect(decoded.exclude).toEqual(exclude);
          }
        }
      }),
  );

  for (const selection of [
    { include: ["Branch"] },
    { exclude: ["Branch"] },
    { include: [] },
    { exclude: [] },
  ]) {
    for (const combination of [{ destroy: true }, { detectDrift: true }]) {
      it.effect(
        `rejects ${JSON.stringify(selection)} with ${JSON.stringify(combination)}`,
        () =>
          Effect.gen(function* () {
            const result = yield* validateSelectionOptions({
              ...selection,
              ...combination,
            }).pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            yield* validateSelectionOptions(combination);
          }),
      );
    }
    it.effect(
      `rejects Alchemist destroy ${JSON.stringify(selection)} before opening a stack session`,
      () =>
        Effect.gen(function* () {
          const exit = yield* Stacks.plan({
            target: { entrypoint: "does-not-exist.ts", stage: "test" },
            operation: "destroy",
            ...selection,
          }).pipe(Effect.exit);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Cause.pretty(exit.cause)).toContain(
              "Filtered destroy is not supported",
            );
        }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
    );
  }
});
