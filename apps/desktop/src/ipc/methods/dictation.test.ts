import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";
import * as DesktopDictation from "../../voice/DesktopDictation.ts";
import * as DesktopSnapShot from "../../snapShot/DesktopSnapShot.ts";
import { dictation } from "./dictation.ts";
import { setClientSettings } from "./clientSettings.ts";

// Exercise the IPC handlers and persisted settings without loading a native Electron binary.
vi.mock("electron", () => ({}));

describe("dictation executable authorization", () => {
  function harness(selected: readonly string[] = ["/chosen/whisper-cli"]) {
    const executions: string[] = [];
    const pickFiles = vi.fn(() => Effect.succeed(selected));
    const layer = Layer.mergeAll(
      Layer.mock(ElectronWindow.ElectronWindow)({
        main: Effect.succeedSome({ webContents: { id: 7 } } as Electron.BrowserWindow),
      }),
      Layer.mock(ElectronDialog.ElectronDialog)({ pickFiles }),
      Layer.mock(DesktopSnapShot.DesktopSnapShot)({ configure: () => Effect.void }),
      Layer.effect(
        DesktopDictation.DesktopDictation,
        Effect.gen(function* () {
          const settings = yield* DesktopClientSettings.DesktopClientSettings;
          return DesktopDictation.DesktopDictation.of({
            execute: () =>
              Effect.gen(function* () {
                executions.push(
                  Option.getOrElse(
                    yield* settings.get.pipe(Effect.orDie),
                    () => DEFAULT_CLIENT_SETTINGS,
                  ).dictationExecutablePath,
                );
                return {
                  state: "ready" as const,
                  message: "Ready",
                  downloadedBytes: 0,
                  totalBytes: 0,
                };
              }),
          });
        }),
      ),
    ).pipe(
      Layer.provideMerge(
        DesktopClientSettings.layerTest(
          Option.some({
            ...DEFAULT_CLIENT_SETTINGS,
            dictationExecutablePath: "/approved/whisper-cli",
          }),
        ),
      ),
    );
    return { layer, executions, pickFiles };
  }
  it.effect("ignores renderer-supplied executable paths while saving ordinary preferences", () => {
    const test = harness();
    return Effect.gen(function* () {
      yield* setClientSettings.handler({
        ...DEFAULT_CLIENT_SETTINGS,
        dictationExecutablePath: "/untrusted/program",
        dictationMicrophoneId: "usb",
      });
      yield* dictation.handler({ action: "status" }, { sender: { id: 7 } });
      assert.deepEqual(test.executions, ["/approved/whisper-cli"]);
      const settings = Option.getOrThrow(
        yield* (yield* DesktopClientSettings.DesktopClientSettings).get,
      );
      assert.equal(settings.dictationMicrophoneId, "usb");
      assert.equal(test.pickFiles.mock.calls.length, 0);
    }).pipe(Effect.provide(test.layer));
  });
  it.effect(
    "runs only the native picker's selection and supports returning to the platform default",
    () => {
      const test = harness();
      return Effect.gen(function* () {
        yield* dictation.handler(
          { action: "choose-executable", executablePath: "/untrusted/program" },
          { sender: { id: 7 } },
        );
        assert.deepEqual(test.executions, ["/chosen/whisper-cli"]);
        assert.equal(test.pickFiles.mock.calls.length, 1);
        yield* dictation.handler({ action: "reset-executable" }, { sender: { id: 7 } });
        assert.deepEqual(test.executions, ["/chosen/whisper-cli", ""]);
        assert.equal(test.pickFiles.mock.calls.length, 1);
      }).pipe(Effect.provide(test.layer));
    },
  );
  it.effect(
    "does not change or run the executable after cancellation or an untrusted picker request",
    () => {
      const test = harness([]);
      return Effect.gen(function* () {
        yield* dictation.handler({ action: "choose-executable" }, { sender: { id: 8 } });
        assert.equal(test.pickFiles.mock.calls.length, 0);
        yield* dictation.handler({ action: "choose-executable" }, { sender: { id: 7 } });
        assert.deepEqual(test.executions, []);
        assert.equal(
          Option.getOrThrow(yield* (yield* DesktopClientSettings.DesktopClientSettings).get)
            .dictationExecutablePath,
          "/approved/whisper-cli",
        );
      }).pipe(Effect.provide(test.layer));
    },
  );
});
