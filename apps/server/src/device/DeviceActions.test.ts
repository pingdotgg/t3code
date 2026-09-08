import { describe, expect, it } from "@effect/vitest";
import type { DeviceActionInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readDeviceDetail, runDeviceAction, supportsAction } from "./DeviceActions.ts";
import type { DeviceHostReady } from "./DeviceHost.ts";

type Call = { command: string; args: ReadonlyArray<string>; stdin?: string };

const makeReady = (
  respond: (call: Call) => { stdout?: string; stderr?: string; code?: number } = () => ({}),
  helpers: DeviceHostReady["helpers"] = {
    serveSimAxSettings: "/hub/simax/serve-sim-ax-settings",
    serveSimCli: "/hub/serve-sim.js",
  },
) => {
  const calls: Call[] = [];
  const ready: DeviceHostReady = {
    hub: { origin: "http://127.0.0.1:1" },
    helpers,
    run: (command, args, options) => {
      const call = { command, args, ...(options?.stdin ? { stdin: options.stdin } : {}) };
      calls.push(call);
      const result = respond(call);
      return Effect.succeed({
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        code: result.code ?? 0,
      });
    },
  };
  return { ready, calls };
};

const udid = "SIM-1";

describe("supportsAction", () => {
  it("advertises platform-specific toggles", () => {
    const toggle = (setting: Extract<DeviceActionInput, { type: "setToggle" }>["setting"]) =>
      ({ type: "setToggle", deviceId: udid, setting, value: true }) as const;
    expect(supportsAction("ios", toggle("voiceOver"))).toBe(true);
    expect(supportsAction("android", toggle("voiceOver"))).toBe(false);
    expect(supportsAction("android", toggle("networkEnabled"))).toBe(true);
    expect(supportsAction("ios", toggle("networkEnabled"))).toBe(false);
    expect(supportsAction("ios", { type: "setLiquidGlass", deviceId: udid, value: "clear" })).toBe(
      true,
    );
    expect(
      supportsAction("android", { type: "setLiquidGlass", deviceId: udid, value: "clear" }),
    ).toBe(false);
    expect(
      supportsAction("android", { type: "setOrientation", deviceId: udid, value: "portrait" }),
    ).toBe(true);
    expect(
      supportsAction("ios", { type: "setOrientation", deviceId: udid, value: "portrait" }),
    ).toBe(false);
  });
});

describe("runDeviceAction", () => {
  it.effect("maps shared text sizes onto simctl content-size categories", () =>
    Effect.gen(function* () {
      const { ready, calls } = makeReady();
      yield* runDeviceAction(ready, "ios", {
        type: "setTextSize",
        deviceId: udid,
        value: "extra-large",
      });
      expect(calls).toEqual([
        { command: "xcrun", args: ["simctl", "ui", udid, "content_size", "accessibility-large"] },
      ]);
    }),
  );

  it.effect("maps shared text sizes onto Android font_scale", () =>
    Effect.gen(function* () {
      const { ready, calls } = makeReady();
      yield* runDeviceAction(ready, "android", {
        type: "setTextSize",
        deviceId: "emulator-5554",
        value: "large",
      });
      expect(calls[0]?.args).toEqual([
        "-s",
        "emulator-5554",
        "shell",
        "settings",
        "put",
        "system",
        "font_scale",
        "1.15",
      ]);
    }),
  );

  it.effect(
    "rotates emulators through the accelerometer and physical devices through the lock",
    () =>
      Effect.gen(function* () {
        const emulator = makeReady();
        yield* runDeviceAction(emulator.ready, "android", {
          type: "setOrientation",
          deviceId: "emulator-5554",
          value: "landscape_left",
        });
        expect(emulator.calls.at(-1)?.args).toEqual([
          "-s",
          "emulator-5554",
          "emu",
          "sensor",
          "set",
          "acceleration",
          "9.81:0:0",
        ]);
        const phone = makeReady();
        yield* runDeviceAction(phone.ready, "android", {
          type: "setOrientation",
          deviceId: "R5CT1234",
          value: "landscape_right",
        });
        expect(phone.calls).toEqual([
          {
            command: "adb",
            args: ["-s", "R5CT1234", "shell", "cmd", "window", "user-rotation", "lock", "3"],
          },
        ]);
      }),
  );

  it.effect("runs accessibility toggles through the bundled helper via simctl spawn", () =>
    Effect.gen(function* () {
      const { ready, calls } = makeReady();
      yield* runDeviceAction(ready, "ios", {
        type: "setToggle",
        deviceId: udid,
        setting: "voiceOver",
        value: true,
      });
      expect(calls).toEqual([
        {
          command: "xcrun",
          args: [
            "simctl",
            "spawn",
            udid,
            "/hub/simax/serve-sim-ax-settings",
            "set",
            "voiceover",
            "on",
          ],
        },
      ]);
    }),
  );

  it.effect("fails clearly when the helper is missing", () =>
    Effect.gen(function* () {
      const { ready } = makeReady(() => ({}), { serveSimAxSettings: null, serveSimCli: null });
      const error = yield* Effect.flip(
        runDeviceAction(ready, "ios", {
          type: "setColorFilter",
          deviceId: udid,
          value: "grayscale",
        }),
      );
      expect(error._tag).toBe("DeviceOperationError");
      expect(error.detail).toContain("accessibility helper");
    }),
  );

  it.effect("rejects actions the platform does not support without running anything", () =>
    Effect.gen(function* () {
      const { ready, calls } = makeReady();
      const error = yield* Effect.flip(
        runDeviceAction(ready, "android", {
          type: "sendPush",
          deviceId: "emulator-5554",
          appId: "com.example",
          payload: "hi",
        }),
      );
      expect(error.detail).toContain("not supported on android");
      expect(calls).toEqual([]);
    }),
  );

  it.effect("surfaces non-zero exit codes as operation errors", () =>
    Effect.gen(function* () {
      const { ready } = makeReady(() => ({ code: 1, stderr: "Invalid device: SIM-1" }));
      const error = yield* Effect.flip(
        runDeviceAction(ready, "ios", { type: "setAppearance", deviceId: udid, value: "dark" }),
      );
      expect(error.operation).toBe("appearance");
      expect(error.detail).toBe("Invalid device: SIM-1");
    }),
  );

  it.effect("wraps a bare push string in an APNs alert and feeds it on stdin", () =>
    Effect.gen(function* () {
      const { ready, calls } = makeReady();
      yield* runDeviceAction(ready, "ios", {
        type: "sendPush",
        deviceId: udid,
        appId: "com.example.app",
        payload: "Hello",
      });
      expect(calls[0]?.args).toEqual(["simctl", "push", udid, "com.example.app", "-"]);
      expect(calls[0]?.stdin).toBe('{"aps":{"alert":"Hello"}}');
    }),
  );
});

