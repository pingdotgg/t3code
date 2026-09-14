// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { createProviderVersionAdvisory } from "../providerMaintenance.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { vi } from "vite-plus/test";
import { OmpDriver } from "./OmpDriver.ts";

const capturedAdapterOptions = vi.hoisted(() => [] as Array<unknown>);

vi.mock("../Layers/OmpAdapter.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../Layers/OmpAdapter.ts")>();
  const makeOmpAdapter = (...args: Parameters<typeof actual.makeOmpAdapter>) => {
    capturedAdapterOptions.push(args[1]);
    return actual.makeOmpAdapter(...args);
  };
  return { ...actual, makeOmpAdapter };
});
const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-omp-driver-maintenance-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected omp HTTP request in driver test")),
    ),
  ),
);

const resolveMockAgentPath = Effect.fn("resolveMockAgentPath")(function* () {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
});

const catalogCommands = [
  { name: "skill:deploy", description: "Deploy the app" },
  { name: "share", description: "Share the session" },
];

/**
 * Fake omp answering every subcommand the driver probes: `--version` for the
 * status check, `update --check` for maintenance, `--mode rpc` for the
 * command catalog, and `acp` delegated to the mock agent. The ACP shapes flip
 * through a flag file so a refresh can publish a changed catalog.
 */
