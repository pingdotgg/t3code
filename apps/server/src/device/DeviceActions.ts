/**
 * Device settings and one-shot actions, run by the server against the host's
 * toolchain instead of through serve-sim's shell-exec channel.
 *
 * serve-sim's preview drives its "Simulator" panel by sending shell commands
 * over a token-gated socket. Proxying that would hand any environment
 * session arbitrary command execution on the host, so T3 runs the same
 * underlying commands itself, typed per action: `xcrun simctl ui` and
 * `simctl privacy` for iOS, the `serve-sim-ax-settings` helper that serve-sim
 * bundles for the accessibility toggles, and `adb shell` for Android.
 *
 * Each platform advertises which actions it supports; the panel hides the
 * rest rather than showing controls that cannot work.
 */
import {
  type DeviceActionInput,
  type DeviceActionType,
  type DeviceForegroundApp,
  DeviceOperationError,
  type DevicePlatform,
  type DeviceSettings,
  type DeviceTextSize,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DeviceHostReady } from "./DeviceHost.ts";

type Runner = DeviceHostReady["run"];

const decodeAxStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const encodePushPayload = Schema.encodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export const IOS_ACTIONS: ReadonlySet<DeviceActionType> = new Set([
  "setAppearance",
  "setTextSize",
  "setToggle",
  "setLiquidGlass",
  "setColorFilter",
  "setLocation",
  "clearLocation",
  "setPermission",
  "openUrl",
  "launchApp",
  "terminateApp",
  "sendPush",
]);

export const ANDROID_ACTIONS: ReadonlySet<DeviceActionType> = new Set([
  "setAppearance",
  "setTextSize",
  "setToggle",
  "setOrientation",
  "setLocation",
  "clearLocation",
  "setPermission",
  "openUrl",
  "launchApp",
  "terminateApp",
]);

/** Toggle settings each platform can actually flip. */
const IOS_TOGGLES = new Set([
  "reduceMotion",
  "increaseContrast",
  "reduceTransparency",
  "showBorders",
  "voiceOver",
]);
const ANDROID_TOGGLES = new Set(["reduceMotion", "networkEnabled"]);

export const supportsAction = (platform: DevicePlatform, input: DeviceActionInput): boolean => {
  const actions = platform === "ios" ? IOS_ACTIONS : ANDROID_ACTIONS;
  if (!actions.has(input.type)) return false;
  if (input.type === "setToggle") {
    return (platform === "ios" ? IOS_TOGGLES : ANDROID_TOGGLES).has(input.setting);
  }
  return true;
};

const fail = (operation: string, detail: string) =>
  new DeviceOperationError({ operation, detail: detail.trim() || "command failed" });

const ok = (operation: string) => (result: { code: number; stderr: string; stdout: string }) =>
  result.code === 0
    ? Effect.succeed(result.stdout)
    : Effect.fail(fail(operation, result.stderr || result.stdout));

// iOS text-size categories in ascending order; the four shared steps index
// into it. `default` is what a fresh simulator reports ("large").
const IOS_TEXT_SIZES: Record<DeviceTextSize, string> = {
  small: "small",
  default: "large",
  large: "extra-extra-large",
  "extra-large": "accessibility-large",
};
const ANDROID_TEXT_SIZES: Record<DeviceTextSize, string> = {
  small: "0.85",
  default: "1.0",
  large: "1.15",
  "extra-large": "1.3",
};

const textSizeFromIos = (category: string): DeviceTextSize | undefined => {
  const entry = (Object.entries(IOS_TEXT_SIZES) as Array<[DeviceTextSize, string]>).find(
    ([, value]) => value === category,
  );
  if (entry) return entry[0];
  if (category.startsWith("accessibility")) return "extra-large";
  if (category.includes("extra")) return "large";
  return category === "extra-small" || category === "small" || category === "medium"
    ? "small"
    : "default";
};

const textSizeFromAndroid = (scale: number): DeviceTextSize => {
  if (scale <= 0.9) return "small";
  if (scale >= 1.25) return "extra-large";
  if (scale >= 1.1) return "large";
  return "default";
};

const IOS_TOGGLE_OPTIONS: Record<string, string> = {
  reduceMotion: "reduce-motion",
  increaseContrast: "increase-contrast",
  reduceTransparency: "reduce-transparency",
  showBorders: "show-borders",
  voiceOver: "voiceover",
};

