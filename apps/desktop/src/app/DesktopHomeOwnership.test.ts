import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as DesktopAppActivation from "./DesktopAppActivation.ts";
import * as DesktopHomeOwnership from "./DesktopHomeOwnership.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";

const healthyOwner: DesktopHomeOwnership.DesktopHomeOwner = {
  _tag: "healthy",
  record: {
    version: 1,
    pid: 4242,
    port: 3773,
    origin: "http://127.0.0.1:3773",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  ownedByThisDesktop: true,
};

const foreignOwner: DesktopHomeOwnership.DesktopHomeOwner = {
  _tag: "foreign",
  record: {
    version: 1,
    pid: 4243,
    port: 3774,
    origin: "http://127.0.0.1:3774",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
};

const strandedOwner: DesktopHomeOwnership.DesktopHomeOwner = {
  _tag: "stranded",
  record: {
    version: 1,
    pid: 4244,
    port: 3775,
    origin: "http://127.0.0.1:3775",
    startedAt: "2026-01-01T00:00:00.000Z",
  },
};

const unknownOwner: DesktopHomeOwnership.DesktopHomeOwner = {
  _tag: "unknown",
  recordPath: "/tmp/t3-home/userdata/server-runtime.json",
};

interface OpenResult {
  readonly dialogs: ReadonlyArray<readonly [string, string]>;
  readonly windowsOpened: number;
  readonly controlSocketsStarted: number;
}

/**
 * The services the desktop reaches for, with the parts this behavior uses
 * replaced by counters.
 */
const layerServices = (options: { readonly quitting?: boolean }) =>
  Effect.gen(function* () {
    const dialogs: Array<readonly [string, string]> = [];
    const windows = yield* Ref.make(0);
    const sockets = yield* Ref.make(0);
    const quitting = Ref.makeUnsafe(options.quitting ?? false);

    const layerDialog = Layer.succeed(ElectronDialog.ElectronDialog, {
      showErrorBox: (title: string, content: string) =>
        Effect.sync(() => {
          dialogs.push([title, content]);
        }),
    } as unknown as ElectronDialog.ElectronDialog["Service"]);

    const layerWindow = Layer.succeed(DesktopWindow.DesktopWindow, {
      createMain: Ref.update(windows, (count) => count + 1),
    } as unknown as DesktopWindow.DesktopWindow["Service"]);

    const layerState = Layer.succeed(DesktopState.DesktopState, {
      backendReady: Ref.makeUnsafe(false),
      quitting,
    });

    const layerActivation = Layer.succeed(DesktopAppActivation.DesktopAppActivation, {
      start: Ref.update(sockets, (count) => count + 1),
      setRendererReady: () => Effect.void,
      complete: () => Effect.void,
    } as unknown as DesktopAppActivation.DesktopAppActivation["Service"]);

    return {
      layer: Layer.mergeAll(layerDialog, layerWindow, layerState, layerActivation),
      read: Effect.gen(function* () {
        return {
          dialogs,
          windowsOpened: yield* Ref.get(windows),
          controlSocketsStarted: yield* Ref.get(sockets),
        };
      }),
    };
  });

const open = (
  owner: DesktopHomeOwnership.DesktopHomeOwner,
  options?: { readonly quitting?: boolean },
): Effect.Effect<
  OpenResult,
  ElectronDialog.ElectronDialogShowErrorBoxError | DesktopWindow.DesktopWindowError
> =>
  Effect.gen(function* () {
    const services = yield* layerServices(options ?? {});
    yield* Effect.scoped(
      DesktopHomeOwnership.openDesktopWithExistingOwner({ owner }).pipe(
        Effect.provide(services.layer),
      ),
    );
    return yield* services.read;
  });

describe("DesktopHomeOwnership", () => {
  it.effect("keeps the app open when another server owns the T3 home", () =>
    Effect.gen(function* () {
      const result = yield* open(healthyOwner);

      assert.equal(result.windowsOpened, 1, "the window must open so Settings stays reachable");
      assert.equal(
        result.controlSocketsStarted,
        1,
        "the control socket must listen, or `t3 app` cannot reach the open app",
      );
      assert.equal(result.dialogs.length, 1, "the owner must be reported");
      assert.equal(result.dialogs[0]?.[0], "This T3 home is already in use");
      assert.include(
        result.dialogs[0]?.[1] ?? "",
        "http://127.0.0.1:3773",
        "the dialog must name the server that owns the home",
      );
    }),
  );

  it.effect("keeps the app open when the owner does not answer", () =>
    Effect.gen(function* () {
      const result = yield* open(foreignOwner);

      assert.equal(result.windowsOpened, 1);
      assert.equal(result.controlSocketsStarted, 1);
      assert.include(result.dialogs[0]?.[1] ?? "", "is not responding");
    }),
  );

  it.effect("reports a server the desktop could not stop", () =>
    Effect.gen(function* () {
      const result = yield* open(strandedOwner);

      assert.equal(result.windowsOpened, 1, "the app stays open so the user can act");
      assert.equal(result.controlSocketsStarted, 1);
      assert.include(
        result.dialogs[0]?.[1] ?? "",
        "could not stop the server that owns this T3 home",
      );
    }),
  );

  it.effect("reports a home whose ownership it cannot establish", () =>
    Effect.gen(function* () {
      const result = yield* open(unknownOwner);

      assert.equal(result.windowsOpened, 1, "the app stays open so the user can act");
      assert.equal(result.controlSocketsStarted, 1);
      assert.equal(result.dialogs[0]?.[0], "This T3 home's ownership could not be read");
      assert.include(
        result.dialogs[0]?.[1] ?? "",
        unknownOwner.recordPath,
        "the dialog must name the record the user has to deal with",
      );
      assert.include(
        result.dialogs[0]?.[1] ?? "",
        "Make sure no T3 Code server is running",
        "the dialog must ask the user to stop the server first: a record removed while its server still holds the lock leaves the next launch just as stuck",
      );
    }),
  );

  it.effect("does not open a window or a control socket while the app is quitting", () =>
    Effect.gen(function* () {
      const result = yield* open(healthyOwner, { quitting: true });

      assert.equal(result.windowsOpened, 0, "a quitting app must not open a window");
      assert.equal(result.controlSocketsStarted, 0, "a quitting app must not listen");
      assert.equal(result.dialogs.length, 1, "the owner must still be reported");
    }),
  );
});
