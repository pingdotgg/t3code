import type { TrackpadScrollPhase } from "@t3tools/contracts";
import type { BrowserWindow } from "electron";
import * as Schema from "effect/Schema";

import type { DesktopEnvironment } from "../app/DesktopEnvironment.ts";

export class MacTrackpadMonitorError extends Schema.TaggedError<MacTrackpadMonitorError>()(
  "MacTrackpadMonitorError",
  { cause: Schema.Defect() },
) {}

const SCROLL_PHASE = new Map<number, TrackpadScrollPhase["kind"]>([
  [1, "begin"],
  [8, "end"],
  [16, "cancel"],
]);
const LIBRARY = "t3-mac-trackpad";
let libraryOpen = false;

export async function monitorMacTrackpadScroll(
  environment: DesktopEnvironment["Service"],
  window: BrowserWindow,
  onPhase: (phase: TrackpadScrollPhase) => void,
): Promise<void> {
  const ffi = await import("ffi-rs");
  if (window.isDestroyed()) return;

  if (!libraryOpen) {
    const fileName = "libt3-trackpad.dylib";
    const libraryPath = environment.isPackaged
      ? environment.path.join(environment.resourcesPath, "mac-trackpad", fileName)
      : environment.path.join(
          environment.rootDir,
          "native",
          "mac-trackpad",
          "build",
          environment.processArch,
          fileName,
        );
    ffi.open({ library: LIBRARY, path: libraryPath });
    libraryOpen = true;
  }

  const callbackType = ffi.funcConstructor({
    paramsType: [
      ffi.DataType.I32,
      ffi.DataType.Double,
      ffi.DataType.Double,
      ffi.DataType.Double,
      ffi.DataType.Double,
    ],
    retType: ffi.DataType.Void,
  });
  const callback = ffi.createPointer({
    paramsType: [callbackType],
    paramsValue: [
      (nativePhase: number, at: number, deltaX: number, travelX: number, travelY: number) => {
        const kind = SCROLL_PHASE.get(nativePhase);
        if (!kind || window.isDestroyed()) return;
        if (kind === "end") {
          const zoom = window.webContents.getZoomFactor();
          onPhase({
            kind,
            at,
            deltaX: deltaX / zoom,
            travelX: travelX / zoom,
            travelY: travelY / zoom,
          });
        } else {
          onPhase({ kind, at });
        }
      },
    ],
  });
  const disposeCallback = () =>
    ffi.freePointer({
      paramsType: [callbackType],
      paramsValue: callback,
      pointerType: ffi.PointerType.RsPointer,
    });
  try {
    const monitor = ffi.load({
      library: LIBRARY,
      funcName: "t3_monitor_trackpad_scroll",
      retType: ffi.DataType.External,
      paramsType: [ffi.DataType.BigInt, ffi.DataType.External],
      paramsValue: [
        window.getNativeWindowHandle().readBigUInt64LE(),
        ...ffi.unwrapPointer(callback),
      ],
    });
    if (ffi.isNullPointer(monitor)) throw new Error("AppKit did not register the trackpad monitor");
    window.once("closed", () => {
      ffi.load({
        library: LIBRARY,
        funcName: "t3_remove_trackpad_monitor",
        retType: ffi.DataType.Void,
        paramsType: [ffi.DataType.External],
        paramsValue: [monitor],
      });
      disposeCallback();
    });
  } catch (error) {
    disposeCallback();
    throw error;
  }
}