// serve-sim permission names -> the TCC service or simctl privacy service.
const IOS_TCC_SERVICES: Record<string, string> = {
  camera: "camera",
  microphone: "microphone",
  photos: "photos",
  contacts: "contacts",
  calendar: "calendar",
  reminders: "reminders",
  motion: "motion",
  "media-library": "media-library",
  faceid: "faceid",
};

const ANDROID_PERMISSIONS: Record<string, ReadonlyArray<string>> = {
  camera: ["android.permission.CAMERA"],
  microphone: ["android.permission.RECORD_AUDIO"],
  photos: ["android.permission.READ_MEDIA_IMAGES", "android.permission.READ_EXTERNAL_STORAGE"],
  contacts: ["android.permission.READ_CONTACTS", "android.permission.WRITE_CONTACTS"],
  calendar: ["android.permission.READ_CALENDAR", "android.permission.WRITE_CALENDAR"],
  location: [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
  ],
  notifications: ["android.permission.POST_NOTIFICATIONS"],
  motion: ["android.permission.ACTIVITY_RECOGNITION"],
};

export const runDeviceAction = Effect.fn("DeviceActions.run")(function* (
  ready: DeviceHostReady,
  platform: DevicePlatform,
  input: DeviceActionInput,
) {
  if (!supportsAction(platform, input)) {
    return yield* fail(input.type, `${input.type} is not supported on ${platform}.`);
  }
  if (platform === "ios") return yield* runIos(ready, input);
  return yield* runAndroid(ready.run, input);
});

const simctl = (run: Runner, udid: string, args: ReadonlyArray<string>, operation: string) =>
  run("xcrun", ["simctl", ...args.slice(0, 1), udid, ...args.slice(1)]).pipe(
    Effect.flatMap(ok(operation)),
  );

const axSettings = (ready: DeviceHostReady, udid: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const helper = ready.helpers.serveSimAxSettings;
    if (!helper) {
      return yield* fail(
        "accessibility",
        "The bundled accessibility helper is missing from this expo-device-hub install.",
      );
    }
    return yield* ready
      .run("xcrun", ["simctl", "spawn", udid, helper, ...args])
      .pipe(Effect.flatMap(ok("accessibility")));
  });

const runIos = Effect.fn("DeviceActions.runIos")(function* (
  ready: DeviceHostReady,
  input: DeviceActionInput,
) {
  const udid = input.deviceId;
  const { run } = ready;
  switch (input.type) {
    case "setAppearance":
      yield* simctl(run, udid, ["ui", "appearance", input.value], "appearance");
      return;
    case "setTextSize":
      yield* simctl(run, udid, ["ui", "content_size", IOS_TEXT_SIZES[input.value]], "text size");
      return;
    case "setToggle":
      if (input.setting === "increaseContrast") {
        yield* simctl(
          run,
          udid,
          ["ui", "increase_contrast", input.value ? "enabled" : "disabled"],
          "increase contrast",
        );
        return;
      }
      yield* axSettings(ready, udid, [
        "set",
        IOS_TOGGLE_OPTIONS[input.setting]!,
        input.value ? "on" : "off",
      ]);
      return;
    case "setLiquidGlass":
      yield* axSettings(ready, udid, ["set", "liquid-glass", input.value]);
      return;
    case "setColorFilter":
      yield* axSettings(ready, udid, ["set", "color-filter", input.value]);
      return;
    case "setLocation":
      yield* simctl(
        run,
        udid,
        ["location", "set", `${input.latitude},${input.longitude}`],
        "location",
      );
      return;
    case "clearLocation":
      yield* simctl(run, udid, ["location", "clear"], "location");
      return;
    case "setPermission": {
      if (input.permission === "notifications") {
        // simctl has no notification permission verb; serve-sim's CLI edits
        // the BulletinBoard plist for it.
        yield* serveSimPermissions(ready, udid, input);
        return;
      }
      const service =
        input.permission === "location" ? "location" : IOS_TCC_SERVICES[input.permission];
      if (!service) return yield* fail("permission", `Unknown permission ${input.permission}.`);
      yield* simctl(run, udid, ["privacy", input.decision, service, input.appId], "permission");
      return;
    }
    case "openUrl":
      yield* simctl(run, udid, ["openurl", input.url], "open url");
      return;
    case "launchApp":
      yield* simctl(run, udid, ["launch", input.appId], "launch");
      return;
    case "terminateApp":
      yield* simctl(run, udid, ["terminate", input.appId], "terminate");
      return;
    case "sendPush": {
      const payload =
        typeof input.payload === "string" ? { aps: { alert: input.payload } } : input.payload;
      const encoded = yield* encodePushPayload(payload).pipe(
        Effect.mapError((cause) => fail("push", String(cause))),
      );
      yield* run("xcrun", ["simctl", "push", udid, input.appId, "-"], { stdin: encoded }).pipe(
        Effect.flatMap(ok("push")),
      );
      return;
    }
    case "shake":
    case "setOrientation":
      return yield* fail(input.type, `${input.type} is not supported on iOS.`);
  }
});

