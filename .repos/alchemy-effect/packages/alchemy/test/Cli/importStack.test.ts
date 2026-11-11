import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@alchemy.run/test";
import * as TestCore from "@alchemy.run/test/Core";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import path from "pathe";
import { authRegistryLayer, collectAuthProviders } from "@/Alchemist/AuthRegistry.ts";
import { DEFAULT_ENTRYPOINT, importStack, StackModuleLoader } from "@/Alchemist/Entrypoint.ts";
import * as Alchemist from "@/Alchemist/index.ts";
import { buildProviders } from "@/Alchemist/Operations.ts";
import { Secrets, Stack, inMemoryState } from "@/index.ts";
import * as Interaction from "@/Interaction.ts";
import { evalStack } from "../../src/EvalStack";
import { TestLayers } from "../test.resources";

const fixtureAbsolutePath = fileURLToPath(
  import.meta.resolve("./fixtures/import-stack-fixture.ts"),
);
const fixtureRelativePath = path.relative(process.cwd(), fixtureAbsolutePath);

const runFixture = (path: string) =>
  TestCore.run(
    importStack(path).pipe(
      Effect.flatMap((stackEffect) =>
        evalStack(stackEffect, (stack) => Effect.succeed(stack.output), {
          stage: "test",
        }),
      ),
    ),
    {
      providers: TestLayers(),
    },
  );

describe("importStack", { tags: ["unit", "local"] }, () => {
  test("--env-file is rejected when the stack declares its own secrets", () =>
    TestCore.run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const envFile = path.join(dir, "cli.env");
        yield* fs.writeFileString(envFile, "ALCHEMY_DOTENV_SESSION_VALUE=cli");
        const stack = Stack(
          "session-secrets-declared",
          {
            state: inMemoryState(),
            providers: Layer.empty,
            secrets: [Secrets.DotEnv({ path: envFile })],
          },
          Config.String("ALCHEMY_DOTENV_SESSION_VALUE"),
        );
        const result = yield* importStack(fixtureAbsolutePath).pipe(
          Effect.flatMap((stack) =>
            Alchemist.plan({ stack, operation: "deploy", stage: "prod", envFile }),
          ),
          Effect.result,
          Effect.provideService(StackModuleLoader, {
            import: async () => ({ default: stack }),
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(String(result.failure)).toContain(
            "--env-file cannot be combined with a stack that declares `secrets`",
          );
        }
      }),
      { providers: TestLayers() },
    ));

  test("--env-file and --profile steer the default secrets for stack and provider-only builds", () =>
    TestCore.run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped();
        const envFile = path.join(dir, "cli.env");
        yield* fs.writeFileString(
          envFile,
          "ALCHEMY_DOTENV_SESSION_VALUE=cli\nALCHEMY_PROFILE=file-profile",
        );
        const observations: string[][] = [];
        const stack = Stack(
          "session-secrets-default",
          {
            state: inMemoryState(),
            providers: Layer.effectDiscard(
              Effect.gen(function* () {
                observations.push([
                  yield* Config.String("ALCHEMY_DOTENV_SESSION_VALUE"),
                  yield* Config.String("ALCHEMY_PROFILE"),
                ]);
              }).pipe(Effect.orDie),
            ),
          },
          Config.String("ALCHEMY_DOTENV_SESSION_VALUE"),
        );
        yield* Effect.gen(function* () {
          const plan = yield* importStack(fixtureAbsolutePath).pipe(
            Effect.flatMap((stack) =>
              Alchemist.plan({
                stack,
                operation: "deploy",
                stage: "prod",
                envFile,
                profile: "cli-profile",
              }),
            ),
          );
          // The flag's file replaces `.env` in the default list...
          expect(plan.native.output).toBe("cli");
          const providers = yield* importStack(fixtureAbsolutePath).pipe(
            Effect.flatMap((stack) => buildProviders(stack, { envFile, profile: "cli-profile" })),
          );
          expect(
            yield* Config.String("ALCHEMY_DOTENV_SESSION_VALUE").pipe(Effect.provide(providers)),
          ).toBe("cli");
          // ...and --profile beats the ALCHEMY_PROFILE the file sets.
          expect(observations).toEqual([
            ["cli", "cli-profile"],
            ["cli", "cli-profile"],
          ]);
        }).pipe(
          Effect.provideService(StackModuleLoader, {
            import: async () => ({ default: stack }),
          }),
        );
      }),
      { providers: TestLayers() },
    ));

  test("loads stack entrypoint via relative path", () =>
    expect(runFixture(fixtureRelativePath)).resolves.toBe("import-stack-fixture"));

  test("loads stack entrypoint via absolute path", () =>
    expect(runFixture(fixtureAbsolutePath)).resolves.toBe("import-stack-fixture"));

  test("memoizes an auth registry within its layer", async () => {
    const options = {
      main: DEFAULT_ENTRYPOINT,
      envFile: Option.none<string>(),
      profile: "default",
    };
    const [first, second] = await TestCore.run(
      Effect.all([collectAuthProviders(options), collectAuthProviders(options)]).pipe(
        Effect.provide(authRegistryLayer),
        Effect.provide(Interaction.layerNonInteractive()),
      ),
      { providers: TestLayers() },
    );

    expect(second).toBe(first);
  });

  test("reports a missing stack entrypoint as a user-facing error", async () => {
    const result = await TestCore.run(
      importStack(path.join(import.meta.dirname, "missing-alchemy.run.ts")).pipe(Effect.result),
      { providers: TestLayers() },
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("StackEntrypointError");
      expect(result.failure.message).toContain("does not exist");
      expect(result.failure.message).toContain("--config <path>");
    }
  });
});
