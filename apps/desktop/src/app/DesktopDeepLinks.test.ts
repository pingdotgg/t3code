import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopDeepLinks from "./DesktopDeepLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

interface ProtocolClientRegistration {
  readonly scheme: string;
  readonly path: string | undefined;
  readonly args: ReadonlyArray<string> | undefined;
}

interface DeepLinkHarness {
  readonly registrations: Array<ProtocolClientRegistration>;
  readonly dispatched: Array<string>;
  readonly listeners: Map<string, (...args: ReadonlyArray<unknown>) => void>;
}

function makeHarness(): DeepLinkHarness {
  return { registrations: [], dispatched: [], listeners: new Map() };
}

const makeElectronAppLayer = (harness: DeepLinkHarness) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("T3 Code"),
    whenReady: Effect.void,
    quit: Effect.void,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: (scheme, path, args) =>
      Effect.sync(() => {
        harness.registrations.push({ scheme, path, args });
        return true;
      }),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    onBeforeQuitForUpdate: () => Effect.void,
    on: (eventName, listener) =>
      Effect.sync(() => {
        harness.listeners.set(eventName, listener as (...args: ReadonlyArray<unknown>) => void);
      }),
  } satisfies ElectronApp.ElectronApp["Service"]);

// Reports delivery failure until the window "exists", mirroring how the real
// service drops renderer sends before bootstrap has opened a window.
const makeDesktopWindowLayer = (harness: DeepLinkHarness, hasRenderer: Ref.Ref<boolean>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected window creation"),
    ensureMain: Effect.die("unexpected window creation"),
    revealOrCreateMain: Effect.die("unexpected window creation"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    dispatchMenuAction: () => Effect.void,
    dispatchDeepLink: (target) =>
      Effect.gen(function* () {
        if (!(yield* Ref.get(hasRenderer))) {
          return false;
        }
        harness.dispatched.push(target);
        return true;
      }),
    syncAppearance: Effect.void,
  } as DesktopWindow.DesktopWindow["Service"]);

const makeEnvironmentLayer = (
  overrides: Partial<DesktopEnvironment.DesktopEnvironment["Service"]> = {},
) =>
  Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
    platform: "linux",
    isDevelopment: false,
    isPackaged: true,
    appPath: "/opt/T3 Code/resources/app.asar",
    ...overrides,
  } as DesktopEnvironment.DesktopEnvironment["Service"]);

const withDeepLinks = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    DesktopDeepLinks.DesktopDeepLinks | DesktopEnvironment.DesktopEnvironment | Scope.Scope
  >,
  input: {
    readonly harness: DeepLinkHarness;
    readonly hasRenderer: Ref.Ref<boolean>;
    readonly argv?: ReadonlyArray<string>;
    readonly environment?: Partial<DesktopEnvironment.DesktopEnvironment["Service"]>;
  },
) => {
  const environmentLayer = makeEnvironmentLayer(input.environment);
  const layer = Layer.effect(
    DesktopDeepLinks.DesktopDeepLinks,
    DesktopDeepLinks.make(input.argv ?? []),
  ).pipe(
    Layer.provideMerge(makeElectronAppLayer(input.harness)),
    Layer.provideMerge(makeDesktopWindowLayer(input.harness, input.hasRenderer)),
    Layer.provideMerge(environmentLayer),
  );

  return Effect.scoped(effect.pipe(Effect.provide(layer)));
};

