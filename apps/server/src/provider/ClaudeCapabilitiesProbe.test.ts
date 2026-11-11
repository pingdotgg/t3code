// @effect-diagnostics nodeBuiltinImport:off - an SDK mock rewrites a cache file while the probe awaits it, outside any Effect.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* decodeClaudeSettings({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const cachedReading = { five_hour: { utilization: 2, resets_at: "2026-11-12T01:00:00.000Z" } };
const cacheEntry = (fetchedAtMs: number, utilization: unknown) =>
  JSON.stringify({ cachedUsageUtilization: { fetchedAtMs, utilization } });

// The clock reads 00:10 when the probe starts; Claude Code fetched the cached reading at 00:01.
it.effect.each([
  { name: "the cache entry it answered from", layout: "configDir", expected: "01" },
  { name: "no cache entry at Claude Code's path", layout: "none", expected: "10" },
  {
    name: "a cache another session replaced during the call",
    layout: "replaced",
    expected: "01",
  },
  { name: "a config dir relative to the probe's cwd", layout: "relative", expected: "01" },
  { name: "the HOME the probe runs with", layout: "home", expected: "01" },
  { name: "nothing when the cache cannot be read", layout: "unreadable", expected: undefined },
  { name: "nothing when the cache read does not answer", layout: "stalled", expected: undefined },
] as const)("dates a Claude usage reading by $name", ({ layout, expected }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped();
    const cacheFile =
      layout === "home" ? `${root}/home/.claude.json` : `${root}/claude-config/.claude.json`;
    yield* fileSystem.makeDirectory(`${root}/home`);
    yield* fileSystem.makeDirectory(`${root}/claude-config`);
    yield* fileSystem.makeDirectory(`${root}/host-home`);
    if (layout !== "none")
      yield* fileSystem.writeFileString(cacheFile, cacheEntry(60_000, cachedReading));
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(
      () =>
        ({
          initializationResult: async () => ({
            account: { subscriptionType: "max", tokenSource: "oauth" },
            commands: [],
          }),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
            if (layout === "replaced") {
              NodeFS.writeFileSync(
                cacheFile,
                cacheEntry(540_000, { five_hour: { utilization: 100 } }),
              );
            }
            return { rate_limits_available: true, rate_limits: cachedReading };
          },
        }) as unknown as ReturnType<typeof ClaudeSdk.query>,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const { PATH } = yield* HostProcess.Environment;
    const environment =
      layout === "home"
        ? { PATH, HOME: `${root}/home` }
        : {
            PATH,
            CLAUDE_CONFIG_DIR: layout === "relative" ? "claude-config" : `${root}/claude-config`,
          };
    yield* TestClock.adjust("10 minutes");
    const stallStarted = yield* Deferred.make<void>();
    let stalls = layout === "stalled" ? 1 : 0;
    const readFileString: FileSystem.FileSystem["readFileString"] = (path, encoding) => {
      if (path === cacheFile && layout === "unreadable") {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFileString",
            pathOrDescriptor: path,
          }),
        );
      }
      if (path === cacheFile && stalls > 0) {
        stalls -= 1;
        return Deferred.succeed(stallStarted, undefined).pipe(Effect.andThen(Effect.never));
      }
      return fileSystem.readFileString(path, encoding);
    };
    const probe = probeClaudeCapabilities(
      yield* decodeClaudeSettings({ binaryPath: "claude" }),
      environment,
      layout === "relative" ? root : undefined,
    ).pipe(
      Effect.provideService(HostProcess.HomeDirectory, `${root}/host-home`),
      Effect.provideService(FileSystem.FileSystem, { ...fileSystem, readFileString }),
    );
    const fiber = yield* Effect.forkChild(probe);
    if (layout === "stalled") {
      yield* Deferred.await(stallStarted);
      yield* TestClock.adjust("2 seconds");
    }
    const capabilities = yield* Fiber.join(fiber);
    assert.equal(
      capabilities.usageCheckedAt,
      expected === undefined ? undefined : `1970-01-01T00:${expected}:00.000Z`,
    );
    if (expected === undefined) assert.equal(capabilities.usage, undefined);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps the probe subprocess alive while gateway model discovery can finish", () =>
  Effect.gen(function* () {
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
          models: [{ value: "gateway/claude-relay", displayName: "Relay", description: "" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () =>
          new Promise((_, reject) => reject(new Error("usage unavailable"))),
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const fileSystem = yield* FileSystem.FileSystem;
    const configDir = yield* fileSystem.makeTempDirectoryScoped();
    // Claude Code also reads these from settings.json, which is where gateway users set them.
    yield* fileSystem.writeFileString(
      `${configDir}/settings.json`,
      JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: "https://gateway.example",
          CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
        },
      }),
    );
    const capabilities = yield* probeClaudeCapabilities(
      yield* decodeClaudeSettings({ binaryPath: "claude" }),
      { PATH: (yield* HostProcess.Environment).PATH, CLAUDE_CONFIG_DIR: configDir },
    );
    assert.deepEqual(
      capabilities.models?.map((model) => model.value),
      ["gateway/claude-relay"],
    );
    assert.equal(abortSignal?.aborted, false);
    yield* TestClock.adjust("3 seconds");
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
