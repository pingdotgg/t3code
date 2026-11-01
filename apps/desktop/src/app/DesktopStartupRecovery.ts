import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import type { BackendStartupFailure } from "../backend/DesktopBackendManager.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopState from "./DesktopState.ts";

const RELEASES_URL = "https://github.com/pingdotgg/t3code/releases";
const LAST_STARTED_VERSION_FILE = "desktop-last-started-version";
// Buttons are plain links to this host; will-navigate cancels them and runs the action.
const ACTION_ORIGIN = "https://startup-recovery.invalid";

const { logInfo, logWarning } = DesktopObservability.makeComponentLogger(
  "desktop-startup-recovery",
);

export type StartupRecoveryOffer =
  | { readonly _tag: "Checking" }
  | { readonly _tag: "Update"; readonly version: string; readonly installError?: string }
  | { readonly _tag: "Downloading"; readonly version: string; readonly percent: number | null }
  | { readonly _tag: "Reinstall"; readonly version: string }
  | { readonly _tag: "Releases" };

const STARTUP_RECOVERY_ACTIONS = ["update", "reinstall", "releases", "copy", "quit"] as const;
type StartupRecoveryAction = (typeof STARTUP_RECOVERY_ACTIONS)[number];

/** Prefer a newer build, then the last build that started on this machine, then the releases page. */
export function resolveStartupRecoveryOffer(
  update: DesktopUpdateState,
  lastStartedVersion: string | null,
): StartupRecoveryOffer {
  if (update.status === "downloading" && update.availableVersion !== null) {
    return {
      _tag: "Downloading",
      version: update.availableVersion,
      percent: update.downloadPercent,
    };
  }
  const updateVersion =
    update.downloadedVersion ?? (update.status === "available" ? update.availableVersion : null);
  // A version that already failed to apply here would loop through install and relaunch.
  if (updateVersion !== null && updateVersion !== update.notAppliedVersion) {
    const installError = update.errorContext === "install" ? update.message?.trim() : undefined;
    return installError
      ? { _tag: "Update", version: updateVersion, installError }
      : { _tag: "Update", version: updateVersion };
  }
  if (update.enabled && (update.status === "idle" || update.status === "checking")) {
    return { _tag: "Checking" };
  }
  if (lastStartedVersion !== null && lastStartedVersion !== update.currentVersion) {
    return { _tag: "Reinstall", version: lastStartedVersion };
  }
  return { _tag: "Releases" };
}

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

const actionLink = (action: StartupRecoveryAction, label: string, primary = false) =>
  `<a class="button${primary ? " primary" : ""}" href="${ACTION_ORIGIN}/${action}">${escapeHtml(label)}</a>`;

function describeOffer(offer: StartupRecoveryOffer): { text: string; action: string } {
  switch (offer._tag) {
    case "Checking":
      return { text: "Checking for a newer version…", action: "" };
    case "Update":
      return {
        text: offer.installError ?? `Version ${offer.version} is available. It can contain a fix.`,
        action: actionLink("update", `Update to ${offer.version}`, true),
      };
    case "Downloading":
      return {
        text: `Downloading ${offer.version}${offer.percent === null ? "" : ` (${Math.floor(offer.percent / 10) * 10}%)`}. T3 Code restarts when the download is done.`,
        action: "",
      };
    case "Reinstall":
      return {
        text: `Version ${offer.version} started correctly on this computer. Download it and install it to go back.`,
        action: actionLink("reinstall", `Download ${offer.version}`, true),
      };
    case "Releases":
      return {
        text: "Get a different version from the releases page.",
        action: actionLink("releases", "Open releases", true),
      };
  }
}