function fakeOmpSource(input: {
  readonly mockAgentPath: string;
  readonly checkOutput: string;
  readonly ompShapesEnv: string;
  readonly probeLogPath?: string;
}): string {
  return [
    'import { appendFileSync, existsSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") {',
    '  process.stdout.write("omp/18.1.18\\n");',
    "  process.exit(0);",
    "}",
    'if (args[0] === "update" && args[1] === "--check") {',
    `  process.stdout.write(${JSON.stringify(input.checkOutput)});`,
    "  process.exit(0);",
    "}",
    'if (args[0] === "--mode") {',
    ...(input.probeLogPath
      ? [
          // The machine-level status probe runs from the server's own cwd on an
          // interval nobody here controls, so each spawn records its cwd and the
          // assertions count only the workspace they asked for.
          `  appendFileSync(${JSON.stringify(input.probeLogPath)}, process.cwd() + "\\n");`,
        ]
      : []),
    `  process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "available_commands_update", commands: catalogCommands })}\n`)});`,
    "  process.exit(0);",
    "}",
    'if (args[0] === "acp") {',
    `  ${input.ompShapesEnv}`,
    `  await import(pathToFileURL(${JSON.stringify(input.mockAgentPath)}).href);`,
    "} else {",
    '  process.stderr.write(`unexpected args: ${args.join(" ")}\\n`);',
    "  process.exit(11);",
    "}",
    "",
  ].join("\n");
}

const makeFakeOmp = Effect.fn("makeFakeOmp")(function* (options: {
  readonly prefix: string;
  readonly checkOutput: string;
  readonly ompShapesEnv?: string;
  readonly probeLogPath?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const mockAgentPath = yield* resolveMockAgentPath();
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: options.prefix });
  return writeFakeCli({
    directory,
    name: "fake-omp",
    source: fakeOmpSource({
      mockAgentPath,
      checkOutput: options.checkOutput,
      ompShapesEnv: options.ompShapesEnv ?? 'process.env.T3_ACP_OMP_SHAPES = "1";',
      ...(options.probeLogPath ? { probeLogPath: options.probeLogPath } : {}),
    }),
  });
});

const createTestInstance = (
  instanceId: string,
  input: { readonly binaryPath: string; readonly enabled: boolean },
) =>
  OmpDriver.create({
    instanceId: ProviderInstanceId.make(instanceId),
    displayName: "omp test",
    enabled: input.enabled,
    environment: [],
    config: { ...OmpDriver.defaultConfig(), binaryPath: input.binaryPath },
  });

interface CapturedOmpAdapterOptions {
  readonly resolveSkillNames?: (cwd: string) => ReadonlySet<string>;
  readonly onSessionCommands?: (
    cwd: string,
    commands: ReadonlyArray<{
      readonly name: string;
      readonly description?: string;
      readonly input?: { readonly hint: string };
    }>,
  ) => void;
}

const lastAdapterOptions = (): CapturedOmpAdapterOptions | undefined =>
  capturedAdapterOptions.at(-1) as CapturedOmpAdapterOptions | undefined;

const readProbeCount = (probeLogPath: string, cwd?: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fileSystem
      .readFileString(probeLogPath)
      .pipe(Effect.orElseSucceed(() => ""));
    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    if (cwd === undefined) return lines.length;
    const expected = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    return lines.filter((line) => {
      const normalized = path.normalize(line.trim());
      return normalized === path.normalize(expected) || normalized === path.normalize(cwd);
    }).length;
  });

it.layer(testLayer)("OmpDriver", (it) => {
  it.effect("advertises omp's own update command with the --check latest version", () =>
    Effect.gen(function* () {
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-update-",
        checkOutput: "Current version: 18.1.18\nNew version available: 18.1.21\n",
      });
      const instance = yield* createTestInstance("omp-update-check", {
        binaryPath: fakePath,
        enabled: false,
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.update).toMatchObject({ args: ["update"], lockKey: "omp" });
      expect(capabilities.update?.executable).toContain("fake-omp");
      expect(capabilities.update?.command).toContain("update");
      expect(capabilities.latestVersion).toBe("18.1.21");
      expect(
        createProviderVersionAdvisory({
          driver: OmpDriver.driverKind,
          currentVersion: "18.1.18",
          latestVersion: capabilities.latestVersion ?? null,
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({ status: "behind_latest", canUpdate: true });
    }).pipe(Effect.scoped),
  );

  it.effect("reports current when update --check announces no new version", () =>
    Effect.gen(function* () {
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-current-",
        checkOutput: "Current version: 18.1.21\nAlready up to date.\n",
      });
      const instance = yield* createTestInstance("omp-update-current", {
        binaryPath: fakePath,
        enabled: false,
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.update).toMatchObject({ args: ["update"], lockKey: "omp" });
      expect(capabilities.latestVersion).toBe("18.1.21");
      expect(
        createProviderVersionAdvisory({
          driver: OmpDriver.driverKind,
          currentVersion: "18.1.21",
          latestVersion: capabilities.latestVersion ?? null,
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({ status: "current", canUpdate: true });
    }).pipe(Effect.scoped),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const instance = yield* createTestInstance("omp-update-missing", {
        binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-omp-missing", "omp"),
        enabled: false,
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("records a workspace snapshot per cwd and keeps earlier workspaces", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-workspace-",
        checkOutput: "Current version: 18.1.18\n",
      });
      const instance = yield* createTestInstance("omp-workspace", {
        binaryPath: fakePath,
        enabled: true,
      });
      const snapshotForCwd = instance.snapshotForCwd;
      if (!snapshotForCwd)
        return yield* Effect.die("OmpDriver does not expose workspace snapshots.");
      const workspaceA = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-workspace-a-" });
      const workspaceB = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-workspace-b-" });
      const first = yield* snapshotForCwd(workspaceA);
      expect(first.skills.map((skill) => skill.name)).toEqual(["deploy"]);
      expect(first.slashCommands.map((command) => command.name)).toEqual(["share"]);
      expect(first.workspaceSnapshots?.map((snapshot) => snapshot.cwd)).toEqual([workspaceA]);
      expect(first.workspaceSnapshots?.[0]?.skills.map((skill) => skill.name)).toEqual(["deploy"]);
      expect(first.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name)).toEqual([
        "share",
      ]);

      const second = yield* snapshotForCwd(workspaceB);
      expect(second.workspaceSnapshots?.map((snapshot) => snapshot.cwd)).toEqual([
        workspaceA,
        workspaceB,
      ]);

      const third = yield* snapshotForCwd(workspaceA);
      expect(third.workspaceSnapshots?.map((snapshot) => snapshot.cwd)).toEqual([
        workspaceB,
        workspaceA,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refreshModels re-probes and publishes a changed catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-driver-refresh-" });
      const shapesFlagPath = path.join(root, "omp-shapes");
      const mockAgentPath = yield* resolveMockAgentPath();
      const fakePath = writeFakeCli({
        directory: path.join(root, "bin"),
        name: "fake-omp",
        source: fakeOmpSource({
          mockAgentPath,
          checkOutput: "Current version: 18.1.18\n",
          // @effect-diagnostics-next-line preferSchemaOverJson:off - quoting a path into the fake CLI source.
          ompShapesEnv: `if (existsSync(${JSON.stringify(shapesFlagPath)})) { process.env.T3_ACP_OMP_SHAPES = "1"; } else { delete process.env.T3_ACP_OMP_SHAPES; }`,
        }),
      });
      const instance = yield* createTestInstance("omp-refresh", {
        binaryPath: fakePath,
        enabled: true,
      });
      // The managed snapshot probes in the background, so await one refresh
      // for the baseline catalog instead of racing the initial probe.
      const baseline = yield* instance.snapshot.refresh;
      const before = baseline.models.map((model) => model.slug);
      expect([...before].sort()).toEqual(
        [
          "composer-2",
          "composer-2[fast=true]",
          "default",
          "gpt-5.3-codex[reasoning=medium,fast=false]",
        ].sort(),
      );

      yield* fs.writeFileString(shapesFlagPath, "omp\n");
      const refresh = instance.refreshModels;
      if (!refresh) return yield* Effect.die("OmpDriver does not expose model refresh.");
      yield* refresh();

      const after = (yield* instance.snapshot.getSnapshot).models.map((model) => model.slug);
      expect([...after].sort()).toEqual(
        ["anthropic/claude-opus-4-6", "openai/gpt-5.4", "zhipu-coding-plan/glm-5.3"].sort(),
      );
      expect(after).not.toEqual(before);
    }).pipe(Effect.scoped),
  );

  it.effect("reuses the probed catalog for a repeat snapshot inside the freshness window", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-driver-cache-" });
      const probeLogPath = path.join(root, "probes.log");
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-cache-bin-",
        checkOutput: "Current version: 18.1.18\n",
        probeLogPath,
      });
      const instance = yield* createTestInstance("omp-catalog-cache", {
        binaryPath: fakePath,
        enabled: true,
      });
      const snapshotForCwd = instance.snapshotForCwd;
      if (!snapshotForCwd)
        return yield* Effect.die("OmpDriver does not expose workspace snapshots.");
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-cache-ws-" });
      const first = yield* snapshotForCwd(workspace);
      const second = yield* snapshotForCwd(workspace);
      expect(second.skills).toEqual(first.skills);
      expect(second.slashCommands).toEqual(first.slashCommands);
      expect(yield* readProbeCount(probeLogPath, workspace)).toBe(1);

      const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-cache-other-" });
      yield* snapshotForCwd(other);
      expect(yield* readProbeCount(probeLogPath, other)).toBe(1);
      expect(yield* readProbeCount(probeLogPath, workspace)).toBe(1);
    }).pipe(Effect.scoped),
  );

  // A cache hit re-records the cwd so the LRU keeps it, which must not also
  // restart its freshness window: a polled cwd would then never re-probe and
  // a skill installed out of band would stay invisible for the session.
  it.effect("re-probes after the freshness window even while the cwd is polled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-driver-stale-" });
      const probeLogPath = path.join(root, "probes.log");
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-stale-bin-",
        checkOutput: "Current version: 18.1.18\n",
        probeLogPath,
      });
      const instance = yield* createTestInstance("omp-catalog-stale", {
        binaryPath: fakePath,
        enabled: true,
      });
      const snapshotForCwd = instance.snapshotForCwd;
      if (!snapshotForCwd)
        return yield* Effect.die("OmpDriver does not expose workspace snapshots.");
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-stale-ws-" });

      const realNow = Date.now;
      let clockOffsetMillis = 0;
      const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMillis);
      try {
        yield* snapshotForCwd(workspace);
        // Polls inside the window are served from cache.
        clockOffsetMillis = 20_000;
        yield* snapshotForCwd(workspace);
        clockOffsetMillis = 29_000;
        yield* snapshotForCwd(workspace);
        expect(yield* readProbeCount(probeLogPath, workspace)).toBe(1);

        clockOffsetMillis = 31_000;
        yield* snapshotForCwd(workspace);
        expect(yield* readProbeCount(probeLogPath, workspace)).toBe(2);
      } finally {
        nowSpy.mockRestore();
      }
    }).pipe(Effect.scoped),
  );

  it.effect("applies a live available_commands_update without a second probe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-driver-live-" });
      const probeLogPath = path.join(root, "probes.log");
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-live-bin-",
        checkOutput: "Current version: 18.1.18\n",
        probeLogPath,
      });
      const instance = yield* createTestInstance("omp-live-commands", {
        binaryPath: fakePath,
        enabled: true,
      });
      const snapshotForCwd = instance.snapshotForCwd;
      if (!snapshotForCwd)
        return yield* Effect.die("OmpDriver does not expose workspace snapshots.");
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-live-ws-" });
      const first = yield* snapshotForCwd(workspace);
      expect(first.skills.map((skill) => skill.name)).toEqual(["deploy"]);
      expect(yield* readProbeCount(probeLogPath, workspace)).toBe(1);

      const options = lastAdapterOptions();
      const onSessionCommands = options?.onSessionCommands;
      if (!onSessionCommands)
        return yield* Effect.die("OmpDriver did not pass onSessionCommands to the adapter.");
      onSessionCommands(workspace, [
        { name: "skill:fresh", description: "Freshly installed skill" },
        { name: "newcmd", description: "New command", input: { hint: "<arg>" } },
      ]);
      // The `$mention` skill set refreshes with the live payload, no turn needed.
      expect(options?.resolveSkillNames?.(workspace)).toEqual(new Set(["fresh"]));

      const second = yield* snapshotForCwd(workspace);
      expect(second.skills.map((skill) => skill.name)).toEqual(["fresh"]);
      expect(second.slashCommands).toEqual([
        { name: "newcmd", description: "New command", input: { hint: "<arg>" } },
      ]);
      expect(
        second.workspaceSnapshots
          ?.find((entry) => entry.cwd === workspace)
          ?.skills.map((skill) => skill.name),
      ).toEqual(["fresh"]);
      // The live payload replaced the cached probe instead of re-spawning it.
      expect(yield* readProbeCount(probeLogPath, workspace)).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the omp advisory on update --check with no registry fallback", () =>
    Effect.gen(function* () {
      const fakePath = yield* makeFakeOmp({
        prefix: "t3-omp-driver-advisory-",
        checkOutput: "Current version: 18.1.18\nNew version available: 18.1.21\n",
      });
      const instance = yield* createTestInstance("omp-advisory-source", {
        binaryPath: fakePath,
        enabled: false,
      });
      const capabilities = yield* instance.snapshot.resolveMaintenance();
      // A null packageName leaves the npm latest-version path unreachable, so
      // the --check latest below is the only version the UI can show.
      expect(capabilities.packageName).toBeNull();
      expect(capabilities.latestVersion).toBe("18.1.21");
    }).pipe(Effect.scoped),
  );
});
