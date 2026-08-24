import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as Electron from "electron";

import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as IpcChannels from "../ipc/channels.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppIdentity from "./DesktopAppIdentity.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import { readThemeFile, themeFilePathFromArguments } from "./DesktopThemeFileCommand.ts";

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
      ElectronApp.ElectronApp | ElectronWindow.ElectronWindow | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

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

const { logInfo, logWarning } = makeComponentLogger("desktop-theme-file-command");

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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

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
      const context = yield* Effect.context<ElectronWindow.ElectronWindow>();
      const runPromise = Effect.runPromiseWith(context);
      const pendingThemePaths: string[] = [];

      const readRequestedTheme = (filePath: string) =>
        readThemeFile(filePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.catchCause((cause) =>
            logWarning("failed to read requested theme file", { filePath, cause }).pipe(
              Effect.as(null),
            ),
          ),
        );

      const sendThemePath = (filePath: string) =>
        Effect.gen(function* () {
          const file = yield* readRequestedTheme(filePath);
          if (file === null) return;
          yield* logInfo("applying requested theme file", {
            fileName: file.name,
            fileSize: file.size,
          });
          yield* electronWindow.sendAll(IpcChannels.APPLY_THEME_FILE_CHANNEL, file);
        });

      const initialThemePath = themeFilePathFromArguments(process.argv);
      if (initialThemePath) pendingThemePaths.push(initialThemePath);

      // The SDK bridge holds Electron's single-instance lock (acquired at
      // bridge creation) so OAuth deep-link callbacks on Windows/Linux are
      // forwarded to the running app. In a secondary instance the bridge has
      // already begun quitting the app; app.quit() is asynchronous, so stop
      // bootstrap here before whenReady can fire.
      if (!bridge.isPrimaryInstance) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      yield* electronApp.on(
        "browser-window-created",
        (_event: Electron.Event, window: Electron.BrowserWindow) => {
          window.webContents.once("did-finish-load", () => {
            const paths = pendingThemePaths.splice(0);
            for (const filePath of paths) {
              void runPromise(
                Effect.gen(function* () {
                  const file = yield* readRequestedTheme(filePath);
                  if (file !== null && !window.isDestroyed()) {
                    yield* logInfo("applying requested startup theme file", {
                      fileName: file.name,
                      fileSize: file.size,
                    });
                    window.webContents.send(IpcChannels.APPLY_THEME_FILE_CHANNEL, file);
                  }
                }),
              );
            }
          });
        },
      );

      yield* electronApp.on("second-instance", (_event: unknown, commandLine: unknown) => {
        void runPromise(
          Effect.gen(function* () {
            if (Array.isArray(commandLine)) {
              const themePath = themeFilePathFromArguments(
                commandLine.filter((argument): argument is string => typeof argument === "string"),
              );
              if (themePath) {
                const currentWindow = yield* electronWindow.currentMainOrFirst;
                if (Option.isNone(currentWindow)) pendingThemePaths.push(themePath);
                else yield* sendThemePath(themePath);
              }
            }
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) {
              yield* electronWindow.reveal(mainWindow.value);
            }
          }),
        );
      });
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
