import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type EasDeviceHostConfig, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DeviceService from "./DeviceService.ts";
import * as EasDeviceHost from "./EasDeviceHost.ts";

const APP_ID = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";

const config = (overrides: Partial<EasDeviceHostConfig> = {}): EasDeviceHostConfig => ({
  kind: "eas",
  id: "eas",
  label: "EAS Simulator",
  appId: APP_ID,
  accessToken: "expo-token",
  maxSessionMinutes: 25,
  idleMinutes: 5,
  maxConcurrentSessions: 2,
  ...overrides,
});

interface Gate {
  readonly requested: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}
const makeGate = Effect.all({
  requested: Deferred.make<void>(),
  release: Deferred.make<void>(),
});

/** Expo's API and one session's preview host, recording what was asked of them. */
const fakeExpo = (
  options: {
    readonly status?: () => string;
    readonly failCreate?: boolean;
    /** Expo answers the create with GraphQL errors: a refusal. */
    readonly rejectCreate?: boolean;
    readonly failStop?: () => boolean;
    readonly failList?: () => boolean;
    readonly active?: ReadonlyArray<{ id: string; status: string; name: string }>;
    readonly previewGate?: Gate;
    readonly createGate?: Gate;
    /** Holds the first session read it answers with a gate. */
    readonly sessionGate?: () => Gate | undefined;
    readonly activeIncludesCreated?: boolean;
    readonly failPreview?: boolean;
    readonly omitCreatedFromActive?: boolean;
    /** The session's agent-device daemon answers with a server error. */
    readonly failAgent?: () => boolean;
  } = {},
) => {
  const calls: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  const releases: Array<unknown> = [];
  let created = 0;
  let createdName = "";
  const previews: string[] = [];
  let previewFails = options.failPreview ?? false;
  let createFails = options.failCreate ?? false;
  let sessionGated = false;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      if (url.origin === "https://preview.test") {
        previews.push(`${url.pathname}${url.search}`);
        expect(request.headers.authorization).toBe("Bearer preview-token");
        if (options.previewGate) {
          yield* Deferred.succeed(options.previewGate.requested, undefined);
          yield* Deferred.await(options.previewGate.release);
        }
        if (previewFails) {
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
        }
        if (url.pathname.endsWith("/api/screenshot")) {
          return HttpClientResponse.fromWeb(request, new Response(Uint8Array.of(137, 80, 78, 71)));
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            url.pathname === "/vendor/serve-emu/api"
              ? { serial: "emulator-5554" }
              : { device: "UDID-1" },
          ),
        );
      }
      if (url.origin === "https://agent.test") {
        expect(request.headers.authorization).toBe("Bearer agent-token");
        if (request.body._tag === "Uint8Array") {
          const rpc = JSON.parse(new TextDecoder().decode(request.body.body)) as {
            params: { command: string; session: string };
          };
          if (rpc.params.command === "close") releases.push(rpc.params.session);
        }
        if (options.failAgent?.())
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
        return HttpClientResponse.fromWeb(request, Response.json({ result: { ok: true } }));
      }
      const body =
        request.body._tag === "Uint8Array"
          ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
              query: string;
              variables: Record<string, { name?: string } & Record<string, unknown>>;
            })
          : { query: "", variables: {} };
      expect(request.headers.authorization).toBe("Bearer expo-token");
      const operation = /(?:query|mutation) (\w+)/.exec(body.query)?.[1] ?? "unknown";
      calls.push({ operation, variables: body.variables });
      if (operation === "T3CreateEasSimulatorSession") {
        createdName = body.variables.input?.name ?? "";
        if (options.createGate) {
          yield* Deferred.succeed(options.createGate.requested, undefined);
          yield* Deferred.await(options.createGate.release);
        }
        if (createFails)
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
        if (options.rejectCreate)
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ errors: [{ message: "Not allowed" }] }),
          );
      }
      if (operation === "T3StopEasSimulatorSession" && options.failStop?.()) {
        return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
      }
      if (operation === "T3ActiveEasSimulatorSessions" && options.failList?.()) {
        return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
      }
      const sessionGate =
        operation === "T3EasSimulatorSession" ? options.sessionGate?.() : undefined;
      if (sessionGate && !sessionGated) {
        sessionGated = true;
        yield* Deferred.succeed(sessionGate.requested, undefined);
        yield* Deferred.await(sessionGate.release);
      }
      const data =
        operation === "T3EasSimulatorAvailability"
          ? {
              app: {
                byId: {
                  ownerAccount: {
                    name: "pingdotgg",
                    accountFeatureGates: { "device-run-sessions": true },
                  },
                },
              },
            }
          : operation === "T3CreateEasSimulatorSession"
            ? { deviceRunSession: { createDeviceRunSession: { id: `session-${++created}` } } }
            : operation === "T3ActiveEasSimulatorSessions"
              ? {
                  app: {
                    byId: {
                      deviceRunSessionsPaginated: {
                        edges: [
                          ...(options.omitCreatedFromActive
                            ? []
                            : [{ node: { id: "orphan", status: "NEW", name: createdName } }]),
                          {
                            node: {
                              id: "someone-else",
                              status: "IN_PROGRESS",
                              name: "T3 Code · EAS Simulator · 000000",
                            },
                          },
                          ...(options.active ?? []).map((node) => ({ node })),
                          ...(options.activeIncludesCreated && created > 0
                            ? [
                                {
                                  node: {
                                    id: `session-${created}`,
                                    status: "STARTING",
                                    name: createdName,
                                  },
                                },
                              ]
                            : []),
                        ],
                      },
                    },
                  },
                }
              : operation === "T3EasSimulatorSession"
                ? {
                    deviceRunSessions: {
                      byId: {
                        id: body.variables.id,
                        status: options.status?.() ?? "IN_PROGRESS",
                        remoteConfig: {
                          __typename: "AgentDeviceRunSessionRemoteConfig",
                          agentDeviceRemoteSessionUrl: "https://agent.test",
                          agentDeviceRemoteSessionToken: "agent-token",
                          webPreviewToken: "preview-token",
                          previewApiUrl: "https://preview.test?token=preview-token",
                        },
                      },
                    },
                  }
                : {
                    deviceRunSession: {
                      ensureDeviceRunSessionStopped: { id: body.variables.id, status: "STOPPED" },
                    },
                  };
      return HttpClientResponse.fromWeb(request, Response.json({ data }));
    }),
  );
  const named = (operation: string) => calls.filter((call) => call.operation === operation);
  const stopped = () => named("T3StopEasSimulatorSession").map((call) => call.variables.id);
  const allowPreview = () => {
    previewFails = false;
  };
  const allowCreate = () => {
    createFails = false;
  };
  return { http, named, stopped, allowPreview, allowCreate, releases, previews };
};

