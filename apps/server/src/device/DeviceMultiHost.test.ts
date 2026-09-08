import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { DeviceHostError, DeviceHost } from "./DeviceHost.ts";
import { makeWithHosts } from "./DeviceService.ts";

it.effect("keeps hosts independent when serials collide and another host fails", () =>
  Effect.gen(function* () {
    const host = (id: string, failed = false): DeviceHost["Service"] => {
      const ready = {
        hub: { origin: `http://${id}` },
        agentDevice: { baseUrl: `http://${id}`, token: "test", entryPath: "/agent-device" },
        run: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
        helpers: { serveSimAxSettings: null, serveSimCli: null },
      };
      return {
        id,
        summary: Effect.succeed({
          id,
          label: id,
          kind: "local",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: [{ platform: "android", available: true }],
        }),
        platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
        ensureReady: () =>
          failed
            ? Effect.fail(
                new DeviceHostError({ hostId: id, step: "connect", cause: new Error("offline") }),
              )
            : Effect.succeed(ready),
        ensureAgentReady: () => Effect.succeed(ready),
        current: Effect.succeed(ready),
        stopAgent: Effect.void,
        stop: Effect.void,
      };
    };
    const http = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            simulators: [],
            emulators: [
              {
                id: "emulator-5554",
                name: "Pixel",
                version: "36",
                platform: "android",
                booted: true,
                physical: false,
              },
            ],
          }),
        ),
      ),
    );
    const hosts = new Map(["a", "b", "offline"].map((id) => [id, host(id, id === "offline")]));
    const service = yield* makeWithHosts(hosts).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );
    const listed = yield* service.list;
    expect(listed.devices.map((device) => device.hostId).sort()).toEqual(["a", "b"]);
    expect(listed.hostStatuses.offline?.status).toBe("failed");
    const threadId = ThreadId.make("thread");
    for (const hostId of ["a", "b"])
      yield* service.open({ threadId, hostId, deviceId: "emulator-5554", platform: "android" });
    yield* service.close({ threadId, hostId: "a", deviceId: "emulator-5554" });
    const state = yield* service.state;
    expect(state.devices).toHaveLength(2);
    expect(state.sessions.map((session) => session.hostId)).toEqual(["b"]);
    expect(state.hostStatuses.a?.status).toBe("ready");
    expect(state.hostStatuses.offline?.status).toBe("failed");
    yield* service.agentReadinessIfSupported("b");
    expect((yield* service.state).hostStatuses.b?.status).toBe("ready");
    yield* service.configure({ enabled: false });
    expect((yield* service.state).hostStatuses).toEqual({});
  }).pipe(
    Effect.provide(
      ServerSettingsService.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
  ),
);
