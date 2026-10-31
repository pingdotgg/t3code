import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { VerifyUpdateCodeSignature } from "electron-updater";
import { vi } from "vite-plus/test";

const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: {
    channel: "latest",
    downloadUpdate: async (): Promise<string[]> => [],
    logger: {
      info: (_message: unknown) => {},
      warn: (_message: unknown) => {},
      error: (_message: unknown) => {},
    },
    verifyUpdateCodeSignature: undefined as VerifyUpdateCodeSignature | undefined,
  },
}));

vi.mock("electron-updater", () => ({ autoUpdater: autoUpdaterMock }));

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("Windows update signature check", () => {
  const publisherNames = ["T3 Tools Inc"];
  const installerPath = "C:\\updater\\pending\\temp-T3-Code-x64.exe";
  // execFile marks a timeout kill; no clock or PowerShell process is needed here.
  const timedOut = () =>
    Object.assign(new Error("Command failed: powershell.exe"), { killed: true });

  const setup = () => {
    autoUpdaterMock.verifyUpdateCodeSignature = undefined;
    autoUpdaterMock.downloadUpdate = async () => {
      const rejection = await autoUpdaterMock.verifyUpdateCodeSignature?.(
        publisherNames,
        installerPath,
      );
      if (rejection != null) throw new Error(`Invalid signature: ${rejection}`);
      return [installerPath];
    };
  };

  const downloadVerifyingSignature = () =>
    Effect.flatMap(ElectronUpdater.ElectronUpdater, (updater) => updater.downloadUpdate);

  it.effect(
    "downloads after a timeout only when the same installer and publisher pass verification",
    () =>
      Effect.gen(function* () {
        setup();
        const logger = autoUpdaterMock.logger;
        let firstCheck = true;
        autoUpdaterMock.verifyUpdateCodeSignature = async (names, path) => {
          if (path !== installerPath || names.length !== 1 || names[0] !== publisherNames[0]) {
            return "Unexpected installer or publisher";
          }
          if (firstCheck) {
            firstCheck = false;
            throw timedOut();
          }
          return null;
        };

        assert.isUndefined(yield* downloadVerifyingSignature());
        assert.strictEqual(autoUpdaterMock.logger, logger);
      }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("rejects invalid signatures, other errors and two timeouts on repeated downloads", () =>
    Effect.gen(function* () {
      setup();
      const logger = autoUpdaterMock.logger;
      const outcomes = [
        () => Promise.resolve("Invalid publisher"),
        () => Promise.reject(new Error("Cannot execute PowerShell")),
        () => Promise.reject(timedOut()),
      ];
      for (const outcome of outcomes) {
        let failures: Array<() => Promise<string | null>> = [];
        autoUpdaterMock.verifyUpdateCodeSignature = () =>
          failures.shift()?.() ?? Promise.resolve(null);

        // An extra retry would accept the installer, including if wrappers stack on download two.
        for (const retry of [false, true]) {
          for (let download = 0; download < 2; download++) {
            failures = retry || outcome === outcomes[2] ? [outcomes[2]!, outcome] : [outcome];
            const error = yield* downloadVerifyingSignature().pipe(Effect.flip);
            assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
            assert.strictEqual(autoUpdaterMock.logger, logger);
          }
        }
      }
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("rejects a retry when the upstream capability probe skips verification", () =>
    Effect.gen(function* () {
      setup();
      const logger = autoUpdaterMock.logger;
      let firstCheck = true;
      autoUpdaterMock.verifyUpdateCodeSignature = async () => {
        if (firstCheck) {
          firstCheck = false;
          throw timedOut();
        }
        // electron-updater resolves null after this warning despite skipping validation.
        autoUpdaterMock.logger.warn(
          "Cannot execute ConvertTo-Json: spawnSync powershell.exe ETIMEDOUT. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.",
        );
        return null;
      };

      const error = yield* downloadVerifyingSignature().pipe(Effect.flip);
      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.instanceOf(error.cause, Error);
      assert.include(error.cause.message, "Signature validation was skipped");
      assert.strictEqual(autoUpdaterMock.logger, logger);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("downloads without a Windows signature hook", () =>
    Effect.gen(function* () {
      setup();
      assert.isUndefined(yield* downloadVerifyingSignature());
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
