import { UserInputError } from "@/Cli/commands/errors.ts";
import { resolveStage, stage } from "@/Cli/commands/flags.ts";
import { PlatformServices } from "@/Util/PlatformServices.ts";
import { describe, expect, test } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

const envLayer = (env: Record<string, string>) =>
  Layer.mergeAll(
    PlatformServices,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
  );

const TestEnv = envLayer({ USER: "sam" });

const writeEnvFile = (contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* fs.makeTempFileScoped();
    yield* fs.writeFileString(file, contents);
    return file;
  });

const withoutProcessStage = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const previous = {
      ALCHEMY_STAGE: process.env.ALCHEMY_STAGE,
      STAGE: process.env.STAGE,
    };
    delete process.env.ALCHEMY_STAGE;
    delete process.env.STAGE;
    return Effect.ensuring(
      effect,
      Effect.sync(() => {
        if (previous.ALCHEMY_STAGE === undefined) {
          delete process.env.ALCHEMY_STAGE;
        } else {
          process.env.ALCHEMY_STAGE = previous.ALCHEMY_STAGE;
        }
        if (previous.STAGE === undefined) {
          delete process.env.STAGE;
        } else {
          process.env.STAGE = previous.STAGE;
        }
      }),
    );
  });

describe("--stage flag", () => {
  test.effect("yields an omitted flag as undefined", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({ arguments: [], flags: {} });
      expect(selected).toBeUndefined();
    }).pipe(Effect.provide(TestEnv)),
  );

  test.effect("parses an explicit --stage flag", () =>
    Effect.gen(function* () {
      const [, selected] = yield* stage.parse({
        arguments: [],
        flags: { stage: ["preview"] },
      });
      expect(selected).toBe("preview");
    }).pipe(Effect.provide(TestEnv)),
  );
});

const provideStageTest = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, withoutProcessStage, Effect.provide(TestEnv));

describe("ALCHEMY_STAGE", () => {
  test.effect(
    "overrides the user default from --env-file / .env",
    () =>
      Effect.gen(function* () {
        const file = yield* writeEnvFile("ALCHEMY_STAGE=production\n");
        expect(yield* resolveStage("live", undefined, Option.some(file))).toBe(
          "production",
        );
      }).pipe(provideStageTest),
    { exclusive: true },
  );

  test.effect(
    "yields to an explicit --stage flag",
    () =>
      Effect.gen(function* () {
        const file = yield* writeEnvFile("ALCHEMY_STAGE=production\n");
        expect(yield* resolveStage("live", "preview", Option.some(file))).toBe(
          "preview",
        );
      }).pipe(provideStageTest),
    { exclusive: true },
  );

  test.effect(
    "ignores $STAGE",
    () =>
      Effect.gen(function* () {
        const file = yield* writeEnvFile("STAGE=production\n");
        expect(yield* resolveStage("live", undefined, Option.some(file))).toBe(
          "live_sam",
        );
      }).pipe(provideStageTest),
    { exclusive: true },
  );

  test.effect(
    "alchemy dev honors $ALCHEMY_STAGE",
    () =>
      Effect.gen(function* () {
        const file = yield* writeEnvFile("ALCHEMY_STAGE=production\n");
        expect(yield* resolveStage("dev", undefined, Option.some(file))).toBe(
          "production",
        );
      }).pipe(provideStageTest),
    { exclusive: true },
  );

  test.effect(
    "process env $ALCHEMY_STAGE overrides the user default",
    () =>
      Effect.gen(function* () {
        process.env.ALCHEMY_STAGE = "production";
        const file = yield* writeEnvFile("");
        expect(yield* resolveStage("live", undefined, Option.some(file))).toBe(
          "production",
        );
      }).pipe(provideStageTest),
    { exclusive: true },
  );

  test.effect(
    "rejects an invalid $ALCHEMY_STAGE",
    () =>
      Effect.gen(function* () {
        const file = yield* writeEnvFile("ALCHEMY_STAGE=not a stage\n");
        const result = yield* resolveStage(
          "live",
          undefined,
          Option.some(file),
        ).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure).toBeInstanceOf(UserInputError);
          expect(result.failure.message).toContain("$ALCHEMY_STAGE");
        }
      }).pipe(provideStageTest),
    { exclusive: true },
  );
});

describe("default stages", () => {
  test.effect(
    "deploy/destroy default to live_${USER}",
    () =>
      Effect.gen(function* () {
        const file = yield* writeEnvFile("");
        expect(yield* resolveStage("live", undefined, Option.some(file))).toBe(
          "live_sam",
        );
      }).pipe(provideStageTest),
    { exclusive: true },
  );

  test.effect(
    "alchemy dev defaults to dev_${USER}",
    () =>
      Effect.gen(function* () {
        const file = yield* writeEnvFile("");
        expect(yield* resolveStage("dev", undefined, Option.some(file))).toBe(
          "dev_sam",
        );
      }).pipe(provideStageTest),
    { exclusive: true },
  );
});
