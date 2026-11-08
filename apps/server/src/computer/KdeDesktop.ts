import {
  ComputerUseConsentError,
  ComputerUseOperationError,
  ComputerUseUnavailableError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { DBusError } from "dbus-next";

import * as ProcessRunner from "../processRunner.ts";
import {
  connectSessionBus,
  openRemoteDesktop,
  type PortalCallError,
  type RemoteDesktopSession,
} from "./RemoteDesktopPortal.ts";

const APP_ID = "com.t3tools.T3Code";

/** A rectangle in the desktop's logical coordinates. */
export interface DesktopRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The enabled screens, from `kscreen-doctor -j`. */
export interface DesktopLayout {
  /** The area a whole-desktop capture covers. */
  readonly bounds: DesktopRect;
  /** Image pixels per logical pixel in that capture. */
  readonly scale: number;
  readonly screens: ReadonlyArray<DesktopRect>;
  /** Which output sits where, so equal screens that swap places still read as a change. */
  readonly outputs: string;
}

export interface DesktopCapture extends DesktopLayout {
  /** Every screen, so the ones the user did not share can be cut out. */
  readonly png: Uint8Array;
}

const KscreenOutputs = Schema.fromJsonString(
  Schema.Struct({
    outputs: Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        enabled: Schema.Boolean,
        pos: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
        size: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
        scale: Schema.Number,
        rotation: Schema.optional(Schema.Number),
      }),
    ),
  }),
);

const decodeKscreenOutputs = Schema.decodeUnknownOption(KscreenOutputs);

/**
 * Logical screen layout from `kscreen-doctor -j`. Its `size` is mode pixels that libkscreen has
 * already turned for the output's rotation, so dividing by the scale gives the logical size.
 */
export const desktopLayoutFromKscreen = (json: string): DesktopLayout | null => {
  const outputs = decodeKscreenOutputs(json);
  if (outputs._tag === "None") return null;
  const enabled = outputs.value.outputs.filter((output) => output.enabled && output.scale > 0);
  const screens = enabled.map((output) => ({
    x: output.pos.x,
    y: output.pos.y,
    width: Math.round(output.size.width / output.scale),
    height: Math.round(output.size.height / output.scale),
  }));
  if (screens.length === 0) return null;
  const left = Math.min(...screens.map((screen) => screen.x));
  const top = Math.min(...screens.map((screen) => screen.y));
  return {
    bounds: {
      x: left,
      y: top,
      width: Math.max(...screens.map((screen) => screen.x + screen.width)) - left,
      height: Math.max(...screens.map((screen) => screen.y + screen.height)) - top,
    },
    // KWin renders a whole-workspace capture at its largest output scale, never below 1, so one
    // scale covers every screen and lower-density ones come out upscaled.
    scale: Math.max(1, ...enabled.map((output) => output.scale)),
    screens,
    outputs: enabled
      .map((output) =>
        JSON.stringify([
          output.name ?? null,
          output.pos.x,
          output.pos.y,
          output.size.width,
          output.size.height,
          output.scale,
          output.rotation ?? null,
        ]),
      )
      .sort()
      .join("\n"),
  };
};

export const layoutChanged =
  "The screen layout changed since control started. Call `computer_screenshot` again to start over.";

const CONSENT_TIMEOUT = "2 minutes";

/** Why this process cannot drive a KDE Plasma Wayland desktop, or null when it can try. */
export const kdeSessionProblem = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null => {
  if (platform !== "linux") {
    return "Computer use supports only KDE Plasma on Linux. This environment is not Linux.";
  }
  if (!env.DBUS_SESSION_BUS_ADDRESS || !env.WAYLAND_DISPLAY) {
    return "This environment's server is not running inside a desktop session, for example because it was started over SSH or as a system service. Start it from the KDE Plasma session to use computer use.";
  }
  const desktops = (env.XDG_CURRENT_DESKTOP ?? "").split(":").map((name) => name.trim());
  if (!desktops.includes("KDE")) {
    return "Computer use supports only KDE Plasma on Wayland. This desktop is not KDE Plasma.";
  }
  return null;
};

