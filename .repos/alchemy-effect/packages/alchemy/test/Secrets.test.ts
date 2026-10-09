import {
  AlchemyContext,
  Secrets,
  Stack,
  Stage,
  inMemoryState,
  type SecretProviders,
  type StackSecrets,
} from "@/index.ts";
import { evalStack } from "@/Stack.ts";
import * as TestCore from "@/Test/Core.ts";
import { loadConfigProvider } from "@/Util/ConfigProvider.ts";
import { describe, expect, it } from "alchemy-test";
import * as Config from "effect/Config";
import type { ConfigError } from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import { MinimumLogLevel } from "effect/References";

const files = (contents: Record<string, string>) =>
  FileSystem.layerNoop({
    exists: (path) => Effect.succeed(path in contents),
    readFileString: (path) =>
      path in contents
        ? Effect.succeed(contents[path])
        : Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "readFileString",
              pathOrDescriptor: path,
            }),
          ),
  });

/**
 * Run with the real process environment temporarily changed; `undefined`
 * removes a variable. Tests using this must be `{ exclusive: true }`.
 */
const withProcessEnv = <A, E, R>(
  values: Record<string, string | undefined>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(
        Object.keys(values).map((key) => [key, process.env[key]]),
      );
      for (const [key, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  ).pipe(Effect.andThen(effect));

/** Build a stack with the given `secrets` and return its output. */
const runStack = <A>(
  name: string,
  secrets: StackSecrets | undefined,
  body: Effect.Effect<A, ConfigError>,
) =>
  Stack(
    name,
    { providers: Layer.empty, state: inMemoryState(), secrets },
    body,
  ).pipe(
    Effect.map((stack) => stack.output),
    Effect.provideService(AlchemyContext, {
      dotAlchemy: ".alchemy",
      dev: false,
      adopt: false,
    }),
  );

/** Run under a stage and a fake file system. */
const withFiles = <A, E, R>(
  contents: Record<string, string>,
  effect: Effect.Effect<A, E, R>,
  stage = "test",
) =>
  effect.pipe(
    Effect.provideService(Stage, stage),
    Effect.provide(files(contents)),
    Effect.scoped,
  );

const values = Effect.all({
  value: Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
  fallback: Config.String("ALCHEMY_DOTENV_TEST_FALLBACK"),
  empty: Config.String("ALCHEMY_DOTENV_TEST_EMPTY"),
});

describe("stack secrets", { tags: ["unit", "local"] }, () => {
  it.effect("scratch deploys and plans retain per-call config overrides", () =>
    TestCore.toEffect(
      Effect.gen(function* () {
        const stack = TestCore.scratchStack(
          { providers: Layer.empty },
          "scratch-config-overrides",
        );
        const read = Config.String("ALCHEMY_SCRATCH_CONFIG_VALUE");
        yield* stack.destroy();
        for (const value of ["first", "second"]) {
          const config = ConfigProvider.fromEnv({
            env: { ALCHEMY_SCRATCH_CONFIG_VALUE: value },
          });
          expect(
            yield* stack
              .deploy(read)
              .pipe(
                Effect.provideService(ConfigProvider.ConfigProvider, config),
              ),
          ).toBe(value);
          yield* stack
            .plan(
              read.pipe(
                Effect.tap((actual) =>
                  Effect.sync(() => {
                    expect(actual).toBe(value);
                  }),
                ),
              ),
            )
            .pipe(Effect.provideService(ConfigProvider.ConfigProvider, config));
        }
        yield* stack.destroy();
      }),
      { providers: Layer.empty, state: inMemoryState() },
    ),
  );

  it.effect(
    "the CLI loads .env without mutating process.env when secrets is omitted",
    () => {
      const before = process.env.ALCHEMY_DOTENV_TEST_VALUE;
      return withFiles(
        { ".env": "ALCHEMY_DOTENV_TEST_VALUE=default" },
        loadConfigProvider(Option.none()).pipe(
          Effect.flatMap((config) =>
            runStack(
              "dotenv-default",
              undefined,
              Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
            ).pipe(
              Effect.provideService(ConfigProvider.ConfigProvider, config),
            ),
          ),
          Effect.map((output) => {
            expect(output).toBe("default");
            expect(process.env.ALCHEMY_DOTENV_TEST_VALUE).toBe(before);
          }),
        ),
      );
    },
  );

  it.effect(
    "omitting secrets preserves the caller's complete ConfigProvider",
    () =>
      withFiles(
        { ".env": "ALCHEMY_DOTENV_TEST_FALLBACK=must-not-be-loaded" },
        runStack(
          "inherited-config",
          undefined,
          Effect.all({
            value: Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
            profile: Config.String("ALCHEMY_PROFILE"),
            absent: Config.String("ALCHEMY_DOTENV_TEST_FALLBACK").pipe(
              Config.option,
            ),
          }),
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({
              ALCHEMY_DOTENV_TEST_VALUE: "injected",
              ALCHEMY_PROFILE: "injected-profile",
            }),
          ),
          Effect.map((output) => {
            expect(output.value).toBe("injected");
            expect(output.profile).toBe("injected-profile");
            expect(Option.isNone(output.absent)).toBe(true);
          }),
        ),
      ),
  );

  it.effect("ignores a missing default .env", () =>
    withFiles(
      {},
      runStack("dotenv-missing-default", undefined, Effect.succeed("ok")).pipe(
        Effect.map((output) => expect(output).toBe("ok")),
      ),
    ),
  );

  it.effect(
    "isolates stage-specific config when stacks share a secrets layer",
    () => {
      const source = Secrets.DotEnv(({ stage }) => ({ path: `${stage}.env` }));
      const stack = runStack(
        "dotenv-isolation",
        [source],
        Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
      );
      return Effect.all(
        [
          stack.pipe(Effect.provideService(Stage, "dev")),
          stack.pipe(Effect.provideService(Stage, "prod")),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((outputs) => expect(outputs).toEqual(["dev", "prod"])),
        Effect.provide(
          files({
            "dev.env": "ALCHEMY_DOTENV_TEST_VALUE=dev",
            "prod.env": "ALCHEMY_DOTENV_TEST_VALUE=prod",
          }),
        ),
        Effect.scoped,
      );
    },
  );

  it.effect(
    "loads ordered path arrays from plain and stage-based options",
    () =>
      withFiles(
        {
          "base.env":
            "ALCHEMY_DOTENV_TEST_VALUE=base\nALCHEMY_DOTENV_TEST_FALLBACK=base\nALCHEMY_DOTENV_TEST_EMPTY=base",
          "prod.env":
            "ALCHEMY_DOTENV_TEST_VALUE=prod\nALCHEMY_DOTENV_TEST_EMPTY=",
        },
        Effect.gen(function* () {
          for (const source of [
            Secrets.DotEnv({ path: ["base.env", "prod.env"] }),
            Secrets.DotEnv(({ stage }) => ({
              path: ["base.env", `${stage}.env`] as const,
            })),
          ]) {
            expect(yield* runStack("dotenv-paths", [source], values)).toEqual({
              value: "prod",
              fallback: "base",
              empty: "",
            });
          }
        }),
        "prod",
      ),
  );

  it.effect(
    "secrets may be a single provider, a list, or a callback picking either",
    () => {
      const seen: Array<{ stack: string; dev: boolean }> = [];
      const stack = runStack(
        "secrets-by-stage",
        ({ stage, stack, alchemyContext }) => {
          seen.push({ stack: stack.name, dev: alchemyContext.dev });
          return stage === "dev"
            ? Secrets.DotEnv({ path: "dev.env" })
            : [Secrets.DotEnv({ path: "other.env" })];
        },
        Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
      );
      return Effect.all([
        stack.pipe(Effect.provideService(Stage, "dev")),
        stack.pipe(Effect.provideService(Stage, "prod")),
      ]).pipe(
        Effect.map((outputs) => {
          expect(outputs).toEqual(["dev", "other"]);
          expect(seen).toEqual([
            { stack: "secrets-by-stage", dev: false },
            { stack: "secrets-by-stage", dev: false },
          ]);
        }),
        Effect.provide(
          files({
            "dev.env": "ALCHEMY_DOTENV_TEST_VALUE=dev",
            "other.env": "ALCHEMY_DOTENV_TEST_VALUE=other",
          }),
        ),
        Effect.scoped,
      );
    },
  );

  it.effect("identifies the missing file in a path array", () =>
    withFiles(
      { "base.env": "" },
      runStack(
        "dotenv-missing-path",
        [Secrets.DotEnv({ path: ["base.env", "missing.env"] })],
        Effect.void,
      ).pipe(
        Effect.flip,
        Effect.map((error) => expect(error.message).toContain("missing.env")),
      ),
    ),
  );

  it.effect("explicit arrays exclude automatic and ambient dotenv values", () =>
    withFiles(
      { ".env": "ALCHEMY_DOTENV_TEST_DEFAULT=default", "explicit.env": "" },
      Effect.gen(function* () {
        for (const secrets of [
          [],
          [Secrets.DotEnv({ path: [] })],
          [Secrets.DotEnv({ path: "explicit.env" })],
        ]) {
          const output = yield* runStack(
            "dotenv-explicit",
            secrets,
            Config.String("ALCHEMY_DOTENV_TEST_DEFAULT").pipe(Config.option),
          );
          expect(Option.isNone(output)).toBe(true);
        }
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: { ALCHEMY_DOTENV_TEST_DEFAULT: "ambient" },
            }),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "selects files by stage and preserves earlier keys and empty overrides",
    () =>
      withFiles(
        {
          "base.env":
            "ALCHEMY_DOTENV_TEST_VALUE=base\nALCHEMY_DOTENV_TEST_FALLBACK=base\nALCHEMY_DOTENV_TEST_EMPTY=base",
          "config/prod.env":
            "ALCHEMY_DOTENV_TEST_VALUE=production\nALCHEMY_DOTENV_TEST_EMPTY=",
        },
        runStack(
          "dotenv-order",
          [
            Secrets.DotEnv({ path: "base.env" }),
            Secrets.DotEnv(({ stage }) => ({ path: `config/${stage}.env` })),
          ],
          values,
        ).pipe(
          Effect.map((output) =>
            expect(output).toEqual({
              value: "production",
              fallback: "base",
              empty: "",
            }),
          ),
        ),
        "prod",
      ),
  );

  it.effect(
    "provides secrets to state, providers, and subsequent stack operations",
    () => {
      const observed: string[] = [];
      return TestCore.toEffect(
        evalStack(
          Stack(
            "dotenv-services",
            {
              state: Layer.unwrap(
                Config.String("ALCHEMY_DOTENV_TEST_VALUE").pipe(
                  Effect.map((value) => {
                    observed.push(`state:${value}`);
                  }),
                  Effect.map(() => inMemoryState()),
                  Effect.orDie,
                ),
              ),
              providers: Layer.effectDiscard(
                Config.String("ALCHEMY_DOTENV_TEST_VALUE").pipe(
                  Effect.map((value) => {
                    observed.push(`providers:${value}`);
                  }),
                  Effect.orDie,
                ),
              ),
              secrets: [Secrets.DotEnv({ path: "services.env" })],
            },
            Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
          ).pipe(
            Effect.provide(
              files({ "services.env": "ALCHEMY_DOTENV_TEST_VALUE=secret" }),
            ),
          ),
          (stack) =>
            Effect.gen(function* () {
              expect(stack.output).toBe("secret");
              expect(yield* Config.String("ALCHEMY_DOTENV_TEST_VALUE")).toBe(
                "secret",
              );
              expect(observed).toEqual(["state:secret", "providers:secret"]);
            }),
          { stage: "test" },
        ),
        { providers: Layer.empty, state: inMemoryState() },
      );
    },
  );

  it.effect("fails for an explicitly missing file", () =>
    withFiles(
      {},
      runStack(
        "dotenv-missing-explicit",
        [Secrets.DotEnv({ path: "missing.env" })],
        Effect.void,
      ).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error._tag).toBe("ConfigError");
          expect(error.message).toContain("missing.env");
        }),
      ),
    ),
  );

  it.effect("does not replace an explicit empty path with .env", () =>
    withFiles(
      { ".env": "ALCHEMY_DOTENV_TEST_VALUE=default" },
      runStack(
        "dotenv-empty-path",
        Secrets.DotEnv({ path: "" }),
        Effect.void,
      ).pipe(
        Effect.flip,
        Effect.map((error) => expect(error._tag).toBe("ConfigError")),
      ),
    ),
  );

  it.effect("reapplies a shared provider at each position in the list", () => {
    const first = Secrets.DotEnv({ path: "first.env" });
    return withFiles(
      {
        "first.env": "ALCHEMY_DOTENV_TEST_VALUE=first",
        "second.env": "ALCHEMY_DOTENV_TEST_FALLBACK=second",
      },
      runStack(
        "dotenv-repeated-provider",
        [first, Secrets.DotEnv({ path: "second.env" }), first],
        Config.String("ALCHEMY_DOTENV_TEST_FALLBACK"),
      ).pipe(Effect.map((output) => expect(output).toBe("second"))),
    );
  });

  it.effect(
    "accepts native ConfigProvider layers; layerAdd merges, layer replaces",
    () =>
      withFiles(
        {},
        Effect.gen(function* () {
          const merged = yield* runStack(
            "native-config-layers",
            [
              ConfigProvider.layerAdd(
                ConfigProvider.fromEnv({
                  env: {
                    ALCHEMY_DOTENV_TEST_VALUE: "first",
                    ALCHEMY_DOTENV_TEST_FALLBACK: "fallback",
                  },
                }),
                { asPrimary: true },
              ),
              ConfigProvider.layerAdd(
                ConfigProvider.fromEnv({
                  env: { ALCHEMY_DOTENV_TEST_VALUE: "last" },
                }),
                { asPrimary: true },
              ),
            ],
            Effect.all([
              Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
              Config.String("ALCHEMY_DOTENV_TEST_FALLBACK"),
            ]),
          );
          expect(merged).toEqual(["last", "fallback"]);

          // A plain ConfigProvider.layer replaces everything before it.
          const replaced = yield* runStack(
            "native-config-layer-replaces",
            [
              ConfigProvider.layerAdd(
                ConfigProvider.fromEnv({
                  env: { ALCHEMY_DOTENV_TEST_FALLBACK: "fallback" },
                }),
                { asPrimary: true },
              ),
              ConfigProvider.layer(
                ConfigProvider.fromEnv({
                  env: { ALCHEMY_DOTENV_TEST_VALUE: "only" },
                }),
              ),
            ],
            Effect.all([
              Config.String("ALCHEMY_DOTENV_TEST_VALUE"),
              Config.String("ALCHEMY_DOTENV_TEST_FALLBACK").pipe(Config.option),
            ]),
          );
          expect(replaced[0]).toBe("only");
          expect(Option.isNone(replaced[1])).toBe(true);
        }),
      ),
  );

  it.effect(
    "ProcessEnv() preserves empty overrides; legacy --env-file keeps file precedence",
    () => {
      const key = "ALCHEMY_DOTENV_TEST_PROCESS";
      return withFiles(
        { "process.env": "ALCHEMY_DOTENV_TEST_PROCESS=file" },
        withProcessEnv(
          { [key]: "shell" },
          Effect.gen(function* () {
            for (const value of ["shell", ""]) {
              process.env[key] = value;
              const output = yield* runStack(
                "dotenv-process",
                [Secrets.DotEnv({ path: "process.env" }), Secrets.ProcessEnv()],
                Config.String(key),
              );
              expect(output).toBe(value);
              const provider = yield* loadConfigProvider(
                Option.some("process.env"),
              );
              expect(
                yield* Config.String(key).pipe(
                  Effect.provide(ConfigProvider.layer(provider)),
                ),
              ).toBe("file");
              expect(process.env[key]).toBe(value);
            }
          }),
        ),
      );
    },
    { exclusive: true },
  );

  it.effect("logs which keys each provider loaded at debug level", () => {
    const messages: string[] = [];
    const capture = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    return withFiles(
      {
        "base.env":
          "ALCHEMY_DOTENV_TEST_VALUE=hunter2\nALCHEMY_DOTENV_TEST_FALLBACK=base",
        "prod.env": "ALCHEMY_DOTENV_TEST_VALUE=hunter2",
        "empty.env": "",
      },
      runStack(
        "dotenv-logging",
        [
          Secrets.DotEnv({ path: "base.env" }),
          Secrets.DotEnv({ path: ["prod.env", "empty.env"] }),
        ],
        Effect.void,
      ).pipe(
        Effect.provide(Logger.layer([capture])),
        Effect.provideService(MinimumLogLevel, "Debug"),
        Effect.map(() => {
          expect(messages.slice(0, 2)).toEqual([
            "Loaded 2 secrets from dotenv (base.env): ALCHEMY_DOTENV_TEST_FALLBACK, ALCHEMY_DOTENV_TEST_VALUE",
            "Loaded 1 secrets from dotenv (prod.env, empty.env): ALCHEMY_DOTENV_TEST_VALUE",
          ]);
          // The implicit shell closes the list; it logs a count, never names.
          expect(messages[2]).toMatch(
            /^Loaded \d+ secrets from the process environment$/,
          );
          expect(messages).toHaveLength(3);
          // Keys only, never values.
          expect(messages.join("\n")).not.toContain("hunter2");
        }),
      ),
    );
  });

  it.effect(
    "the shell closes the list unless ProcessEnv() is placed or disabled",
    () => {
      const key = "ALCHEMY_DOTENV_TEST_PROCESS_POS";
      const read = (secrets: SecretProviders | undefined) =>
        runStack("dotenv-process-position", secrets, Config.String(key));
      const file = Secrets.DotEnv({ path: "pos.env" });
      return withFiles(
        { "pos.env": "ALCHEMY_DOTENV_TEST_PROCESS_POS=file" },
        withProcessEnv(
          { [key]: "shell" },
          Effect.gen(function* () {
            // Implicitly last: the shell wins over any list...
            expect(yield* read([file])).toBe("shell");
            expect(yield* read([])).toBe("shell");
            // ...unless it is placed, in which case position decides...
            expect(yield* read([Secrets.ProcessEnv(), file])).toBe("file");
            expect(yield* read([file, Secrets.ProcessEnv()])).toBe("shell");
            // ...or disabled, in which case it is never consulted.
            expect(
              yield* read([file, Secrets.ProcessEnv({ disabled: true })]),
            ).toBe("file");
            const disabled = yield* read([
              Secrets.ProcessEnv({ disabled: true }),
            ]).pipe(Effect.flip);
            expect(disabled._tag).toBe("ConfigError");
            const byStage = Secrets.ProcessEnv(({ stage }) => ({
              disabled: stage === "prod",
            }));
            expect(
              yield* read([file, byStage]).pipe(
                Effect.provideService(Stage, "dev"),
              ),
            ).toBe("shell");
            expect(
              yield* read([file, byStage]).pipe(
                Effect.provideService(Stage, "prod"),
              ),
            ).toBe("file");
          }),
        ),
      );
    },
    { exclusive: true },
  );

  it.effect(
    "ALCHEMY_PROFILE comes from the real process environment, never a provider",
    () => {
      const read = (secrets: SecretProviders) =>
        runStack(
          "dotenv-profile-pinned",
          secrets,
          Config.option(Config.String("ALCHEMY_PROFILE")),
        ).pipe(Effect.map(Option.getOrUndefined));
      const file = Secrets.DotEnv({ path: "profile.env" });
      // A provider listed after the file must also see the pinned value, since
      // that is where its credentials resolve the profile from.
      const seenByProvider: Array<string | undefined> = [];
      const observer = ConfigProvider.layerAdd(
        Effect.gen(function* () {
          seenByProvider.push(
            Option.getOrUndefined(
              yield* Config.option(Config.String("ALCHEMY_PROFILE")),
            ),
          );
          return ConfigProvider.fromEnv({ env: {} });
        }),
        { asPrimary: true },
      );
      return withFiles(
        { "profile.env": "ALCHEMY_PROFILE=file" },
        withProcessEnv(
          { ALCHEMY_PROFILE: undefined },
          Effect.gen(function* () {
            // A provider's ALCHEMY_PROFILE is filtered out...
            expect(yield* read([file])).toBeUndefined();
            expect(yield* read([file, Secrets.ProcessEnv()])).toBeUndefined();
            expect(yield* read([file, observer])).toBeUndefined();
            // ...while the shell's is seen even without ProcessEnv() listed.
            process.env.ALCHEMY_PROFILE = "shell";
            expect(yield* read([file])).toBe("shell");
            expect(yield* read([])).toBe("shell");
            expect(yield* read([file, observer])).toBe("shell");
            expect(seenByProvider).toEqual([undefined, "shell"]);
          }),
        ),
      );
    },
    { exclusive: true },
  );
});