describe("parseDeepLinkTarget", () => {
  it("keeps the path, query, and fragment of a link to the app origin", () => {
    assert.deepStrictEqual(
      DesktopDeepLinks.parseDeepLinkTarget("t3code://app/settings/connections", "t3code"),
      Option.some("/settings/connections"),
    );
    assert.deepStrictEqual(
      DesktopDeepLinks.parseDeepLinkTarget("t3code://app/threads?id=7#top", "t3code"),
      Option.some("/threads?id=7#top"),
    );
    assert.deepStrictEqual(
      DesktopDeepLinks.parseDeepLinkTarget("  t3code://app/  ", "t3code"),
      Option.some("/"),
    );
  });

  it("refuses links that would navigate the renderer off its own origin", () => {
    // A protocol-relative path is the dangerous one: a router reads
    // "//evil.example" as another origin rather than an in-app route.
    assert.deepStrictEqual(
      DesktopDeepLinks.parseDeepLinkTarget("t3code://app//evil.example/phish", "t3code"),
      Option.none(),
    );
    assert.deepStrictEqual(
      DesktopDeepLinks.parseDeepLinkTarget("t3code://evil.example/settings", "t3code"),
      Option.none(),
    );
    assert.deepStrictEqual(
      DesktopDeepLinks.parseDeepLinkTarget("https://evil.example/settings", "t3code"),
      Option.none(),
    );
  });

  it("keeps the development and production schemes apart", () => {
    assert.deepStrictEqual(
      DesktopDeepLinks.parseDeepLinkTarget("t3code-dev://app/settings", "t3code"),
      Option.none(),
    );
    assert.deepStrictEqual(
      DesktopDeepLinks.parseDeepLinkTarget("t3code-dev://app/settings", "t3code-dev"),
      Option.some("/settings"),
    );
  });

  it("ignores values that are not usable links", () => {
    for (const rawUrl of [undefined, null, 42, "", "   ", "not a url", "t3code:app/settings"]) {
      assert.deepStrictEqual(
        DesktopDeepLinks.parseDeepLinkTarget(rawUrl, "t3code"),
        Option.none(),
        `expected no target for ${String(rawUrl)}`,
      );
    }
  });
});

describe("describeDeepLinkTarget", () => {
  it("reduces a target to diagnostics that cannot leak a token", () => {
    assert.deepStrictEqual(
      DesktopDeepLinks.describeDeepLinkTarget("/pair?token=super-secret#frag"),
      { path: "/pair", hasQuery: true, hasFragment: true },
    );
    assert.deepStrictEqual(DesktopDeepLinks.describeDeepLinkTarget("/settings"), {
      path: "/settings",
      hasQuery: false,
      hasFragment: false,
    });
    // A fragment can carry a credential too, so it must not survive either.
    assert.deepStrictEqual(DesktopDeepLinks.describeDeepLinkTarget("/callback#id_token=abc"), {
      path: "/callback",
      hasQuery: false,
      hasFragment: true,
    });
  });
});

describe("findDeepLinkTarget", () => {
  it("picks the link out of the surrounding process arguments", () => {
    assert.deepStrictEqual(
      DesktopDeepLinks.findDeepLinkTarget(
        ["/opt/T3 Code/t3code", "--no-sandbox", "t3code://app/settings", "--enable-logging"],
        "t3code",
      ),
      Option.some("/settings"),
    );
  });

  it("resolves to none when no argument addresses the scheme", () => {
    assert.deepStrictEqual(
      DesktopDeepLinks.findDeepLinkTarget(["/opt/T3 Code/t3code", "--no-sandbox"], "t3code"),
      Option.none(),
    );
  });
});

