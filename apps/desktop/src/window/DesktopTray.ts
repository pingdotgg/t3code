import { environmentEndpointUrl } from "@t3tools/client-runtime/environment";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
} from "@t3tools/client-runtime/rpc";
import {
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/unstable/http/HttpClient";

import type * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronTray from "../electron/ElectronTray.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import { handleCheckForUpdatesClick } from "./DesktopApplicationMenu.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import { buildTrayAgentsModel, trayProjectRowLabel, trayThreadRowLabel } from "./trayMenu.ts";
import type { TrayAgentsModel } from "./trayMenu.ts";

const TRAY_ICON_FILE = "t3TrayTemplate.png";

// Kept short because the fetch runs between the tray click and the menu
// popup; a slow backend degrades to the cached snapshot instead of a
// noticeably delayed menu.
const TRAY_SNAPSHOT_TIMEOUT_MS = 2_000;

const PRIMARY_ENVIRONMENT_ID = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);

export class DesktopTrayActionError extends Schema.TaggedErrorClass<DesktopTrayActionError>()(
  "DesktopTrayActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop tray action "${this.action}" failed.`;
  }
}

export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    readonly configure: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/window/DesktopTray") {}

type DesktopTrayRuntimeServices =
  | DesktopBackendPool.DesktopBackendPool
  | DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth
  | DesktopUpdates.DesktopUpdates
  | DesktopWindow.DesktopWindow
  | ElectronDialog.ElectronDialog;

const { logError: logTrayError, logWarning: logTrayWarning } = makeComponentLogger("desktop-tray");

const dispatchMenuAction = Effect.fn("desktop.tray.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action);
});

const revealMainWindow = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.revealOrCreateMain;
}).pipe(Effect.asVoid, Effect.withSpan("desktop.tray.revealMainWindow"));

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronTray = yield* ElectronTray.ElectronTray;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const appName = yield* electronApp.name;
  const context = yield* Effect.context<DesktopTrayRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  const cachedSnapshotRef = yield* Ref.make(Option.none<OrchestrationShellSnapshot>());

  const runTrayEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopTrayRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.tray.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopTrayActionError({ action, cause });
          return logTrayError(error.message, { error });
        }),
      ),
    );
  };

  /**
   * One GET against the local backend's shell endpoint. Deliberately not the
   * client-runtime shell state machine: that module drags the whole
   * connection-supervisor graph into the main bundle, and the tray only needs
   * a point-in-time snapshot at click time. Any failure (backend still
   * starting, auth bootstrap, timeout) degrades to the last good snapshot.
   */
  const loadShellSnapshot = Effect.gen(function* () {
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    const primary = yield* pool.primary;
    const config = yield* primary.currentConfig;
    if (Option.isNone(config)) {
      return yield* Ref.get(cachedSnapshotRef);
    }
    const token = yield* localAuth.getBearerToken;
    const httpBaseUrl = config.value.httpBaseUrl.href;
    const client = yield* makeEnvironmentHttpApiClient(httpBaseUrl);
    const snapshot = yield* executeEnvironmentHttpRequest(
      environmentEndpointUrl(httpBaseUrl, "/api/orchestration/shell"),
      TRAY_SNAPSHOT_TIMEOUT_MS,
      client.orchestration.shellSnapshot({ headers: { authorization: `Bearer ${token}` } }),
    );
    yield* Ref.set(cachedSnapshotRef, Option.some(snapshot));
    return Option.some(snapshot);
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.withSpan("desktop.tray.loadShellSnapshot"),
    Effect.catchCause((cause) =>
      logTrayWarning("could not load the shell snapshot for the tray menu", {
        cause: Cause.pretty(cause),
      }).pipe(Effect.andThen(Ref.get(cachedSnapshotRef))),
    ),
  );

  const buildTrayTemplate = (model: TrayAgentsModel): Electron.MenuItemConstructorOptions[] => {
    const agentItems: Electron.MenuItemConstructorOptions[] = [];
    if (model.kind === "unavailable") {
      agentItems.push({ label: "Agents unavailable", enabled: false });
    } else if (model.kind === "empty") {
      agentItems.push({ label: "No agents running", enabled: false });
    } else {
      for (const project of model.projects) {
        agentItems.push({
          label: trayProjectRowLabel(project),
          submenu: project.threads.map((thread) => ({
            label: trayThreadRowLabel(thread),
            enabled: false,
          })),
        });
      }
    }
    return [
      ...agentItems,
      { type: "separator" },
      {
        label: `Open ${appName}`,
        click: () => runTrayEffect("open-main-window", revealMainWindow),
      },
      { type: "separator" },
      {
        label: "Settings…",
        click: () => runTrayEffect("open-settings", dispatchMenuAction("open-settings")),
      },
      {
        label: "Usage",
        click: () => runTrayEffect("open-usage", dispatchMenuAction("open-usage")),
      },
      {
        label: "Pull Requests",
        click: () => runTrayEffect("open-pull-requests", dispatchMenuAction("open-pull-requests")),
      },
      { type: "separator" },
      {
        label: "Check for Updates…",
        click: () => runTrayEffect("check-for-updates", handleCheckForUpdatesClick("tray")),
      },
      { type: "separator" },
      {
        label: `Quit ${appName}`,
        click: () => runTrayEffect("quit", electronApp.quit),
      },
    ];
  };

  const showTrayMenu = Effect.gen(function* () {
    const snapshot = yield* loadShellSnapshot;
    const model = buildTrayAgentsModel(PRIMARY_ENVIRONMENT_ID, Option.getOrNull(snapshot));
    yield* electronTray.popUpMenu(buildTrayTemplate(model));
  }).pipe(Effect.withSpan("desktop.tray.showMenu"));

  const configure = Effect.gen(function* () {
    // "Menu bar" is the macOS ask; Windows/Linux tray semantics (persistent
    // context menus, appindicator quirks) need their own treatment before
    // enabling this elsewhere.
    if (environment.platform !== "darwin") {
      return;
    }
    const iconPath = yield* assets.resolveResourcePath(TRAY_ICON_FILE);
    if (Option.isNone(iconPath)) {
      yield* logTrayWarning("tray icon asset is missing; skipping the menu bar item", {
        fileName: TRAY_ICON_FILE,
      });
      return;
    }
    yield* electronTray.create({
      iconPath: iconPath.value,
      tooltip: appName,
      onClick: () => runTrayEffect("show-menu", showTrayMenu),
    });
  }).pipe(
    Effect.withSpan("desktop.tray.configure"),
    // A missing tray must never take down startup; the app is fully usable
    // without the menu bar item.
    Effect.catchCause((cause) =>
      logTrayError("could not create the tray menu bar item", { cause: Cause.pretty(cause) }),
    ),
  );

  return DesktopTray.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopTray, make);
