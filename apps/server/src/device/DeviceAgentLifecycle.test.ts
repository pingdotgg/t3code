import { expect, it } from "@effect/vitest";
import {
  DeviceId,
  ProjectId,
  ThreadId,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings as ServerSettingsValue,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as NetAddress from "effect/net/NetAddress";
import * as Result from "effect/Result";
import * as NetService from "@t3tools/shared/Net";
import * as ProcessRunner from "../processRunner.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceAgentAccess from "./DeviceAgentAccess.ts";
import * as DeviceAgentLifecycle from "./DeviceAgentLifecycle.ts";
import * as DeviceService from "./DeviceService.ts";
import { HttpClient, HttpClientResponse, HttpServer } from "effect/http";
import {
  agentDeviceConfigPath,
  agentDeviceThreadConfigDirectory,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";

it.effect(
  "retires deleted thread access and prunes only owned inactive configs across restart",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "device-agent-lifecycle-" });
      const processed = yield* Deferred.make<void>();
      const projectId = ProjectId.make("project-1");
      const target = {
        threadId: ThreadId.make("deleted-during-sweep"),
        hostId: "host-1",
        deviceId: DeviceId.make("device-1"),
        session: "session-1",
      };
      const stored: OrchestrationV2StoredEvent[] = [];
      let sweeping = false;
      const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (id) =>
          Effect.sync(() => {
            if (sweeping && id === "active") {
              stored.push({
                sequence: 11,
                event: { type: "thread.deleted", payload: { id: target.threadId } },
              } as OrchestrationV2StoredEvent);
            }
            return id === "orphan"
              ? null
              : ({
                  projectId,
                  deletedAt: id === "deleted-before-restart" ? "2026-01-01" : null,
                  archivedAt: id === "archived" ? "2026-01-01" : null,
                } as NonNullable<
                  Effect.Success<
                    ReturnType<ProjectionStore.ProjectionStoreV2["Service"]["getThreadShell"]>
                  >
                >);
          }),
      });
      const accessLayer = DeviceAgentAccess.layer.pipe(
        Layer.provide(projections),
        Layer.provide(
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeed(Option.some({ deletedAt: null } as ProjectStore.ProjectRow)),
          }),
        ),
        Layer.provide(
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              enableDeviceSupport: true,
              enableAgentDeviceAccess: true,
            }),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const access = yield* DeviceAgentAccess.DeviceAgentAccess;
        const token = yield* access.issue(target);
        const other = { ...target, threadId: ThreadId.make("archived"), hostId: "host-2" };
        const otherToken = yield* access.issue(other);
        yield* access.recordResource(other, { kind: "artifact", id: "artifact-1" });
        yield* access.recordResource(target, { kind: "artifact", id: "artifact-1" });
        const files = new Map<string, string>();
        for (const id of [
          "active",
          "archived",
          "orphan",
          "deleted-before-restart",
          target.threadId,
        ]) {
          const file = yield* agentDeviceConfigPath(stateDir, target.hostId, path, {
            threadId: id,
            deviceId: target.deviceId,
          });
          yield* writeAgentDeviceConfig(file, {
            baseUrl: "http://daemon.example",
            token: "test-token",
            entryPath: "/agent.mjs",
          });
          files.set(id, file);
        }
        const legacy = yield* agentDeviceConfigPath(stateDir, target.hostId, path);
        yield* writeAgentDeviceConfig(legacy, {
          baseUrl: "http://daemon.example",
          token: "legacy-token",
          entryPath: "/agent.mjs",
        });
        yield* Layer.build(
          DeviceAgentLifecycle.layer.pipe(
            Layer.provide(projections),
            Layer.provide(
              Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
            ),
            Layer.provide(
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
              }),
            ),
            Layer.provide(
              Layer.effect(
                DeviceService.DeviceService,
                DeviceService.makeWithHosts(new Map(), undefined, undefined, undefined, (id) =>
                  access.retireThread(id).pipe(
                    Effect.andThen(
                      fs.remove(agentDeviceThreadConfigDirectory(stateDir, id, path), {
                        recursive: true,
                        force: true,
                      }),
                    ),
                    Effect.orDie,
                  ),
                ),
              ).pipe(
                Layer.provide(
                  Layer.mock(ServerSettings.ServerSettingsService)({
                    getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                  }),
                ),
                Layer.provide(
                  Layer.succeed(
                    HttpClient.HttpClient,
                    HttpClient.make((request) =>
                      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok"))),
                    ),
                  ),
                ),
              ),
            ),
            Layer.provide(
              Layer.succeed(ServerConfig.ServerConfig, {
                stateDir,
              } as ServerConfig.ServerConfig["Service"]),
            ),
            Layer.provide(
              Layer.mock(EventSink.EventSinkV2)({
                latestSequence: () =>
                  Effect.sync(() => {
                    sweeping = true;
                    return 10;
                  }),
                stream: (input) => {
                  if (input === undefined) throw new Error("Expected a filtered deletion stream");
                  expect(input.afterSequence).toBe(10);
                  expect(input.eventType).toBe("thread.deleted");
                  return Stream.fromIterable(stored).pipe(
                    Stream.concat(Stream.fromEffectDrain(Deferred.succeed(processed, undefined))),
                  );
                },
              }),
            ),
          ),
        );
        yield* Deferred.await(processed);
        for (const [id, file] of files)
          expect(yield* fs.exists(file)).toBe(id === "active" || id === "archived");
        expect(yield* fs.exists(legacy)).toBe(true);
        expect(yield* access.ownsResource(target, { kind: "artifact", id: "artifact-1" })).toBe(
          false,
        );
        expect(
          (yield* Effect.exit(
            access.recordResource(target, { kind: "artifact", id: "late-artifact" }),
          ))._tag,
        ).toBe("Failure");
        const freshTarget = { ...target };
        const fresh = yield* access.issue(freshTarget);
        expect(
          (yield* Effect.exit(
            access.recordResource(target, { kind: "artifact", id: "late-artifact" }),
          ))._tag,
        ).toBe("Failure");
        yield* access.recordResource(freshTarget, { kind: "artifact", id: "new-artifact" });
        expect(fresh).not.toBe(token);
        yield* access.retireHost(target.hostId);
        expect((yield* Effect.exit(access.authorize(fresh)))._tag).toBe("Failure");
        expect(
          yield* access.ownsResource(freshTarget, { kind: "artifact", id: "new-artifact" }),
        ).toBe(false);
        expect(yield* access.authorize(otherToken)).toEqual(other);
        expect(yield* access.ownsResource(other, { kind: "artifact", id: "artifact-1" })).toBe(
          true,
        );
        expect((yield* Effect.exit(access.authorize(token)))._tag).toBe("Failure");
      }).pipe(Effect.provide(accessLayer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect.each([
  { name: "stale deleted grant with another active project", otherGrant: true },
  { name: "stale deleted final grant at startup", otherGrant: false },
])("reconciles helper access for $name through the actual settings subscriber", ({ otherGrant }) =>
  Effect.gen(function* () {
    const deletedProject = ProjectId.make("deleted-project");
    const activeProject = ProjectId.make("active-project");
    const initial = {
      ...DEFAULT_SERVER_SETTINGS,
      enableDeviceSupport: true,
      enableAgentDeviceAccess: false,
      projectSettingsOverrides: {
        [deletedProject]: { enableAgentDeviceAccess: true },
        ...(otherGrant ? { [activeProject]: { enableAgentDeviceAccess: true } } : {}),
      },
    };
    const current = yield* Ref.make<ServerSettingsValue>(initial);
    const changes = yield* PubSub.unbounded<ServerSettingsValue>();
    const reconciled = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const deleted = true;
    let capturedCursor = false;
    let agentRunning = false;
    let hubStops = 0;
    let agentStops = 0;
    const settingLayer = Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Ref.get(current).pipe(
        Effect.tap((value) =>
          value.projectSettingsOverrides[deletedProject] === undefined
            ? Deferred.succeed(reconciled, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
      ),
      updateSettings: (patch) =>
        Ref.updateAndGet(current, (value) => applyServerSettingsPatch(value, patch)).pipe(
          Effect.tap((value) => PubSub.publish(changes, value)),
        ),
      subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
    });
    const projects = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (id) =>
        Effect.sync(() => {
          if (id === deletedProject) expect(capturedCursor).toBe(true);
          return Option.some({
            deletedAt: id === deletedProject && deleted ? "2026-10-01T00:00:00.000Z" : null,
          } as ProjectStore.ProjectRow);
        }),
    });
    const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: () => Effect.succeed(null),
    });
    const ready: DeviceHost.DeviceHostReady = {
      nodePath: process.execPath,
      hub: { origin: "http://hub.example" },
      helpers: { serveSimAxSettings: null, serveSimCli: null },
      run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
    };
    const agentReady = {
      ...ready,
      agentDevice: {
        baseUrl: "http://daemon.example",
        token: "test-token",
        entryPath: "/test/cli.js",
      },
    };
    const host = Layer.mock(DeviceHost.DeviceHost)({
      id: "local",
      summary: Effect.succeed({
        id: "local",
        kind: "local",
        label: "Test host",
        platforms: [{ platform: "android", available: true }],
        hubInstalled: true,
        agentDeviceInstalled: true,
      }),
      platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
      current: Effect.sync(() => (agentRunning ? agentReady : ready)),
      ensureReady: () => Effect.succeed(ready),
      ensureAgentReady: () =>
        Effect.sync(() => {
          agentRunning = true;
          return agentReady;
        }),
      stopAgent: Effect.gen(function* () {
        agentRunning = false;
        agentStops++;
        yield* Deferred.succeed(stopped, undefined);
      }),
      stop: Effect.sync(() => {
        hubStops++;
      }),
    });
    const dependencies = Layer.mergeAll(
      settingLayer,
      projects,
      projections,
      host,
      Layer.mock(HttpServer.HttpServer)({
        address: Result.getOrThrow(NetAddress.inetAddressV4(NetAddress.ipv4Loopback, 9999)),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                emulators: [
                  {
                    id: "emulator-5554",
                    name: "Test AVD",
                    platform: "android",
                    version: "26",
                    booted: true,
                    physical: false,
                  },
                ],
                simulators: [],
              }),
            ),
          ),
        ),
      ),
    );
    const deviceLayer = Layer.effect(DeviceService.DeviceService, DeviceService.make).pipe(
      Layer.provideMerge(DeviceAgentAccess.layer),
      Layer.provide(dependencies),
      Layer.provide(ProcessRunner.layer),
      Layer.provide(NetService.layer),
    );
    yield* Effect.gen(function* () {
      const devices = yield* DeviceService.DeviceService;
      const session = yield* devices.open({
        threadId: ThreadId.make("manual-thread"),
        deviceId: DeviceId.make("emulator-5554"),
        platform: "android",
      });
      yield* devices.agentReadinessIfSupported("local", true);
      expect(agentRunning).toBe(true);
      const streamInputs: Array<{ afterSequence?: number; eventType?: string }> = [];
      const events = Layer.mock(EventSink.EventSinkV2)({
        latestSequence: () =>
          Effect.sync(() => {
            capturedCursor = true;
            return 10;
          }),
        stream: (input) => {
          if (input === undefined) throw new Error("Expected a filtered deletion stream");
          streamInputs.push(input);
          return Stream.empty;
        },
      });
      yield* Layer.build(
        DeviceAgentLifecycle.layer.pipe(
          Layer.provide(Layer.succeed(DeviceService.DeviceService, devices)),
          Layer.provide(dependencies),
          Layer.provide(events),
        ),
      );
      yield* Deferred.await(reconciled);
      if (!otherGrant) yield* Deferred.await(stopped);
      expect((yield* Ref.get(current)).projectSettingsOverrides[deletedProject]).toBeUndefined();
      expect(agentRunning).toBe(otherGrant);
      expect(agentStops).toBe(otherGrant ? 0 : 1);
      expect(hubStops).toBe(0);
      expect((yield* devices.state).sessions[0]).toBe(session);
      if (otherGrant)
        expect(
          (yield* Ref.get(current)).projectSettingsOverrides[activeProject]
            ?.enableAgentDeviceAccess,
        ).toBe(true);
      expect(streamInputs).toEqual(
        expect.arrayContaining([{ afterSequence: 10, eventType: "thread.deleted" }]),
      );
    }).pipe(Effect.provide(deviceLayer));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "device-project-lifecycle-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
