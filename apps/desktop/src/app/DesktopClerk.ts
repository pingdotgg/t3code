import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";

import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import {
  applyPendingDesktopProtocolUrl,
  extractDesktopProtocolUrl,
  isDesktopProtocolUrl,
  queuePendingDesktopProtocolUrl,
} from "./desktopProtocolUrl.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedErrorClass<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedErrorClass<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      | ElectronApp.ElectronApp
      | ElectronWindow.ElectronWindow
      | DesktopWindow.DesktopWindow
      | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

const isStringArg = (value: unknown): value is string => typeof value === "string";

export function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = resolveDesktopClerkFrontendApiHostname(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);

export function createDesktopClerkBridge(stateDir: string, isDevelopment: boolean) {
  return createClerkBridge({
    storage: storage({ path: stateDir }),
    passkeys: true,
    renderer: {
      scheme: ElectronProtocol.getDesktopScheme(isDevelopment),
      host: ElectronProtocol.DESKTOP_HOST,
    },
  });
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;

  // Electron scopes the single-instance lock to the userData directory and
  // creates that directory when the lock is acquired. The SDK bridge takes
  // the lock at creation, so userData must already point at the real
  // directory here — under the default productName-derived path, acquiring
  // the lock would create "T3 Code (Alpha)" and make the legacy-install
  // detection in resolveUserDataPath match on fresh installs.
  const userDataPath = yield* DesktopAppIdentity.resolveUserDataPath;
  yield* electronApp.setPath("userData", userDataPath);

  const bridge = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createDesktopClerkBridge(environment.stateDir, environment.isDevelopment),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );

  return DesktopClerk.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;

      // The SDK bridge holds Electron's single-instance lock (acquired at
      // bridge creation) so OAuth deep-link callbacks on Windows/Linux are
      // forwarded to the running app. In a secondary instance the bridge has
      // already begun quitting the app; app.quit() is asynchronous, so stop
      // bootstrap here before whenReady can fire.
      if (!bridge.isPrimaryInstance) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      const context = yield* Effect.context<
        ElectronWindow.ElectronWindow | DesktopWindow.DesktopWindow
      >();
      const runPromise = Effect.runPromiseWith(context);
      const createMainGate = yield* Semaphore.make(1);

      const scheme = ElectronProtocol.getDesktopScheme(environment.isDevelopment);
      const revealAndDispatch = Effect.fn("desktop.clerk.revealAndDispatchProtocolUrl")(function* (
        url: string | null,
      ) {
        // Registered main only. currentMainOrFirst can be the WSL splash.
        const mainWindow = yield* electronWindow.main;
        if (Option.isSome(mainWindow)) {
          yield* electronWindow.reveal(mainWindow.value);
          if (url !== null) {
            yield* Effect.sync(() => {
              // Queue then apply so a later waiter cannot load a stale
              // fiber-local URL over a newer deep link, and createMain cannot
              // replay the older pending slot.
              queuePendingDesktopProtocolUrl(url);
              applyPendingDesktopProtocolUrl(mainWindow.value);
            });
          }
          return;
        }

        if (url !== null) {
          queuePendingDesktopProtocolUrl(url);
          // Serialize so concurrent open-url / second-instance events cannot
          // each pass the empty-main check and create two untracked windows.
          yield* createMainGate.withPermits(1)(
            Effect.gen(function* () {
              const existing = yield* electronWindow.main;
              if (Option.isSome(existing)) {
                yield* electronWindow.reveal(existing.value);
                yield* Effect.sync(() => {
                  applyPendingDesktopProtocolUrl(existing.value);
                });
                return;
              }
              // Opens the real main when the backend is already ready (macOS
              // with no windows). Otherwise createMain applies the queued URL.
              yield* desktopWindow.createMainIfBackendReady.pipe(Effect.ignore);
            }),
          );
          return;
        }

        const fallbackWindow = yield* electronWindow.currentMainOrFirst;
        if (Option.isSome(fallbackWindow)) {
          yield* electronWindow.reveal(fallbackWindow.value);
        }
      });

      yield* electronApp.on("second-instance", (_event, argv) => {
        void runPromise(
          revealAndDispatch(
            extractDesktopProtocolUrl(Array.isArray(argv) ? argv.filter(isStringArg) : [], scheme),
          ),
        );
      });

      if (environment.platform === "darwin") {
        yield* electronApp.on("open-url", (event, url) => {
          if (typeof url !== "string" || !isDesktopProtocolUrl(url, scheme)) {
            return;
          }
          (event as { preventDefault?: () => void } | undefined)?.preventDefault?.();
          void runPromise(revealAndDispatch(url));
        });
      }
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
