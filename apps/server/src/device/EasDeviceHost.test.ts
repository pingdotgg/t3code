import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { EasDeviceHostConfig } from "@t3tools/contracts";
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
  } = {},
) => {
  const calls: Array<{ operation: string; variables: Record<string, unknown> }> = [];
  let created = 0;
  let createdName = "";
  let previewFails = options.failPreview ?? false;
  let createFails = options.failCreate ?? false;
  let sessionGated = false;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const url = new URL(request.url);
      if (url.origin === "https://preview.test") {
        expect(request.headers.authorization).toBe("Bearer preview-token");
        if (options.previewGate) {
          yield* Deferred.succeed(options.previewGate.requested, undefined);
          yield* Deferred.await(options.previewGate.release);
        }
        if (previewFails) {
          return HttpClientResponse.fromWeb(request, new Response("bad gateway", { status: 502 }));
        }
        return HttpClientResponse.fromWeb(request, Response.json({ device: "UDID-1" }));
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
  return { http, named, stopped, allowPreview, allowCreate };
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
      expect(catalog.map((device) => [device.id, device.booted])).toEqual([["eas-ios", false]]);

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
        "session-2",
      ]);
      yield* Scope.close(scope, Exit.void);
      expect(expo.stopped()).toEqual(["session-1", "session-2"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops only the sessions a previous server recorded, found by name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
      yield* fs.makeDirectory(path.dirname(ledger), { recursive: true });
      yield* fs.writeFileString(
        ledger,
        JSON.stringify([
          { name: "T3 Code · EAS Simulator · left", appId: APP_ID, recordedAt: 0 },
          // Recorded long enough ago that Expo has ended it, so the record goes.
          { name: "T3 Code · EAS Simulator · gone", appId: APP_ID, recordedAt: -181 * 60_000 },
          // Recorded just now and not listed yet: kept for a later sweep.
          { name: "T3 Code · EAS Simulator · new", appId: APP_ID, recordedAt: 0 },
        ]),
      );
      const expo = fakeExpo({
        active: [
          { id: "left-behind", status: "IN_PROGRESS", name: "T3 Code · EAS Simulator · left" },
        ],
      });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      yield* host.ensureReady(() => Effect.void);
      // The sweep runs in the background, so readiness does not wait on Expo.
      const ledgerNames = Effect.map(
        Effect.flatMap(fs.readFileString(ledger), (text) =>
          Effect.try(() => JSON.parse(text) as ReadonlyArray<{ name: string }>),
        ),
        (entries) => entries.map((entry) => entry.name),
      );
      yield* Effect.eventually(
        Effect.flatMap(ledgerNames, (names) =>
          names.length === 1 ? Effect.void : Effect.fail("not swept yet"),
        ),
      );
      expect(expo.stopped()).toEqual(["left-behind"]);
      expect(yield* ledgerNames).toEqual(["T3 Code · EAS Simulator · new"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("counts a fresh record a previous server left until Expo lists it or would have", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
      yield* fs.makeDirectory(path.dirname(ledger), { recursive: true });
      yield* fs.writeFileString(
        ledger,
        JSON.stringify([{ name: "T3 Code · EAS Simulator · new", appId: APP_ID, recordedAt: 0 }]),
      );
      const expo = fakeExpo();
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      // The record is fresh and Expo does not list it yet: it holds the slot.
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("still being cleaned up");
      yield* TestClock.adjust("6 minutes");
      yield* ready.devices.list;
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-1");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("counts an old record a previous server left until a sweep stops its session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
      yield* fs.makeDirectory(path.dirname(ledger), { recursive: true });
      yield* fs.writeFileString(
        ledger,
        JSON.stringify([
          { name: "T3 Code · EAS Simulator · old", appId: APP_ID, recordedAt: -10 * 60_000 },
        ]),
      );
      const expo = fakeExpo({
        active: [
          { id: "old-session", status: "IN_PROGRESS", name: "T3 Code · EAS Simulator · old" },
        ],
      });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      // Listing sweeps before anything starts, so the old session is stopped first.
      const [catalogDevice] = (yield* ready.devices.list).devices;
      expect(expo.stopped()).toContain("old-session");
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-1");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps an old record counted while the listing that would find it fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
      yield* fs.makeDirectory(path.dirname(ledger), { recursive: true });
      yield* fs.writeFileString(
        ledger,
        JSON.stringify([
          { name: "T3 Code · EAS Simulator · old", appId: APP_ID, recordedAt: -10 * 60_000 },
        ]),
      );
      let listFails = true;
      const expo = fakeExpo({
        active: [
          { id: "old-session", status: "IN_PROGRESS", name: "T3 Code · EAS Simulator · old" },
        ],
        failList: () => listFails,
      });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      // The sweep could not look, so the record still holds the slot.
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("still being cleaned up");
      listFails = false;
      yield* ready.devices.list;
      expect(expo.stopped()).toContain("old-session");
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-1");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "frees the slot of a record Expo has ended by now, but keeps it until a listing confirms",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const server = yield* ServerConfig.ServerConfig;
        const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
        yield* fs.makeDirectory(path.dirname(ledger), { recursive: true });
        yield* fs.writeFileString(
          ledger,
          JSON.stringify([
            { name: "T3 Code · EAS Simulator · gone", appId: APP_ID, recordedAt: -181 * 60_000 },
            {
              name: "T3 Code · EAS Simulator · refused",
              appId: APP_ID,
              recordedAt: -181 * 60_000,
              refused: true,
            },
            // No queue holds a session for a day: forgotten unconfirmed.
            {
              name: "T3 Code · EAS Simulator · ancient",
              appId: APP_ID,
              recordedAt: -25 * 60 * 60_000,
            },
          ]),
        );
        // The app is gone, say: listing it fails for good.
        const expo = fakeExpo({ failList: () => true });
        const host = yield* makeHost(
          expo,
          config({ maxConcurrentSessions: 1 }),
          yield* Scope.make(),
        );
        const ready = yield* host.ensureReady(() => Effect.void);
        const [catalogDevice] = (yield* ready.devices.list).devices;
        expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-1");
        const names = (JSON.parse(yield* fs.readFileString(ledger)) as Array<{ name: string }>).map(
          (entry) => entry.name,
        );
        // The listing never confirmed the two: a queued session could still be
        // running, so their records stay for the reaper.
        expect(names.filter((name) => !/[0-9a-f]{6}$/.test(name))).toEqual([
          "T3 Code · EAS Simulator · gone",
          "T3 Code · EAS Simulator · refused",
        ]);
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

  it.effect("leaves a replacement's session alone once its own scope has closed", () =>
    Effect.gen(function* () {
      // One Expo for both instances: they share the record and the account.
      const expo = fakeExpo();
      const first = yield* Scope.make();
      const old = yield* makeHost(expo, config(), first);
      const oldReady = yield* old.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* oldReady.devices.list).devices;
      expect(yield* oldReady.devices.boot(catalogDevice!)).toBe("session-1");
      // Settings saved: the old instance goes, a replacement takes its id.
      yield* Scope.close(first, Exit.void);
      expect(expo.stopped()).toEqual(["session-1"]);
      const replacement = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* replacement.ensureReady(() => Effect.void);
      const [device] = (yield* ready.devices.list).devices;
      expect(yield* ready.devices.boot(device!)).toBe("session-2");
      // A listing still running on the old instance must not sweep the new
      // session, which it does not own but its replacement does.
      yield* TestClock.adjust("2 minutes");
      yield* oldReady.devices.list;
      expect(expo.stopped()).toEqual(["session-1"]);
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

  it.effect("waits for a record write in flight before its scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const gate = yield* makeGate;
      let armed = false;
      // The ledger read inside a write waits on the gate once armed.
      const gatedFs: FileSystem.FileSystem = {
        ...fs,
        readFileString: (path, encoding) =>
          Effect.gen(function* () {
            if (armed && path.endsWith("eas.json")) {
              armed = false;
              yield* Deferred.succeed(gate.requested, undefined);
              yield* Deferred.await(gate.release);
            }
            return yield* fs.readFileString(path, encoding);
          }),
      };
      let status = "IN_PROGRESS";
      // Nothing is listed, so the close's own sweep writes nothing: only the
      // write in flight can hold the close.
      const expo = fakeExpo({ status: () => status, omitCreatedFromActive: true });
      const first = yield* Scope.make();
      const old = yield* makeHost(expo, config(), first).pipe(
        Effect.provideService(FileSystem.FileSystem, gatedFs),
      );
      const oldReady = yield* old.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* oldReady.devices.list).devices;
      expect(yield* oldReady.devices.boot(catalogDevice!)).toBe("session-1");
      // Expo ended the session; the next listing forgets its record.
      status = "STOPPED";
      yield* TestClock.adjust("20 seconds");
      armed = true;
      const listing = yield* oldReady.devices.list.pipe(Effect.forkChild);
      yield* Deferred.await(gate.requested);
      // Settings saved while that write is in flight: closing waits for it.
      const listingsBefore = expo.named("T3ActiveEasSimulatorSessions").length;
      const closing = yield* Scope.close(first, Exit.void).pipe(Effect.forkChild);
      // The close reads the record and lists sessions in real time: yield until
      // its sweep has listed, then a good deal more, before looking at it.
      while (expo.named("T3ActiveEasSimulatorSessions").length === listingsBefore) {
        yield* Effect.yieldNow;
      }
      for (let i = 0; i < 200; i++) yield* Effect.yieldNow;
      expect(closing.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(listing);
      yield* Fiber.join(closing);
      const replacement = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* replacement.ensureReady(() => Effect.void);
      const [device] = (yield* ready.devices.list).devices;
      status = "IN_PROGRESS";
      expect(yield* ready.devices.boot(device!)).toBe("session-2");
      // The old write landed first, so the replacement's record is intact.
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const entries = JSON.parse(
        yield* fs.readFileString(path.join(server.stateDir, "device", "eas", "eas.json")),
      ) as Array<{ name: string }>;
      expect(entries).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps an old record whose session is listed but cannot be stopped", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
      yield* fs.makeDirectory(path.dirname(ledger), { recursive: true });
      yield* fs.writeFileString(
        ledger,
        JSON.stringify([
          { name: "T3 Code · EAS Simulator · old", appId: APP_ID, recordedAt: -181 * 60_000 },
        ]),
      );
      // Expo still lists it (queued for hours, say) and refuses to stop it.
      const expo = fakeExpo({
        active: [
          { id: "old-session", status: "IN_PROGRESS", name: "T3 Code · EAS Simulator · old" },
        ],
        failStop: () => true,
      });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      // Found and still running: its slot stays taken and its record stays.
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("still being cleaned up");
      const names = (JSON.parse(yield* fs.readFileString(ledger)) as Array<{ name: string }>).map(
        (entry) => entry.name,
      );
      expect(names).toContain("T3 Code · EAS Simulator · old");
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

  it.effect("keeps a session tracked when the open that started it is interrupted", () =>
    Effect.gen(function* () {
      const createGate = yield* makeGate;
      const expo = fakeExpo({ createGate });
      const scope = yield* Scope.make();
      const host = yield* makeHost(expo, config(), scope);
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const opening = yield* ready.devices.boot(catalogDevice!).pipe(Effect.forkChild);
      yield* Deferred.await(createGate.requested);
      yield* Fiber.interrupt(opening);
      yield* Deferred.succeed(createGate.release, undefined);
      // The start goes on in the host and tracks its session.
      yield* Effect.eventually(
        ready.devices.list.pipe(
          Effect.flatMap(({ devices }) =>
            devices.some((device) => device.id === "session-1")
              ? Effect.void
              : Effect.fail("not tracked yet"),
          ),
        ),
      );
      yield* Scope.close(scope, Exit.void);
      expect(expo.stopped()).toEqual(["session-1"]);
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
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual(["eas-ios"]);
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
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual(["eas-ios"]);
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
  it.effect("stops listing sessions Expo already ended", () =>
    Effect.gen(function* () {
      let status = "IN_PROGRESS";
      const expo = fakeExpo({ status: () => status });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!);
      status = "STOPPED";
      yield* TestClock.adjust("20 seconds");
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual(["eas-ios"]);
      expect(yield* ready.devices.agentEndpoint!("session-1").pipe(Effect.flip)).toMatchObject({
        reason: "This EAS Simulator device is no longer running.",
      });
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
      expect((yield* ready.devices.list).devices.map((device) => device.id)).toEqual(["eas-ios"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("leaves a start in progress to its owner when the sweep runs", () =>
    Effect.gen(function* () {
      const previewGate = yield* makeGate;
      // Expo lists the starting session by name, as it does while it boots.
      const expo = fakeExpo({ previewGate, activeIncludesCreated: true });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const server = yield* ServerConfig.ServerConfig;
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      const booting = yield* ready.devices.boot(catalogDevice!).pipe(Effect.forkChild);
      yield* Deferred.await(previewGate.requested);
      yield* TestClock.adjust("61 seconds");
      yield* ready.devices.list;
      expect(expo.stopped()).toEqual([]);
      const ledger = path.join(server.stateDir, "device", "eas", "eas.json");
      expect(JSON.parse(yield* fs.readFileString(ledger))).toHaveLength(1);
      yield* Deferred.succeed(previewGate.release, undefined);
      expect(yield* Fiber.join(booting)).toBe("session-1");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("keeps a session counted when its start fails and stopping it fails too", () =>
    Effect.gen(function* () {
      let stopFails = true;
      const expo = fakeExpo({ failPreview: true, failStop: () => stopFails });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      // The preview probe is retried a few seconds apart before the start gives up.
      const failing = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip, Effect.forkChild);
      while (failing.pollUnsafe() === undefined) yield* TestClock.adjust("1 second");
      yield* Fiber.join(failing);
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("still being cleaned up");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(1);
      stopFails = false;
      yield* ready.devices.list;
      expect(expo.stopped().at(-1)).toBe("session-1");
      expo.allowPreview();
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-2");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops only its own session when creating one fails after Expo made it", () =>
    Effect.gen(function* () {
      const expo = fakeExpo({ failCreate: true });
      const host = yield* makeHost(expo, config(), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(expo.stopped()).toEqual(["orphan"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("counts a create whose outcome is unknown against the limit, then frees it", () =>
    Effect.gen(function* () {
      // Create fails and the session is not listed yet, so the outcome is unknown.
      const expo = fakeExpo({ failCreate: true, omitCreatedFromActive: true });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      // The slot is held: Expo may have made the session.
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("still being cleaned up");
      expect(expo.named("T3CreateEasSimulatorSession")).toHaveLength(1);
      // After Expo would have listed it, the slot frees and a new start runs.
      yield* TestClock.adjust("6 minutes");
      yield* ready.devices.list;
      expo.allowCreate();
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-1");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("holds the slot when a failed create’s session is listed but its stop fails", () =>
    Effect.gen(function* () {
      let stopFails = true;
      // Create fails, Expo lists the session by name, and stopping it fails too.
      const expo = fakeExpo({ failCreate: true, failStop: () => stopFails });
      const host = yield* makeHost(expo, config({ maxConcurrentSessions: 1 }), yield* Scope.make());
      const ready = yield* host.ensureReady(() => Effect.void);
      const [catalogDevice] = (yield* ready.devices.list).devices;
      yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      const refused = yield* ready.devices.boot(catalogDevice!).pipe(Effect.flip);
      expect(refused.message).toContain("still being cleaned up");
      stopFails = false;
      yield* ready.devices.list;
      expect(expo.stopped()).toContain("orphan");
      expo.allowCreate();
      expect(yield* ready.devices.boot(catalogDevice!)).toBe("session-1");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