const serveSimPermissions = (
  ready: DeviceHostReady,
  udid: string,
  input: Extract<DeviceActionInput, { type: "setPermission" }>,
) =>
  Effect.gen(function* () {
    const cli = ready.helpers.serveSimCli;
    if (!cli) return yield* fail("permission", "serve-sim's CLI is missing from this install.");
    yield* ready
      .run(process.execPath, [
        cli,
        "permissions",
        input.decision,
        input.permission,
        input.appId,
        "-d",
        udid,
      ])
      .pipe(Effect.flatMap(ok("permission")));
  });

const adb = (run: Runner, serial: string, args: ReadonlyArray<string>, operation: string) =>
  run("adb", ["-s", serial, ...args]).pipe(Effect.flatMap(ok(operation)));

const runAndroid = Effect.fn("DeviceActions.runAndroid")(function* (
  run: Runner,
  input: DeviceActionInput,
) {
  const serial = input.deviceId;
  const shell = (args: ReadonlyArray<string>, operation: string) =>
    adb(run, serial, ["shell", ...args], operation);
  switch (input.type) {
    case "setAppearance":
      yield* shell(["cmd", "uimode", "night", input.value === "dark" ? "yes" : "no"], "appearance");
      return;
    case "setTextSize":
      yield* shell(
        ["settings", "put", "system", "font_scale", ANDROID_TEXT_SIZES[input.value]],
        "text size",
      );
      return;
    case "setToggle":
      if (input.setting === "networkEnabled") {
        const state = input.value ? "enable" : "disable";
        yield* shell(["svc", "wifi", state], "network");
        yield* shell(["svc", "data", state], "network");
        return;
      }
      if (input.setting === "reduceMotion") {
        const scale = input.value ? "0" : "1";
        for (const key of [
          "animator_duration_scale",
          "transition_animation_scale",
          "window_animation_scale",
        ]) {
          yield* shell(["settings", "put", "global", key, scale], "reduce motion");
        }
        return;
      }
      return yield* fail(input.type, `${input.setting} is not supported on Android.`);
    case "setOrientation": {
      const rotation =
        input.value === "portrait"
          ? "0"
          : input.value === "landscape_left"
            ? "1"
            : input.value === "portrait_upside_down"
              ? "2"
              : "3";
      yield* shell(["cmd", "window", "user-rotation", "lock", rotation], "orientation");
      return;
    }
    case "setLocation":
      yield* adb(
        run,
        serial,
        ["emu", "geo", "fix", String(input.longitude), String(input.latitude)],
        "location",
      );
      return;
    case "clearLocation":
      // The emulator has no "clear"; leaving the fix in place is the closest
      // behavior, so this is a no-op that still refreshes the reading.
      return;
    case "setPermission": {
      const permissions = ANDROID_PERMISSIONS[input.permission];
      if (!permissions) {
        return yield* fail("permission", `${input.permission} has no Android equivalent.`);
      }
      const verb = input.decision === "grant" ? "grant" : "revoke";
      for (const permission of permissions) {
        // Not every app declares every permission in a group; ignore those.
        yield* shell(["pm", verb, input.appId, permission], "permission").pipe(Effect.ignore);
      }
      return;
    }
    case "openUrl":
      yield* shell(
        ["am", "start", "-a", "android.intent.action.VIEW", "-d", input.url],
        "open url",
      );
      return;
    case "launchApp":
      yield* shell(
        ["monkey", "-p", input.appId, "-c", "android.intent.category.LAUNCHER", "1"],
        "launch",
      );
      return;
    case "terminateApp":
      yield* shell(["am", "force-stop", input.appId], "terminate");
      return;
    case "setLiquidGlass":
    case "setColorFilter":
    case "shake":
    case "sendPush":
      return yield* fail(input.type, `${input.type} is not supported on Android.`);
  }
});

