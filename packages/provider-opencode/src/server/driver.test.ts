// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderMaintenance from "@t3tools/provider-core/server/maintenanceResolver";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OpenCodeDriver, openCodeUpdateFor } from "./driver.ts";
import { OPENCODE_2_RESPONSES, replayOpenCodeServer } from "./probeResponses.fixture.ts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

const serverStarts: Array<string> = [];
const reachedServer = (operation: string) =>
  Effect.sync(() => serverStarts.push(operation)).pipe(
    Effect.andThen(
      Effect.fail(
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation,
          detail: "reached a 1.x server path",
        }),
      ),
    ),
  );
const openCode2Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode2Runtime),
).pipe(Layer.provideMerge(NodeServices.layer));

const create = (config: Partial<OpenCodeSettings>, http: HttpClient.HttpClient) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment: [],
    enabled: true,
    config: { ...OpenCodeDriver.defaultConfig(), ...config },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

const noHttp = HttpClient.make(() => Effect.die("A local binary must not be probed over HTTP"));

const nativeInstall = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-update-owner-" });
  const directory = NodePath.join(root, ".opencode", "bin");
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  const binaryPath = NodePath.join(
    directory,
    HostProcess.Platform.defaultValue() === "win32" ? "opencode.exe" : "opencode",
  );
  yield* fileSystem.writeFileString(binaryPath, "fixture");
  yield* fileSystem.chmod(binaryPath, 0o755);
  return binaryPath;
});

it.layer(layer)("OpenCodeDriver runtime selection", (it) => {
  it.effect.each(["http://127.0.0.1:4096", "https://server.example.test"])(
    "keeps updates owned by the configured server at %s",
    (serverUrl) =>
      Effect.gen(function* () {
        const binaryPath = yield* nativeInstall;
        const cliProbes: string[] = [];
        const runtime = {
          ...openCode2Runtime,
          runOpenCodeCommand: () => {
            cliProbes.push("--version");
            return Effect.succeed({ stdout: "opencode v2.1.3\n", stderr: "", code: 0 });
          },
        } as OpenCodeRuntime.OpenCodeRuntime["Service"];
        const responses = {
          ...OPENCODE_2_RESPONSES,
          "/api/info": {
            ...OPENCODE_2_RESPONSES["/api/info"],
            body: OPENCODE_2_RESPONSES["/api/info"].body.replace("2.0.18", "2.0.32"),
          },
        };
        const latestVersions = yield* ProviderLatestVersions.make([["@opencode/cli", "2.1.3"]]);
        const instance = yield* create(
          { binaryPath, serverUrl },
          replayOpenCodeServer(responses, ""),
        ).pipe(
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        );
        const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(maintenance.packageName, "@opencode/cli");
        assert.isNull(maintenance.update);

        for (const runningVersion of ["2.0.32", "2.0.32", "2.1.3"]) {
          responses["/api/info"].body = OPENCODE_2_RESPONSES["/api/info"].body.replace(
            "2.0.18",
            runningVersion,
          );
          const enriched = yield* instance.snapshot.streamChanges.pipe(
            Stream.filter(
              (snapshot) => snapshot.versionAdvisory?.currentVersion === runningVersion,
            ),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* instance.snapshot.refresh;
          const [snapshot] = yield* Fiber.join(enriched);
          assert.ok(snapshot);
          assert.strictEqual(snapshot.version, runningVersion);
          assert.strictEqual(snapshot.versionAdvisory?.canUpdate, false);
          assert.strictEqual(snapshot.versionAdvisory?.canInstallVersion, false);
          assert.isNull(snapshot.versionAdvisory?.updateCommand);
          assert.strictEqual(
            snapshot.versionAdvisory?.status,
            runningVersion === "2.1.3" ? "current" : "behind_latest",
          );
          if (runningVersion !== "2.1.3") {
            assert.include(snapshot.versionAdvisory?.message ?? "", "Version 2.1.3 is out.");
            assert.include(snapshot.versionAdvisory?.message ?? "", "configured OpenCode server");
            assert.include(snapshot.versionAdvisory?.message ?? "", "refresh provider status");
          }
        }
        assert.deepStrictEqual(cliProbes, []);
      }).pipe(Effect.scoped),
  );

  it.effect("still offers native CLI updates when T3 manages the local server", () =>
    Effect.gen(function* () {
      const binaryPath = yield* nativeInstall;
      const instance = yield* create({ binaryPath, serverUrl: " " }, noHttp);
      const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
      assert.strictEqual(maintenance.update?.executable, binaryPath);
      assert.deepStrictEqual(maintenance.update?.args, ["upgrade"]);
    }).pipe(Effect.scoped),
  );

  it.effect("never starts a 1.x server for an OpenCode 2 instance", () =>
    Effect.gen(function* () {
      serverStarts.length = 0;
      const instance = yield* create({}, noHttp);
      yield* Effect.flip(
        instance.textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "hello",
          modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
        }),
      );
      assert.deepStrictEqual(serverStarts, ["start"]);
    }).pipe(Effect.scoped),
  );

  it.effect("answers capability reads without waiting on an unreachable server", () =>
    Effect.gen(function* () {
      const hang = HttpClient.make(() => Effect.never);
      const instance = yield* create({ serverUrl: "http://127.0.0.1:9" }, hang);

      const capabilities = yield* instance.orchestrationAdapter
        .getCapabilities()
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isDefined(capabilities.pollUnsafe());
      yield* Fiber.join(capabilities);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

// npm links `<prefix>/bin/opencode` into the package that installed it:
// `opencode-ai` for 1.x and `@opencode/cli` (whose bin is `bin/opencode.exe`) for 2.x.
const npmGlobalInstall = (prefix: string, packagePath: ReadonlyArray<string>, bin: string) => {
  const target = NodePath.join(prefix, "lib", "node_modules", ...packagePath, "bin", bin);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, "#!/bin/sh\n");
  NodeFS.chmodSync(target, 0o755);
  const link = NodePath.join(prefix, "bin", "opencode");
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
  NodeFS.symlinkSync(target, link);
  return link;
};
const resolveUpdate = (generation: "v1" | "v2", binaryPath: string) =>
  ProviderMaintenance.resolveProviderMaintenanceCapabilitiesEffect(openCodeUpdateFor(generation), {
    binaryPath,
    env: { PATH: "" },
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("resolving an update must not spawn")),
    ),
    Effect.provide(NodeServices.layer),
  );

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "updates an npm-global OpenCode 2 install as @opencode/cli and a 1.x one as opencode-ai",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-update-")),
      );
      const v2Prefix = NodePath.join(root, "v2");
      const v1Prefix = NodePath.join(root, "v1");
      const v2 = yield* resolveUpdate(
        "v2",
        npmGlobalInstall(v2Prefix, ["@opencode", "cli"], "opencode.exe"),
      );
      assert.deepStrictEqual(v2.update?.args, [
        "install",
        "-g",
        "--prefix",
        v2Prefix,
        "--allow-scripts=@opencode/cli",
        "@opencode/cli@latest",
      ]);
      const v1 = yield* resolveUpdate(
        "v1",
        npmGlobalInstall(v1Prefix, ["opencode-ai"], "opencode"),
      );
      assert.strictEqual(v1.update?.args.at(-1), "opencode-ai@latest");
      assert.isNull(
        (yield* resolveUpdate("v2", NodePath.join(v1Prefix, "bin", "opencode"))).update,
      );
      assert.isNull(
        (yield* resolveUpdate("v1", NodePath.join(v2Prefix, "bin", "opencode"))).update,
      );
    }),
);

