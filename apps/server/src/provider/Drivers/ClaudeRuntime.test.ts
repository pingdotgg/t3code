import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId, ProviderSetupError } from "@t3tools/contracts";
import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { makeClaudeQueryOptions } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import { buildClaudeCapabilitiesProbeQueryOptions } from "../ClaudeProvider.ts";
import {
  SYNTHETIC_CLAUDE_MODEL_CATALOG,
  SYNTHETIC_CLAUDE_STANDARD_MODEL,
} from "../ClaudeModelCatalog.testFixtures.ts";
import { resolveClaudeRuntime } from "./ClaudeHome.ts";
import { claudeUsageReader } from "./claudeUsage.ts";

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

const hostile = {
  ANTHROPIC_API_KEY: "host-key",
  CLAUDE_CODE_OAUTH_TOKEN: "host-token",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "1",
  CLAUDE_CODE_USE_MANTLE: "1",
  CLAUDE_CODE_USE_GATEWAY: "1",
  CLAUDE_SECURESTORAGE_CONFIG_DIR: "",
  anthropic_auth_token: "lowercase-key",
  claude_config_dir: "/lowercase-profile",
};

it.effect.each(["adapter", "probe"] as const)(
  "pins the %s final SDK child after ambient credentials are merged back in",
  (consumer) => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const runtime = yield* resolveClaudeRuntime({
        instanceId: ProviderInstanceId.make("one"),
        config: yield* decodeClaudeSettings({ setupMode: "cli" }),
        stateDir: "/state",
        environment: { ...process.env, ...hostile },
      });
      const signal = yield* Effect.abortSignal;
      const options =
        consumer === "adapter"
          ? makeClaudeQueryOptions({
              platform: yield* HostProcess.Platform,
              modelSelection: {
                instanceId: ProviderInstanceId.make("one"),
                model: "claude-sonnet-4-6",
              },
              nativeThreadId: "fixture",
              resume: false,
              cwd: "/project",
              settings: { ...runtime.config, launchArgs: "--settings /hostile/settings.json" },
              sdkSettings: { env: hostile, apiKeyHelper: "hostile-helper" },
              environment: runtime.environment,
            })
          : buildClaudeCapabilitiesProbeQueryOptions({
              platform: yield* HostProcess.Platform,
              executablePath: process.execPath,
              abortController: controller,
              environment: runtime.environment,
              cwd: "/project",
              managedMcpConfig: false,
              config: runtime.config,
            });
      expect(options.settings).toMatchObject({
        forceLoginMethod: "claudeai",
        apiKeyHelper: "",
        env: {
          ANTHROPIC_API_KEY: "",
          CLAUDE_CONFIG_DIR: "/state/providers/claude/one/cli",
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "/state/providers/claude/one/cli",
          CLAUDE_CODE_USE_ANTHROPIC_AWS: "0",
          CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "0",
          CLAUDE_CODE_USE_MANTLE: "0",
          CLAUDE_CODE_USE_GATEWAY: "0",
        },
      });
      if (consumer === "probe")
        expect(options.settingSources).toEqual(["user", "project", "local"]);
      expect(options.extraArgs?.settings).toBeUndefined();
      const observed = yield* Effect.tryPromise({
        try: () =>
          new Promise<string>((resolve, reject) => {
            const child = options.spawnClaudeCodeProcess!({
              command: process.execPath,
              args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
              signal,
              env: { ...options.env, ...hostile, AWS_PROFILE: "project-tools" },
            });
            let output = "";
            child.stdout.on("data", (chunk) => {
              output += chunk.toString();
            });
            child.on("error", reject);
            child.stdout.on("end", () => resolve(output));
            child.on("exit", (code) => {
              if (code !== 0) reject(new Error("Fixture child failed"));
            });
          }),
        catch: (cause) =>
          new ProviderSetupError({
            instanceId: ProviderInstanceId.make("one"),
            operation: "observeFixtureEnvironment",
            detail: "Could not observe the Claude fixture child environment.",
            cause,
          }),
      });
      const env = JSON.parse(observed);
      expect({
        config: env.CLAUDE_CONFIG_DIR,
        storage: env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
        aws: env.AWS_PROFILE,
        credential: env.ANTHROPIC_API_KEY ?? null,
        lowercaseCredential: env.anthropic_auth_token ?? null,
        gateway: env.CLAUDE_CODE_USE_GATEWAY ?? null,
      }).toEqual({
        config: "/state/providers/claude/one/cli",
        storage: "/state/providers/claude/one/cli",
        aws: "project-tools",
        credential: null,
        lowercaseCredential: null,
        gateway: null,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
  },
);

it.effect("runs text generation with private credentials and final account settings", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-private-textgen-" });
    const binaryPath = writeFakeCli({
      directory: root,
      name: "claude",
      platform: yield* HostProcess.Platform,
      source: `import fs from 'node:fs'; const args = process.argv.slice(2); fs.writeFileSync(process.env.T3_OBSERVATION, JSON.stringify({ env: process.env, settings: JSON.parse(args[args.indexOf('--settings')+1]) })); process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ structured_output: { title: 'Private account' } })));`,
    });
    const observation = path.join(root, "observation.json");
    const runtime = yield* resolveClaudeRuntime({
      instanceId: ProviderInstanceId.make("one"),
      config: yield* decodeClaudeSettings({ setupMode: "cli", binaryPath }),
      stateDir: root,
      environment: { ...process.env, ...hostile, T3_OBSERVATION: observation },
    });
    const generation = yield* makeClaudeTextGeneration(
      runtime.config,
      runtime.environment,
      Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
    );
    expect(
      (yield* generation.generateThreadTitle({
        cwd: root,
        message: "Title",
        modelSelection: {
          instanceId: ProviderInstanceId.make("one"),
          model: SYNTHETIC_CLAUDE_STANDARD_MODEL,
        },
      })).title,
    ).toBe("Private account");
    const actual = JSON.parse(yield* fs.readFileString(observation));
    expect({
      profile: actual.env.CLAUDE_CONFIG_DIR,
      storage: actual.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
      credential: actual.env.ANTHROPIC_API_KEY ?? null,
    }).toEqual({ profile: runtime.configDir, storage: runtime.configDir, credential: null });
    expect(actual.settings).toMatchObject({
      disableAllHooks: true,
      forceLoginMethod: "claudeai",
      apiKeyHelper: "",
      env: { CLAUDE_CONFIG_DIR: runtime.configDir, CLAUDE_CODE_USE_MANTLE: "0" },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reads each Claude account's usage from its own transcript directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const existing = path.join(stateDir, "existing");
    const homes = [
      path.join(stateDir, "providers", "claude", "one", "cli"),
      path.join(stateDir, "providers", "claude", "two", "cli"),
      existing,
    ];
    for (const [index, home] of homes.entries()) {
      yield* fs.makeDirectory(path.join(home, "projects"), { recursive: true });
      yield* fs.writeFileString(
        path.join(home, "projects", "usage.jsonl"),
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-01-01T00:00:00Z",
          sessionId: `session-${index}`,
          message: { model: "claude-sonnet-4-6", usage: { output_tokens: index + 1 } },
        }),
      );
    }
    const records = [];
    for (const id of ["one", "two", "existing"]) {
      const config = yield* decodeClaudeSettings({
        ...(id === "existing" ? {} : { setupMode: "cli" }),
        homePath: existing,
      });
      if (claudeUsageReader.kind !== "transcripts") throw new Error("Expected transcript usage");
      const directories = yield* claudeUsageReader.directories({
        instanceId: ProviderInstanceId.make(id),
        config,
        environment: { CLAUDE_CONFIG_DIR: existing },
        configured: true,
      });
      const raw = yield* fs.readFileString(path.join(directories[0]!.dir, "usage.jsonl"));
      records.push(
        claudeUsageReader.format
          .parseLine(raw, undefined)
          .map((record) => ({ session: record.sessionId, output: record.totals.outputTokens })),
      );
    }
    expect(records).toEqual([
      [{ session: "session-0", output: 1 }],
      [{ session: "session-1", output: 2 }],
      [{ session: "session-2", output: 3 }],
    ]);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-private-usage-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
