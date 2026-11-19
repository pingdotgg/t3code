import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import { msg } from "gt-i18n";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import { applyLanguage, m, onLocaleChange } from "../i18n/messages.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedError<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices = DesktopWindow.DesktopWindow;

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action, {
    reveal: action !== "paste-as-text",
  });
});

const zoomMainWindow = Effect.fn("desktop.menu.zoomMainWindow")(function* (
  direction: DesktopWindow.MainWindowZoomDirection,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.zoomMain(direction);
});

const runMainContentsCommand = Effect.fn("desktop.menu.runMainContentsCommand")(function* (
  command: DesktopWindow.MainWindowContentsCommand,
): Effect.fn.Return<void, never, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.runMainContentsCommand(command);
});

/** @public */
export const make = Effect.gen(function* () {
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const clientSettings = yield* Effect.serviceOption(DesktopClientSettings.DesktopClientSettings);
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  const runFork = Effect.runForkWith(context);

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    const checkForUpdatesClick = () => {
      // The renderer checks this app, every connected server and every provider, and reports each.
      runMenuEffect("check-for-updates", dispatchMenuAction("check-for-updates"));
    };
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    // Chromium and the renderer already handle this chord; injecting another paste duplicates text.
    const pasteAsTextClick = (
      _item: Electron.MenuItem,
      _window: Electron.BaseWindow | undefined,
      event: Electron.KeyboardEvent,
    ) => {
      if (event.triggeredByAccelerator === true) return;
      runMenuEffect("paste-as-text", dispatchMenuAction("paste-as-text"));
    };
    const zoomClick = (direction: DesktopWindow.MainWindowZoomDirection) => () => {
      runMenuEffect(`zoom-${direction}`, zoomMainWindow(direction));
    };
    const mainContentsClick = (command: DesktopWindow.MainWindowContentsCommand) => () => {
      runMenuEffect(command, runMainContentsCommand(command));
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: environment.displayName,
        submenu: [
          { role: "about", label: m(msg("About {appName}"), { appName: environment.displayName }) },
          {
            label: m(msg("Check for Updates...")),
            click: checkForUpdatesClick,
          },
          { type: "separator" },
          {
            label: m(msg("Settings...")),
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { role: "hide", label: m(msg("Hide {appName}"), { appName: environment.displayName }) },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: m(msg("Quit {appName}"), { appName: environment.displayName }) },
        ],
      });
    }

    template.push(
      {
        label: m(msg("File", { $context: "menu bar title" })),
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: m(msg("Settings...")),
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          {
            label: m(msg("Close Developer Tools")),
            accelerator: "CmdOrCtrl+W",
            visible: false,
            click: () => {
              Electron.webContents
                .getAllWebContents()
                .find((contents) => !contents.isDestroyed() && contents.isDevToolsFocused())
                ?.closeDevTools();
            },
          },
          // Cmd/Ctrl+W belongs to the renderer's tab close; it must never close the window.
          environment.platform === "darwin"
            ? { label: m(msg("Close Window")), click: (_item, window) => window?.close() }
            : { role: "quit" },
        ],
      },
      {
        label: m(msg("Edit", { $context: "menu bar title" })),
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          {
            label: m(msg("Paste as Text")),
            accelerator: "CmdOrCtrl+Shift+V",
            click: pasteAsTextClick,
          },
          { role: "delete" },
          { type: "separator" },
          { role: "selectAll" },
          ...(environment.platform === "darwin"
            ? [
                { type: "separator" as const },
                {
                  label: m(msg("Speech", { $context: "menu, text-to-speech" })),
                  submenu: [{ role: "startSpeaking" as const }, { role: "stopSpeaking" as const }],
                },
              ]
            : []),
        ],
      },
      {
        label: m(msg("View", { $context: "menu bar title" })),
        submenu: [
          /* Native reload/DevTools/zoom roles target focused guests; these commands must target the app. */
          {
            label: m(msg("Reload")),
            accelerator: "CmdOrCtrl+R",
            click: mainContentsClick("reload"),
          },
          {
            label: m(msg("Force Reload")),
            accelerator: "Shift+CmdOrCtrl+R",
            click: mainContentsClick("forceReload"),
          },
          {
            label: m(msg("Toggle Developer Tools")),
            accelerator: environment.platform === "darwin" ? "Alt+Command+I" : "Ctrl+Shift+I",
            click: mainContentsClick("toggleDevTools"),
          },
          { type: "separator" },
          { label: m(msg("Actual Size")), accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
          { label: m(msg("Zoom In")), accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
          {
            label: m(msg("Zoom In")),
            accelerator: "CmdOrCtrl+Plus",
            visible: false,
            click: zoomClick("in"),
          },
          ...(environment.platform === "darwin"
            ? [
                {
                  label: m(msg("Zoom In")),
                  accelerator: "CmdOrCtrl+Shift+=",
                  visible: false,
                  click: zoomClick("in"),
                },
              ]
            : []),
          { label: m(msg("Zoom Out")), accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
          // Keypad codes do not match number-row accelerators.
          {
            label: m(msg("Actual Size")),
            accelerator: "CmdOrCtrl+num0",
            visible: false,
            click: zoomClick("reset"),
          },
          {
            label: m(msg("Zoom In")),
            accelerator: "CmdOrCtrl+numadd",
            visible: false,
            click: zoomClick("in"),
          },
          {
            label: m(msg("Zoom Out")),
            accelerator: "CmdOrCtrl+numsub",
            visible: false,
            click: zoomClick("out"),
          },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        // Electron's default Window submenu adds a Ctrl+W close role off macOS.
        role: "windowMenu",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          ...(environment.platform === "darwin"
            ? [{ type: "separator" as const }, { role: "front" as const }]
            : []),
        ],
      },
      {
        role: "help",
        submenu: [
          {
            label: m(msg("Check for Updates...")),
            click: checkForUpdatesClick,
          },
        ],
      },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  // Load the saved language before the first build so the menu never starts in English.
  const applySavedLanguage = Effect.gen(function* () {
    if (Option.isNone(clientSettings)) return;
    const saved = yield* clientSettings.value.get.pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(saved)) {
      yield* applyLanguage(saved.value.language).pipe(
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
      );
    }
  });

  let rebuildsOnLocaleChange = false;
  return DesktopApplicationMenu.of({
    configure: applySavedLanguage.pipe(
      Effect.andThen(configure),
      Effect.tap(() =>
        Effect.sync(() => {
          if (rebuildsOnLocaleChange) return;
          rebuildsOnLocaleChange = true;
          onLocaleChange(() => runFork(configure));
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
