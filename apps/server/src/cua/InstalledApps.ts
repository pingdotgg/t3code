import type { AppsListResult, InstalledApp } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as ServerSettings from "../serverSettings.ts";

/**
 * Applications the composer can mention for computer use. Only the host that
 * runs Cua Driver can answer, and only while computer use is enabled, so other
 * environments report `supported: false` rather than an empty list.
 */
export class InstalledApps extends Context.Service<
  InstalledApps,
  {
    readonly list: Effect.Effect<AppsListResult>;
  }
>()("t3/cua/InstalledApps") {}

const COMMAND_TIMEOUT = "10 seconds";
const CACHE_TTL_MS = 60_000;
const MAX_APPS = 500;
const SPOTLIGHT_QUERY = "kMDItemContentType == 'com.apple.application-bundle'";
const APPLICATION_ROOTS = [
  "/Applications",
  "/System/Applications",
  "/System/Applications/Utilities",
  `${process.env.HOME ?? ""}/Applications`,
];
const UNSUPPORTED: AppsListResult = { supported: false, apps: [] };

/** One `mdfind -attr` line: `<path>   kMDItemCFBundleIdentifier = <id>   kMDItemDisplayName = <name>`. */
export function parseSpotlightAppLine(line: string): InstalledApp | undefined {
  const match =
    /^(?<path>.+?\.app)\s{2,}kMDItemCFBundleIdentifier = (?<bundleId>[A-Za-z0-9._-]+)\s{2,}kMDItemDisplayName = (?<name>.+?)\s*$/u.exec(
      line,
    );
  if (!match?.groups) return undefined;
  const name = match.groups.name!.replace(/\.app$/u, "").trim();
  if (name.length === 0 || name.length > 160) return undefined;
  return { name, bundleId: match.groups.bundleId!, path: match.groups.path!.trim() };
}

export function parseSpotlightAppList(output: string): InstalledApp[] {
  const seen = new Set<string>();
  const apps: InstalledApp[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const app = parseSpotlightAppLine(line);
    if (!app || seen.has(app.bundleId)) continue;
    seen.add(app.bundleId);
    apps.push(app);
    if (apps.length >= MAX_APPS) break;
  }
  return apps.toSorted((left, right) => left.name.localeCompare(right.name));
}

export const make = Effect.fn("InstalledApps.make")(function* () {
  const platform = yield* HostProcessPlatform;
  const settings = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cache = yield* Ref.make<{
    readonly at: number;
    readonly apps: ReadonlyArray<InstalledApp>;
  } | null>(null);
  const scan = Effect.gen(function* () {
    const output = yield* spawner
      .string(
        ChildProcess.make(
          "/usr/bin/mdfind",
          [
            "-attr",
            "kMDItemCFBundleIdentifier",
            "-attr",
            "kMDItemDisplayName",
            ...APPLICATION_ROOTS.filter((root) => root.length > 1).flatMap((root) => [
              "-onlyin",
              root,
            ]),
            SPOTLIGHT_QUERY,
          ],
          { stdin: "ignore", stderr: "ignore" },
        ),
      )
      .pipe(Effect.timeout(COMMAND_TIMEOUT));
    return parseSpotlightAppList(output);
  });
  const list = Effect.gen(function* () {
    if (platform !== "darwin") return UNSUPPORTED;
    const enabled = yield* settings.getSettings.pipe(
      Effect.map((value) => value.enableCua),
      Effect.orElseSucceed(() => false),
    );
    if (!enabled) return UNSUPPORTED;
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(cache);
    if (cached && now - cached.at < CACHE_TTL_MS) return { supported: true, apps: cached.apps };
    const apps = yield* scan.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not list installed applications.", { cause }).pipe(
          Effect.as(cached?.apps ?? []),
        ),
      ),
    );
    yield* Ref.set(cache, { at: now, apps });
    return { supported: true, apps };
  });
  return InstalledApps.of({ list });
});

export const layer = Layer.effect(InstalledApps, make());

/** No host to enumerate: tests and non-desktop runtimes report unsupported. */
export const layerTest = Layer.succeed(
  InstalledApps,
  InstalledApps.of({ list: Effect.succeed(UNSUPPORTED) }),
);
