// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as UrlParams from "effect/http/UrlParams";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderMaintenance from "@t3tools/provider-core/server/maintenanceResolver";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import {
  OPENCODE_2_RESPONSES,
  OPENCODE_2_WORKSPACE_RESPONSES,
  replayOpenCodeServer,
} from "./probeResponses.fixture.ts";
import { OpenCodeDriver, openCodeUpdateFor } from "./driver.ts";
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

const openCode2Project = "/work/project-with-config";
const openCode2Model = (providerID: string, id: string, name: string) => ({
  id,
  modelID: id,
  providerID,
  name,
  package: "@opencode/ai/providers/openai-compatible",
  settings: {},
  compatibility: {},
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  variants: [],
  time: { released: 1789516800000 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
  status: "active",
  enabled: true,
  limit: { context: 1000000, output: 65536 },
});
// Serves one machine catalog everywhere plus extra models for the project directory.
const makeOpenCode2ProjectInstance = (
  projectCatalog: "listed" | "models-unavailable" | "providers-unavailable",
) =>
  Effect.gen(function* () {
    const machineModels = [openCode2Model("opencode", "big-pickle", "Big Pickle")];
    const projectModels = [
      ...machineModels,
      openCode2Model("uni", "medium-gpt", "Medium GPT"),
      openCode2Model("uni", "large-gpt", "Large GPT"),
    ];
    const replay = replayOpenCodeServer(
      { ...OPENCODE_2_RESPONSES, ...OPENCODE_2_WORKSPACE_RESPONSES },
      "secret",
    );
    const server = HttpClient.make((request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/api/model" && pathname !== "/api/provider") {
        return replay.execute(request);
      }
      const directory = Option.getOrUndefined(
        UrlParams.getFirst(request.urlParams, "location[directory]"),
      );
      const isProject = directory === openCode2Project;
      const data = pathname === "/api/provider" ? [] : isProject ? projectModels : machineModels;
      const unavailable =
        isProject &&
        ((pathname === "/api/model" && projectCatalog === "models-unavailable") ||
          (pathname === "/api/provider" && projectCatalog === "providers-unavailable"));
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ location: { directory }, data }), {
            status: unavailable ? 503 : 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    });
    const instance = yield* create(
      { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
      server,
    );
    const ready = yield* instance.snapshot.streamChanges.pipe(
      Stream.filter((snapshot) => snapshot.status === "ready"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkChild,
    );
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(ready);
    // Catalog reads repeat until two agree, so let them settle on the test clock.
    return (cwd: string) =>
      Effect.gen(function* () {
        const read = yield* Effect.forkChild(instance.snapshotForCwd!(cwd));
        yield* TestClock.adjust("5 seconds");
        return yield* Fiber.join(read);
      });
  });

it.layer(layer)("OpenCodeDriver runtime selection", (it) => {
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

  it.effect.each(["probe", "error", "empty"] as const)(
    "recovers discovery without a manual refresh after %s",
    (initialCatalog) =>
      Effect.gen(function* () {
        const releaseCatalog = yield* Deferred.make<void>();
        const discoveryLogs: Array<Record<string, unknown>> = [];
        const logger = Logger.make(({ message, fiber }) => {
          if (Array.isArray(message) && message.includes("OpenCode discovery failed")) {
            discoveryLogs.push({ ...fiber.getRef(References.CurrentLogAnnotations) });
          }
        });
        let catalogAvailable = false;
        let modelReads = 0;
        const replies = {
          ...OPENCODE_2_RESPONSES,
          "/api/provider": {
            status: 200,
            contentType: "application/json",
            body: '{"location":{"directory":"/work"},"data":[]}',
          },
          "/api/model": {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              location: { directory: "/work" },
              data: [
                {
                  id: "big-pickle",
                  modelID: "big-pickle",
                  providerID: "opencode",
                  name: "Big Pickle",
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: {},
                  compatibility: {},
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  variants: [],
                  time: { released: 1789516800000 },
                  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
                  status: "active",
                  enabled: true,
                  limit: { context: 1000000, output: 65536 },
                },
              ],
            }),
          },
        };
        const replay = replayOpenCodeServer(replies, "secret");
        const server = HttpClient.make((request) =>
          Effect.gen(function* () {
            if (initialCatalog === "probe" && !catalogAvailable) {
              yield* Deferred.await(releaseCatalog);
              return HttpClientResponse.fromWeb(
                request,
                new Response('{"_tag":"InternalServerError","message":"server starting"}', {
                  status: 503,
                  headers: { "content-type": "application/json" },
                }),
              );
            }
            if (new URL(request.url).pathname === "/api/model") {
              modelReads += 1;
              yield* Deferred.await(releaseCatalog);
              if (!catalogAvailable) {
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    initialCatalog === "error"
                      ? '{"_tag":"InternalServerError","message":"catalog unavailable"}'
                      : '{"location":{"directory":"/work"},"data":[]}',
                    {
                      status: initialCatalog === "error" ? 500 : 200,
                      headers: { "content-type": "application/json" },
                    },
                  ),
                );
              }
            }
            return yield* replay.execute(request);
          }),
        );
        const instance = yield* create(
          { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
          server,
        ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
        const initial = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.installed &&
              snapshot.status === (initialCatalog === "empty" ? "warning" : "error"),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseCatalog, undefined);
        yield* TestClock.adjust("5 seconds");
        const [failed] = Array.from(yield* Fiber.join(initial));
        assert.strictEqual(failed?.auth.status, "unknown");
        assert.deepStrictEqual(failed?.models, []);
        if (initialCatalog === "probe") assert.strictEqual(failed?.version, null);
        assert.strictEqual(discoveryLogs.length, 1);
        assert.strictEqual(discoveryLogs[0]?.providerInstanceId, "opencode-test");
        assert.strictEqual(discoveryLogs[0]?.serverMode, "external");
        assert.strictEqual(
          discoveryLogs[0]?.phase,
          initialCatalog === "probe" ? "version" : "models",
        );

        catalogAvailable = true;
        const recovered = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.status === "ready"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* TestClock.adjust("5 minutes");
        assert.strictEqual((yield* instance.snapshot.getSnapshot).status, "ready");
        const [ready] = Array.from(yield* Fiber.join(recovered));
        assert.strictEqual(ready?.auth.status, "authenticated");
        assert.deepStrictEqual(
          ready?.models.map((model) => model.slug),
          ["opencode/big-pickle"],
        );

        const readsAfterRecovery = modelReads;
        yield* TestClock.adjust("15 minutes");
        assert.strictEqual(modelReads, readsAfterRecovery);
        assert.strictEqual(discoveryLogs.length, 1);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("lists a project's own opencode.jsonc models in that project's snapshot", () =>
    Effect.gen(function* () {
      const snapshotFor = yield* makeOpenCode2ProjectInstance("listed");

      const projectSnapshot = yield* snapshotFor(openCode2Project);
      assert.deepStrictEqual(projectSnapshot.models.map((entry) => entry.slug).toSorted(), [
        "opencode/big-pickle",
        "uni/large-gpt",
        "uni/medium-gpt",
      ]);
      const otherSnapshot = yield* snapshotFor("/work/other-project");
      assert.deepStrictEqual(
        otherSnapshot.models.map((entry) => entry.slug),
        ["opencode/big-pickle"],
      );
      assert.strictEqual(otherSnapshot.workspaceModels, undefined);
      assert.strictEqual(otherSnapshot.workspaceModelsPending, undefined);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect.each(["models-unavailable", "providers-unavailable"] as const)(
    "reports a project's catalog unknown when its read fails (%s)",
    (projectCatalog) =>
      Effect.gen(function* () {
        const snapshotFor = yield* makeOpenCode2ProjectInstance(projectCatalog);

        const projectSnapshot = yield* snapshotFor(openCode2Project);
        assert.deepStrictEqual(
          projectSnapshot.models.map((entry) => entry.slug),
          ["opencode/big-pickle"],
        );
        assert.strictEqual(projectSnapshot.workspaceModels, undefined);
        assert.strictEqual(projectSnapshot.workspaceModelsPending, true);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("does not retry a rejected server password in the background", () =>
    Effect.gen(function* () {
      const releaseResponse = yield* Deferred.make<void>();
      const requested: Array<string> = [];
      const server = replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret", requested);
      const instance = yield* create(
        { serverUrl: "http://127.0.0.1:4096", serverPassword: "wrong" },
        HttpClient.make((request) =>
          Deferred.await(releaseResponse).pipe(Effect.andThen(server.execute(request))),
        ),
      );
      // Wait for startup and its maintenance enrichment, both of which probe.
      const rejected = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) => snapshot.status === "error" && snapshot.versionAdvisory !== undefined,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseResponse, undefined);
      const [snapshot] = Array.from(yield* Fiber.join(rejected));
      assert.strictEqual(snapshot?.version, null);
      assert.strictEqual(snapshot?.auth.status, "unauthenticated");
      const readsAfterRejection = requested.length;

      yield* TestClock.adjust("15 minutes");
      assert.strictEqual(requested.length, readsAfterRejection);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

// npm links into opencode-ai for 1.x and @opencode/cli for 2.x.
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

const openCode1Provider = (id: string, models: ReadonlyArray<string>) => ({
  id,
  name: id,
  models: Object.fromEntries(
    models.map((model) => [model, { id: model, name: model, release_date: "2026-01-01" }]),
  ),
});
const openCode1Project = "/work/project-with-config";
const openCode1UnreadableProject = "/work/unreadable-project";
const openCode1Providers = (directory: string) => {
  const all = [
    openCode1Provider("opencode", ["big-pickle"]),
    ...(directory === openCode1Project ? [openCode1Provider("uni", ["medium-gpt"])] : []),
  ];
  return { all, connected: all.map((provider) => provider.id), default: {} };
};
const openCode1Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "1.18.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4096",
      version: "1.18.18",
      isRunning: Effect.succeed(true),
      exitCode: Effect.never,
    }),
  createOpenCodeSdkClient: ({ directory }: { readonly directory: string }) => ({
    provider: {
      list: () =>
        directory === openCode1UnreadableProject
          ? Promise.reject(new Error("provider list failed"))
          : Promise.resolve({ data: openCode1Providers(directory) }),
    },
    app: { agents: () => Promise.resolve({ data: [] }) },
    command: { list: () => Promise.resolve({ data: [] }) },
  }),
  loadOpenCodeInventory: () =>
    Effect.succeed({ providerList: openCode1Providers("/machine"), agents: [], skills: [] }),
  loadOpenCodeSkills: () => Effect.succeed([]),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

it.layer(Layer.mergeAll(layer, Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode1Runtime)))(
  "OpenCodeDriver on OpenCode 1",
  (it) => {
    it.effect("lists a project's own opencode.jsonc models in that project's snapshot", () =>
      Effect.gen(function* () {
        const instance = yield* create({}, noHttp);
        const ready = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.status === "ready"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Fiber.join(ready);
        const slugsOf = (snapshot: { readonly models: ReadonlyArray<{ readonly slug: string }> }) =>
          snapshot.models.map((model) => model.slug).toSorted();

        assert.deepStrictEqual(slugsOf(yield* instance.snapshotForCwd!(openCode1Project)), [
          "opencode/big-pickle",
          "uni/medium-gpt",
        ]);
        const otherSnapshot = yield* instance.snapshotForCwd!("/work/other-project");
        assert.deepStrictEqual(slugsOf(otherSnapshot), ["opencode/big-pickle"]);
        assert.strictEqual(otherSnapshot.workspaceModels, undefined);
        assert.strictEqual(otherSnapshot.workspaceModelsPending, undefined);
        const unreadable = yield* instance.snapshotForCwd!(openCode1UnreadableProject);
        assert.deepStrictEqual(slugsOf(unreadable), ["opencode/big-pickle"]);
        assert.strictEqual(unreadable.workspaceModels, undefined);
        assert.strictEqual(unreadable.workspaceModelsPending, true);
      }).pipe(Effect.scoped),
    );
  },
);

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
