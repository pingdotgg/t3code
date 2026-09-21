import { expect, it } from "@effect/vitest";
import { LOCAL_DEVICE_HOST_ID, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ServerSettingsService } from "../serverSettings.ts";
import { DeviceHostError, DeviceHost } from "./DeviceHost.ts";
import { makeWithHosts } from "./DeviceService.ts";

for (const hostId of [LOCAL_DEVICE_HOST_ID, "mac-ssh"]) {
  for (const failure of [
    { code: 127, stderr: "sh: exec: emulator: not found" },
    { code: 1, stderr: "emulator: SDK directory is unreadable" },
    { code: 255, stderr: "ssh: connection reset by peer" },
  ]) {
    it.effect(
      `retains partial discovery and diagnostics on ${hostId} after emulator exit ${failure.code}`,
      () =>
        Effect.gen(function* () {
          let enumeration = { ...failure, stdout: "incomplete-output-must-not-be-an-avd" };
          let hubErrors = [{ message: "One simulator could not be inspected" }];
          const ready = {
            nodePath: process.execPath,
            hub: { origin: "http://device.test" },
            agentDevice: {
              baseUrl: "http://device.test",
              token: "test",
              entryPath: "/agent-device",
            },
            run: () => Effect.succeed(enumeration),
            helpers: { serveSimAxSettings: null, serveSimCli: null },
          };
          const host: DeviceHost["Service"] = {
            id: hostId,
            summary: Effect.succeed({
              id: hostId,
              label: hostId,
              kind: hostId === LOCAL_DEVICE_HOST_ID ? "local" : "ssh",
              hubInstalled: true,
              agentDeviceInstalled: true,
              platforms: [
                { platform: "android", available: true },
                { platform: "ios", available: true },
              ],
            }),
            platformAvailability: (platform) => Effect.succeed({ platform, available: true }),
            ensureReady: () => Effect.succeed(ready),
            ensureAgentReady: () => Effect.succeed(ready),
            current: Effect.succeed(ready),
            stopAgent: Effect.void,
            stop: Effect.void,
          };
          const http = HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  simulators: [
                    {
                      id: "ios-1",
                      name: "iPhone",
                      version: "26",
                      platform: "ios",
                      booted: true,
                      physical: false,
                    },
                  ],
                  emulators: [
                    {
                      id: "phone-1",
                      name: "Physical Pixel",
                      version: "36",
                      platform: "android",
                      booted: true,
                      physical: true,
                    },
                    {
                      id: "emulator-5554",
                      name: "Running_AVD",
                      version: "36",
                      platform: "android",
                      booted: true,
                      physical: false,
                    },
                  ],
                  errors: hubErrors,
                }),
              ),
            ),
          );
          const service = yield* makeWithHosts(new Map([[hostId, host]])).pipe(
            Effect.provideService(HttpClient.HttpClient, http),
          );
          const partial = yield* service.list;
          expect(partial.devices.map((device) => device.id)).toEqual([
            "ios-1",
            "phone-1",
            "emulator-5554",
          ]);
          expect(partial.hostStatuses[hostId]).toEqual({
            status: "ready",
            detail: expect.stringContaining(failure.stderr),
          });
          expect(partial.hostStatuses[hostId]?.detail).toContain(`exit code ${failure.code}`);
          expect(partial.hostStatuses[hostId]?.detail).toContain(hubErrors[0]!.message);
          if (hostId === LOCAL_DEVICE_HOST_ID)
            expect(partial.hostStatusDetail).toBe(partial.hostStatuses[hostId]?.detail);

          enumeration = {
            code: failure.code,
            stdout: "",
            stderr: "verbose-prefix" + "x".repeat(3000) + failure.stderr,
          };
          const bounded = yield* service.list;
          expect(bounded.devices).toEqual(partial.devices);
          expect(bounded.hostStatuses[hostId]?.detail).not.toContain("verbose-prefix");
          expect(bounded.hostStatuses[hostId]?.detail?.endsWith(failure.stderr)).toBe(true);
          expect(bounded.hostStatuses[hostId]?.detail?.length).toBeLessThan(2300);

          enumeration = {
            code: 0,
            stderr: "",
            stdout: "Running_AVD\r\nStopped_AVD\r\nStopped_AVD\r\n",
          };
          hubErrors = [];
          const recovered = yield* service.list;
          expect(recovered.hostStatuses[hostId]).toEqual({ status: "ready" });
          expect(recovered.devices.map((device) => device.id)).toEqual([
            "ios-1",
            "phone-1",
            "emulator-5554",
            "Stopped_AVD",
          ]);
          expect(recovered.devices.at(-1)).toMatchObject({
            hostId,
            booted: false,
            physical: false,
          });
          if (hostId === LOCAL_DEVICE_HOST_ID) expect(recovered.hostStatusDetail).toBeUndefined();
        }).pipe(Effect.provide(ServerSettingsService.layerTest({ enableDeviceSupport: true }))),
    );
  }
}

it.effect("keeps hosts independent when serials collide and another host fails", () =>
  Effect.gen(function* () {
    const host = (id: string, failed = false): DeviceHost["Service"] => {
      const ready = {
        nodePath: process.execPath,
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
          kind: id === "b" ? "ssh" : "local",
          hubInstalled: true,
          agentDeviceInstalled: true,
          platforms: id === "b" ? [] : [{ platform: "android", available: true }],
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
    const writeStarted = yield* Deferred.make<void>();
    const finishWrite = yield* Deferred.make<void>();
    const order: string[] = [];
    const service = yield* makeWithHosts(hosts, undefined, () =>
      Effect.gen(function* () {
        order.push("write started");
        yield* Deferred.succeed(writeStarted, undefined);
        yield* Deferred.await(finishWrite);
        order.push("write finished");
        return "/host-config.json";
      }),
    ).pipe(Effect.provideService(HttpClient.HttpClient, http));
    expect(yield* service.agentReadinessIfSupported("b")).not.toBeNull();
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
    const targeting = yield* service
      .agentTarget({ threadId, hostId: "b", deviceId: "emulator-5554" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(writeStarted);
    const replacing = yield* service
      .withLifecycleLock(
        Effect.gen(function* () {
          order.push("replace");
          hosts.set("b", host("b"));
          yield* service.refreshHosts;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.succeed(finishWrite, undefined);
    yield* Fiber.join(targeting);
    yield* Fiber.join(replacing);
    expect(order).toEqual(["write started", "write finished", "replace"]);
    const replaced = yield* service.state;
    expect(replaced.sessions).toEqual([]);
    expect(replaced.devices.map((device) => device.hostId)).toEqual(["a"]);
    expect(replaced.hostStatuses.b).toBeUndefined();
    yield* service.open({ threadId, hostId: "b", deviceId: "emulator-5554", platform: "android" });
    hosts.delete("b");
    yield* service.refreshHosts;
    yield* service.setHostStatus("b", { status: "ready" });
    expect((yield* service.state).hostStatuses.b).toBeUndefined();
    expect((yield* service.state).sessions).toEqual([]);
    yield* service.agentReadinessIfSupported("a");
    expect((yield* service.state).hostStatuses.a?.status).toBe("ready");
    yield* service.configure({ enabled: false });
    expect((yield* service.state).hostStatuses).toEqual({});
  }).pipe(
    Effect.provide(
      ServerSettingsService.layerTest({ enableDeviceSupport: true, enableAgentDeviceAccess: true }),
    ),
  ),
);
