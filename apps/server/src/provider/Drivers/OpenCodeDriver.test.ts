// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { ProviderInstanceId, type OpenCodeSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProviderEventLoggers from "../Layers/ProviderEventLoggers.ts";
import * as ProviderMaintenance from "../providerMaintenance.ts";
import * as OpenCodeRuntime from "../opencodeRuntime.ts";
import {
  OPENCODE_1_RESPONSES,
  OPENCODE_2_RESPONSES,
  OPENCODE_2_WORKSPACE_RESPONSES,
  replayOpenCodeServer,
} from "../testFixtures/opencodeProbeResponses.ts";
import { OpenCodeDriver, openCodeUpdateFor } from "./OpenCodeDriver.ts";

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
// Reports OpenCode 2 from `--version`; any attempt to reach a server is recorded and refused.
const openCode2Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntimeShape;

const layer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode-driver-" }),
  IdAllocator.layer,
  ServerSettings.layerTest(),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
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

const createOpenCode1WorkspaceDriver = (client: ReturnType<typeof createOpencodeClient>) =>
  create(
    { serverUrl: "http://127.0.0.1:4096" },
    replayOpenCodeServer(OPENCODE_1_RESPONSES, ""),
  ).pipe(
    Effect.provide(
      Layer.mock(OpenCodeRuntime.OpenCodeRuntime)({
        connectToOpenCodeServer: () =>
          Effect.succeed({
            url: "http://127.0.0.1:4096",
            version: "1.18.32",
            exitCode: null,
            external: true,
          }),
        createOpenCodeSdkClient: () => client,
        loadOpenCodeSkills: () =>
          Effect.succeed([
            {
              name: "workspace-skill",
              location: "/work/.opencode/skills/workspace-skill/SKILL.md",
            },
          ]),
      }),
    ),
  );

it.layer(layer)("OpenCodeDriver 1.x workspace commands", (it) => {
  it.effect("fails a timed-out command probe and loads commands on retry", () =>
    Effect.gen(function* () {
      const requested = Promise.withResolvers<void>();
      let ready = false;
      const client = createOpencodeClient({
        baseUrl: "http://127.0.0.1:4096",
        throwOnError: true,
        fetch: () => {
          requested.resolve();
          return ready
            ? Promise.resolve(Response.json([{ name: "hello", hints: [] }]))
            : new Promise<Response>(() => {});
        },
      });
      const instance = yield* createOpenCode1WorkspaceDriver(client);
      const probe = yield* instance.snapshotForCwd!("/work").pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => requested.promise);
      yield* TestClock.adjust("10 seconds");

      const result = yield* Fiber.join(probe);
      assert.strictEqual(result._tag, "Failure");
      if (Result.isFailure(result)) {
        assert.include(result.failure.detail, "Failed to probe OpenCode commands");
      }

      ready = true;
      const workspace = yield* instance.snapshotForCwd!("/work");
      assert.deepStrictEqual(
        workspace.slashCommands.map((command) => command.name),
        ["compact", "hello"],
      );
      assert.deepStrictEqual(
        workspace.skills.map((skill) => skill.name),
        ["workspace-skill"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps skills and the built-in command when the SDK returns an error", () =>
    Effect.gen(function* () {
      const client = createOpencodeClient({
        baseUrl: "http://127.0.0.1:4096",
        throwOnError: true,
        fetch: () => Promise.resolve(Response.json({ message: "unavailable" }, { status: 500 })),
      });
      const instance = yield* createOpenCode1WorkspaceDriver(client);
      const workspace = yield* instance.snapshotForCwd!("/work");

      assert.deepStrictEqual(
        workspace.slashCommands.map((command) => command.name),
        ["compact"],
      );
      assert.deepStrictEqual(
        workspace.skills.map((skill) => skill.name),
        ["workspace-skill"],
      );
    }).pipe(Effect.scoped),
  );
});

it.layer(layer)("OpenCodeDriver runtime selection", (it) => {
  it.effect("never starts a 1.x server for an OpenCode 2 instance", () =>
    Effect.gen(function* () {
      serverStarts.length = 0;
      const instance = yield* create({}, noHttp);
      // Text generation goes to the instance's 2.x server, which this test refuses to start.
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

  it.effect("lists an OpenCode 2 workspace's own skills and commands from its server", () =>
    Effect.gen(function* () {
      serverStarts.length = 0;
      const requested: Array<string> = [];
      const server = replayOpenCodeServer(
        { ...OPENCODE_2_RESPONSES, ...OPENCODE_2_WORKSPACE_RESPONSES },
        "secret",
        requested,
      );
      const instance = yield* create(
        { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
        server,
      );

      const workspace = yield* instance.snapshotForCwd!("/work");
      assert.includeMembers(
        workspace.skills.map((skill) => skill.name),
        ["plum", "opencode"],
      );
      assert.deepStrictEqual(
        workspace.slashCommands.map((command) => command.name),
        ["compact", "init", "review", "bee"],
      );
      assert.include(requested, "/api/skill");
      assert.deepStrictEqual(serverStarts, []);
    }).pipe(Effect.scoped),
  );

  it.effect("answers capability reads without waiting on an unreachable server", () =>
    Effect.gen(function* () {
      const hang = HttpClient.make(() => Effect.never);
      const instance = yield* create({ serverUrl: "http://127.0.0.1:9" }, hang);

      // No probe has succeeded yet, and the server never answers: the 1.x default applies.
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

it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
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
      // A 1.x install is never offered 2.x's package, or the reverse.
      assert.isNull(
        (yield* resolveUpdate("v2", NodePath.join(v1Prefix, "bin", "opencode"))).update,
      );
      assert.isNull(
        (yield* resolveUpdate("v1", NodePath.join(v2Prefix, "bin", "opencode"))).update,
      );
    }),
);

// The update the driver offers follows the version the binary reports now.
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
} as unknown as OpenCodeRuntime.OpenCodeRuntimeShape;
const updateLayer = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-opencode-driver-update-" }),
  IdAllocator.layer,
  ServerSettings.layerTest(),
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, changingRuntime),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(updateLayer)("OpenCodeDriver updates", (it) => {
  it.effect("never runs the binary for a disabled instance's update check", () =>
    Effect.gen(function* () {
      versionProbes.length = 0;
      versionOutput.current = "opencode v2.0.18\n";
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-disabled"),
        displayName: undefined,
        environment: [],
        enabled: false,
        config: { ...OpenCodeDriver.defaultConfig(), binaryPath: "opencode" },
      }).pipe(Effect.provideService(HttpClient.HttpClient, noHttp));
      const maintenance = yield* instance.snapshot.resolveMaintenance();
      yield* instance.snapshot.resolveMaintenance({ fresh: true });
      assert.isNull(maintenance.update);
      assert.deepStrictEqual(versionProbes, []);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcessPlatform.defaultValue() === "win32")(
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

        // The version could not be read: which package owns the binary is unknown.
        versionOutput.current = undefined;
        const unknown = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.isNull(unknown.update);
        assert.isNull(unknown.packageName);

        versionOutput.current = "1.18.32\n";
        const v1 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v1.packageName, "opencode-ai");

        // The same path now reports 2.x (reinstalled in place): a fresh read re-probes
        // and never offers 1.x's package for it.
        versionOutput.current = "opencode v2.0.18\n";
        const v2 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v2.packageName, "@opencode/cli");
        assert.isNull(v2.update);
      }).pipe(Effect.scoped),
  );
});
