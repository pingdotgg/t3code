// Post-apply install integrity check. A Windows update apply is not atomic:
// NSIS replaces files one by one, and a file held open (e.g. via a WSL 9p
// handle) is silently skipped in silent-install mode, leaving app.asar and
// app.asar.unpacked from DIFFERENT builds. That state crashes later with an
// opaque ERR_MODULE_NOT_FOUND in the main process. The desktop build stamps
// apps/server/dist/desktop-build-manifest.json (asar-unpacked on Windows)
// with the build version; comparing it against the asar's own version at
// startup detects a half-applied update before anything loads from the
// mismatched halves, and turns the opaque crash into an actionable dialog.

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopObservability from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as DesktopState from "./DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";

// Kept in sync with scripts/build-desktop-artifact.ts, which writes the
// manifest into the staged apps/server/dist so it lands under the Windows
// asarUnpack globs.
export const DESKTOP_BUILD_MANIFEST_RELATIVE_PATH =
  "app.asar.unpacked/apps/server/dist/desktop-build-manifest.json";

export const DesktopBuildManifest = Schema.Struct({
  version: Schema.String,
});
export type DesktopBuildManifest = typeof DesktopBuildManifest.Type;

const decodeDesktopBuildManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DesktopBuildManifest),
);

export type DesktopInstallIntegrityResult =
  | { readonly _tag: "Ok" }
  // No manifest to compare against where none is expected: dev runs,
  // macOS/Linux (which pack the server dist inside the asar), or an
  // unreadable/corrupt manifest. Never blocks launch.
  | { readonly _tag: "Skipped"; readonly reason: string }
  // Packaged Windows build with no manifest at all. Every Windows artifact
  // that ships this checker also ships the stamp (both come from the same
  // build script), so a missing manifest means the unpacked tree is from an
  // older, pre-stamp build — i.e. a half-applied update that replaced
  // app.asar but not app.asar.unpacked.
  | { readonly _tag: "MissingManifest"; readonly appVersion: string; readonly manifestPath: string }
  | {
      readonly _tag: "Mismatch";
      readonly appVersion: string;
      readonly unpackedVersion: string;
      readonly manifestPath: string;
    };

const { logWarning: logIntegrityWarning, logError: logIntegrityError } =
  DesktopObservability.makeComponentLogger("desktop-install-integrity");

export const checkInstallIntegrity: Effect.Effect<
  DesktopInstallIntegrityResult,
  never,
  DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem
> = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  if (!environment.isPackaged) {
    return { _tag: "Skipped", reason: "not a packaged build" } as const;
  }

  const manifestPath = environment.path.join(
    environment.resourcesPath,
    ...DESKTOP_BUILD_MANIFEST_RELATIVE_PATH.split("/"),
  );
  const read = yield* fileSystem.readFileString(manifestPath, "utf-8").pipe(
    Effect.match({
      onFailure: (error) =>
        error.reason._tag === "NotFound"
          ? ({ _tag: "NotFound" } as const)
          : ({ _tag: "Unreadable", detail: error.message } as const),
      onSuccess: (contents) => ({ _tag: "Found", contents }) as const,
    }),
  );
  if (read._tag === "Unreadable") {
    // The manifest exists (or at least the failure is not "absent") but
    // could not be read — access denied, I/O error. That is not evidence of
    // a half-applied update, and blocking every launch on a transient read
    // failure would brick healthy installs. Log loudly and let the launch
    // proceed.
    yield* logIntegrityWarning("build manifest could not be read; skipping integrity check", {
      manifestPath,
      detail: read.detail,
    });
    return { _tag: "Skipped", reason: `unreadable build manifest at ${manifestPath}` } as const;
  }
  if (read._tag === "NotFound") {
    if (environment.platform === "win32") {
      return {
        _tag: "MissingManifest",
        appVersion: environment.appVersion,
        manifestPath,
      } as const;
    }
    return { _tag: "Skipped", reason: `no build manifest at ${manifestPath}` } as const;
  }

  const manifest = yield* decodeDesktopBuildManifest(read.contents).pipe(Effect.option);
  if (Option.isNone(manifest)) {
    // A corrupt manifest could itself be fallout from a partial apply, but a
    // false positive here bricks every launch — log loudly and let the
    // version comparison stay the only hard gate.
    yield* logIntegrityWarning("build manifest exists but could not be decoded", {
      manifestPath,
    });
    return { _tag: "Skipped", reason: `undecodable build manifest at ${manifestPath}` } as const;
  }

  if (manifest.value.version === environment.appVersion) {
    return { _tag: "Ok" } as const;
  }

  return {
    _tag: "Mismatch",
    appVersion: environment.appVersion,
    unpackedVersion: manifest.value.version,
    manifestPath,
  } as const;
}).pipe(Effect.withSpan("desktop.installIntegrity.check"));

