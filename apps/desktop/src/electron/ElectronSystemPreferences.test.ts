import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const {
  askForMediaAccessMock,
  getMediaAccessStatusMock,
  setPermissionCheckHandlerMock,
  setPermissionRequestHandlerMock,
} = vi.hoisted(() => ({
  askForMediaAccessMock: vi.fn(),
  getMediaAccessStatusMock: vi.fn(),
  setPermissionCheckHandlerMock: vi.fn(),
  setPermissionRequestHandlerMock: vi.fn(),
}));

vi.mock("electron", () => ({
  session: {
    defaultSession: {
      setPermissionCheckHandler: setPermissionCheckHandlerMock,
      setPermissionRequestHandler: setPermissionRequestHandlerMock,
    },
  },
  systemPreferences: {
    askForMediaAccess: askForMediaAccessMock,
    getMediaAccessStatus: getMediaAccessStatusMock,
  },
}));

import * as ElectronSystemPreferences from "./ElectronSystemPreferences.ts";

const macLayer = ElectronSystemPreferences.layer.pipe(
  Layer.provide(Layer.succeed(HostProcessPlatform, "darwin")),
);

describe("ElectronSystemPreferences", () => {
  beforeEach(() => {
    askForMediaAccessMock.mockReset();
    getMediaAccessStatusMock.mockReset();
    setPermissionCheckHandlerMock.mockReset();
    setPermissionRequestHandlerMock.mockReset();
  });

  it.effect("reads and requests macOS microphone permission through systemPreferences", () =>
    Effect.gen(function* () {
      getMediaAccessStatusMock.mockReturnValue("not-determined");
      askForMediaAccessMock.mockResolvedValue(true);
      const preferences = yield* ElectronSystemPreferences.ElectronSystemPreferences;

      assert.equal(yield* preferences.getMicrophoneAccessStatus, "not-determined");
      assert.equal(yield* preferences.requestMicrophoneAccess, "granted");
      assert.deepEqual(getMediaAccessStatusMock.mock.calls, [["microphone"]]);
      assert.deepEqual(askForMediaAccessMock.mock.calls, [["microphone"]]);
    }).pipe(Effect.provide(macLayer)),
  );

  it.effect("reports a user denial as a permission state", () =>
    Effect.gen(function* () {
      askForMediaAccessMock.mockResolvedValue(false);
      const preferences = yield* ElectronSystemPreferences.ElectronSystemPreferences;

      assert.equal(yield* preferences.requestMicrophoneAccess, "denied");
    }).pipe(Effect.provide(macLayer)),
  );

  it.effect("reports non-macOS hosts as unsupported without touching native permission APIs", () =>
    Effect.gen(function* () {
      const preferences = ElectronSystemPreferences.make({
        platform: "linux",
        systemPreferences: {
          getMediaAccessStatus: getMediaAccessStatusMock,
          askForMediaAccess: askForMediaAccessMock,
        },
      });

      assert.equal(yield* preferences.getMicrophoneAccessStatus, "unsupported");
      const error = yield* preferences.requestMicrophoneAccess.pipe(Effect.flip);
      assert.instanceOf(error, ElectronSystemPreferences.ElectronMicrophoneAccessError);
      assert.isTrue(ElectronSystemPreferences.isElectronMicrophoneAccessError(error));
      assert.equal(error.operation, "request-access");
      assert.equal(error.reason, "unsupported-platform");
      assert.equal(getMediaAccessStatusMock.mock.calls.length, 0);
      assert.equal(askForMediaAccessMock.mock.calls.length, 0);
    }),
  );

  it.effect("redacts native microphone status and request failures", () =>
    Effect.gen(function* () {
      const unsafeStatusCause = "microphone-status-secret";
      const unsafeRequestCause = "microphone-request-secret";
      const preferences = ElectronSystemPreferences.make({
        platform: "darwin",
        systemPreferences: {
          getMediaAccessStatus: () => {
            throw new Error(unsafeStatusCause);
          },
          askForMediaAccess: () => Promise.reject(new Error(unsafeRequestCause)),
        },
      });

      const statusError = yield* preferences.getMicrophoneAccessStatus.pipe(Effect.flip);
      const requestError = yield* preferences.requestMicrophoneAccess.pipe(Effect.flip);

      for (const [error, unsafeCause] of [
        [statusError, unsafeStatusCause],
        [requestError, unsafeRequestCause],
      ] as const) {
        assert.instanceOf(error, ElectronSystemPreferences.ElectronMicrophoneAccessError);
        assert.notProperty(error, "cause");
        assert.notInclude(error.message, unsafeCause);
        assert.notInclude(String(error), unsafeCause);
      }
    }),
  );

  it.effect("does not prompt or install default-session permission handlers during setup", () =>
    Effect.gen(function* () {
      getMediaAccessStatusMock.mockReturnValue("granted");
      const preferences = yield* ElectronSystemPreferences.ElectronSystemPreferences;

      assert.equal(askForMediaAccessMock.mock.calls.length, 0);
      assert.equal(yield* preferences.getMicrophoneAccessStatus, "granted");
      assert.equal(askForMediaAccessMock.mock.calls.length, 0);
      assert.equal(setPermissionCheckHandlerMock.mock.calls.length, 0);
      assert.equal(setPermissionRequestHandlerMock.mock.calls.length, 0);
    }).pipe(Effect.provide(macLayer)),
  );
});
