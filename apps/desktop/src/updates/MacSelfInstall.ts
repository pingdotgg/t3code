// @effect-diagnostics nodeBuiltinImport:off -- This macOS install boundary runs codesign/ditto/xattr, hashes the downloaded zip, and launches a detached swap script with Node.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";

// electron-updater hands Squirrel.Mac the downloaded zip, and Squirrel only
// accepts a bundle that satisfies the running app's designated requirement.
// Ad-hoc and unsigned builds have no Team ID to anchor that requirement, so
// Squirrel rejects every update. Those builds swap the bundle themselves.

export const DownloadedUpdate = Schema.Struct({
  version: Schema.String,
  downloadedFile: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      sha512: Schema.optional(Schema.String),
    }),
  ),
});
export type DownloadedUpdate = typeof DownloadedUpdate.Type;

export class MacSelfInstallError extends Schema.TaggedError<MacSelfInstallError>()(
  "MacSelfInstallError",
  {
    stage: Schema.Literals([
      "locate-bundle",
      "permission",
      "download",
      "verify",
      "extract",
      "launch",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "locate-bundle":
        return "Could not locate the installed app bundle to update.";
      case "permission":
        return "The update could not be installed because the app's folder is not writable. Move the app to a folder you own, such as Applications, and try again.";
      case "download":
        return "The downloaded update is missing. Download it again.";
      case "verify":
        return "The downloaded update failed its checksum check. Download it again.";
      case "extract":
        return "Could not unpack the downloaded update.";
      case "launch":
        return "Could not start the update installer.";
    }
  }
}

export class MacSelfInstall extends Context.Service<
  MacSelfInstall,
  {
    /** True when the running macOS bundle has no Team ID, so Squirrel.Mac cannot install updates. */
    readonly isRequired: Effect.Effect<boolean>;
    /** Stages the update, launches a detached swap script, and quits the app. */
    readonly install: (update: DownloadedUpdate) => Effect.Effect<void, MacSelfInstallError>;
  }
>()("@t3tools/desktop/updates/MacSelfInstall") {}

/** Returns the enclosing `.app` bundle of a macOS executable path. */
export function resolveAppBundlePath(execPath: string): Option.Option<string> {
  const match = execPath.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/);
  return match?.[1] ? Option.some(match[1]) : Option.none();
}

/** `codesign -dv` output names a Team ID only for Developer ID / team-signed bundles. */
export function hasTeamIdentifier(codesignOutput: string): boolean {
  const match = codesignOutput.match(/^TeamIdentifier=(.+)$/m);
  const team = match?.[1]?.trim();
  return team !== undefined && team !== "" && team !== "not set";
}

/** Finds the sha512 that latest-mac.yml lists for the file electron-updater downloaded. */
export function selectDownloadedFileSha512(update: DownloadedUpdate): Option.Option<string> {
  const downloadedName = NodePath.basename(update.downloadedFile);
  const entry = update.files.find(
    (file) =>
      decodeURIComponent(NodePath.posix.basename(new URL(file.url, "file:///").pathname)) ===
      downloadedName,
  );
  return Option.fromNullishOr(entry?.sha512);
}

export function sha512Matches(expectedBase64: string, actual: Buffer): boolean {
  const expected = Buffer.from(expectedBase64, "base64");
  return expected.length === actual.length && NodeCrypto.timingSafeEqual(expected, actual);
}

// Arguments arrive positionally so no path ever needs shell quoting:
// $1 app pid, $2 installed bundle, $3 staged bundle, $4 staging root.
// The old bundle is moved aside first and restored if the new one cannot take
// its place, so a failure never leaves the user without an app.
export const SWAP_SCRIPT = `#!/bin/sh
pid="$1"
target="$2"
staged="$3"
root="$4"
backup="$root/previous"
tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -gt 600 ]; then exit 1; fi
  sleep 0.5
done
mkdir -p "$backup" || exit 1
old="$backup/$(basename "$target")"
if ! mv "$target" "$old"; then
  open "$target"
  exit 1
fi
if ! mv "$staged" "$target"; then
  mv "$old" "$target"
  open "$target"
  exit 1
fi
open "$target"
rm -rf "$root"
`;

const STAGING_DIR_NAME = "self-install";

