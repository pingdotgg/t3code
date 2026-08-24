import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopExistingLocalBackend from "./DesktopExistingLocalBackend.ts";
import { resolveExistingLocalBackendForStartup } from "./DesktopExistingLocalBackendStartup.ts";

const backend: DesktopExistingLocalBackend.ExistingLocalBackend = {
  baseDir: "/home/tester/.t3/service",
  origin: "http://127.0.0.1:41773/",
  port: 41773,
  pid: 1234,
  environmentId: "existing-environment",
  label: "Existing environment",
  desktopAttachToken: "credential",
};

const pairingError = new DesktopExistingLocalBackend.ExistingLocalBackendPairingError({
  baseDir: backend.baseDir,
  origin: backend.origin,
  detail: "pairing failed",
});

const pairingFailed: DesktopBackendConfiguration.ExistingLocalBackendResolution = {
  _tag: "PairingFailed",
  backend,
  error: pairingError,
};

const ready: DesktopBackendConfiguration.ExistingLocalBackendResolution = {
  _tag: "ReadyToAttach",
  attachment: { backend, credential: "credential", bearerToken: "bearer" },
};

function makeLayer(input: {
  readonly resolutions: ReadonlyArray<DesktopBackendConfiguration.ExistingLocalBackendResolution>;
  readonly dialogResponses?: ReadonlyArray<number>;
  readonly openExternalResult?: boolean;
  readonly onResolve?: () => void;
  readonly onIndependent?: () => void;
  readonly onOpenExternal?: (url: unknown) => void;
  readonly onDialog?: () => void;
}) {
  let resolutionIndex = 0;
  let dialogIndex = 0;
  return Layer.mergeAll(
    Layer.succeed(DesktopBackendConfiguration.DesktopBackendConfiguration, {
      resolveExistingLocalBackend: Effect.sync(() => {
        input.onResolve?.();
        const resolution = input.resolutions[resolutionIndex];
        resolutionIndex += 1;
        if (resolution === undefined) throw new Error("unexpected resolution attempt");
        return resolution;
      }),
      useIndependentBackendForLaunch: Effect.sync(() => input.onIndependent?.()),
      invalidateExistingLocalBackendAttachment: Effect.succeed(false),
      resolvePrimary: Effect.die("unexpected primary resolution"),
      resolvePrimaryLabel: Effect.die("unexpected primary label resolution"),
      resolveWsl: () => Effect.die("unexpected WSL resolution"),
    } satisfies DesktopBackendConfiguration.DesktopBackendConfiguration["Service"]),
    Layer.succeed(
      ElectronDialog.ElectronDialog,
      ElectronDialog.ElectronDialog.of({
        pickFolder: () => Effect.succeed(Option.none()),
        pickFiles: () => Effect.succeed([]),
        showMessageBox: () =>
          Effect.sync(() => {
            input.onDialog?.();
            const response = input.dialogResponses?.[dialogIndex];
            dialogIndex += 1;
            if (response === undefined) throw new Error("unexpected dialog");
            return { response, checkboxChecked: false };
          }),
        showErrorBox: () => Effect.void,
      }),
    ),
    Layer.succeed(
      ElectronShell.ElectronShell,
      ElectronShell.ElectronShell.of({
        openExternal: (url) =>
          Effect.sync(() => {
            input.onOpenExternal?.(url);
            return input.openExternalResult ?? true;
          }),
        copyText: () => Effect.void,
      }),
    ),
  );
}

describe("resolveExistingLocalBackendForStartup", () => {
  it.effect("retries pairing without treating the detected backend as absent", () => {
    let resolveCount = 0;
    let dialogCount = 0;
    return Effect.gen(function* () {
      const selection = yield* resolveExistingLocalBackendForStartup;

      assert.equal(selection._tag, "Continue");
      if (selection._tag !== "Continue") return;
      assert.equal(Option.getOrThrow(selection.attachment).credential, "credential");
      assert.equal(resolveCount, 2);
      assert.equal(dialogCount, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          resolutions: [pairingFailed, ready],
          dialogResponses: [0],
          onResolve: () => {
            resolveCount += 1;
          },
          onDialog: () => {
            dialogCount += 1;
          },
        }),
      ),
    );
  });

  it.effect("starts an independent backend only after explicit confirmation", () => {
    let independentCount = 0;
    return Effect.gen(function* () {
      const selection = yield* resolveExistingLocalBackendForStartup;

      assert.equal(selection._tag, "Continue");
      if (selection._tag !== "Continue") return;
      assert.isTrue(Option.isNone(selection.attachment));
      assert.equal(independentCount, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          resolutions: [pairingFailed],
          dialogResponses: [1],
          onIndependent: () => {
            independentCount += 1;
          },
        }),
      ),
    );
  });

  it.effect("opens the detected server in a browser and quits Desktop", () => {
    const openedUrls: unknown[] = [];
    return Effect.gen(function* () {
      const selection = yield* resolveExistingLocalBackendForStartup;

      assert.equal(selection._tag, "Quit");
      assert.deepEqual(openedUrls, [backend.origin]);
    }).pipe(
      Effect.provide(
        makeLayer({
          resolutions: [pairingFailed],
          dialogResponses: [2],
          onOpenExternal: (url) => openedUrls.push(url),
        }),
      ),
    );
  });

  it.effect("keeps the decision open if the browser cannot be launched", () =>
    Effect.gen(function* () {
      const selection = yield* resolveExistingLocalBackendForStartup;
      assert.equal(selection._tag, "Quit");
    }).pipe(
      Effect.provide(
        makeLayer({
          resolutions: [pairingFailed, pairingFailed],
          dialogResponses: [2, 3],
          openExternalResult: false,
        }),
      ),
    ),
  );
});