/** Read the current settings and foreground app. Errors degrade to unknowns. */
export const readDeviceDetail = Effect.fn("DeviceActions.readDetail")(function* (
  ready: DeviceHostReady,
  platform: DevicePlatform,
  deviceId: string,
): Effect.fn.Return<{ settings: DeviceSettings; foregroundApp: DeviceForegroundApp | null }> {
  return platform === "ios"
    ? yield* readIos(ready, deviceId)
    : yield* readAndroid(ready.run, deviceId);
});

const quiet = <A>(effect: Effect.Effect<A, unknown>) =>
  effect.pipe(Effect.orElseSucceed((): A | undefined => undefined));

const readIos = Effect.fn("DeviceActions.readIos")(function* (
  ready: DeviceHostReady,
  udid: string,
) {
  const { run } = ready;
  const uiValue = (option: string) =>
    quiet(
      simctl(run, udid, ["ui", option], option).pipe(Effect.map((out) => out.trim().toLowerCase())),
    );
  const [appearance, contentSize, contrast, axStatus] = yield* Effect.all(
    [
      uiValue("appearance"),
      uiValue("content_size"),
      uiValue("increase_contrast"),
      quiet(axSettings(ready, udid, ["status"]).pipe(Effect.flatMap(decodeAxStatus))),
    ],
    { concurrency: 4 },
  );
  const onOff = (value: string | undefined) =>
    value === "on" ? true : value === "off" ? false : undefined;
  const settings: DeviceSettings = {
    ...(appearance === "light" || appearance === "dark" ? { appearance } : {}),
    ...(contentSize ? { textSize: textSizeFromIos(contentSize) } : {}),
    ...(contrast ? { increaseContrast: contrast === "enabled" } : {}),
    ...(axStatus
      ? {
          ...(onOff(axStatus["reduce-motion"]) === undefined
            ? {}
            : { reduceMotion: onOff(axStatus["reduce-motion"]) }),
          ...(onOff(axStatus["reduce-transparency"]) === undefined
            ? {}
            : { reduceTransparency: onOff(axStatus["reduce-transparency"]) }),
          ...(onOff(axStatus["show-borders"]) === undefined
            ? {}
            : { showBorders: onOff(axStatus["show-borders"]) }),
          ...(onOff(axStatus.voiceover) === undefined
            ? {}
            : { voiceOver: onOff(axStatus.voiceover) }),
          ...(axStatus["liquid-glass"] === "clear" || axStatus["liquid-glass"] === "tinted"
            ? { liquidGlass: axStatus["liquid-glass"] }
            : {}),
          ...(isColorFilter(axStatus["color-filter"])
            ? { colorFilter: axStatus["color-filter"] }
            : {}),
        }
      : {}),
  };
  return { settings, foregroundApp: null };
});

const isColorFilter = (value: unknown): value is DeviceSettings["colorFilter"] & string =>
  value === "none" ||
  value === "grayscale" ||
  value === "red-green" ||
  value === "green-red" ||
  value === "blue-yellow";

const readAndroid = Effect.fn("DeviceActions.readAndroid")(function* (run: Runner, serial: string) {
  const shell = (args: ReadonlyArray<string>) =>
    quiet(
      adb(run, serial, ["shell", ...args], args[0] ?? "shell").pipe(Effect.map((s) => s.trim())),
    );
  const [night, fontScale, animator, wifi, focus] = yield* Effect.all(
    [
      shell(["cmd", "uimode", "night"]),
      shell(["settings", "get", "system", "font_scale"]),
      shell(["settings", "get", "global", "animator_duration_scale"]),
      shell(["settings", "get", "global", "wifi_on"]),
      // `dumpsys window windows` stopped printing the focus on API 36; the
      // unfiltered dump still does.
      shell(["dumpsys", "window"]),
    ],
    { concurrency: 5 },
  );
  const scale = fontScale && fontScale !== "null" ? Number(fontScale) : Number.NaN;
  const focused = focus?.match(/m(?:CurrentFocus|FocusedApp)=\w+\{[^ ]+ u\d+ ([^/ ]+)\//);
  const settings: DeviceSettings = {
    ...(night?.includes("yes")
      ? { appearance: "dark" }
      : night?.includes("no")
        ? { appearance: "light" }
        : {}),
    ...(Number.isFinite(scale) ? { textSize: textSizeFromAndroid(scale) } : {}),
    ...(animator !== undefined && animator !== "null"
      ? { reduceMotion: Number(animator) === 0 }
      : {}),
    ...(wifi === "1" || wifi === "0" ? { networkEnabled: wifi === "1" } : {}),
  };
  return {
    settings,
    foregroundApp: focused ? { id: focused[1]! } : null,
  };
});
