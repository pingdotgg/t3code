import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

/**
 * macOS Login Items no longer persist a hidden flag. Electron 44 removed
 * `openAsHidden`, and the system "Hide" checkbox does not stick without
 * LSUIElement. A login launch is detected with `wasOpenedAtLogin`; the app
 * then stays out of the Dock and off-screen until the user opens it.
 */
/** Passed to a manual launch (`open -a "T3 Code (Alpha)" --args --t3-start-hidden`) to exercise the login-launch path. */
export const HIDDEN_LAUNCH_ARG = "--t3-start-hidden";

export function macLaunchedHidden(input: {
  readonly platform: string;
  readonly wasOpenedAtLogin: boolean;
  readonly argv: readonly string[];
}): boolean {
  if (input.platform !== "darwin") return false;
  return input.wasOpenedAtLogin || input.argv.includes(HIDDEN_LAUNCH_ARG);
}

export class DesktopMacLoginItemUpdateError extends Schema.TaggedError<DesktopMacLoginItemUpdateError>()(
  "DesktopMacLoginItemUpdateError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not update the macOS login item.";
  }
}

export interface DesktopMacStatusItemHandlers {
  readonly onOpen: () => void;
  readonly onQuit: () => void;
}

export class DesktopMacLoginItem extends Context.Service<
  DesktopMacLoginItem,
  {
    /** This process was opened by a macOS login item and should not show a window yet. */
    readonly launchedHidden: boolean;
    /** True until the user asks for the window. Backend startup must not open one. */
    readonly deferringWindow: Effect.Effect<boolean>;
    /**
     * macOS emits `activate` for the login launch itself. The first one must
     * not open a window; later ones (Spotlight, Dock) should.
     */
    readonly consumeAutomaticActivate: Effect.Effect<boolean>;
    /** Show the Dock again and drop the menu-bar icon. Safe to call more than once. */
    readonly presentForeground: Effect.Effect<void>;
    readonly getOpenAtLogin: Effect.Effect<boolean>;
    readonly setOpenAtLogin: (
      enabled: boolean,
    ) => Effect.Effect<void, DesktopMacLoginItemUpdateError>;
    readonly installStatusItem: (
      handlers: DesktopMacStatusItemHandlers,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopMacLoginItem") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-mac-login-item");

// 22x22 template "T". Black pixels with alpha, so the menu bar inverts it.
const MENU_BAR_ICON_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAYAAADEtGw7AAAAJklEQVR42mNgGAV4wH8y8ajBxBtMjGU0i9BRg0cNHjV4SBs8AgAAzxxnmZIqgKUAAAAASUVORK5CYII=",
  "base64",
);

interface LoginItemSnapshot {
  readonly openAtLogin: boolean;
  readonly wasOpenedAtLogin: boolean;
}

const readLoginItemSnapshot = Effect.fn("desktop.macLoginItem.read")(function* (): Effect.fn.Return<
  LoginItemSnapshot
> {
  return yield* Effect.try({
    try: (): LoginItemSnapshot => {
      const settings = Electron.app.getLoginItemSettings();
      return {
        openAtLogin: settings.openAtLogin === true,
        wasOpenedAtLogin: settings.wasOpenedAtLogin === true,
      };
    },
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => ({ openAtLogin: false, wasOpenedAtLogin: false })));
});

const hideDock = () => {
  Electron.app.setActivationPolicy("accessory");
  Electron.app.dock?.hide();
};