function buildStartupRecoveryHtml(input: {
  readonly appVersion: string;
  readonly failure: BackendStartupFailure;
  readonly offer: StartupRecoveryOffer;
  readonly logDir: string;
}): string {
  const offer = describeOffer(input.offer);
  const output = input.failure.output.trim();
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>T3 Code could not start</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#111;--muted:#666;--line:#ddd;--code:#f4f4f4}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#fff;--muted:#999;--line:#333;--code:#111}}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg)}
body{font:13px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;padding:28px;box-sizing:border-box;display:flex;flex-direction:column;gap:14px}
h1{font-size:18px;margin:0}p{margin:0}.muted{color:var(--muted)}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.button{color:var(--fg);text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:6px 12px}
.button.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
pre{flex:1;min-height:60px;margin:0;overflow:auto;background:var(--code);border:1px solid var(--line);border-radius:6px;padding:10px;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>T3 Code could not start</h1>
<p>${escapeHtml(input.failure.reason)}</p>
<p>${escapeHtml(offer.text)}</p>
<div class="actions">${offer.action}${actionLink("copy", "Copy details")}${actionLink("quit", "Quit")}</div>
<pre>${escapeHtml(output.length > 0 ? output : "The server wrote no output.")}</pre>
<p class="muted">Version ${escapeHtml(input.appVersion)}. T3 Code tries again in the background. Logs: ${escapeHtml(input.logDir)}</p>
</body></html>`;
}

/** Shows a self-contained error window while the primary backend fails to start, so a broken release still opens. */
export const listen: Effect.Effect<
  void,
  never,
  | DesktopState.DesktopState
  | DesktopUpdates.DesktopUpdates
  | DesktopEnvironment.DesktopEnvironment
  | ElectronApp.ElectronApp
  | ElectronShell.ElectronShell
  | ElectronTheme.ElectronTheme
  | ElectronWindow.ElectronWindow
  | FileSystem.FileSystem
  | Scope.Scope
> = Effect.gen(function* () {
  const { primaryBackendStartup, quitting } = yield* DesktopState.DesktopState;
  const updates = yield* DesktopUpdates.DesktopUpdates;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const fileSystem = yield* FileSystem.FileSystem;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  const lastStartedVersionPath = environment.path.join(
    environment.stateDir,
    LAST_STARTED_VERSION_FILE,
  );
  const lastStartedVersion = yield* fileSystem.readFileString(lastStartedVersionPath).pipe(
    Effect.map((text) => text.trim() || null),
    Effect.orElseSucceed(() => null),
  );

  const windowRef = yield* Ref.make(Option.none<Electron.BrowserWindow>());
  // The failure that opened the window; later restarts do not reload its details.
  const failureRef = yield* Ref.make(Option.none<BackendStartupFailure>());
  const renderedHtmlRef = yield* Ref.make("");
  const checkedRef = yield* Ref.make(false);
  const { latest, changes: updateChanges } = yield* updates.subscribe;
  const updateStateRef = yield* Ref.make(latest);

  const offer = Ref.get(updateStateRef).pipe(
    Effect.map((state) => resolveStartupRecoveryOffer(state, lastStartedVersion)),
  );

  const render = Effect.gen(function* () {
    const window = yield* Ref.get(windowRef);
    const failure = yield* Ref.get(failureRef);
    if (Option.isNone(window) || Option.isNone(failure) || window.value.isDestroyed()) return;
    const html = buildStartupRecoveryHtml({
      appVersion: environment.appVersion,
      failure: failure.value,
      offer: yield* offer,
      logDir: environment.logDir,
    });
    if ((yield* Ref.getAndSet(renderedHtmlRef, html)) === html) return;
    void window.value.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

  const runAction = Effect.fn("desktop.startupRecovery.runAction")(function* (
    action: StartupRecoveryAction,
  ) {
    yield* logInfo("startup recovery action", { action });
    const current = yield* offer;
    switch (action) {
      case "update": {
        if (current._tag !== "Update") return;
        const state = yield* updates.getState;
        if (state.downloadedVersion === null) {
          const download = yield* updates.download;
          if (!download.completed) return;
        }
        // Waits for a running background check; plain install would refuse.
        yield* updates.installPrepared(current.version);
        return;
      }
      case "reinstall":
        if (current._tag === "Reinstall") {
          yield* electronShell.openExternal(`${RELEASES_URL}/tag/v${current.version}`);
        }
        return;
      case "releases":
        yield* electronShell.openExternal(RELEASES_URL);
        return;
      case "copy": {
        const failure = yield* Ref.get(failureRef);
        if (Option.isNone(failure)) return;
        yield* electronShell.copyText(
          `T3 Code ${environment.appVersion} (${environment.platform} ${environment.processArch}) could not start.\n${failure.value.reason}\n\n${failure.value.output}`,
        );
        return;
      }
      case "quit":
        yield* electronApp.quit;
        return;
    }
  });

  const show = Effect.fn("desktop.startupRecovery.show")(
    function* () {
      if (yield* Ref.get(quitting)) return;
      // A backend that crashes after the app opened is reported by the app itself.
      if (Option.isSome(yield* electronWindow.main)) return;
      const existing = yield* Ref.get(windowRef);
      if (Option.isSome(existing) && !existing.value.isDestroyed()) {
        yield* electronWindow.reveal(existing.value);
        return;
      }
      const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
      const window = yield* electronWindow.create(
        {
          width: 640,
          height: 480,
          minWidth: 420,
          minHeight: 320,
          show: false,
          title: "T3 Code could not start",
          autoHideMenuBar: true,
          backgroundColor: shouldUseDarkColors ? "#000000" : "#ffffff",
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            javascript: false,
          },
        },
        { auxiliary: true },
      );
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        event.preventDefault();
        const action = STARTUP_RECOVERY_ACTIONS.find((name) => url === `${ACTION_ORIGIN}/${name}`);
        if (action !== undefined) runFork(runAction(action));
      });
      window.once("ready-to-show", () => {
        if (!window.isDestroyed()) window.show();
      });
      window.once("closed", () => {
        runFork(
          Ref.set(windowRef, Option.none()).pipe(Effect.andThen(Ref.set(renderedHtmlRef, ""))),
        );
      });
      yield* Ref.set(windowRef, Option.some(window));
      yield* render;
      yield* logInfo("startup recovery window shown");
    },
    Effect.catch((error) =>
      logWarning("could not show startup recovery", { errorTag: error._tag }),
    ),
  );

  const close = Effect.gen(function* () {
    const window = yield* Ref.getAndSet(windowRef, Option.none());
    if (Option.isSome(window) && !window.value.isDestroyed()) window.value.close();
  });

  const rememberStartedVersion = Effect.gen(function* () {
    if (lastStartedVersion === environment.appVersion) return;
    yield* fileSystem.writeFileString(lastStartedVersionPath, environment.appVersion);
  }).pipe(
    Effect.catch((error) =>
      logWarning("could not record the started version", { errorTag: error._tag }),
    ),
  );

  yield* updateChanges.pipe(
    Stream.runForEach((state) => Ref.set(updateStateRef, state).pipe(Effect.andThen(render))),
    Effect.forkScoped,
  );

  yield* SubscriptionRef.changes(primaryBackendStartup).pipe(
    Stream.runForEach(
      Effect.fn("desktop.startupRecovery.onStartupChange")(function* (startup) {
        if (startup._tag === "Ready") {
          yield* Ref.set(failureRef, Option.none());
          yield* close;
          yield* rememberStartedVersion;
          return;
        }
        if (startup._tag !== "Failing") return;
        if (Option.isSome(yield* Ref.get(failureRef))) return;
        yield* Ref.set(failureRef, Option.some({ reason: startup.reason, output: startup.output }));
        // The backend manager already logs each failure's reason.
        yield* logWarning("primary backend failing to start");
        yield* show();
        if (!(yield* Ref.getAndSet(checkedRef, true))) {
          yield* updates.check("startup-recovery").pipe(Effect.forkScoped);
        }
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("startup recovery stopped", cause).pipe(
        Effect.annotateLogs({ component: "desktop-startup-recovery" }),
      ),
    ),
    Effect.forkScoped,
  );

  // macOS keeps running with no windows; the Dock icon must bring the error back.
  yield* electronApp.on("activate", () => {
    runFork(
      Ref.get(failureRef).pipe(
        Effect.flatMap((failure) => (Option.isSome(failure) ? show() : Effect.void)),
      ),
    );
  });
});
