import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { fileURLToPath } from "node:url";
import path from "pathe";
import { describe, expect, test } from "alchemy-test";
import {
  collectAuthProviders,
  DEFAULT_ENTRYPOINT,
  importStack,
  open,
  routeCacheLayer,
} from "@/Alchemist/Session.ts";
import * as CliKit from "@/Cli/CliKit/index.ts";
import { evalStack } from "../../src/Stack";
import * as TestCore from "../../src/Test/Core";
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

describe("importStack", () => {
  test("loads stack entrypoint via relative path", () =>
    expect(runFixture(fixtureRelativePath)).resolves.toBe(
      "import-stack-fixture",
    ));

  test("loads stack entrypoint via absolute path", () =>
    expect(runFixture(fixtureAbsolutePath)).resolves.toBe(
      "import-stack-fixture",
    ));

  test("memoizes an opened stack session within a command scope", async () => {
    const [first, second] = await TestCore.run(
      Effect.all([
        open({ entrypoint: fixtureAbsolutePath, stage: "test" }),
        open({ entrypoint: fixtureAbsolutePath, stage: "test" }),
      ]).pipe(
        Effect.provide(routeCacheLayer),
        Effect.provide(CliKit.layer({ input: false })),
      ),
      { providers: TestLayers() },
    );

    expect(second).toBe(first);
  });

  test("memoizes an auth registry within a command scope", async () => {
    const options = {
      main: DEFAULT_ENTRYPOINT,
      envFile: Option.none<string>(),
      profile: "default",
    };
    const [first, second] = await TestCore.run(
      Effect.all([
        collectAuthProviders(options),
        collectAuthProviders(options),
      ]).pipe(
        Effect.provide(routeCacheLayer),
        Effect.provide(CliKit.layer({ input: false })),
      ),
      { providers: TestLayers() },
    );

    expect(second).toBe(first);
  });

  test("reports a missing stack entrypoint as a user-facing error", async () => {
    const result = await TestCore.run(
      importStack(
        path.join(import.meta.dirname, "missing-alchemy.run.ts"),
      ).pipe(Effect.result),
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
