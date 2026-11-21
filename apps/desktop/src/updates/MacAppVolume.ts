import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

// Squirrel.Mac's ShipIt stages updates on the startup disk. Swapping an app on another volume is
// then a copy, and a ShipIt stopped partway leaves the app missing or half-written.
export type MacAppLocation =
  | { readonly _tag: "ShipIt" }
  | { readonly _tag: "Blocked"; readonly reason: string }
  | { readonly _tag: "OwnVolume"; readonly bundlePath: string };

export const SHIP_IT: MacAppLocation = { _tag: "ShipIt" };

export class MacAppVolumeInstallError extends Schema.TaggedError<MacAppVolumeInstallError>()(
  "MacAppVolumeInstallError",
  {
    step: Schema.Literals(["stage", "extract", "verify", "launch"]),
    exitCode: Schema.optionalKey(Schema.Number),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.step) {
      case "stage":
        return "Could not prepare the update next to T3 Code.";
      case "extract":
        return "Could not unpack the update next to T3 Code.";
      case "verify":
        return "The downloaded update is not signed like this copy of T3 Code, so it was not installed.";
      case "launch":
        return "Could not start the update installer.";
    }
  }
}

export interface StagedMacUpdate {
  readonly bundlePath: string;
  readonly stageDirectory: string;
  readonly stagedBundlePath: string;
}

const blocked = (reason: string): MacAppLocation => ({ _tag: "Blocked", reason });

export const UNCHECKED: MacAppLocation = blocked(
  "Automatic updates are off because T3 Code could not check the disk it runs from.",
);

const quietly = { stdin: "ignore", stdout: "ignore", stderr: "ignore" } as const;

// Args: app pid, app, staged app, stage, then how many 0.2s waits the app gets to exit (300) and
// how many 0.2s retries the swap gets once the app is moved aside (18000). A drive that drops out
// between the renames fails both, so they retry until it returns. previous.app stays until an app
// opens at the bundle path, and goes back there if the new one will not open.
export const SWAP_SCRIPT = `trap '' HUP INT TERM QUIT PIPE
pid=$1 target=$2 staged=$3 stage=$4 waits=\${5:-300} retries=\${6:-18000}
backup="$stage/previous.app"
while kill -0 "$pid" 2>/dev/null; do
  if [ "$waits" -le 0 ]; then rm -rf "$stage"; exit 1; fi
  waits=$((waits - 1))
  sleep 0.2
done
mv "$target" "$backup" || { open -n "$target"; exit 1; }
until mv "$staged" "$target"; do
  if mv "$backup" "$target"; then open -n "$target"; exit 1; fi
  if [ "$retries" -le 0 ]; then exit 1; fi
  retries=$((retries - 1))
  sleep 0.2
done
xattr -r -d com.apple.quarantine "$target" 2>/dev/null
open -n "$target" ||
  { [ -e "$backup" ] && rm -rf "$target" && mv "$backup" "$target" && open -n "$target"; } ||
  exit 1
rm -rf "$stage"
`;