// Best-effort "where to get a fresh installer" link for the repair dialog,
// derived from the packaged update feed (app-update.yml). None when the
// build has no feed configured.
export const resolveDownloadPageUrl: Effect.Effect<
  Option.Option<string>,
  never,
  DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem
> = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const raw = yield* fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
    Effect.option,
  );
  if (Option.isNone(raw)) {
    return Option.none<string>();
  }
  const owner = raw.value.match(/^owner:\s*(.+)$/m)?.[1]?.trim();
  const repo = raw.value.match(/^repo:\s*(.+)$/m)?.[1]?.trim();
  if (!owner || !repo) {
    return Option.none<string>();
  }
  return Option.some(`https://github.com/${owner}/${repo}/releases`);
});

// Runs the check and, on mismatch, refuses to continue launching: shows an
// actionable dialog (with a jump to the releases page when the update feed
// names one) and requests shutdown. Returns false when startup must stop.
export const enforceInstallIntegrity = (options: {
  readonly downloadPageUrl: Option.Option<string>;
}): Effect.Effect<
  boolean,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | FileSystem.FileSystem
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
  | ElectronShell.ElectronShell
> =>
  Effect.gen(function* () {
    const result = yield* checkInstallIntegrity;
    if (result._tag === "Ok") {
      return true;
    }
    if (result._tag === "Skipped") {
      return true;
    }

    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const state = yield* DesktopState.DesktopState;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronDialog = yield* ElectronDialog.ElectronDialog;
    const electronShell = yield* ElectronShell.ElectronShell;

    yield* logIntegrityError(
      "install is internally inconsistent (half-applied update); refusing to launch",
      {
        appVersion: result.appVersion,
        unpackedVersion: result._tag === "Mismatch" ? result.unpackedVersion : "<no manifest>",
        manifestPath: result.manifestPath,
      },
    );

    const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
    if (!wasQuitting) {
      const supportFilesDescription =
        result._tag === "Mismatch"
          ? `support files are version ${result.unpackedVersion}`
          : `support files are from an older build with no version stamp`;
      const message =
        `This T3 Code installation is damaged: a previous update was only partially applied ` +
        `(application core is version ${result.appVersion}, ${supportFilesDescription}). ` +
        `Please reinstall T3 Code to repair it.`;
      const buttons = Option.isSome(options.downloadPageUrl)
        ? ["Open Download Page", "Quit"]
        : ["Quit"];
      const response = yield* electronDialog
        .showMessageBox({
          type: "error",
          title: "T3 Code installation is damaged",
          message,
          buttons,
          defaultId: 0,
          cancelId: buttons.length - 1,
        })
        .pipe(Effect.orElseSucceed(() => ({ response: buttons.length - 1 })));
      if (Option.isSome(options.downloadPageUrl) && response.response === 0) {
        yield* electronShell.openExternal(options.downloadPageUrl.value).pipe(Effect.ignore);
      }
    }
    yield* shutdown.request;
    yield* electronApp.quit;
    return false;
  }).pipe(Effect.withSpan("desktop.installIntegrity.enforce"));