export class KdeDesktop extends Context.Service<
  KdeDesktop,
  {
    /** Null when the desktop can be asked for remote control. */
    readonly unavailableReason: Effect.Effect<string | null>;
    /** Shows the desktop's consent dialog unless `restoreToken` still holds a grant. */
    readonly openSession: (
      restoreToken: string | null,
    ) => Effect.Effect<
      RemoteDesktopSession,
      ComputerUseConsentError | ComputerUseOperationError | ComputerUseUnavailableError
    >;
    readonly capture: Effect.Effect<
      DesktopCapture,
      ComputerUseOperationError | ComputerUseUnavailableError
    >;
  }
>()("t3/computer/KdeDesktop") {}

const mapCallError = (error: PortalCallError) =>
  error.cause instanceof DBusError &&
  error.cause.type === "org.freedesktop.DBus.Error.NameHasNoOwner"
    ? new ComputerUseUnavailableError({
        reason: "No desktop portal is running in this session. Install xdg-desktop-portal-kde.",
      })
    : new ComputerUseOperationError({ operation: "session", cause: error });

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const unavailableReason = Effect.gen(function* () {
    const problem = kdeSessionProblem(platform, env);
    if (problem !== null) return problem;
    if ((yield* resolveCommandPath("spectacle", { env })) === null) {
      return "Computer use needs Spectacle, KDE's screenshot tool, to see the screen. Install it on this machine.";
    }
    return (yield* resolveCommandPath("kscreen-doctor", { env })) === null
      ? "Computer use needs kscreen-doctor, from KDE's libkscreen, to find the screens. Install it on this machine."
      : null;
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.withSpan("KdeDesktop.unavailableReason"),
  );

  const openSession = Effect.fn("KdeDesktop.openSession")(function* (restoreToken: string | null) {
    const bus = yield* Effect.try({
      try: connectSessionBus,
      catch: (cause) => new ComputerUseOperationError({ operation: "session", cause }),
    });
    return yield* openRemoteDesktop(bus, {
      appId: APP_ID,
      registerAppId: !env.FLATPAK_ID && !env.SNAP,
      restoreToken,
      consentTimeout: CONSENT_TIMEOUT,
    }).pipe(
      Effect.catchTags({
        PortalConsentError: (error) =>
          Effect.fail(new ComputerUseConsentError({ outcome: error.outcome })),
        PortalUnsupportedError: (error) =>
          Effect.fail(new ComputerUseUnavailableError({ reason: error.reason })),
        PortalCallError: (error) => Effect.fail(mapCallError(error)),
      }),
    );
  });

  const readLayout = Effect.gen(function* () {
    const screens = yield* processRunner.run({
      command: "kscreen-doctor",
      args: ["-j"],
      timeout: "15 seconds",
      maxOutputBytes: 4 * 1024 * 1024,
    });
    const layout = screens.code === 0 ? desktopLayoutFromKscreen(screens.stdout) : null;
    if (layout === null) {
      return yield* new ComputerUseOperationError({
        operation: "screenshot",
        cause: { exitCode: screens.code, stderr: screens.stderr.slice(0, 500) },
      });
    }
    return layout;
  });

  // Spectacle reads the screen through KWin, which lets it in by its desktop file. Background
  // mode writes only `--output`. `--fullscreen` is KWin's CaptureWorkspace at native resolution:
  // every screen's logical bounding box at one scale. It reports no layout, so one read on each
  // side brackets it; a change undone before the second read still goes unseen.
  const capture = Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-computer-" });
      const output = path.join(directory, "screen.png");
      const before = yield* readLayout;
      const result = yield* processRunner.run({
        command: "spectacle",
        args: ["--new-instance", "--background", "--nonotify", "--fullscreen", "--output", output],
        timeout: "15 seconds",
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
      });
      if (result.code !== 0) {
        return yield* new ComputerUseOperationError({
          operation: "screenshot",
          cause: { exitCode: result.code, stderr: result.stderr.slice(0, 500) },
        });
      }
      const layout = yield* readLayout;
      if (layout.outputs !== before.outputs) {
        return yield* new ComputerUseUnavailableError({ reason: layoutChanged });
      }
      return { png: yield* fileSystem.readFile(output), ...layout };
    }),
  ).pipe(
    Effect.mapError((cause) =>
      cause._tag === "ComputerUseOperationError" || cause._tag === "ComputerUseUnavailableError"
        ? cause
        : new ComputerUseOperationError({ operation: "screenshot", cause }),
    ),
    Effect.withSpan("KdeDesktop.capture"),
  );

  return KdeDesktop.of({ unavailableReason, openSession, capture });
});

export const layer = Layer.effect(KdeDesktop, make);
