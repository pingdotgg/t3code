import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import { resolveSupportedLocale, resources, type SupportedLocale } from "@t3tools/i18n";

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
    readonly setLocale: (locale: SupportedLocale) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logInfo: logUpdaterInfo } = makeComponentLogger("desktop-updater");

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

const desktopText = (locale: SupportedLocale, key: keyof typeof resources.en.desktop) =>
  resources[locale].desktop[key];

const checkForUpdatesFromMenu = Effect.fn("desktop.menu.checkForUpdates")(function* (
  locale: SupportedLocale,
) {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const result = yield* updates.check("menu");
  const updateState = result.state;

  if (updateState.status === "up-to-date") {
    yield* electronDialog.showMessageBox({
      type: "info",
      title: desktopText(locale, "upToDate"),
      message: desktopText(locale, "currentlyNewest").replace(
        "{{version}}",
        updateState.currentVersion,
      ),
      buttons: [desktopText(locale, "ok")],
    });
  } else if (updateState.status === "error") {
    yield* electronDialog.showMessageBox({
      type: "warning",
      title: desktopText(locale, "updateCheckFailed"),
      message: desktopText(locale, "couldNotCheck"),
      detail: updateState.message ?? desktopText(locale, "unknownErrorTryAgain"),
      buttons: [desktopText(locale, "ok")],
    });
  }
});

const handleCheckForUpdatesMenuClick = Effect.fn("desktop.menu.handleCheckForUpdatesClick")(
  function* (locale: SupportedLocale) {
    const updates = yield* DesktopUpdates.DesktopUpdates;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const disabledReason = yield* updates.disabledReason;
    if (Option.isSome(disabledReason)) {
      yield* logUpdaterInfo("manual update check requested, but updates are disabled", {
        disabledReason: disabledReason.value,
      });
      yield* electronDialog.showMessageBox({
        type: "info",
        title: desktopText(locale, "updatesUnavailable"),
        message: desktopText(locale, "automaticUpdatesUnavailable"),
        detail: disabledReason.value,
        buttons: [desktopText(locale, "ok")],
      });
      return;
    }

    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.ensureMain;
    yield* checkForUpdatesFromMenu(locale);
  },
);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appName = yield* electronApp.name;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);

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

  let currentLocale: SupportedLocale | null = null;
  const configureForLocale = (locale: SupportedLocale) => {
    if (currentLocale === locale) return Effect.void;
    const text = (key: keyof typeof resources.en.desktop) => resources[locale].desktop[key];
    return Effect.gen(function* () {
      const checkForUpdatesClick = () => {
        runMenuEffect("check-for-updates", handleCheckForUpdatesMenuClick(locale));
      };
      const settingsClick = () => {
        runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
      };
      // Chromium already pastes as plain text for this chord, so the accelerator
      // needs nothing from the menu: the composer and the terminal each arm
      // themselves from the same keydown. Routing it through the renderer anyway
      // lands a second, injected paste and doubles the text. Only a menu click,
      // which produces no keystroke for them to see, needs that round trip.
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
      const template: Electron.MenuItemConstructorOptions[] = [];

      if (environment.platform === "darwin") {
        template.push({
          label: appName,
          submenu: [
            { role: "about", label: text("about") },
            {
              label: text("checkForUpdates"),
              click: checkForUpdatesClick,
            },
            { type: "separator" },
            {
              label: text("settings"),
              accelerator: "CmdOrCtrl+,",
              click: settingsClick,
            },
            { type: "separator" },
            { role: "services", label: text("services") },
            { type: "separator" },
            { role: "hide", label: text("hide") },
            { role: "hideOthers", label: text("hideOthers") },
            { role: "unhide", label: text("unhide") },
            { type: "separator" },
            { role: "quit", label: text("quit") },
          ],
        });
      }

      template.push(
        {
          label: text("file"),
          submenu: [
            ...(environment.platform === "darwin"
              ? []
              : [
                  {
                    label: text("settings"),
                    accelerator: "CmdOrCtrl+,",
                    click: settingsClick,
                  },
                  { type: "separator" as const },
                ]),
            {
              role: environment.platform === "darwin" ? "close" : "quit",
              label: text(environment.platform === "darwin" ? "close" : "quit"),
            },
          ],
        },
        {
          label: text("edit"),
          submenu: [
            { role: "undo", label: text("undo") },
            { role: "redo", label: text("redo") },
            { type: "separator" },
            { role: "cut", label: text("cut") },
            { role: "copy", label: text("copy") },
            { role: "paste", label: text("paste") },
            {
              label: text("pasteAsText"),
              accelerator: "CmdOrCtrl+Shift+V",
              click: pasteAsTextClick,
            },
            { role: "delete", label: text("delete") },
            { type: "separator" },
            { role: "selectAll", label: text("selectAll") },
            ...(environment.platform === "darwin"
              ? [
                  { type: "separator" as const },
                  {
                    label: text("speech"),
                    submenu: [
                      { role: "startSpeaking" as const, label: text("startSpeaking") },
                      { role: "stopSpeaking" as const, label: text("stopSpeaking") },
                    ],
                  },
                ]
              : []),
          ],
        },
        {
          label: text("view"),
          submenu: [
            { role: "reload", label: text("reload") },
            { role: "forceReload", label: text("forceReload") },
            { role: "toggleDevTools", label: text("toggleDevTools") },
            { type: "separator" },
            /*
            Not the zoom roles: those act on the focused webContents, so with
            an embedded preview WebContentsView focused they zoom the guest
            page and the app UI appears stuck. These always zoom the main
            window (see DesktopWindow.zoomMain).
          */
            { label: text("actualSize"), accelerator: "CmdOrCtrl+0", click: zoomClick("reset") },
            { label: text("zoomIn"), accelerator: "CmdOrCtrl+=", click: zoomClick("in") },
            {
              label: text("zoomIn"),
              accelerator: "CmdOrCtrl+Plus",
              visible: false,
              click: zoomClick("in"),
            },
            { label: text("zoomOut"), accelerator: "CmdOrCtrl+-", click: zoomClick("out") },
            { type: "separator" },
            { role: "togglefullscreen", label: text("toggleFullscreen") },
          ],
        },
        { role: "windowMenu", label: text("window") },
        {
          role: "help",
          label: text("help"),
          submenu: [
            {
              label: text("checkForUpdates"),
              click: checkForUpdatesClick,
            },
          ],
        },
      );

      yield* electronMenu.setApplicationMenu(template);
      currentLocale = locale;
    }).pipe(Effect.withSpan("desktop.menu.configure"));
  };

  const configure = Effect.gen(function* () {
    const systemLocale = yield* electronApp.systemLocale;
    yield* configureForLocale(resolveSupportedLocale("system", [systemLocale]));
  });

  return DesktopApplicationMenu.of({
    configure,
    setLocale: configureForLocale,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
