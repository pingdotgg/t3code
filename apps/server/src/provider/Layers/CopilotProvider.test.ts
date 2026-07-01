import { ProviderDriverKind, type CopilotSettings } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as PlatformError from "effect/PlatformError";
import { Effect, FileSystem, Layer, Path, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { checkCopilotProviderStatus, getCopilotFallbackModels } from "./CopilotProvider.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const encoder = new TextEncoder();

function mockHandle(result: { stdout: string; stderr: string; code: number }) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockCommandSpawnerLayer(
  handler: (
    command: string,
    args: ReadonlyArray<string>,
  ) => { stdout: string; stderr: string; code: number },
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as { command: string; args: ReadonlyArray<string> };
      return Effect.succeed(mockHandle(handler(cmd.command, cmd.args)));
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

const enabledCopilotSettings: Partial<CopilotSettings> = {
  enabled: true,
};
const COPILOT_DRIVER = ProviderDriverKind.make("copilot");

const EXPECTED_COPILOT_BUILT_IN_MODEL_SLUGS = [
  "auto",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4o",
  "claude-fable-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-opus-4.5",
  "claude-opus-41",
  "claude-sonnet-5",
  "claude-sonnet-4.6",
  "claude-sonnet-4.5",
  "claude-sonnet-4",
  "claude-haiku-4.5",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
  "gemini-3-flash-preview",
  "gemini-2.5-pro",
  "grok-code-fast-1",
  "mai-code-1-flash-picker",
] as const;

const withNodeServices = <E, A, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, FileSystem.FileSystem | Path.Path>> =>
  effect.pipe(Effect.provide(NodeServices.layer)) as Effect.Effect<
    A,
    E,
    Exclude<R, FileSystem.FileSystem | Path.Path>
  >;

function reasoningCapabilities(includeXHigh: boolean) {
  return {
    optionDescriptors: [
      {
        id: "reasoning",
        label: "Reasoning",
        type: "select" as const,
        currentValue: "medium",
        options: [
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium", isDefault: true },
          { id: "high", label: "High" },
          ...(includeXHigh ? [{ id: "xhigh", label: "Extra High" }] : []),
        ],
      },
    ],
  };
}

describe("CopilotProvider", () => {
  it("builds the full Copilot model catalog plus unique custom models", () => {
    const models = getCopilotFallbackModels({
      customModels: ["custom-model", "gpt-5.4", "5.5", "custom-model"],
    });

    assert.deepStrictEqual(
      models.map((model) => model.slug),
      [...EXPECTED_COPILOT_BUILT_IN_MODEL_SLUGS, "custom-model"],
    );
    assert.deepStrictEqual(
      models.find((model) => model.slug === "gpt-5.5"),
      {
        slug: "gpt-5.5",
        name: "GPT-5.5",
        isCustom: false,
        capabilities: reasoningCapabilities(true),
      },
    );
    assert.deepStrictEqual(
      models.find((model) => model.slug === "claude-opus-4.8"),
      {
        slug: "claude-opus-4.8",
        name: "Claude Opus 4.8",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    );
    assert.deepStrictEqual(
      models.find((model) => model.slug === "auto"),
      {
        slug: "auto",
        name: "Auto",
        isCustom: false,
        capabilities: reasoningCapabilities(false),
      },
    );
    assert.deepStrictEqual(
      models.find((model) => model.slug === "claude-sonnet-4.6"),
      {
        slug: "claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    );
    assert.deepStrictEqual(models.at(-1), {
      slug: "custom-model",
      name: "custom-model",
      isCustom: true,
      capabilities: { optionDescriptors: [] },
    });
  });

  it.effect("keeps Copilot disabled and skips binary probing", () =>
    Effect.gen(function* () {
      const status = yield* checkCopilotProviderStatus();

      assert.strictEqual(status.driver, COPILOT_DRIVER);
      assert.strictEqual(status.enabled, false);
      assert.strictEqual(status.status, "disabled");
      assert.strictEqual(status.installed, false);
      assert.strictEqual(status.auth.status, "unknown");
      assert.strictEqual(status.models[0]?.slug, "auto");
      assert.strictEqual(status.message, "GitHub Copilot is disabled in T3 Code settings.");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({
            providers: {
              copilot: {
                enabled: false,
              },
            },
          }),
          failingSpawnerLayer("spawn copilot ENOENT"),
        ),
      ),
      withNodeServices,
    ),
  );

  it.effect("returns ready when Copilot CLI version probing succeeds", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-copilot-provider-home-",
      });
      const previousHome = process.env.HOME;
      process.env.HOME = homeDir;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousHome === undefined) {
            delete process.env.HOME;
          } else {
            process.env.HOME = previousHome;
          }
        }),
      );

      const status = yield* checkCopilotProviderStatus();

      assert.strictEqual(status.driver, COPILOT_DRIVER);
      assert.strictEqual(status.enabled, true);
      assert.strictEqual(status.status, "ready");
      assert.strictEqual(status.installed, true);
      assert.strictEqual(status.version, "1.2.3");
      assert.strictEqual(status.auth.status, "unknown");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({
            providers: {
              copilot: enabledCopilotSettings,
            },
          }),
          mockCommandSpawnerLayer((command, args) => {
            assert.strictEqual(command, "copilot");
            assert.deepStrictEqual(args, ["--version"]);
            return { stdout: "github-copilot-cli 1.2.3\n", stderr: "", code: 0 };
          }),
        ),
      ),
      withNodeServices,
      Effect.scoped,
    ),
  );

  it.effect("returns warning when Copilot CLI is missing", () =>
    Effect.gen(function* () {
      const status = yield* checkCopilotProviderStatus();

      assert.strictEqual(status.driver, COPILOT_DRIVER);
      assert.strictEqual(status.enabled, true);
      assert.strictEqual(status.status, "warning");
      assert.strictEqual(status.installed, false);
      assert.strictEqual(status.auth.status, "unknown");
      assert.strictEqual(
        status.message,
        "GitHub Copilot CLI was not found. Install it or configure the binary path in T3 Code settings.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({
            providers: {
              copilot: enabledCopilotSettings,
            },
          }),
          failingSpawnerLayer("spawn copilot ENOENT"),
        ),
      ),
      withNodeServices,
    ),
  );

  it.effect("falls back to help probing when version probing is unsupported", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const homeDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-copilot-provider-home-",
      });
      const previousHome = process.env.HOME;
      process.env.HOME = homeDir;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousHome === undefined) {
            delete process.env.HOME;
          } else {
            process.env.HOME = previousHome;
          }
        }),
      );

      const status = yield* checkCopilotProviderStatus();

      assert.deepStrictEqual(calls, ["copilot --version", "copilot --help"]);
      assert.strictEqual(status.driver, COPILOT_DRIVER);
      assert.strictEqual(status.status, "warning");
      assert.strictEqual(status.installed, true);
      assert.strictEqual(status.version, null);
      assert.strictEqual(status.message, "GitHub Copilot CLI version could not be determined.");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({
            providers: {
              copilot: enabledCopilotSettings,
            },
          }),
          mockCommandSpawnerLayer((command, args) => {
            calls.push(`${command} ${args.join(" ")}`);
            if (args.join(" ") === "--version") {
              return { stdout: "", stderr: "unknown option --version", code: 2 };
            }
            return { stdout: "usage: copilot\n", stderr: "", code: 0 };
          }),
        ),
      ),
      withNodeServices,
      Effect.scoped,
    );
  });

  it.effect("surfaces the configured Copilot model on the Auto provider model", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-copilot-provider-home-",
      });
      const previousHome = process.env.HOME;
      process.env.HOME = homeDir;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousHome === undefined) {
            delete process.env.HOME;
          } else {
            process.env.HOME = previousHome;
          }
        }),
      );
      const configPath = path.join(homeDir, ".copilot", "config.json");
      yield* fileSystem.makeDirectory(path.dirname(configPath), { recursive: true });
      yield* fileSystem.writeFileString(configPath, JSON.stringify({ model: "gpt-5.4" }));

      const status = yield* checkCopilotProviderStatus();

      assert.strictEqual(status.models[0]?.slug, "auto");
      assert.strictEqual(status.models[0]?.name, "Auto (gpt-5.4)");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({
            providers: {
              copilot: enabledCopilotSettings,
            },
          }),
          mockCommandSpawnerLayer(() => ({
            stdout: "github-copilot-cli 1.2.3\n",
            stderr: "",
            code: 0,
          })),
        ),
      ),
      withNodeServices,
      Effect.scoped,
    ),
  );

  it.effect("prefers project-scoped Copilot config when a cwd is provided", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-copilot-provider-home-",
      });
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3code-copilot-provider-project-",
      });
      const previousHome = process.env.HOME;
      process.env.HOME = homeDir;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previousHome === undefined) {
            delete process.env.HOME;
          } else {
            process.env.HOME = previousHome;
          }
        }),
      );

      const userConfigPath = path.join(homeDir, ".copilot", "config.json");
      const projectConfigPath = path.join(projectDir, ".copilot", "config.json");
      yield* fileSystem.makeDirectory(path.dirname(userConfigPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(projectConfigPath), { recursive: true });
      yield* fileSystem.writeFileString(userConfigPath, JSON.stringify({ model: "gpt-5.4" }));
      yield* fileSystem.writeFileString(
        projectConfigPath,
        JSON.stringify({ model: "claude-sonnet-4-5" }),
      );

      const status = yield* checkCopilotProviderStatus({ cwd: projectDir });

      assert.strictEqual(status.models[0]?.slug, "auto");
      assert.strictEqual(status.models[0]?.name, "Auto (claude-sonnet-4-5)");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettingsService.layerTest({
            providers: {
              copilot: enabledCopilotSettings,
            },
          }),
          mockCommandSpawnerLayer(() => ({
            stdout: "github-copilot-cli 1.2.3\n",
            stderr: "",
            code: 0,
          })),
        ),
      ),
      withNodeServices,
      Effect.scoped,
    ),
  );
});