describe("readDeviceDetail", () => {
  it.effect("reads iOS settings from simctl and the accessibility helper", () =>
    Effect.gen(function* () {
      const { ready } = makeReady((call) => {
        const key = call.args.join(" ");
        if (key.endsWith("ui SIM-1 appearance")) return { stdout: "dark\n" };
        if (key.endsWith("ui SIM-1 content_size")) return { stdout: "extra-extra-large\n" };
        if (key.endsWith("ui SIM-1 increase_contrast")) return { stdout: "enabled\n" };
        if (key.includes("serve-sim-ax-settings status")) {
          return {
            stdout:
              '{"reduce-motion":"on","reduce-transparency":"off","show-borders":"off","voiceover":"off","liquid-glass":"tinted","color-filter":"grayscale"}',
          };
        }
        return { code: 1 };
      });
      const detail = yield* readDeviceDetail(ready, "ios", udid);
      expect(detail.settings).toEqual({
        appearance: "dark",
        textSize: "large",
        increaseContrast: true,
        reduceMotion: true,
        reduceTransparency: false,
        showBorders: false,
        voiceOver: false,
        liquidGlass: "tinted",
        colorFilter: "grayscale",
      });
    }),
  );

  it.effect("degrades unreadable values to unknown instead of failing", () =>
    Effect.gen(function* () {
      const { ready } = makeReady(() => ({ code: 1, stderr: "boom" }));
      const detail = yield* readDeviceDetail(ready, "ios", udid);
      expect(detail.settings).toEqual({});
      expect(detail.foregroundApp).toBeNull();
    }),
  );

  it.effect("reads Android settings and the focused package", () =>
    Effect.gen(function* () {
      const { ready } = makeReady((call) => {
        const key = call.args.join(" ");
        if (key.endsWith("cmd uimode night")) return { stdout: "Night mode: yes\n" };
        if (key.endsWith("font_scale")) return { stdout: "0.85\n" };
        if (key.endsWith("animator_duration_scale")) return { stdout: "0\n" };
        if (key.endsWith("wifi_on")) return { stdout: "1\n" };
        if (key.endsWith("dumpsys window")) {
          return {
            stdout:
              "  mFocusedApp=ActivityRecord{155579877 u0 com.example.app/.MainActivity t15}\n  mCurrentFocus=Window{1a2b u0 com.example.app/com.example.app.MainActivity}\n",
          };
        }
        return { code: 1 };
      });
      const detail = yield* readDeviceDetail(ready, "android", "emulator-5554");
      expect(detail.settings).toEqual({
        appearance: "dark",
        textSize: "small",
        reduceMotion: true,
        networkEnabled: true,
      });
      expect(detail.foregroundApp).toEqual({ id: "com.example.app" });
    }),
  );
});