// Args: app pid, app, stage. Once the copy running from the stage's previous.app quits, moves it
// back to the bundle path unless an app is already there, then removes the stage.
export const PUT_BACK_SCRIPT = `trap '' HUP INT TERM QUIT PIPE
while kill -0 "$1" 2>/dev/null; do sleep 1; done
[ -e "$2" ] || mv "$3/previous.app" "$2"
[ -e "$2" ] && rm -rf "$3"
`;

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const removeStage = (stageDirectory: string) =>
    fileSystem.remove(stageDirectory, { recursive: true, force: true }).pipe(Effect.ignore);

  const launchHelper = (script: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      spawner
        .spawn(
          ChildProcess.make(
            "/bin/sh",
            ["-c", script, "t3code-update", String(process.pid), ...args],
            {
              ...quietly,
              detached: true,
              extendEnv: true,
              env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
            },
          ),
        )
        // An unreferenced helper outlives this scope and the app.
        .pipe(
          Effect.flatMap((handle) => handle.unref),
          Effect.asVoid,
        ),
    );

  const resolveLocation = Effect.fn("MacAppVolume.resolveLocation")(function* (
    resourcesPath: string,
    tempDirectory: string,
  ) {
    const bundlePath = /^(.+\.app)\/Contents\/Resources\/?$/.exec(resourcesPath)?.[1];
    if (bundlePath === undefined) return SHIP_IT;
    if (bundlePath.includes("/AppTranslocation/")) {
      return blocked(
        "Automatic updates are off because macOS opened T3 Code from a temporary read-only copy. Move T3 Code to Applications with Finder, then open it from there.",
      );
    }
    // macOS follows an app the swap moved aside, so an interrupted swap's previous.app can be the
    // copy that opens. Its backends run from this bundle, so it moves back only after it quits.
    const stageDirectory = path.dirname(bundlePath);
    const appName = /^\.(.+)\.update$/.exec(path.basename(stageDirectory))?.[1];
    if (path.basename(bundlePath) === "previous.app" && appName !== undefined) {
      yield* launchHelper(PUT_BACK_SCRIPT, [
        path.join(path.dirname(stageDirectory), `${appName}.app`),
        stageDirectory,
      ]).pipe(Effect.ignore({ log: true }));
      return blocked(
        "Automatic updates are off because an earlier update did not finish. Quit and reopen T3 Code to turn them back on.",
      );
    }
    const [bundle, temp] = yield* Effect.all([
      fileSystem.stat(bundlePath),
      fileSystem.stat(tempDirectory),
    ]);
    // `/Volumes/Macintosh HD` links back to the startup disk.
    if (bundle.dev === temp.dev) return SHIP_IT;
    const writable = yield* Effect.all([
      fileSystem.access(path.dirname(bundlePath), { writable: true }),
      fileSystem.access(bundlePath, { writable: true }),
    ]).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (writable) return { _tag: "OwnVolume", bundlePath } satisfies MacAppLocation;
    const volume = /^\/Volumes\/([^/]+)\//.exec(bundlePath)?.[1];
    return blocked(
      `Automatic updates are off because T3 Code cannot replace itself on ${volume === undefined ? "the drive it runs from" : `"${volume}"`}, such as its disk image or a read-only drive. Drag T3 Code to Applications, then open it from there.`,
    );
  });

  /** Unpacks and verifies the update beside the app, so the swap is a rename on one volume. */
  const stage = Effect.fn("MacAppVolume.stage")(function* (
    bundlePath: string,
    downloadedFile: string,
  ) {
    const stageDirectory = path.join(
      path.dirname(bundlePath),
      `.${path.basename(bundlePath, ".app")}.update`,
    );
    const extractDirectory = path.join(stageDirectory, "extracted");
    const failAt =
      (step: MacAppVolumeInstallError["step"]) =>
      (cause: unknown): MacAppVolumeInstallError =>
        new MacAppVolumeInstallError({ step, cause });

    return yield* Effect.gen(function* () {
      // A stage left by an interrupted install holds nothing the running app needs.
      yield* fileSystem
        .remove(stageDirectory, { recursive: true, force: true })
        .pipe(
          Effect.andThen(fileSystem.makeDirectory(extractDirectory, { recursive: true })),
          Effect.mapError(failAt("stage")),
        );

      // ditto keeps the bundle's symlinks, resource forks, and extended attributes, as ShipIt does.
      const dittoExit = yield* spawner
        .exitCode(
          ChildProcess.make(
            "/usr/bin/ditto",
            ["-x", "-k", downloadedFile, extractDirectory],
            quietly,
          ),
        )
        .pipe(Effect.mapError(failAt("extract")));
      if (dittoExit !== 0) {
        return yield* new MacAppVolumeInstallError({ step: "extract", exitCode: dittoExit });
      }
      const bundles = (yield* fileSystem
        .readDirectory(extractDirectory)
        .pipe(Effect.mapError(failAt("extract")))).filter((name) => name.endsWith(".app"));
      const [bundleName] = bundles;
      if (bundleName === undefined || bundles.length > 1) {
        return yield* new MacAppVolumeInstallError({ step: "extract" });
      }
      const stagedBundlePath = path.join(extractDirectory, bundleName);

      // ShipIt's own check: the update must satisfy the running app's designated requirement.
      const display = yield* spawner
        .string(ChildProcess.make("/usr/bin/codesign", ["-d", "-r-", bundlePath]), {
          includeStderr: true,
        })
        .pipe(Effect.mapError(failAt("verify")));
      const requirement = /designated => (.+)/.exec(display)?.[1];
      if (requirement === undefined) {
        return yield* new MacAppVolumeInstallError({ step: "verify" });
      }
      const verifyExit = yield* spawner
        .exitCode(
          ChildProcess.make(
            "/usr/bin/codesign",
            [
              "--verify",
              "--deep",
              "--strict",
              "--test-requirement",
              `=${requirement}`,
              stagedBundlePath,
            ],
            quietly,
          ),
        )
        .pipe(Effect.mapError(failAt("verify")));
      if (verifyExit !== 0) {
        return yield* new MacAppVolumeInstallError({ step: "verify", exitCode: verifyExit });
      }
      return { bundlePath, stageDirectory, stagedBundlePath } satisfies StagedMacUpdate;
    }).pipe(Effect.onError(() => removeStage(stageDirectory)));
  });

  /** Starts the helper that swaps in the staged app once this process exits, then reopens it. */
  const launchSwap = Effect.fn("MacAppVolume.launchSwap")(function* (staged: StagedMacUpdate) {
    yield* launchHelper(SWAP_SCRIPT, [
      staged.bundlePath,
      staged.stagedBundlePath,
      staged.stageDirectory,
    ]).pipe(
      Effect.mapError((cause) => new MacAppVolumeInstallError({ step: "launch", cause })),
      Effect.onError(() => removeStage(staged.stageDirectory)),
    );
  });

  return { resolveLocation, stage, launchSwap };
});