const showDock = () => {
  Electron.app.setActivationPolicy("regular");
  const dock = Electron.app.dock;
  if (!dock) return;
  void Promise.resolve(dock.show()).catch(() => undefined);
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const snapshot = yield* readLoginItemSnapshot();
  const launchedHidden = macLaunchedHidden({
    platform: environment.platform,
    wasOpenedAtLogin: snapshot.wasOpenedAtLogin,
    argv: process.argv,
  });
  let deferring = launchedHidden;
  let suppressActivate = launchedHidden;
  let tray: Electron.Tray | null = null;

  const destroyTray = () => {
    const current = tray;
    tray = null;
    if (current && !current.isDestroyed()) {
      current.destroy();
    }
  };

  if (launchedHidden) {
    yield* Effect.try({
      try: hideDock,
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((cause) =>
        logWarning("failed to hide the Dock for a login launch", { cause }),
      ),
      Effect.asVoid,
    );
    yield* logInfo("launched hidden from a macOS login item");
  }

  return DesktopMacLoginItem.of({
    launchedHidden,
    deferringWindow: Effect.sync(() => deferring),
    consumeAutomaticActivate: Effect.sync(() => {
      if (!suppressActivate) return false;
      suppressActivate = false;
      return true;
    }),
    presentForeground: Effect.sync(() => {
      if (!launchedHidden) return;
      deferring = false;
      suppressActivate = false;
      destroyTray();
      try {
        showDock();
      } catch {
        // Restoring the Dock is best-effort; the window can still open without it.
      }
    }),
    getOpenAtLogin: Effect.gen(function* () {
      if (environment.platform !== "darwin") return false;
      return (yield* readLoginItemSnapshot()).openAtLogin;
    }).pipe(Effect.withSpan("desktop.macLoginItem.getOpenAtLogin")),
    setOpenAtLogin: Effect.fn("desktop.macLoginItem.setOpenAtLogin")(function* (enabled) {
      if (environment.platform !== "darwin") return;
      yield* Effect.try({
        try: () => {
          Electron.app.setLoginItemSettings({ openAtLogin: enabled });
        },
        catch: (cause) => new DesktopMacLoginItemUpdateError({ cause }),
      });
      yield* logInfo("updated macOS login item", { openAtLogin: enabled });
    }),
    installStatusItem: (handlers) =>
      Effect.gen(function* () {
        if (!launchedHidden) return;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            try {
              hideDock();
            } catch {
              // The Dock hide before ready is best-effort; try again now that Electron is ready.
            }
            const image = Electron.nativeImage
              .createFromBuffer(MENU_BAR_ICON_PNG)
              .resize({ width: 18, height: 18 });
            image.setTemplateImage(true);
            const next = new Electron.Tray(image);
            next.setToolTip(environment.displayName);
            next.setContextMenu(
              Electron.Menu.buildFromTemplate([
                {
                  label: `Open ${environment.displayName}`,
                  click: () => {
                    handlers.onOpen();
                  },
                },
                { type: "separator" },
                {
                  label: "Quit",
                  click: () => {
                    handlers.onQuit();
                  },
                },
              ]),
            );
            tray = next;
          }),
          () => Effect.sync(destroyTray),
        ).pipe(Effect.asVoid);
      }).pipe(Effect.withSpan("desktop.macLoginItem.installStatusItem")),
  });
});

export const layer = Layer.effect(DesktopMacLoginItem, make);

export const layerTest = (input?: { readonly launchedHidden?: boolean }) => {
  const launchedHidden = input?.launchedHidden === true;
  let deferring = launchedHidden;
  let suppressActivate = launchedHidden;
  return Layer.succeed(
    DesktopMacLoginItem,
    DesktopMacLoginItem.of({
      launchedHidden,
      deferringWindow: Effect.sync(() => deferring),
      consumeAutomaticActivate: Effect.sync(() => {
        if (!suppressActivate) return false;
        suppressActivate = false;
        return true;
      }),
      presentForeground: Effect.sync(() => {
        deferring = false;
        suppressActivate = false;
      }),
      getOpenAtLogin: Effect.succeed(false),
      setOpenAtLogin: () => Effect.void,
      installStatusItem: () =>
        Effect.acquireRelease(Effect.void, () => Effect.void).pipe(Effect.asVoid),
    }),
  );
};
