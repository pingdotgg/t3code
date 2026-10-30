import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

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
  it.live.each([
    "https://example.com/callback?code=1&state=2",
    "https://example.com/it's?a=1&b=2",
    "https://example.com/a b?key=value",
    "https://example.com/plain",
  ])("opens the complete Android URL %s", (url) =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const { ready, calls } = makeReady();
      yield* runDeviceAction(ready, "android", {
        type: "openUrl",
        deviceId: "emulator-5554",
        url,
      });
      const args = calls[0]!.args;
      expect(args.slice(0, 3)).toEqual(["-s", "emulator-5554", "shell"]);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // adb joins arguments verbatim before the Android shell parses them.
      const stdout = yield* spawner.string(
        ChildProcess.make("/bin/sh", [
          "-c",
          `am() { printf '%s\\0' "$@"; }\n${args.slice(3).join(" ")}`,
        ]),
      );
      expect(stdout.split("\0").slice(0, -1)).toEqual([
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        url,
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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

  it.effect.each([
    ["camera", "grant", "android.permission.CAMERA"],
    ["photos", "revoke", "android.permission.READ_MEDIA_IMAGES"],
  ] as const)(
    "reports an Android %s %s that no pm command applied",
    ([permission, decision, firstPermission]) =>
      Effect.gen(function* () {
        const { ready } = makeReady((call) => ({
          code: 1,
          stderr: `Unknown package: ${call.args.at(-1)}`,
        }));
        const error = yield* Effect.flip(
          runDeviceAction(ready, "android", {
            type: "setPermission",
            deviceId: "emulator-5554",
            appId: "com.example.missing",
            permission,
            decision,
          }),
        );
        expect(error._tag).toBe("DeviceOperationError");
        expect(error.operation).toBe("permission");
        expect(error._tag === "DeviceOperationError" && error.cause).toMatchObject({
          stderr: `Unknown package: ${firstPermission}`,
        });
      }),
  );

  it.effect.each([
    [
      "photos",
      ["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_EXTERNAL_STORAGE"],
      1,
    ],
    ["contacts", ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"], 0],
  ] as const)(
    "keeps a partially applied %s permission change",
    ([permission, permissions, success]) =>
      Effect.gen(function* () {
        const { ready, calls } = makeReady((call) => ({
          code: call.args.at(-1) === permissions[success] ? 0 : 1,
        }));
        const result = yield* runDeviceAction(ready, "android", {
          type: "setPermission",
          deviceId: "emulator-5554",
          appId: "com.example.app",
          permission,
          decision: "grant",
        });
        expect(result).toBeUndefined();
        expect(calls.map((call) => call.args.at(-1))).toEqual(permissions);
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
