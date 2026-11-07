import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { VerifyUpdateCodeSignature } from "electron-updater";
import { vi } from "vite-plus/test";

const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: {
    channel: "latest",
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    verifyUpdateCodeSignature: undefined as VerifyUpdateCodeSignature | undefined,
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import * as ElectronUpdater from "./ElectronUpdater.ts";

const publisherNames = ["T3 Tools Inc"];
const installerPath = "C:\\updater\\pending\\temp-T3-Code-x64.exe";
// execFile marks the error killed when the verifier exceeds its 20-second timeout.
const timedOut = () => Object.assign(new Error("Command failed: powershell.exe"), { killed: true });

const downloadVerifyingSignature = () => {
  autoUpdaterMock.downloadUpdate.mockImplementationOnce(async () => {
    // NsisUpdater reads the current verifier and accepts only null as a valid signature.
    const rejection = await autoUpdaterMock.verifyUpdateCodeSignature!(
      publisherNames,
      installerPath,
    );
    if (rejection !== null) throw new Error(`Invalid signature: ${rejection}`);
    return [];
  });
  return Effect.flatMap(ElectronUpdater.ElectronUpdater, (updater) => updater.downloadUpdate);
};

describe("ElectronUpdater", () => {
  it.effect("downloads the update when the first Windows signature checks time out", () =>
    Effect.gen(function* () {
      const verify = vi
        .fn<VerifyUpdateCodeSignature>()
        .mockRejectedValueOnce(timedOut())
        .mockRejectedValueOnce(timedOut())
        .mockRejectedValueOnce(timedOut())
        .mockResolvedValueOnce(null);
      autoUpdaterMock.verifyUpdateCodeSignature = verify;

      yield* downloadVerifyingSignature();

      assert.deepEqual(
        verify.mock.calls,
        Array.from({ length: 4 }, () => [publisherNames, installerPath]),
      );
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect(
    "fails on invalid signatures, other errors and repeated timeouts on each download",
    () =>
      Effect.gen(function* () {
        const cases = [
          { outcome: () => Promise.resolve("Invalid publisher"), calls: 1 },
          { outcome: () => Promise.reject(new Error("Cannot execute PowerShell")), calls: 1 },
          { outcome: () => Promise.reject(timedOut()), calls: 5 },
        ];
        for (const { outcome, calls } of cases) {
          const verify = vi.fn<VerifyUpdateCodeSignature>(outcome);
          autoUpdaterMock.verifyUpdateCodeSignature = verify;

          // A second download must neither stack retries nor start with a spent budget.
          for (let download = 1; download <= 2; download++) {
            const error = yield* downloadVerifyingSignature().pipe(Effect.flip);
            assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
            assert.equal(verify.mock.calls.length, calls * download);
          }
        }
      }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("retries a check the upstream capability probe skipped, and never accepts one", () =>
    Effect.gen(function* () {
      const skipped = async () => {
        // electron-updater warns through the updater's logger, then resolves null unchecked.
        autoUpdaterMock.logger.warn(
          "Cannot execute ConvertTo-Json: spawnSync powershell.exe ETIMEDOUT. Ignoring signature validation due to unsupported powershell version. Please upgrade to powershell 3 or higher.",
        );
        return null;
      };

      const recovers = vi
        .fn<VerifyUpdateCodeSignature>()
        .mockRejectedValueOnce(timedOut())
        .mockImplementationOnce(skipped)
        .mockResolvedValueOnce(null);
      autoUpdaterMock.verifyUpdateCodeSignature = recovers;
      yield* downloadVerifyingSignature();
      assert.equal(recovers.mock.calls.length, 3);

      const alwaysSkipped = vi
        .fn<VerifyUpdateCodeSignature>(skipped)
        .mockRejectedValueOnce(timedOut());
      autoUpdaterMock.verifyUpdateCodeSignature = alwaysSkipped;
      const error = yield* downloadVerifyingSignature().pipe(Effect.flip);
      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.equal(alwaysSkipped.mock.calls.length, 5);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