const versionOutput: { current: string | undefined } = { current: undefined };
const versionProbes: Array<string> = [];
const changingRuntime = {
  runOpenCodeCommand: ({ binaryPath }: { readonly binaryPath: string }) =>
    Effect.sync(() => versionProbes.push(binaryPath)).pipe(
      Effect.andThen(
        versionOutput.current === undefined
          ? Effect.fail(
              new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "version",
                detail: "no version",
              }),
            )
          : Effect.succeed({ stdout: versionOutput.current, stderr: "", code: 0 }),
      ),
    ),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];
const layerUpdate = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, changingRuntime),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layerUpdate)("OpenCodeDriver updates", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "offers no package update for an unknown version and follows a changed one on a fresh read",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-driver-update-")),
        );
        const binaryPath = npmGlobalInstall(NodePath.join(root, "v1"), ["opencode-ai"], "opencode");
        const instance = yield* OpenCodeDriver.create({
          instanceId: ProviderInstanceId.make("opencode-update"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: { ...OpenCodeDriver.defaultConfig(), binaryPath },
        }).pipe(Effect.provideService(HttpClient.HttpClient, noHttp));

        versionOutput.current = undefined;
        const unknown = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.isNull(unknown.update);
        assert.isNull(unknown.packageName);

        versionOutput.current = "1.18.32\n";
        const v1 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v1.packageName, "opencode-ai");

        versionOutput.current = "opencode v2.0.18\n";
        const v2 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v2.packageName, "@opencode/cli");
        assert.isNull(v2.update);
      }).pipe(Effect.scoped),
  );
});
