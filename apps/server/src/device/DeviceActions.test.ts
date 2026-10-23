import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
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
  const unused = Effect.die("Device actions run host commands, never device operations");
  const ready: DeviceHostReady = {
    nodePath: process.execPath,
    hub: { origin: "http://127.0.0.1:1" },
    devices: {
      list: unused,
      boot: () => unused,
      attach: () => unused,
      shutdown: () => unused,
      screenshot: () => unused,
    },
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

describe("runDeviceAction", () => {
  it.effect.each([
    ["emulator-5554", "Physical size: 2560x1600", "portrait", "-9.81:0:0"],
    ["emulator-5554", "Physical size: 2560x1600", "landscape_left", "0:9.81:0"],
    ["R5CT1234", "Physical size: 2560x1600", "portrait", "3"],
    ["R5CT1234", "Physical size: 2560x1600", "landscape_left", "0"],
    ["R5CT1234", "Physical size: 1080x1920\nOverride size: 1920x1080", "portrait", "3"],
  ] as const)(
    "rotates from the natural orientation reported by wm size: %s %j %s",
    ([deviceId, wmSize, value, expected]) =>
      Effect.gen(function* () {
        const { ready, calls } = makeReady((call) =>
          call.args.join(" ").endsWith("shell wm size") ? { stdout: `${wmSize}\n` } : {},
        );
        yield* runDeviceAction(ready, "android", { type: "setOrientation", deviceId, value });
        expect(calls.at(-1)?.args.at(-1)).toBe(expected);
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