describe("DesktopDeepLinks", () => {
  it.effect("claims the scheme on Linux and Windows", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hasRenderer = yield* Ref.make(true);
      yield* withDeepLinks(
        Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;
        }),
        { harness, hasRenderer },
      );

      assert.deepStrictEqual(harness.registrations, [
        { scheme: "t3code", path: undefined, args: undefined },
      ]);
    });
  });

  it.effect("points an unpackaged registration back at the Electron entry", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hasRenderer = yield* Ref.make(true);
      yield* withDeepLinks(
        Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;
        }),
        {
          harness,
          hasRenderer,
          environment: { isPackaged: false, isDevelopment: true, appPath: "/repo/apps/desktop" },
        },
      );

      assert.lengthOf(harness.registrations, 1);
      const registration = harness.registrations[0]!;
      assert.equal(registration.scheme, "t3code-dev");
      assert.equal(registration.path, process.execPath);
      assert.deepStrictEqual(registration.args, ["/repo/apps/desktop"]);
    });
  });

  it.effect("leaves the scheme to the app bundle on macOS", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hasRenderer = yield* Ref.make(true);
      yield* withDeepLinks(
        Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;
        }),
        { harness, hasRenderer, environment: { platform: "darwin" } },
      );

      assert.isEmpty(harness.registrations);
      assert.isTrue(harness.listeners.has("open-url"));
    });
  });

  it.effect("hands a cold-start link to the renderer that asks for it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      // No renderer exists while the app boots, which is exactly when a link
      // handed over on the command line arrives, so the renderer claims it on
      // mount instead of being pushed to.
      const hasRenderer = yield* Ref.make(false);
      yield* withDeepLinks(
        Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;
          assert.isEmpty(harness.dispatched);

          assert.deepStrictEqual(yield* deepLinks.takePending, Option.some("/threads/42"));
          // Claiming it clears it, so a remount does not navigate again.
          assert.deepStrictEqual(yield* deepLinks.takePending, Option.none());
        }),
        {
          harness,
          hasRenderer,
          argv: ["/opt/T3 Code/t3code", "t3code://app/threads/42"],
        },
      );
    });
  });

  it.effect("keeps a link pending when no loaded renderer took it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hasRenderer = yield* Ref.make(false);
      yield* withDeepLinks(
        Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;

          // Arrives while the app runs but before a renderer can take it, so
          // the push fails and it must survive for the next renderer.
          harness.listeners.get("second-instance")?.({}, [
            "/opt/T3 Code/t3code",
            "t3code://app/settings",
          ]);
          yield* Effect.yieldNow;

          assert.isEmpty(harness.dispatched);
          assert.deepStrictEqual(yield* deepLinks.takePending, Option.some("/settings"));
        }),
        { harness, hasRenderer },
      );
    });
  });

  it.effect("stops holding a link once a renderer has it", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hasRenderer = yield* Ref.make(true);
      yield* withDeepLinks(
        Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;

          harness.listeners.get("second-instance")?.({}, [
            "/opt/T3 Code/t3code",
            "t3code://app/settings",
          ]);
          yield* Effect.yieldNow;

          assert.deepStrictEqual(harness.dispatched, ["/settings"]);
          // Pushed successfully, so a later mount has nothing to replay.
          assert.deepStrictEqual(yield* deepLinks.takePending, Option.none());
        }),
        { harness, hasRenderer },
      );
    });
  });

  it.effect("routes a link handed over by a second launch", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hasRenderer = yield* Ref.make(true);
      yield* withDeepLinks(
        Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;

          const secondInstance = harness.listeners.get("second-instance");
          assert.isFunction(secondInstance);
          secondInstance?.({}, ["/opt/T3 Code/t3code", "t3code://app/settings/connections"]);
          yield* Effect.yieldNow;

          assert.deepStrictEqual(harness.dispatched, ["/settings/connections"]);
        }),
        { harness, hasRenderer },
      );
    });
  });

  it.effect("routes a link delivered by macOS and consumes the event", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hasRenderer = yield* Ref.make(true);
      yield* withDeepLinks(
        Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;

          const openUrl = harness.listeners.get("open-url");
          assert.isFunction(openUrl);
          let prevented = false;
          openUrl?.(
            {
              preventDefault: () => {
                prevented = true;
              },
            },
            "t3code://app/settings",
          );
          yield* Effect.yieldNow;

          assert.isTrue(prevented);
          assert.deepStrictEqual(harness.dispatched, ["/settings"]);
        }),
        { harness, hasRenderer, environment: { platform: "darwin" } },
      );
    });
  });

  it.effect("ignores a foreign link handed over by another app", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const hasRenderer = yield* Ref.make(true);
      yield* withDeepLinks(
        Effect.gen(function* () {
          const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
          yield* deepLinks.configure;

          harness.listeners.get("open-url")?.({}, "https://evil.example/settings");
          harness.listeners.get("second-instance")?.({}, [
            "/opt/T3 Code/t3code",
            "t3code://app//evil.example",
          ]);
          yield* Effect.yieldNow;

          assert.isEmpty(harness.dispatched);
        }),
        { harness, hasRenderer },
      );
    });
  });
});
