import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import { SparrowSettings } from "../settings.ts";
import {
  buildInitialSparrowProviderSnapshot,
  checkSparrowProviderStatus,
  matchesSparrowEnabledModels,
} from "./status.ts";

const encoder = new TextEncoder();

function makeCliSpawner(result: {
  readonly stdout?: string;
  readonly code?: number;
  readonly missing?: boolean;
}) {
  return ChildProcessSpawner.make(() =>
    result.missing
      ? Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            method: "spawn",
            module: "ChildProcess",
          }),
        )
      : Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(900_000_201),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code ?? 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: result.stdout ? Stream.succeed(encoder.encode(result.stdout)) : Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
  );
}

describe("matchesSparrowEnabledModels", () => {
  it("matches exact, bracketed, and glob patterns", () => {
    assert.isTrue(matchesSparrowEnabledModels(undefined, "magpie", "group/flash"));
    assert.isTrue(matchesSparrowEnabledModels(["magpie/<group/flash>"], "magpie", "group/flash"));
    assert.isTrue(matchesSparrowEnabledModels(["magpie/*"], "magpie", "group/flash"));
    assert.isFalse(
      matchesSparrowEnabledModels(["magpie/<group/flash>"], "openai-codex", "gpt-5.5"),
    );
  });
});

const DISABLED_SETTINGS = Schema.decodeSync(SparrowSettings)({ enabled: false });
const ENABLED_SETTINGS = Schema.decodeSync(SparrowSettings)({ enabled: true });
const decodeSparrowSettings = Schema.decodeEffect(SparrowSettings);

describe("checkSparrowProviderStatus", () => {
  it.effect("returns disabled snapshot when disabled in settings", () =>
    Effect.gen(function* () {
      const initial = yield* buildInitialSparrowProviderSnapshot(DISABLED_SETTINGS);
      assert.equal(initial.status, "disabled");
      const status = yield* checkSparrowProviderStatus(DISABLED_SETTINGS, {}).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(HostProcess.HomeDirectory, "/unused"),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              makeCliSpawner({ stdout: "sparrow 0.14.0\n" }),
            ),
          ),
        ),
      );
      assert.equal(status.status, "disabled");
      assert.equal(status.installed, false);
    }),
  );

  it.effect("reports missing binary cleanly", () =>
    Effect.gen(function* () {
      const status = yield* checkSparrowProviderStatus(ENABLED_SETTINGS, {}).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(HostProcess.HomeDirectory, "/unused"),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              makeCliSpawner({ missing: true }),
            ),
          ),
        ),
      );
      assert.equal(status.installed, false);
      assert.equal(status.status, "error");
    }),
  );

  it.effect("reports unconfigured when models.json is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "sparrow-status-empty-" });
      const settings = yield* decodeSparrowSettings({
        enabled: true,
        homePath: home,
      });
      const status = yield* checkSparrowProviderStatus(settings, { HOME: home }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(HostProcess.HomeDirectory, home),
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              makeCliSpawner({ stdout: "sparrow 0.14.0\n" }),
            ),
          ),
        ),
      );
      assert.equal(status.installed, true);
      assert.equal(status.version, "0.14.0");
      assert.equal(status.status, "error");
      assert.equal(status.auth.status, "unauthenticated");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "discovers configured models, thinking descriptors, env credentials, OAuth codex catalog, and prompts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "sparrow-status-ready-" });
        const configDir = path.join(home, ".config", "sparrow");
        yield* fs.makeDirectory(path.join(configDir, "prompts"), { recursive: true });
        yield* fs.writeFileString(
          path.join(configDir, "models.json"),
          JSON.stringify({
            providers: {
              magpie: {
                api: "openai-responses",
                baseUrl: "http://localhost:3425",
                apiKey: "$MAGPIE_KEY",
                models: [
                  {
                    id: "group/flash",
                    name: "Magpie Flash",
                    reasoning: true,
                    thinkingLevelMap: { high: "High", max: "Max" },
                  },
                  {
                    id: "ignored/model",
                    name: "Ignored Model",
                    reasoning: false,
                  },
                ],
              },
            },
          }),
        );
        yield* fs.writeFileString(
          path.join(configDir, "config.json"),
          JSON.stringify({
            defaultModel: "magpie/<group/flash>/max",
            enabledModels: ["magpie/<group/flash>", "openai-codex/gpt-5.5"],
          }),
        );
        yield* fs.writeFileString(
          path.join(configDir, "chatgpt-auth.json"),
          JSON.stringify({ access_token: "tok", account_id: "acct" }),
        );
        yield* fs.writeFileString(
          path.join(configDir, "prompts", "lint.md"),
          "---\ndescription: Run repo linter\n---\nCheck lint",
        );

        const settings = yield* decodeSparrowSettings({
          enabled: true,
          homePath: home,
        });
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          makeCliSpawner({ stdout: "sparrow 0.14.0\n" }),
        );

        // Missing env var marks magpie unavailable while openai-codex remains usable -> warning.
        const partial = yield* checkSparrowProviderStatus(settings, { HOME: home }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(HostProcess.HomeDirectory, home),
              spawnerLayer,
            ),
          ),
        );
        assert.equal(partial.status, "warning");
        assert.equal(
          partial.subProviders
            ?.find((s) => s.name === "magpie")
            ?.unavailableReason?.includes("MAGPIE_KEY"),
          true,
        );
        assert.deepEqual(
          partial.models.map((m) => m.slug),
          ["default", "openai-codex/gpt-5.5"],
        );

        // With MAGPIE_KEY present, both providers are ready and default points to Magpie Flash.
        const ready = yield* checkSparrowProviderStatus(settings, {
          HOME: home,
          MAGPIE_KEY: "secret",
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.succeed(HostProcess.HomeDirectory, home),
              spawnerLayer,
            ),
          ),
        );
        assert.equal(ready.status, "ready");
        assert.equal(ready.auth.status, "authenticated");
        assert.equal(ready.reportsContextWindow, true);
        assert.equal(ready.supportsTextGeneration, false);
        assert.deepEqual(ready.supportedRuntimeModes, [
          "read-only",
          "workspace-write",
          "full-access",
        ]);
        assert.deepEqual(
          ready.runtimeModes?.map((mode) => mode.label),
          ["Read only", "Workspace write", "Full access"],
        );
        assert.deepEqual(
          ready.models.map((m) => ({ slug: m.slug, name: m.name, subProvider: m.subProvider })),
          [
            { slug: "default", name: "Default (Magpie Flash)", subProvider: undefined },
            { slug: "magpie/group/flash", name: "Magpie Flash", subProvider: "magpie" },
            { slug: "openai-codex/gpt-5.5", name: "GPT-5.5", subProvider: "openai-codex" },
          ],
        );
        assert.deepEqual(ready.models[1]?.capabilities, {
          optionDescriptors: [
            {
              id: "thought_level",
              label: "Thinking",
              type: "select",
              role: "reasoning",
              currentValue: "max",
              options: [
                { id: "high", label: "High" },
                { id: "max", label: "Max", isDefault: true },
              ],
            },
          ],
        });
        assert.deepEqual(ready.slashCommands, [
          COMPACT_SLASH_COMMAND,
          { name: "lint", description: "Run repo linter" },
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
