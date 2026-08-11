import type { DesktopMicrophoneAccessStatus } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

type NativeMicrophoneAccessStatus = Exclude<DesktopMicrophoneAccessStatus, "unsupported">;

export interface ElectronMediaAccessPreferences {
  readonly getMediaAccessStatus: (mediaType: "microphone") => NativeMicrophoneAccessStatus;
  readonly askForMediaAccess: (mediaType: "microphone") => Promise<boolean>;
}

export class ElectronMicrophoneAccessError extends Schema.TaggedErrorClass<ElectronMicrophoneAccessError>()(
  "ElectronMicrophoneAccessError",
  {
    operation: Schema.Literals(["get-status", "request-access"]),
    reason: Schema.Literals(["unsupported-platform", "native-failure"]),
  },
) {
  override get message(): string {
    if (this.reason === "unsupported-platform") {
      return "Desktop microphone permission requests are only supported on macOS.";
    }
    return this.operation === "get-status"
      ? "Failed to read the macOS microphone permission status."
      : "Failed to request macOS microphone permission.";
  }
}

export const isElectronMicrophoneAccessError = Schema.is(ElectronMicrophoneAccessError);

export class ElectronSystemPreferences extends Context.Service<
  ElectronSystemPreferences,
  {
    readonly getMicrophoneAccessStatus: Effect.Effect<
      DesktopMicrophoneAccessStatus,
      ElectronMicrophoneAccessError
    >;
    readonly requestMicrophoneAccess: Effect.Effect<
      DesktopMicrophoneAccessStatus,
      ElectronMicrophoneAccessError
    >;
  }
>()("@t3tools/desktop/electron/ElectronSystemPreferences") {}

export function make(input: {
  readonly platform: NodeJS.Platform;
  readonly systemPreferences: ElectronMediaAccessPreferences;
}): ElectronSystemPreferences["Service"] {
  if (input.platform !== "darwin") {
    return ElectronSystemPreferences.of({
      getMicrophoneAccessStatus: Effect.succeed("unsupported"),
      requestMicrophoneAccess: Effect.fail(
        new ElectronMicrophoneAccessError({
          operation: "request-access",
          reason: "unsupported-platform",
        }),
      ),
    });
  }

  return ElectronSystemPreferences.of({
    getMicrophoneAccessStatus: Effect.try({
      try: () => input.systemPreferences.getMediaAccessStatus("microphone"),
      catch: () =>
        new ElectronMicrophoneAccessError({
          operation: "get-status",
          reason: "native-failure",
        }),
    }),
    requestMicrophoneAccess: Effect.tryPromise({
      try: () => input.systemPreferences.askForMediaAccess("microphone"),
      catch: () =>
        new ElectronMicrophoneAccessError({
          operation: "request-access",
          reason: "native-failure",
        }),
    }).pipe(Effect.map((granted) => (granted ? "granted" : "denied"))),
  });
}

const makeService = Effect.map(HostProcessPlatform, (platform) =>
  make({
    platform,
    systemPreferences: Electron.systemPreferences,
  }),
);

export const layer = Layer.effect(ElectronSystemPreferences, makeService);
