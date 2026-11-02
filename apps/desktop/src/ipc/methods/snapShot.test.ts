import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import {
  setupSnapShot,
  previewSnapShotConfig,
  applySnapShotConfig,
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
            main: Effect.succeedSome({ webContents: { id: 7 } }),
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
            main: Effect.succeedSome({ webContents: { id: 7 } }),
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
