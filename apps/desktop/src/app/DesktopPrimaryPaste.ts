import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export class DesktopPrimaryPaste extends Context.Service<
  DesktopPrimaryPaste,
  {
    readonly enabled: boolean;
  }
>()("@t3tools/desktop/app/DesktopPrimaryPaste") {}

// Chrome applies gtk-enable-primary-paste from chrome/, which Electron does not include.
export const readGtkPrimaryPasteEnabled = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* spawner.string(
    ChildProcess.make(
      "gsettings",
      ["get", "org.gnome.desktop.interface", "gtk-enable-primary-paste"],
      { stdin: "ignore", stderr: "ignore" },
    ),
  );
  return output.trim() !== "false";
}).pipe(
  Effect.timeout("2 seconds"),
  Effect.orElseSucceed(() => true),
);

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  // Resolved before any window exists so the first preload never sees a provisional value.
  const enabled =
    platform === "darwin" || platform === "win32" ? true : yield* readGtkPrimaryPasteEnabled;
  return DesktopPrimaryPaste.of({ enabled });
});

export const layer = Layer.effect(DesktopPrimaryPaste, make);
