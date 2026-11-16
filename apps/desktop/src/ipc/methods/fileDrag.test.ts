import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

const { startDrag, getFileIcon } = vi.hoisted(() => ({
  startDrag: vi.fn(),
  getFileIcon: vi.fn(async () => "file-icon"),
}));
vi.mock("electron", () => ({ app: { getFileIcon } }));

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { startFileDrag } from "./fileDrag.ts";

it.effect("only drags existing absolute paths from the host environment and app window", () =>
  Effect.gen(function* () {
    startDrag.mockClear();
    getFileIcon.mockClear();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped();
    const filePath = path.join(stateDir, "file with spaces.txt");
    yield* fs.writeFileString(filePath, "file");
    yield* fs.writeFileString(path.join(stateDir, "environment-id"), "host\n");
    const run = (environmentId: string, target: string, platform = "darwin", sender = 1) =>
      startFileDrag.handler({ environmentId, path: target }, { sender: { id: sender } }).pipe(
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
          path,
          stateDir,
          platform,
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        Effect.provideService(ElectronWindow.ElectronWindow, {
          appWindowFor: ({ id }: { readonly id: number }) =>
            id === 1
              ? Effect.succeedSome({ webContents: { id: 1, startDrag } })
              : Effect.succeedNone,
        } as unknown as ElectronWindow.ElectronWindow["Service"]),
      );
    assert.isFalse(yield* run("remote", filePath));
    assert.isFalse(yield* run("host", "relative.txt"));
    assert.isFalse(yield* run("host", `${filePath}:12`));
    assert.isFalse(yield* run("host", filePath, "linux"));
    assert.isFalse(yield* run("host", filePath, "darwin", 2));
    assert.strictEqual(startDrag.mock.calls.length, 0);
    assert.isTrue(yield* run("host", filePath));
    assert.isTrue(yield* run("host", filePath, "win32"));
    assert.deepEqual(startDrag.mock.calls, [
      [{ file: filePath, icon: "file-icon" }],
      [{ file: filePath, icon: "file-icon" }],
    ]);
    yield* fs.remove(path.join(stateDir, "environment-id"));
    assert.isFalse(yield* run("host", filePath));
    assert.strictEqual(startDrag.mock.calls.length, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