const layer = Layer.mergeAll(
  ProcessRunner.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-eas-host-" }),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeHost = (
  expo: ReturnType<typeof fakeExpo>,
  hostConfig: EasDeviceHostConfig,
  scope: Scope.Scope,
) =>
  EasDeviceHost.make(hostConfig).pipe(
    Effect.provideService(HttpClient.HttpClient, expo.http),
    Effect.provideService(Scope.Scope, scope),
  );

describe("EAS Simulator host", () => {
  it.effect("starts a bounded session and routes its stream and agent to that session", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const scope = yield* Scope.make();
      const host = yield* makeHost(expo, config(), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const catalog = (yield* ready.devices.list).devices;
      expect(catalog.map((device) => [device.id, device.booted])).toEqual([
        ["eas-ios", false],
        ["eas-android", false],
      ]);

      expect(yield* ready.devices.boot(catalog[0]!)).toBe("session-1");
      expect(expo.named("T3CreateEasSimulatorSession")[0]?.variables.input).toMatchObject({
        appId: APP_ID,
        platform: "IOS",
        type: "AGENT_DEVICE",
        maxRunTimeMinutes: 25,
        maxIdleTimeMinutes: 5,
      });
      const listed = (yield* ready.devices.list).devices;
      expect(listed.find((device) => device.id === "session-1")?.booted).toBe(true);
      expect(yield* ready.devices.agentEndpoint!("session-1")).toEqual({
        baseUrl: "https://agent.test",
        token: "agent-token",
        agentDeviceId: "UDID-1",
      });

      const routed = yield* ready.upstream!(
        "/vendor/serve-sim/helper/session-1/webrtc/offer",
        new URLSearchParams("hostId=eas"),
      );
      expect(routed).toEqual({
        url: "https://preview.test/helper/UDID-1/webrtc/offer?hostId=eas",
        headers: { authorization: "Bearer preview-token" },
        protocols: ["serve-sim.token.preview-token"],
      });
      expect(
        yield* ready.upstream!(
          "/vendor/serve-sim/helper/ws",
          new URLSearchParams("device=session-1"),
        ),
      ).toMatchObject({ url: "https://preview.test/helper/ws?device=UDID-1" });
      expect(yield* ready.upstream!("/vendor/serve-emu/ws", new URLSearchParams())).toBeNull();
      expect(
        yield* ready.upstream!("/vendor/serve-sim/helper/%E0/config", new URLSearchParams()),
      ).toBeNull();

      yield* Scope.close(scope, Exit.void);
      expect(expo.named("T3StopEasSimulatorSession").map((call) => call.variables.id)).toEqual([
        "session-1",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("runs an Android session through serve-emu beside an iOS one", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const scope = yield* Scope.make();
      const host = yield* makeHost(expo, config(), scope);
      expect(yield* host.platformAvailability("android")).toEqual({
        platform: "android",
        available: true,
      });
      const ready = yield* host.ensureReady(() => Effect.void);
      const [ios, android] = (yield* ready.devices.list).devices;
      expect(yield* ready.devices.boot(ios!)).toBe("session-1");
      expect(yield* ready.devices.boot(android!)).toBe("session-2");
      expect(expo.named("T3CreateEasSimulatorSession")[1]?.variables.input).toMatchObject({
        platform: "ANDROID",
      });
      const running = (yield* ready.devices.list).devices.find(
        (device) => device.id === "session-2",
      );
      expect(running).toMatchObject({ platform: "android", booted: true });

      expect(yield* ready.devices.agentEndpoint!("session-2")).toMatchObject({
        agentDeviceId: "emulator-5554",
      });
      expect(Array.from(yield* ready.devices.screenshot(running!))).toEqual([137, 80, 78, 71]);
      expect(expo.previews.slice(-2)).toEqual([
        "/vendor/serve-emu/api",
        "/vendor/serve-emu/api/screenshot?device=emulator-5554",
      ]);
      expect(
        yield* ready.upstream!(
          "/vendor/serve-emu/webrtc/offer",
          new URLSearchParams("device=session-2&hostId=eas"),
        ),
      ).toEqual({
        url: "https://preview.test/vendor/serve-emu/webrtc/offer?device=emulator-5554&hostId=eas",
        headers: { authorization: "Bearer preview-token" },
        protocols: ["serve-emu.token.preview-token"],
      });
      // Each session answers only on its own platform's stream.
      expect(
        yield* ready.upstream!("/vendor/serve-emu/api", new URLSearchParams("device=session-1")),
      ).toBeNull();
      expect(
        yield* ready.upstream!("/vendor/serve-sim/api", new URLSearchParams("device=session-2")),
      ).toBeNull();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("refuses to start past its session limit", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toBe(
        "EAS Simulator is unavailable: EAS Simulator is limited to 1 running session. Close one in the Device panel first.",
      );
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("tells concurrent sessions apart although EAS gives each the same UDID", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const scope = yield* Scope.make();
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 2 }), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-1");
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-2");
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "eas-android",
        "session-1",
        "session-2",
      ]);
      expect(
        yield* ready.upstream!(
          "/vendor/serve-sim/api",
          new URLSearchParams("device=session-2&hostId=eas"),
        ),
      ).toMatchObject({ url: "https://preview.test/api?device=UDID-1&hostId=eas" });

      yield* ready.devices.shutdown({ id: "session-1", platform: "ios" });
      expect(expo.stopped()).toEqual(["session-1"]);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "eas-android",
        "session-2",
      ]);
      yield* Scope.close(scope, Exit.void);
      expect(expo.stopped()).toEqual(["session-1", "session-2"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "keeps a refused create's record for the reaper without counting it after a restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const server = yield* ServerConfig.ServerConfig;
        const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
        // Expo refuses the create and lists nothing.
        const expo = fakeExpo({ rejectCreate: true, omitCreatedFromActive: true });
        const first = yield* Scope.make();
        const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), first);
        const ready = yield* host.ensureReady(() => Effect.void);
        const [catalogDevice] = (yield* ready.devices.list).devices;
        yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
        const entries = JSON.parse(yield* fs.readFileString(ledger)) as Array<{
          refused?: boolean;
        }>;
        expect(entries.map((entry) => entry.refused)).toEqual([true]);
        yield* Scope.close(first, Exit.void);
        // A later server cannot even list the app: the record must not hold a slot.
        const later = fakeExpo({ failList: () => true });
        const restarted = yield* makeHost(
          later,
          config({ maxConcurrentSessions: 1 }),
          yield* Scope.make(),
        );
        const readyAgain = yield* restarted.ensureReady(() => Effect.void);
        const [device] = (yield* readyAgain.devices.list).devices;
        expect(yield* readyAgain.devices.boot(device!)).toBe("session-1");
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "does not sweep a replacement's session from a listing in flight when its scope closes",
    () =>
      Effect.gen(function* () {
        const gate = yield* makeGate;
        let armed = false;
        const expo = fakeExpo({ sessionGate: () => (armed ? gate : undefined) });
        const first = yield* Scope.make();
        const old = yield* makeHost(expo, config(), first);
        const oldReady = yield* old.ensureReady(() => Effect.void);
        const [catalogDevice] = (yield* oldReady.devices.list).devices;
        expect(yield* oldReady.devices.boot(catalogDevice!)).toBe("session-1");
        // Long enough that the listing reads the session's status and a sweep is due.
        yield* TestClock.adjust("2 minutes");
        armed = true;
        const listing = yield* oldReady.devices.list.pipe(Effect.forkChild);
        yield* Deferred.await(gate.requested);
        // Settings saved while the old listing waits on Expo.
        yield* Scope.close(first, Exit.void);
        const replacement = yield* makeHost(expo, config(), yield* Scope.make());
        const ready = yield* replacement.ensureReady(() => Effect.void);
        const [device] = (yield* ready.devices.list).devices;
        expect(yield* ready.devices.boot(device!)).toBe("session-2");
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(listing);
        expect(expo.stopped()).toEqual(["session-1"]);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops the session a refused create made anyway", () =>
    Effect.gen(function* () {
      // Expo refuses the create but lists a session by its name.
      const expo = fakeExpo({ rejectCreate: true });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const failure = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(failure.message).toContain("Not allowed");
      expect(expo.stopped()).toEqual(["orphan"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("records a session before creating it and refuses to start without the record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      // A directory where the ledger file should be: it can be neither read nor written.
      yield* fs.makeDirectory(path.join(server.stateDir, "device", "eas", "eas.json"), {
        recursive: true,
      });
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const failure = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(failure.message).toContain("could not be read");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps a session it could not stop counted, listed, and retried", () =>
    Effect.gen(function* () {
      let stopFails = true;
      const expo = fakeExpo({ failStop: () => stopFails });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      yield* ready.devices.shutdown({ id: "session-1", platform: "ios" }).pipe(Effect.flip);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toContain("session-1");
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("limited to 1 running session");
      stopFails = false;
      yield* ready.devices.list;
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "eas-android",
      ]);
      expect(expo.stopped().filter((id) => id === "session-1").length).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("lets go of a stopping session Expo has ended although its stop keeps failing", () =>
    Effect.gen(function* () {
      let status = "IN_PROGRESS";
      const expo = fakeExpo({ failStop: () => true, status: () => status });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      yield* ready.devices.shutdown({ id: "session-1", platform: "ios" }).pipe(Effect.flip);
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toContain("session-1");
      // Expo ended it by itself: the stop keeps failing, but the status says so.
      status = "STOPPED";
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "eas-android",
      ]);
      status = "IN_PROGRESS";
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-2");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("asks for an EAS project before starting anything when none can be found", () =>
    Effect.gen(function* () {
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config({ appId: undefined }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const failure = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(failure.message).toContain("Choose one for this host in Settings");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reports iOS unavailable on a server with no Expo credential", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-expo-home-" });
      const host = yield* makeHost(
        fakeExpo(),
        config({ accessToken: "" }),
        yield* Scope.make(),
      ).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
      const [ios] = (yield* host.summary).platforms;
      expect(ios).toMatchObject({ platform: "ios", available: false });
      expect(ios?.reason).toContain("No Expo credential on the server");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops a session that is still starting when the host stops", () =>
    Effect.gen(function* () {
      const previewGate = yield* makeGate;
      const expo = fakeExpo({ previewGate });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const booting = yield* ready.devices.boot(catalogDevice!).pipe(Effect.forkChild);
      yield* Deferred.await(previewGate.requested);
      // Never released: stopping must not wait for the session to become ready.
      yield* host.stop;
      expect(expo.stopped()).toEqual(["session-1"]);
      const failure = yield* Fiber.join(booting).pipe(Effect.flip);
      expect(failure.message).toContain("was stopped while the session started");
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual([
        "eas-ios",
        "eas-android",
      ]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("releases each thread's agent session on close and keeps the session running", () =>
    Effect.gen(function* () {
      let agentFails = false;
      const expo = fakeExpo({ failAgent: () => agentFails });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const service = yield* DeviceService.makeWithHosts(new Map([["eas", host]]), undefined, () =>
        Effect.succeed("/eas-agent.json"),
      );
      const first = ThreadId.make("first");
      const second = ThreadId.make("second");
      const opened = yield* service.open({
        threadId: first,
        hostId: "eas",
        deviceId: "eas-ios",
        platform: "ios",
      });
      expect(opened.deviceId).toBe("session-1");
      yield* service.open({
        threadId: second,
        hostId: "eas",
        deviceId: opened.deviceId,
        platform: "ios",
      });
      const sessionOf = (threadId: ThreadId) =>
        service
          .agentTarget({ threadId, hostId: "eas", deviceId: opened.deviceId })
          .pipe(Effect.map((target) => target.args[3]));
      const firstSession = yield* sessionOf(first);
      const secondSession = yield* sessionOf(second);

      yield* service.close({ threadId: first });
      expect(expo.releases).toEqual([firstSession]);
      expect((yield* service.state).sessions.map((entry) => entry.threadId)).toEqual([second]);

      agentFails = true;
      const failed = yield* Effect.exit(service.close({ threadId: second, shutdown: false }));
      expect(Exit.isFailure(failed)).toBe(true);
      expect((yield* service.state).sessions.map((entry) => entry.threadId)).toEqual([second]);

      agentFails = false;
      yield* service.close({ threadId: second, shutdown: false });
      expect(expo.releases).toEqual([firstSession, secondSession, secondSession]);
      expect((yield* service.state).sessions).toEqual([]);
      expect(expo.stopped()).not.toContain("session-1");
      expect(
        (yield* service.state).devices.find((device) => device.id === "session-1")?.booted,
      ).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          layer,
          NodeCrypto.layer,
          ServerSettings.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
        ),
      ),
    ),
  );
});
