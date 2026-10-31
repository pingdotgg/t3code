import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { vi } from "vite-plus/test";

const { installed } = vi.hoisted(() => ({
  installed: { updater: undefined as typeof import("electron-updater").autoUpdater | undefined },
}));

vi.mock("electron-updater", () => ({
  get autoUpdater() {
    return installed.updater;
  },
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";
import { makeInstalledDebUpdater } from "../updates/updatesTestHarness.ts";

describe("ElectronUpdater", () => {
  it.effect(
    "rejects an install error emitted by the installed DebUpdater and removes its listener",
    () =>
      Effect.gen(function* () {
        const cause = new Error("pkexec exited with code 126: authentication cancelled");
        const native = yield* Effect.promise(() => makeInstalledDebUpdater(cause));
        installed.updater = native.updater;
        try {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          const listenersBefore = native.updater.listenerCount("error");
          const exit = yield* updater
            .quitAndInstall({ isSilent: true, isForceRunAfter: false })
            .pipe(Effect.exit);
          assert.equal(
            exit._tag,
            "Failure",
            "the emitted installer error must fail the service call",
          );
          if (exit._tag === "Success") return;
          const error = Cause.squash(exit.cause);
          assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
          assert.strictEqual(error.cause, cause);
          assert.deepEqual(native.steps, ["install"]);
          assert.equal(native.updater.listenerCount("error"), listenersBefore);
        } finally {
          installed.updater = undefined;
          native.restore();
        }
      }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
