import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { expect, vi } from "vite-plus/test";
import type * as Electron from "electron";

vi.mock("electron", () => ({}));

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import * as DesktopShutdown from "../../app/DesktopShutdown.ts";
import * as DesktopState from "../../app/DesktopState.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopBackendConfiguration from "../../backend/DesktopBackendConfiguration.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopServerExposure from "../../backend/DesktopServerExposure.ts";
import * as ElectronApp from "../../electron/ElectronApp.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";
import { getLocalEnvironmentBearerToken, getLocalEnvironmentBootstraps } from "./window.ts";
import { setServerExposureMode, setTailscaleServeEnabled } from "./serverExposure.ts";

const state = {
  mode: "local-only" as const,
  endpointUrl: null,
  advertisedHost: null,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};

const harness = Effect.fn("SensitiveIpcTest.harness")(function* (
  url = "t3code://app/threads/1",
  isDevelopment = false,
  hasWindow = true,
) {
  const calls: string[] = [];
  const frame = { url };
  const event = { sender: { id: 7 }, senderFrame: frame };
  const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
  const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
  const ipcMain: DesktopIpc.DesktopIpcMain = {
    handle: (channel, listener) => void invoke.set(channel, listener),
    removeHandler: (channel) => void invoke.delete(channel),
    on: (channel, listener) => void sync.set(channel, listener),
    removeAllListeners: (channel) => void sync.delete(channel),
  };
  const record = (name: string) => Effect.sync(() => void calls.push(name));
  const layer = Layer.mergeAll(
    DesktopIpc.layer(ipcMain),
    Layer.mock(ElectronWindow.ElectronWindow, {
      main: Effect.succeed(
        hasWindow
          ? Option.some({ webContents: { id: 7, mainFrame: frame } } as Electron.BrowserWindow)
          : Option.none(),
      ),
    }),
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      isDevelopment,
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.mock(DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth, {
      getBearerToken: record("token").pipe(Effect.as("test-bearer")),
    }),
    Layer.mock(DesktopBackendPool.DesktopBackendPool, {
      list: record("bootstraps").pipe(Effect.as([])),
    }),
    Layer.mock(DesktopBackendConfiguration.DesktopBackendConfiguration, {}),
    Layer.mock(DesktopServerExposure.DesktopServerExposure, {
      setMode: () => record("exposure").pipe(Effect.as({ state, requiresRelaunch: false })),
      setTailscaleServeEnabled: () =>
        record("tailscale").pipe(Effect.as({ state, requiresRelaunch: false })),
    }),
    Layer.mock(DesktopLifecycle.DesktopLifecycle, {}),
    Layer.mock(DesktopShutdown.DesktopShutdown, {}),
    DesktopState.layer,
    Layer.mock(DesktopWindow.DesktopWindow, {}),
    Layer.mock(ElectronApp.ElectronApp, {}),
    Layer.mock(ElectronTheme.ElectronTheme, {}),
  );
  yield* Effect.gen(function* () {
    const ipc = yield* DesktopIpc.DesktopIpc;
    yield* ipc.handle(getLocalEnvironmentBearerToken);
    yield* ipc.handleSync(getLocalEnvironmentBootstraps);
    yield* ipc.handle(setServerExposureMode);
    yield* ipc.handle(setTailscaleServeEnabled);
  }).pipe(Effect.provide(layer));
  return { calls, frame, event, invoke, sync };
});

describe("sensitive desktop IPC", () => {
  it.effect.each([
    { url: "t3code://app/threads/1", development: false },
    { url: "t3code-dev://app/settings", development: true },
  ] as const)("accepts the main renderer at $url", ({ url, development }) =>
    Effect.gen(function* () {
      const h = yield* harness(url, development);
      assert.strictEqual(
        yield* Effect.promise(async () =>
          h.invoke.get(Channels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL)!(h.event, undefined),
        ),
        "test-bearer",
      );
      const syncEvent = { ...h.event, returnValue: undefined as unknown };
      h.sync.get(Channels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL)!(syncEvent);
      assert.deepEqual(syncEvent.returnValue, []);
      yield* Effect.promise(async () =>
        h.invoke.get(Channels.SET_SERVER_EXPOSURE_MODE_CHANNEL)!(h.event, "local-only"),
      );
      yield* Effect.promise(async () =>
        h.invoke.get(Channels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL)!(h.event, { enabled: false }),
      );
      assert.deepEqual(h.calls, ["token", "bootstraps", "exposure", "tailscale"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects other windows, subframes, detached frames and unexpected URLs before access",
    () =>
      Effect.gen(function* () {
        for (const url of [
          "t3code://app/",
          "t3code://other/",
          "https://app/",
          "t3code-dev://app/",
          "data:text/html,untrusted",
          "invalid",
        ]) {
          const h = yield* harness(url);
          const events = [
            { sender: { id: 8 }, senderFrame: h.frame },
            { sender: h.event.sender, senderFrame: { url } },
            { sender: h.event.sender, senderFrame: null },
            ...(url === "t3code://app/" ? [] : [h.event]),
          ];
          for (const event of events) {
            for (const [channel, input] of [
              [Channels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL, undefined],
              [Channels.SET_SERVER_EXPOSURE_MODE_CHANNEL, "network-accessible"],
              [Channels.SET_TAILSCALE_SERVE_ENABLED_CHANNEL, { enabled: true }],
            ] as const) {
              yield* Effect.promise(async () =>
                expect(h.invoke.get(channel)!(event, input)).rejects.toThrow(),
              );
            }
            const syncEvent = { ...event, returnValue: undefined as unknown };
            expect(() =>
              h.sync.get(Channels.GET_LOCAL_ENVIRONMENT_BOOTSTRAPS_CHANNEL)!(syncEvent),
            ).not.toThrow();
            assert.deepEqual(syncEvent.returnValue, []);
          }
          assert.deepEqual(h.calls, []);
        }
        const h = yield* harness("t3code://app/", false, false);
        yield* Effect.promise(async () =>
          expect(
            h.invoke.get(Channels.GET_LOCAL_ENVIRONMENT_BEARER_TOKEN_CHANNEL)!(h.event, undefined),
          ).rejects.toThrow(),
        );
        assert.deepEqual(h.calls, []);
      }).pipe(Effect.scoped),
  );
});
