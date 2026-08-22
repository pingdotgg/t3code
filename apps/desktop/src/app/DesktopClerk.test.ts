import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  applyPendingDesktopProtocolUrl,
  takePendingDesktopProtocolUrl,
} from "./desktopProtocolUrl.ts";

const makeDesktopClerkLayer = (
  isDevelopment = true,
  events: string[] = [],
  platform: NodeJS.Platform = "linux",
) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    platform,
    appDataDirectory: "/tmp/app-data",
    userDataDirName: isDevelopment ? "t3code-dev" : "t3code",
    legacyUserDataDirName: isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
      ),
    ),
  );
};

const unusedDesktopWindow = {
  createMainIfBackendReady: Effect.void,
} as unknown as DesktopWindow.DesktopWindow["Service"];

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
    takePendingDesktopProtocolUrl();
  });

  it("derives the Clerk Frontend API hostname used by the desktop CSP", () => {
    const publishableKey = `pk_test_${btoa("clerk.t3.codes$")}`;

    assert.equal(
      DesktopClerk.resolveDesktopClerkFrontendApiHostname(publishableKey),
      "clerk.t3.codes",
    );
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname(""), undefined);
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname("invalid"), undefined);
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    const events: string[] = [];
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementation(() => {
      events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopClerkLayer(true, events)));

      assert.deepEqual(createClerkBridgeMock.mock.calls, [
        [
          {
            storage: storageAdapter,
            passkeys: true,
            renderer: { scheme: "t3code-dev", host: "app" },
          },
        ],
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
      // The bridge acquires Electron's single-instance lock at creation, and
      // the lock both lives in and creates the userData directory — so the
      // real path must be set before the bridge exists.
      assert.deepEqual(events, ["setPath:userData:/tmp/app-data/t3code-dev", "createClerkBridge"]);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(makeDesktopClerkLayer())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, "/tmp/t3-state");
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        'Failed to initialize the desktop Clerk bridge for state directory "/tmp/t3-state" (development: true).',
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(makeDesktopClerkLayer(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, "/tmp/t3-state");
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          'Failed to clean up the desktop Clerk bridge for state directory "/tmp/t3-state" (development: false).',
        );
      }
    });
  });

  it.effect("registers the second-instance handler in the primary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["second-instance"]);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, unusedDesktopWindow),
    );
  });

  it.effect("loads a second-instance protocol URL on the existing window", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    const loadURL = vi.fn(() => Promise.resolve());
    const mainWindow = { loadURL };
    const revealed: unknown[] = [];
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: readonly unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      main: Effect.succeed(Option.some(mainWindow)),
      currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
      reveal: (window: unknown) =>
        Effect.sync(() => {
          revealed.push(window);
        }),
    } as unknown as ElectronWindow.ElectronWindow["Service"];

    return Effect.scoped(
      Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;

        const url = "t3code-dev://app/CLERK-ROUTER/VIRTUAL/sign-in?__clerk_status=complete";
        listeners.get("second-instance")?.({}, ["electron", "--hidden", url], process.cwd());
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            assert.deepEqual(revealed, [mainWindow]);
            assert.deepEqual(loadURL.mock.calls, [[url]]);
          }),
        );
      }),
    ).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, unusedDesktopWindow),
    );
  });

  it.effect("reveals the window when second-instance argv has no protocol URL", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    const loadURL = vi.fn(() => Promise.resolve());
    const mainWindow = { loadURL };
    const revealed: unknown[] = [];
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: readonly unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      main: Effect.succeed(Option.some(mainWindow)),
      currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
      reveal: (window: unknown) =>
        Effect.sync(() => {
          revealed.push(window);
        }),
    } as unknown as ElectronWindow.ElectronWindow["Service"];

    return Effect.scoped(
      Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;

        listeners.get("second-instance")?.({}, ["electron", "--hidden"], process.cwd());
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            assert.deepEqual(revealed, [mainWindow]);
          }),
        );
        assert.deepEqual(loadURL.mock.calls, []);
      }),
    ).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, unusedDesktopWindow),
    );
  });

  it.effect("loads macOS open-url deep links on the existing window", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    const loadURL = vi.fn(() => Promise.resolve());
    const mainWindow = { loadURL };
    const revealed: unknown[] = [];
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: readonly unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      main: Effect.succeed(Option.some(mainWindow)),
      currentMainOrFirst: Effect.succeed(Option.some(mainWindow)),
      reveal: (window: unknown) =>
        Effect.sync(() => {
          revealed.push(window);
        }),
    } as unknown as ElectronWindow.ElectronWindow["Service"];

    return Effect.scoped(
      Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;

        assert.deepEqual([...listeners.keys()], ["second-instance", "open-url"]);

        const url = "t3code-dev://app/sso-callback";
        const preventDefault = vi.fn();
        listeners.get("open-url")?.({ preventDefault }, url);
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            assert.equal(preventDefault.mock.calls.length, 1);
            assert.deepEqual(revealed, [mainWindow]);
            assert.deepEqual(loadURL.mock.calls, [[url]]);
          }),
        );
      }),
    ).pipe(
      Effect.provide(makeDesktopClerkLayer(true, [], "darwin")),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, unusedDesktopWindow),
    );
  });

  it.effect("queues macOS open-url when no window exists and later dispatches", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    const loadURL = vi.fn(() => Promise.resolve());
    const mainWindow = { loadURL };
    const createMainAttempts: string[] = [];
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: readonly unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      main: Effect.succeed(Option.none()),
      currentMainOrFirst: Effect.succeed(Option.none()),
      reveal: () => Effect.die("unexpected reveal before main exists"),
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    const desktopWindow = {
      createMainIfBackendReady: Effect.sync(() => {
        createMainAttempts.push("createMainIfBackendReady");
      }),
    } as unknown as DesktopWindow.DesktopWindow["Service"];

    return Effect.scoped(
      Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;

        const url = "t3code-dev://app/sso-callback";
        const preventDefault = vi.fn();
        listeners.get("open-url")?.({ preventDefault }, url);
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            assert.equal(preventDefault.mock.calls.length, 1);
            assert.deepEqual(createMainAttempts, ["createMainIfBackendReady"]);
            assert.deepEqual(loadURL.mock.calls, []);
          }),
        );

        // Same seam DesktopWindow.createMain uses after setMain.
        assert.equal(applyPendingDesktopProtocolUrl(mainWindow), true);
        assert.deepEqual(loadURL.mock.calls, [[url]]);
      }),
    ).pipe(
      Effect.provide(makeDesktopClerkLayer(true, [], "darwin")),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
    );
  });

  it.effect("does not apply a stale deep link after a newer one is queued", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    const loadURL = vi.fn(() => Promise.resolve());
    const mainWindow = { loadURL };
    let currentMain = Option.none<typeof mainWindow>();
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: readonly unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      main: Effect.sync(() => currentMain),
      currentMainOrFirst: Effect.sync(() => currentMain),
      reveal: () => Effect.void,
    } as unknown as ElectronWindow.ElectronWindow["Service"];

    return Effect.scoped(
      Effect.gen(function* () {
        const enteredCreate = yield* Deferred.make<void>();
        const releaseCreate = yield* Deferred.make<void>();
        const desktopWindow = {
          createMainIfBackendReady: Effect.gen(function* () {
            yield* Deferred.succeed(enteredCreate, undefined);
            yield* Deferred.await(releaseCreate);
            applyPendingDesktopProtocolUrl(mainWindow);
            currentMain = Option.some(mainWindow);
          }),
        } as unknown as DesktopWindow.DesktopWindow["Service"];

        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure.pipe(
          Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
        );

        const older = "t3code-dev://app/sso-callback?state=old";
        const newer = "t3code-dev://app/sso-callback?state=new";
        listeners.get("open-url")?.({ preventDefault: vi.fn() }, older);
        yield* Deferred.await(enteredCreate);
        listeners.get("open-url")?.({ preventDefault: vi.fn() }, newer);
        yield* Deferred.succeed(releaseCreate, undefined);
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            assert.deepEqual(loadURL.mock.calls, [[newer]]);
          }),
        );
        assert.equal(takePendingDesktopProtocolUrl(), null);
      }),
    ).pipe(
      Effect.provide(makeDesktopClerkLayer(true, [], "darwin")),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });

  it.effect("does not load a protocol URL on the WSL connecting splash", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: readonly unknown[]) => void>();
    const splashLoadURL = vi.fn(() => Promise.resolve());
    const mainLoadURL = vi.fn(() => Promise.resolve());
    const splashWindow = { loadURL: splashLoadURL };
    const mainWindow = { loadURL: mainLoadURL };
    const revealed: unknown[] = [];
    const electronApp = {
      quit: Effect.void,
      on: (eventName: string, listener: (...args: readonly unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(eventName, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const createMainAttempts: string[] = [];
    const electronWindow = {
      main: Effect.succeed(Option.none()),
      currentMainOrFirst: Effect.succeed(Option.some(splashWindow)),
      reveal: (window: unknown) =>
        Effect.sync(() => {
          revealed.push(window);
        }),
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    const desktopWindow = {
      createMainIfBackendReady: Effect.sync(() => {
        createMainAttempts.push("createMainIfBackendReady");
      }),
    } as unknown as DesktopWindow.DesktopWindow["Service"];

    return Effect.scoped(
      Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;

        const url = "t3code-dev://app/sso-callback";
        listeners.get("second-instance")?.({}, ["electron", url], process.cwd());
        yield* Effect.promise(() =>
          vi.waitFor(() => {
            assert.deepEqual(createMainAttempts, ["createMainIfBackendReady"]);
            assert.deepEqual(splashLoadURL.mock.calls, []);
          }),
        );
        assert.deepEqual(revealed, []);
        assert.deepEqual(mainLoadURL.mock.calls, []);

        assert.equal(applyPendingDesktopProtocolUrl(mainWindow), true);
        assert.deepEqual(splashLoadURL.mock.calls, []);
        assert.deepEqual(mainLoadURL.mock.calls, [[url]]);
      }),
    ).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: false });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
    );
  });

  it.each([
    { isDevelopment: true, scheme: "t3code-dev" },
    { isDevelopment: false, scheme: "t3code" },
  ])("configures the SDK with the $scheme renderer origin", ({ isDevelopment, scheme }) => {
    const bridge = { cleanup: vi.fn(), isPrimaryInstance: true };
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue(bridge);

    assert.equal(DesktopClerk.createDesktopClerkBridge("/tmp/t3-state", isDevelopment), bridge);
    assert.deepEqual(storageMock.mock.calls, [[{ path: "/tmp/t3-state" }]]);
    assert.deepEqual(createClerkBridgeMock.mock.calls, [
      [
        {
          storage: storageAdapter,
          passkeys: true,
          renderer: { scheme, host: "app" },
        },
      ],
    ]);
    storageMock.mockClear();
    createClerkBridgeMock.mockClear();
  });
});
