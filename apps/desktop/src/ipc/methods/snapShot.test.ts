import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import {
  checkSnapShotShortcut,
  requestSnapShotPermissions,
  setupSnapShot,
  previewSnapShotConfig,
  applySnapShotConfig,
  setSnapShotAnimationDestination,
  setSnapShotShortcutSuppressed,
  snapShotScreenFrame,
  snapShotRelativeFrame,
} from "./snapShot.ts";

describe("window capture IPC", () => {
  const configPreview = {
    id: "12345678-1234-1234-1234-123456789abc",
    path: "/config/niri/config.kdl",
    resolvedPath: "/config/niri/config.kdl",
    before: "binds {}\n",
    after: "binds {\n}\n",
    shortcut: "Ctrl+Shift+2",
    operation: "install" as const,
  };
  it.effect("requires a trusted renderer for both config read and write approval", () => {
    const calls: string[] = [];
    return Effect.gen(function* () {
      const request = { operation: "install" as const, chooseFile: false };
      const untrustedRead = yield* Effect.exit(
        previewSnapShotConfig.handler(request, { sender: { id: 8 } }),
      );
      const untrustedWrite = yield* Effect.exit(
        applySnapShotConfig.handler(configPreview.id, { sender: { id: 8 } }),
      );
      assert(Exit.isFailure(untrustedRead));
      assert(Exit.isFailure(untrustedWrite));
      assert.deepEqual(calls, []);
      yield* previewSnapShotConfig.handler(request, { sender: { id: 7 } });
      assert.deepEqual(calls, ["read"]);
      yield* applySnapShotConfig.handler(configPreview.id, { sender: { id: 7 } });
      assert.deepEqual(calls, ["read", configPreview.id]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
          } as ElectronWindow.ElectronWindow["Service"]),
          Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
            previewConfig: () =>
              Effect.sync(() => {
                calls.push("read");
                return configPreview;
              }),
            applyConfig: (id: string) =>
              Effect.sync(() => {
                calls.push(id);
                return { backupPath: null, warning: null };
              }),
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
          Layer.succeed(
            ElectronDialog.ElectronDialog,
            {} as ElectronDialog.ElectronDialog["Service"],
          ),
        ),
      ),
    );
  });

  it.effect("cancelling custom file selection reads and writes nothing", () => {
    let read = false;
    return Effect.gen(function* () {
      const preview = yield* previewSnapShotConfig.handler(
        { operation: "install", chooseFile: true },
        { sender: { id: 7 } },
      );
      assert.isNull(preview);
      assert.isFalse(read);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
          } as ElectronWindow.ElectronWindow["Service"]),
          Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
            state: Effect.succeed({
              linuxBackend: "niri",
              shortcutConfigPath: "/config/niri/config.kdl",
            }),
            previewConfig: () =>
              Effect.sync(() => {
                read = true;
                return configPreview;
              }),
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
          Layer.succeed(ElectronDialog.ElectronDialog, {
            pickFiles: () => Effect.succeed([]),
          } as unknown as ElectronDialog.ElectronDialog["Service"]),
        ),
      ),
    );
  });

  it.effect("uses only the file returned by the native custom config picker", () => {
    let path: string | undefined;
    return Effect.gen(function* () {
      yield* previewSnapShotConfig.handler(
        { operation: "install", chooseFile: true },
        { sender: { id: 7 } },
      );
      assert.equal(path, "/chosen/config.kdl");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
          } as ElectronWindow.ElectronWindow["Service"]),
          Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
            state: Effect.succeed({ linuxBackend: "niri" }),
            previewConfig: (_: unknown, selected: string) =>
              Effect.sync(() => {
                path = selected;
                return configPreview;
              }),
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
          Layer.succeed(ElectronDialog.ElectronDialog, {
            pickFiles: () => Effect.succeed(["/chosen/config.kdl"]),
          } as unknown as ElectronDialog.ElectronDialog["Service"]),
        ),
      ),
    );
  });

  it("converts renderer viewport coordinates from the content origin using the window zoom", () => {
    assert.deepEqual(
      snapShotScreenFrame(
        { x: 12, y: 20, width: 208, height: 112 },
        { x: 100, y: 80, width: 1_000, height: 700 },
        1.25,
      ),
      { x: 115, y: 105, width: 260, height: 140 },
    );
  });

  it.effect("forwards a trusted renderer animation destination in screen coordinates", () => {
    let received: unknown;
    const webContents = { id: 7, getZoomFactor: () => 1.25 };
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeed(
            Option.some({
              getBounds: () => ({ x: 100, y: 80, width: 1_000, height: 700 }),
              getContentBounds: () => ({ x: 100, y: 118, width: 1_000, height: 662 }),
              webContents,
            }),
          ),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopSnapShot.DesktopSnapShot,
        DesktopSnapShot.DesktopSnapShot.of({
          setAnimationDestination: (id: string, destination: unknown) =>
            Effect.sync(() => {
              received = { id, destination };
            }),
        } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      ),
    );

    return Effect.gen(function* () {
      yield* setSnapShotAnimationDestination.handler(
        {
          id: "12345678-1234-1234-1234-123456789abc",
          viewportFrame: { x: 12, y: 20, width: 208, height: 112 },
          backgroundColor: "rgb(20, 20, 20)",
          borderColor: "rgba(80, 80, 80, 0.8)",
          borderWidth: 1,
          cornerRadius: 8,
          details: {
            appName: "T3 Code",
            windowTitle: "Capture animation",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
        { sender: webContents },
      );
      assert.deepEqual(received, {
        id: "12345678-1234-1234-1234-123456789abc",
        destination: {
          relativeFrame: { x: 15 / 1000, y: 25 / 662, width: 260 / 1000, height: 140 / 662 },
          frame: { x: 115, y: 143, width: 260, height: 140 },
          backgroundColor: "rgb(20, 20, 20)",
          borderColor: "rgba(80, 80, 80, 0.8)",
          borderWidth: 1.25,
          cornerRadius: 10,
          scaleFactor: 1.25,
          details: {
            appName: "T3 Code",
            windowTitle: "Capture animation",
            appIconDataUrl: "data:image/png;base64,aWNvbg==",
          },
        },
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("forwards the accessibility permission preference from a trusted renderer", () => {
    let includeAccessibility: boolean | undefined;
    const webContents = { id: 7 };
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeed(Option.some({ webContents })),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopSnapShot.DesktopSnapShot,
        DesktopSnapShot.DesktopSnapShot.of({
          requestPermissions: (include: boolean) =>
            Effect.sync(() => {
              includeAccessibility = include;
            }),
        } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      ),
    );

    return Effect.gen(function* () {
      yield* requestSnapShotPermissions.handler(false, { sender: webContents });
      assert.isFalse(includeAccessibility);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects an untrusted renderer at the IPC boundary", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        requestSnapShotPermissions.handler(false, { sender: { id: 8 } }),
      );
      assert(Exit.isFailure(exit));
      const failure = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(failure));
      const error = failure.value;

      assert.equal((error as { readonly _tag: string })._tag, "SnapShotIpcUnauthorizedSenderError");
      assert.equal((error as Error).message, "Snapshot request was rejected.");
    }).pipe(
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Effect.provideService(DesktopSnapShot.DesktopSnapShot, null as never),
    ),
  );

  it.effect("allows capture setup only from the trusted main renderer", () => {
    const actions: string[] = [];
    return Effect.gen(function* () {
      yield* setupSnapShot.handler("install-extension", { sender: { id: 7 } });
      assert.deepEqual(actions, ["install-extension"]);
      const rejected = yield* Effect.exit(
        setupSnapShot.handler("enable-extension", { sender: { id: 8 } }),
      );
      assert(Exit.isFailure(rejected));
      assert.deepEqual(actions, ["install-extension"]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ElectronWindow.ElectronWindow, {
            main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
          } as ElectronWindow.ElectronWindow["Service"]),
          Layer.succeed(DesktopSnapShot.DesktopSnapShot, {
            setup: (action: string) =>
              Effect.sync(() => {
                actions.push(action);
              }),
          } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
        ),
      ),
    );
  });

  it.effect("checks shortcut availability for a trusted renderer", () => {
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopSnapShot.DesktopSnapShot,
        DesktopSnapShot.DesktopSnapShot.of({
          checkShortcut: () => Effect.succeed({ available: true, message: null }),
        } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      ),
    );

    return Effect.gen(function* () {
      const result = yield* checkSnapShotShortcut.handler(
        { kind: "both-shift-keys" },
        { sender: { id: 7 } },
      );
      assert.deepEqual(result, { available: true, message: null });
    }).pipe(Effect.provide(layer));
  });
  it.effect("suppresses the active shortcut for a trusted renderer", () => {
    let suppressed = false;
    const layer = Layer.mergeAll(
      Layer.succeed(
        ElectronWindow.ElectronWindow,
        ElectronWindow.ElectronWindow.of({
          main: Effect.succeed(Option.some({ webContents: { id: 7 } })),
        } as ElectronWindow.ElectronWindow["Service"]),
      ),
      Layer.succeed(
        DesktopSnapShot.DesktopSnapShot,
        DesktopSnapShot.DesktopSnapShot.of({
          setShortcutSuppressed: (next: boolean) =>
            Effect.sync(() => {
              suppressed = next;
            }),
        } as unknown as DesktopSnapShot.DesktopSnapShot["Service"]),
      ),
    );

    return Effect.gen(function* () {
      yield* setSnapShotShortcutSuppressed.handler(true, { sender: { id: 7 } });
      assert.isTrue(suppressed);
    }).pipe(Effect.provide(layer));
  });
});

it("normalizes Wayland attachment coordinates without trusting Electron's screen origin", () => {
  const frame = { x: 100, y: 300, width: 200, height: 100 };
  const bounds = { x: 0, y: 0, width: 1000, height: 600 };
  assert.deepEqual(snapShotRelativeFrame(frame, bounds, 1.25), {
    x: 0.125,
    y: 0.625,
    width: 0.25,
    height: 125 / 600,
  });
  assert.deepEqual(
    snapShotRelativeFrame(frame, { ...bounds, x: -3840, y: 900 }, 1.25),
    snapShotRelativeFrame(frame, bounds, 1.25),
  );
  assert.isUndefined(snapShotRelativeFrame(frame, { ...bounds, width: 0 }, 1));
});
