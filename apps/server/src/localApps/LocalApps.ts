import type { LocalApp, LocalAppsListResult } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const COMMAND_TIMEOUT = "3 seconds";
const APPLICATION_DIRECTORIES = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
];

export class LocalApps extends Context.Service<
  LocalApps,
  {
    readonly list: () => Effect.Effect<LocalAppsListResult>;
  }
>()("t3/localApps/LocalApps") {}

export interface RunningApp {
  readonly name: string;
  readonly path: string;
  readonly bundleId: string | undefined;
}

/** Foreground (Dock) apps from `lsappinfo list`; agents and daemons are left out. */
export function parseLsappinfoList(output: string): ReadonlyArray<RunningApp> {
  const apps: RunningApp[] = [];
  for (const block of output.split(/^\s*\d+\) /mu).slice(1)) {
    const name = /^"(.+?)" ASN:/u.exec(block)?.[1]?.trim();
    const path = /^\s*bundle path="(.+?)"\s*$/mu.exec(block)?.[1]?.trim();
    if (!name || !path?.endsWith(".app") || !/\btype="Foreground"/u.test(block)) continue;
    const bundleId = /^\s*bundleID="(.+?)"\s*$/mu.exec(block)?.[1]?.trim();
    apps.push({ name, path, bundleId: bundleId || undefined });
  }
  return apps;
}

function bundleFileName(appPath: string): string {
  return (appPath.split("/").at(-1) ?? appPath).toLowerCase();
}

/**
 * Running apps first, then installed ones by name. An installed bundle that is running is listed
 * once, keyed by its file name: macOS may report a running app from a different path (Safari
 * runs from a cryptex) and under a localized name.
 */
export function mergeLocalApps(input: {
  readonly running: ReadonlyArray<RunningApp>;
  readonly installedPaths: ReadonlyArray<string>;
}): ReadonlyArray<LocalApp> {
  const seen = new Set<string>();
  const running: LocalApp[] = [];
  for (const app of input.running) {
    const key = bundleFileName(app.path);
    if (seen.has(key)) continue;
    seen.add(key);
    running.push({
      name: app.name,
      path: app.path,
      ...(app.bundleId ? { bundleId: app.bundleId } : {}),
      running: true,
    });
  }
  const installed: LocalApp[] = [];
  for (const appPath of input.installedPaths) {
    const key = bundleFileName(appPath);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = (appPath.split("/").at(-1) ?? appPath).replace(/\.app$/u, "").trim();
    if (name.length === 0) continue;
    installed.push({ name, path: appPath, running: false });
  }
  const byName = (left: LocalApp, right: LocalApp) => left.name.localeCompare(right.name);
  return [...running.sort(byName), ...installed.sort(byName)];
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostPlatform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;

  const runningApps = spawner
    .string(
      ChildProcess.make("/usr/bin/lsappinfo", ["list"], { stdin: "ignore", stderr: "ignore" }),
    )
    .pipe(
      Effect.timeout(COMMAND_TIMEOUT),
      Effect.map(parseLsappinfoList),
      Effect.tapError((cause) => Effect.logDebug("Failed to list running apps.", { cause })),
      Effect.orElseSucceed((): ReadonlyArray<RunningApp> => []),
    );

  const installedAppPaths = Effect.forEach(
    [...APPLICATION_DIRECTORIES, path.join(homeDirectory, "Applications")],
    (directory) =>
      fileSystem.readDirectory(directory).pipe(
        Effect.map((entries) =>
          entries
            .filter((entry) => entry.endsWith(".app"))
            .map((entry) => path.join(directory, entry)),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((groups) => groups.flat()));

  const list = Effect.fn("LocalApps.list")(function* () {
    // open-computer-use, the tool these apps are mentioned for, only drives macOS.
    if (hostPlatform !== "darwin") return { apps: [] };
    const [running, installedPaths] = yield* Effect.all([runningApps, installedAppPaths], {
      concurrency: 2,
    });
    return { apps: mergeLocalApps({ running, installedPaths }) };
  });

  return LocalApps.of({ list });
});

export const layer = Layer.effect(LocalApps, make);
