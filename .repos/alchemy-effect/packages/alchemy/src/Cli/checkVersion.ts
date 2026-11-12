import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SemVer from "effect/SemVer";
import packageJson from "../../package.json" with { type: "json" };

export class CheckVersionUnexpectedResponse extends Data.TaggedError(
  "CheckVersionUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const NPM_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/alchemy/dist-tags";

const CACHE_FILE = "version-check.json";
const CACHE_TTL_MILLIS = Duration.toMillis(Duration.days(1));
// npm's dist-tags endpoint is CDN-backed and typically answers in ~100ms;
// the sync budget only needs to absorb a slow handshake, not a dead network.
const SYNC_WAIT = Duration.seconds(3);

interface VersionCheckCache {
  checkedAt: number;
  /** Absent when the last check attempt failed (offline, timeout, …). */
  distTags?: Record<string, string>;
}

/**
 * Semver precedence: negative when a < b, positive when a > b. Versions that
 * don't parse compare equal, so they never trigger an upgrade notice.
 */
const compareVersions = (a: string, b: string): number => {
  const pa = Result.getOrUndefined(SemVer.parse(a));
  const pb = Result.getOrUndefined(SemVer.parse(b));
  return pa === undefined || pb === undefined ? 0 : SemVer.Order(pa, pb);
};

const readCache = Effect.fn(
  function* (cachePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(cachePath);
    const parsed = yield* Effect.try(() => JSON.parse(raw) as VersionCheckCache | null | undefined);
    return typeof parsed?.checkedAt === "number" ? parsed : undefined;
  },
  Effect.orElseSucceed(() => undefined),
);

const writeCache = Effect.fn(
  function* (cachePath: string, distTags?: Record<string, string>) {
    const fs = yield* FileSystem.FileSystem;
    const checkedAt = yield* Clock.currentTimeMillis;
    const cache: VersionCheckCache = { checkedAt, distTags };
    yield* fs.writeFileString(cachePath, JSON.stringify(cache));
  },
  (effect) => Effect.ignore(effect),
);

const fetchDistTags = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const response = yield* http.get(NPM_DIST_TAGS_URL);
  const distTags = (yield* response.json) as Record<string, string> | null;
  if (typeof distTags !== "object" || distTags === null) {
    return yield* new CheckVersionUnexpectedResponse({ message: "malformed dist-tags response" });
  }
  return distTags;
});

/**
 * Refresh the dist-tags cache with a single request. The fetch is forked so
 * it outlives the sync wait: we give it {@link SYNC_WAIT} to land inline,
 * and if it's still in flight the same request keeps going in the
 * background, writing the cache when it completes. The background path
 * never logs, so it can't interleave with prompts.
 */
const refreshDistTags = Effect.fn(function* (cachePath: string) {
  const fetch = yield* fetchDistTags.pipe(
    // The fiber owns all cache writes, whenever it completes — even after
    // the sync wait below has given up on it. A failed attempt is cached
    // too (a bare checkedAt), so a dead network costs at most one blocking
    // wait per TTL window, not one per run.
    Effect.tap((distTags) => writeCache(cachePath, distTags)),
    Effect.tapError(() => writeCache(cachePath)),
    Effect.forkScoped,
  );
  return yield* Fiber.join(fetch).pipe(
    Effect.timeout(SYNC_WAIT),
    Effect.orElseSucceed(() => undefined),
  );
});

/**
 * Warn if a newer `alchemy` version is published on the `latest` dist-tag. Runs to completion before any interactive prompts so
 * the warning never interleaves with prompt rendering, and is bounded so it
 * can never stall the CLI: dist-tags are cached in
 * `.alchemy/version-check.json` for a day (failed attempts included), so at
 * most one run per day waits on the network, and only up to
 * {@link SYNC_WAIT}. Best-effort: every failure is swallowed silently.
 */
export const checkLatestVersion = Effect.gen(function* () {
  const path = yield* Path.Path;
  const { dotAlchemy } = yield* AlchemyContext;
  const cachePath = path.join(dotAlchemy, CACHE_FILE);
  const now = yield* Clock.currentTimeMillis;

  const cached = yield* readCache(cachePath);
  const distTags =
    cached !== undefined && now - cached.checkedAt <= CACHE_TTL_MILLIS
      ? cached.distTags
      : yield* refreshDistTags(cachePath);
  if (distTags === undefined) return;

  const current = packageJson.version;
  const { latest } = distTags;
  // Strictly newer only: `latest` at (or behind) the installed version must
  // not prompt a "downgrade".
  if (latest === undefined || compareVersions(latest, current) <= 0) return;

  const installCmd =
    typeof process !== "undefined" && process.versions.bun !== undefined
      ? `bun add alchemy@${latest}`
      : `pnpm add alchemy@${latest}`;
  // A warning record: above the default console floor, and a JSON record
  // under --log-format json (commands run this check, after the flags parse).
  yield* Effect.logWarning(
    `alchemy ${latest} is available (you're on ${current}). Run \`${installCmd}\` to upgrade.`,
  );
}).pipe(Effect.ignore);

// Exported for tests.
export const _internal = { compareVersions };