function runFile(
  file: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly exitCode: number; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(file, [...args], { timeout: 120_000 }, (error, _stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        reject(error);
        return;
      }
      resolve({ exitCode: typeof error?.code === "number" ? error.code : 0, stderr });
    });
  });
}

function hashFileSha512(path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const hash = NodeCrypto.createHash("sha512");
    NodeFS.createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest()));
  });
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const fileSystem = yield* FileSystem.FileSystem;

  const bundlePath =
    environment.platform === "darwin" && environment.isPackaged
      ? resolveAppBundlePath(process.execPath)
      : Option.none<string>();

  // codesign exits non-zero for a fully unsigned bundle but still reports on
  // stderr; only when it cannot run at all do we keep the Squirrel path.
  const isRequired = yield* Option.match(bundlePath, {
    onNone: () => Effect.succeed(false),
    onSome: (bundle) =>
      Effect.tryPromise({
        try: () => runFile("/usr/bin/codesign", ["-dv", "--verbose=2", bundle]),
        catch: (cause) => new MacSelfInstallError({ stage: "locate-bundle", cause }),
      }).pipe(
        Effect.map(({ stderr }) => !hasTeamIdentifier(stderr)),
        Effect.orElseSucceed(() => false),
      ),
  }).pipe(Effect.cached);

  const fail = (stage: MacSelfInstallError["stage"]) => (cause: unknown) =>
    new MacSelfInstallError({ stage, cause });

  const install = Effect.fn("desktop.updates.macSelfInstall")(function* (update: DownloadedUpdate) {
    yield* Effect.annotateCurrentSpan({ version: update.version });
    const bundle = yield* Effect.fromOption(bundlePath).pipe(
      Effect.mapError(() => new MacSelfInstallError({ stage: "locate-bundle" })),
    );

    yield* fileSystem
      .access(NodePath.dirname(bundle), { writable: true })
      .pipe(Effect.mapError(fail("permission")));

    const expectedSha512 = yield* Effect.fromOption(selectDownloadedFileSha512(update)).pipe(
      Effect.mapError(() => new MacSelfInstallError({ stage: "verify" })),
    );
    const actualSha512 = yield* Effect.tryPromise({
      try: () => hashFileSha512(update.downloadedFile),
      catch: fail("download"),
    });
    if (!sha512Matches(expectedSha512, actualSha512)) {
      return yield* new MacSelfInstallError({ stage: "verify" });
    }

    // Staged beside electron-updater's download so the final move stays on one volume.
    const stagingRoot = NodePath.join(NodePath.dirname(update.downloadedFile), STAGING_DIR_NAME);
    const extractDir = NodePath.join(stagingRoot, "extracted");
    yield* fileSystem.remove(stagingRoot, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* fileSystem
      .makeDirectory(extractDir, { recursive: true })
      .pipe(Effect.mapError(fail("extract")));
    const extract = yield* Effect.tryPromise({
      try: () => runFile("/usr/bin/ditto", ["-x", "-k", update.downloadedFile, extractDir]),
      catch: fail("extract"),
    });
    if (extract.exitCode !== 0) return yield* new MacSelfInstallError({ stage: "extract" });
    const entries = yield* fileSystem
      .readDirectory(extractDir)
      .pipe(Effect.mapError(fail("extract")));
    const appName = entries.find((entry) => entry.endsWith(".app"));
    if (appName === undefined) return yield* new MacSelfInstallError({ stage: "extract" });
    const stagedBundle = NodePath.join(extractDir, appName);

    // Missing quarantine makes xattr exit non-zero; either way the bundle is usable.
    yield* Effect.tryPromise({
      try: () => runFile("/usr/bin/xattr", ["-dr", "com.apple.quarantine", stagedBundle]),
      catch: fail("extract"),
    }).pipe(Effect.ignore);

    const scriptPath = NodePath.join(stagingRoot, "swap.sh");
    yield* fileSystem
      .writeFileString(scriptPath, SWAP_SCRIPT)
      .pipe(Effect.mapError(fail("launch")));
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const child = NodeChildProcess.spawn(
            "/bin/sh",
            [scriptPath, String(process.pid), bundle, stagedBundle, stagingRoot],
            { detached: true, stdio: "ignore" },
          );
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        }),
      catch: fail("launch"),
    });
    yield* electronApp.quit;
  });

  return MacSelfInstall.of({ isRequired, install });
});

export const layer = Layer.effect(MacSelfInstall, make);
