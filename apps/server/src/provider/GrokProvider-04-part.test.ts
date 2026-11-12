// @effect-diagnostics nodeBuiltinImport:off - resolves the mock ACP agent script path relative to this test file.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { GrokSettings } from "@t3tools/provider-grok/settings";

import {
  buildGrokModelCapabilities,
  checkGrokProviderStatus,
  grokSlashCommandsFromInitialize,
  parseGrokModelsCliOutput,
} from "@t3tools/provider-grok/testing";
import { execScriptSource, writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import { grokUsageResponseToLimits, readGrokAccount } from "@t3tools/provider-grok/testing";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));

const LOGGED_IN_MODELS_OUTPUT = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "  - grok-4.5",
  "",
].join("\n");

const LOGGED_OUT_MODELS_OUTPUT = LOGGED_IN_MODELS_OUTPUT.replace(
  "You are logged in with grok.com.",
  "You are not authenticated.",
);









it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("checkGrokProviderStatus", (it) => {
  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = writeFakeCli({
            directory: dir,
            name: "grok",
            source: [
              `process.stderr.write(${JSON.stringify(`${secretStderr}\n`)});`,
              "process.exit(2);",
              "",
            ].join("\n"),
          });

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect.each([
    {
      label: "answers after 6 s",
      versionDelay: "6 seconds",
      version: "1.0.52",
      message: "Grok CLI is installed but ACP initialize failed. Model options may be incomplete.",
      probesAfterVersion: true,
    },
    {
      label: "never answers",
      versionDelay: "Infinity",
      version: null,
      message: "Grok CLI is installed but timed out while running `grok --version`.",
      probesAfterVersion: false,
    },
  ] as const)("gives `grok --version` 10 s when it $label", (row) =>
    Effect.gen(function* () {
      // A fake CLI runs on wall time, so a stub answers `--version` on the test clock.
      const spawned: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        const args = ChildProcess.isStandardCommand(command) ? command.args : [];
        spawned.push(args.join(" "));
        if (!args.includes("--version")) {
          return Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "ChildProcess",
              method: "spawn",
              description: "Only `grok --version` is stubbed.",
            }),
          );
        }
        const handle = ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(900_000_201),
          exitCode: Effect.delay(Effect.succeed(ChildProcessSpawner.ExitCode(0)), row.versionDelay),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.encodeText(
            Stream.fromEffect(Effect.delay(Effect.succeed("grok 1.0.52\n"), row.versionDelay)),
          ),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
        return Effect.succeed(handle);
      });
      const fiber = yield* checkGrokProviderStatus(decodeGrokSettings({ enabled: true }), {}).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      const snapshot = yield* Fiber.join(fiber);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe(row.version);
      expect(snapshot.message).toBe(row.message);
      expect(spawned.length > 1).toBe(row.probesAfterVersion);
    }),
  );

  // A stand-in for the Grok CLI: `--version` and `models` print canned text,
  // and `agent stdio` execs the mock ACP agent so `initialize` returns model metadata.
  // A list of `models` outputs is served in call order, repeating the last one.
  const writeFakeGrokCli = (input: {
    readonly modelsOutput: string | ReadonlyArray<string>;
    readonly acp: boolean;
    readonly updateLogPath?: string;
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-probe-" });
      const mockAgentPath = NodePath.resolve(__dirname, "../../scripts/acp-mock-agent.ts");
      return writeFakeCli({
        directory: dir,
        name: "grok",
        source: [
          ...(input.updateLogPath
            ? [
                'import { appendFileSync as appendUpdateAttempt } from "node:fs";',
                'if (process.env.GROK_DISABLE_AUTOUPDATER !== "1") {',
                `  appendUpdateAttempt(${JSON.stringify(input.updateLogPath)}, "update\\n");`,
                "}",
              ]
            : []),
          'if (process.argv[2] === "--version") {',
          '  process.stdout.write("grok 1.0.13\\n");',
          "  process.exit(0);",
          "}",
          'if (process.argv[2] === "models") {',
          '  const fs = await import("node:fs");',
          `  const callsPath = ${JSON.stringify(NodePath.join(dir, "models-calls"))};`,
          '  const calls = fs.existsSync(callsPath) ? fs.readFileSync(callsPath, "utf8").length : 0;',
          '  fs.appendFileSync(callsPath, ".");',
          `  const outputs = ${JSON.stringify([input.modelsOutput].flat())};`,
          "  process.stdout.write(outputs[Math.min(calls, outputs.length - 1)]);",
          "  process.exit(0);",
          "}",
          'if (process.argv[2] !== "agent") process.exit(1);',
          ...(input.acp ? [execScriptSource({ scriptPath: mockAgentPath })] : ["process.exit(3);"]),
          "",
        ].join("\n"),
      });
    });

  it.effect("reports ready with ACP-discovered models without running startup updates", () =>
    Effect.gen(function* () {
      const environment = { ...process.env, XAI_API_KEY: "", GROK_DISABLE_AUTOUPDATER: "0" };
      const { snapshot, updateRan } = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-updater-" });
          const updateLogPath = NodePath.join(dir, "updates.log");
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: LOGGED_IN_MODELS_OUTPUT,
            acp: true,
            updateLogPath,
          });
          const snapshot = yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            environment,
          );
          return { snapshot, updateRan: yield* fs.exists(updateLogPath) };
        }),
      );

      expect(updateRan).toBe(false);
      expect(environment.GROK_DISABLE_AUTOUPDATER).toBe("0");
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.0.13");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "cached_token",
        label: "Grok account",
      });
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-4.6", "grok-mock-alt"]);
      expect(snapshot.models[0]?.isDefault).toBe(true);
      expect(
        snapshot.models[0]?.capabilities?.optionDescriptors?.map((option) => option.id) ?? [],
      ).toEqual(["reasoningEffort"]);
    }),
  );

  // An expired access token prints the logged-out banner, then the CLI refreshes it in the
  // same run, so the next `grok models` reports the login.
  it.effect("reports authenticated when `grok models` logs in after refreshing a token", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: [LOGGED_OUT_MODELS_OUTPUT, LOGGED_IN_MODELS_OUTPUT],
            acp: true,
          });
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { ...process.env, XAI_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("ready");
      expect(snapshot.auth.status).toBe("authenticated");
    }),
  );

  it.effect("falls back to CLI-listed models with a warning when ACP initialize fails", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: LOGGED_IN_MODELS_OUTPUT,
            acp: false,
          });
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { ...process.env, XAI_API_KEY: "" },
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.map((model) => [model.slug, model.isDefault ?? false])).toEqual([
        ["grok-4.6", true],
        ["grok-4.5", false],
      ]);
      expect(snapshot.message).toContain("ACP initialize failed");
      expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["compact"]);
    }),
  );

  it.effect("warns instead of reporting ready when no models are discovered", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: "You are logged in with grok.com.\n",
            acp: true,
          });
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { ...process.env, XAI_API_KEY: "", T3_ACP_OMIT_INITIALIZE_MODEL_STATE: "1" },
          );
        }),
      );

      expect(snapshot.status).toBe("warning");
      expect(snapshot.message).toContain("did not list any models");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
    }),
  );

  it.effect("treats XAI_API_KEY as authenticated regardless of CLI login state", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const grokPath = yield* writeFakeGrokCli({
            modelsOutput: LOGGED_OUT_MODELS_OUTPUT,
            acp: false,
          });
          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
            { ...process.env, XAI_API_KEY: "xai-test-key" },
          );
        }),
      );

      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "xAI API key",
      });
      expect(snapshot.status).toBe("warning");
    }),
  );
});

