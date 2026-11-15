// @effect-diagnostics nodeBuiltinImport:off - The probe compares nanosecond mtimes, which need bigint lstat.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as CheckoutCloner from "../../vcs/CheckoutCloner.ts";
import type * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { makeWorktreeCheckoutCache } from "../../vcs/worktreeCheckoutCache.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import { makeCheckoutCacheLedger, type RecordedFolder } from "./checkoutCacheLedger.ts";
import {
  CHECKOUT_CACHE_FOLDER,
  homeCheckoutCacheDir,
  homeKey,
  inRootCacheDir,
  ownerOfCacheFolder,
} from "./checkoutCacheSites.ts";
import type { CheckoutCacheRetention } from "./fastCheckoutSetting.ts";

type CheckoutCache = NonNullable<Effect.Success<ReturnType<typeof makeWorktreeCheckoutCache>>>;

type CheckoutCacheLease = Pick<CheckoutCache, "create" | "currentGeneration" | "schedule">;

interface Site {
  readonly folder: RecordedFolder;
  readonly cache: CheckoutCache;
  readonly lease: CheckoutCacheLease;
}

/** What a location looked like, so a `select` can tell when it, a drive or a link in it changed. */
interface Observed {
  readonly setting: string;
  readonly root: string;
  readonly usable: ReadonlyArray<{ readonly kind: "home" | "inRoot"; readonly folder: string }>;
  readonly refused: ReadonlyArray<{ readonly folder: string; readonly reason: string }>;
  readonly fingerprint: string;
}

type State =
  | { readonly _tag: "Off" }
  // Probed at the next `select`, so settings changes and boot write nothing to the location.
  | {
      readonly _tag: "Pending";
      readonly setting: string | undefined;
      readonly keep: ReadonlySet<string>;
    }
  // A failed probe can pass later, such as on a full drive, so it keeps every usable folder.
  | { readonly _tag: "Unusable"; readonly observed: Observed }
  | { readonly _tag: "OnRoot"; readonly site: Site; readonly observed: Observed }
  | { readonly _tag: "AnyLocation"; readonly site: Site };

type ProbeResult =
  | { readonly _tag: "Clones" }
  // The cloner ran and refused, as `cp --reflink=always` does on a drive that cannot share blocks.
  | { readonly _tag: "Refused"; readonly cause: unknown }
  | { readonly _tag: "Failed"; readonly cause: unknown };

const kept = (state: State): ReadonlySet<string> =>
  state._tag === "Pending"
    ? state.keep
    : state._tag === "Unusable"
      ? new Set(state.observed.usable.map(({ folder }) => folder))
      : new Set(state._tag === "Off" ? [] : [state.site.folder]);

const PROBE_BYTES = 64 * 1024;
// Upstream's age for discarding an unused repository's cached checkouts.
const UNUSED_CACHE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Keeps at most one checkout cache in use: on Linux the first cache folder on the worktree
 * location's drive that clones like `create` needs, on macOS upstream's one cache in the T3 home.
 * Only the location, the T3 home's `caches` folder and the state dir are resolved through links;
 * a cache folder or reserved folder that is a link is never used, written or cleared.
 */
export const makeWorktreeCheckoutSites = Effect.fn("WorktreeCheckoutSites.make")(function* (input: {
  readonly execute: GitVcsDriver.GitVcsDriver["Service"]["execute"];
}) {
  const clone = yield* CheckoutCloner.CheckoutCloner;
  const platform = yield* HostProcess.Platform;
  const mode = platform === "linux" ? "probed" : platform === "darwin" ? "anyLocation" : undefined;
  if (clone === undefined || mode === undefined) {
    return {
      apply: (_retention: CheckoutCacheRetention) => Effect.void,
      select: (_worktreesDirectorySetting: string): Effect.Effect<CheckoutCacheLease | undefined> =>
        Effect.undefined,
    };
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const home = yield* HostProcess.HomeDirectory;
  const scope = yield* Effect.scope;
  // Also carries the cloner and host references `makeWorktreeCheckoutCache` reads.
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | Scope.Scope
  >();
  const homeFolder = Effect.provide(homeCheckoutCacheDir, context);
  const realOr = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => target));
  const stateDir = yield* realOr(config.stateDir);
  const key = homeKey(stateDir);
  const ledger = yield* makeCheckoutCacheLedger({ stateDir, key });
  // Until the first `apply`, the first `select` probes the location it is asked for.
  const state = yield* Ref.make<State>({ _tag: "Pending", setting: undefined, keep: new Set() });
  const lock = yield* Semaphore.make(1);
  // Made only under `lock`: one upstream instance per folder, so its clears and builds share one
  // semaphore and generation and a late clear cannot delete a later build.
  const sites = new Map<RecordedFolder, Site>();

  const rootOf = (setting: string) => {
    const location = resolveWorktreesDirectory(setting, config.worktreesDir, path, home);
    return location === null ? Effect.succeed(null) : realOr(location);
  };
  const list = (folder: string) =>
    fileSystem.readDirectory(folder).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const isLink = (target: string) =>
    Effect.map(Effect.option(fileSystem.readLink(target)), Option.isSome);
  const isLinkFree = (folder: string) =>
    fileSystem.realPath(folder).pipe(
      Effect.map((real) => real === folder),
      Effect.orElseSucceed(() => false),
    );

  /** Why the folder `names` lead to from `anchor` cannot hold a cache; never follows a link. */
  const refusal = Effect.fn("WorktreeCheckoutSites.refusal")(function* (
    anchor: string,
    names: ReadonlyArray<string>,
    device: bigint | undefined,
  ) {
    const anchorInfo = yield* Effect.option(fileSystem.stat(anchor));
    if (Option.isNone(anchorInfo)) return "unreadable";
    if (device !== undefined && anchorInfo.value.dev !== device) return "other-drive";
    let target = anchor;
    for (const name of names) {
      target = path.join(target, name);
      if (yield* isLink(target)) return "link";
      const info = yield* Effect.result(fileSystem.stat(target));
      if (Result.isFailure(info)) {
        return info.failure.reason._tag === "NotFound" ? undefined : "unreadable";
      }
      if (info.success.type !== "Directory") return "not-a-folder";
      if (device !== undefined && info.success.dev !== device) return "other-drive";
    }
    return undefined;
  });

  /** Reads only: the location's real path and drive, and a verdict per cache folder. */
  const observe = Effect.fn("WorktreeCheckoutSites.observe")(function* (
    setting: string,
  ): Effect.fn.Return<Observed | undefined> {
    const homeCacheDir = yield* homeFolder;
    // macOS keeps upstream's one cache for every location, refused only as a link or a file.
    const root = mode === "anyLocation" ? path.dirname(homeCacheDir) : yield* rootOf(setting);
    if (root === null) return undefined;
    const device =
      mode === "anyLocation"
        ? undefined
        : Option.getOrUndefined(
            Option.map(yield* Effect.option(fileSystem.stat(root)), (info) => info.dev),
          );
    const reserved = path.join(root, CHECKOUT_CACHE_FOLDER);
    // Every probe clones into the location's reserved folder, so it gates the home cache too.
    const gate =
      mode === "anyLocation" ? undefined : yield* refusal(root, [CHECKOUT_CACHE_FOLDER], device);
    const candidates: Array<Observed["usable"][number]> = [];
    if (
      gate === undefined &&
      (mode === "anyLocation" || root === (yield* realOr(config.worktreesDir)))
    ) {
      candidates.push({ kind: "home", folder: homeCacheDir });
    }
    if (gate === undefined && mode === "probed") {
      candidates.push({ kind: "inRoot", folder: inRootCacheDir(root, key, path) });
    }
    const usable: Array<Observed["usable"][number]> = [];
    const refused = gate === undefined ? [] : [{ folder: reserved, reason: gate }];
    for (const candidate of candidates) {
      const anchor = candidate.kind === "home" ? path.dirname(homeCacheDir) : root;
      const names = path.relative(anchor, candidate.folder).split(path.sep);
      const reason = yield* refusal(anchor, names, device);
      if (reason === undefined) usable.push(candidate);
      else refused.push({ folder: candidate.folder, reason });
    }
    const fingerprint = [
      root,
      device,
      ...usable.map(({ folder }) => folder),
      ...refused.map(({ folder, reason }) => `${folder} ${reason}`),
    ].join("\0");
    return { setting, root, usable, refused, fingerprint };
  });

  const siteFor = Effect.fn("WorktreeCheckoutSites.siteFor")(function* (folder: RecordedFolder) {
    const known = sites.get(folder);
    if (known !== undefined) return known;
    const cache = yield* Effect.provide(
      makeWorktreeCheckoutCache({ cacheDir: folder, execute: input.execute }),
      context,
    );
    if (cache === undefined) return yield* Effect.die("the checkout cache needs a cloner");
    const schedule: CheckoutCache["schedule"] = (worktreePath, generationAtStart) =>
      Ref.get(state).pipe(
        Effect.flatMap((current) =>
          current._tag !== "Unusable" && kept(current).has(folder)
            ? cache.schedule(worktreePath, generationAtStart)
            : Effect.void,
        ),
      );
    const site: Site = { folder, cache, lease: { ...cache, schedule } };
    sites.set(folder, site);
    return site;
  });

  /**
   * The one retire rule: set `next`, then clear each recorded or instantiated folder it does not
   * keep that is a real folder at its own path and not a kept folder under another name (a bind
   * mount). A missing folder is cleared only to stop builds an instance may still run there.
   */
  const transition = Effect.fn("WorktreeCheckoutSites.transition")(function* (next: State) {
    yield* Ref.set(state, next);
    const keep = kept(next);
    const identity = (info: FileSystem.File.Info) =>
      `${info.dev}:${Option.getOrUndefined(info.ino)}`;
    const keptIds = new Set(
      (yield* Effect.forEach(keep, (folder) => Effect.option(fileSystem.stat(folder))))
        .flatMap(Option.toArray)
        .map(identity),
    );
    const { folders } = yield* ledger.entries(yield* homeFolder);
    for (const folder of new Set([...folders, ...sites.keys()])) {
      if (keep.has(folder)) continue;
      const real = yield* Effect.option(fileSystem.realPath(folder));
      const info =
        Option.isSome(real) && real.value === folder
          ? yield* Effect.option(fileSystem.stat(folder))
          : Option.none();
      const clearable = Option.isNone(real)
        ? sites.has(folder)
        : Option.exists(
            info,
            (value) => value.type === "Directory" && !keptIds.has(identity(value)),
          );
      if (clearable) yield* (yield* siteFor(folder)).cache.clear;
    }
  }, Effect.uninterruptible);

  // Only names this home's probes and upstream's trash make; anything else may be a user's folder.
  const leftoversOf = Effect.fn("WorktreeCheckoutSites.leftoversOf")(function* (folder: string) {
    const parent = path.dirname(folder);
    if (!(yield* isLinkFree(parent))) return [];
    const name = path.basename(folder);
    return (yield* list(parent))
      .filter(
        (entry) => entry.startsWith(`${name}.trash-`) || entry.startsWith(`${name}.probe-${key}-`),
      )
      .map((entry) => path.join(parent, entry));
  });

  // Another T3 home may be gone for good (moved, deleted), and only its own runs ever clear its cache.
  const ageOutOtherHomes = Effect.fn("WorktreeCheckoutSites.ageOutOtherHomes")(function* (
    root: string,
  ) {
    const reserved = path.join(root, CHECKOUT_CACHE_FOLDER);
    if (!(yield* isLinkFree(reserved))) return;
    const now = yield* Clock.currentTimeMillis;
    for (const name of yield* list(reserved)) {
      const owner = ownerOfCacheFolder(name);
      const folder = path.join(reserved, name);
      if (owner === undefined || owner === key || (yield* isLink(folder))) continue;
      const buckets = (yield* list(folder)).map((bucket) => path.join(folder, bucket));
      const unused = yield* Effect.forEach([folder, ...buckets], (target) =>
        fileSystem.stat(target).pipe(
          Effect.map(({ mtime }) =>
            Option.exists(mtime, (at) => now - at.getTime() > UNUSED_CACHE_MS),
          ),
          Effect.orElseSucceed(() => false),
        ),
      );
      if (!unused.every(Boolean)) continue;
      // Renamed first like upstream's discard, so a home still using it never reads a half-deleted entry.
      const trashed = name === owner ? `${folder}.trash-${NodeCrypto.randomUUID()}` : folder;
      if (
        trashed !== folder &&
        Exit.isFailure(yield* Effect.exit(fileSystem.rename(folder, trashed)))
      ) {
        continue;
      }
      yield* fileSystem.remove(trashed, { recursive: true }).pipe(Effect.ignore);
    }
  });

  // Clones a small tree with the same cloner `create` uses, from the cache folder's drive to the
  // location's, and checks what the cache's index restat needs: type, mode, size and mtime.
  const probe = Effect.fn("WorktreeCheckoutSites.probe")(function* (
    folder: RecordedFolder,
    root: string,
  ) {
    const id = NodeCrypto.randomUUID();
    // Keyed, so another state dir sharing the T3 home cache folder never sweeps a probe in progress.
    const source = `${folder}.probe-${key}-${id}`;
    const target = path.join(root, CHECKOUT_CACHE_FOLDER, `${key}.probe-${key}-${id}-clone`);
    const entries = ["", "tool", "folder", path.join("folder", "data"), "link"];
    const failed = (cause: unknown): ProbeResult => ({ _tag: "Failed", cause });
    const writeTree = Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(path.join(source, "folder"), { recursive: true });
        await NodeFSP.mkdir(path.dirname(target), { recursive: true });
        const bytes = () => NodeCrypto.randomBytes(PROBE_BYTES);
        await NodeFSP.writeFile(path.join(source, "tool"), bytes(), { mode: 0o755 });
        await NodeFSP.writeFile(path.join(source, "folder", "data"), bytes());
        await NodeFSP.symlink(path.join("folder", "data"), path.join(source, "link"));
      },
      catch: failed,
    });
    const sameStats = Effect.tryPromise({
      try: async () => {
        for (const entry of entries) {
          const [original, cloned] = await Promise.all([
            NodeFSP.lstat(path.join(source, entry), { bigint: true }),
            NodeFSP.lstat(path.join(target, entry), { bigint: true }),
          ]);
          if (
            original.mode !== cloned.mode ||
            original.mtimeNs !== cloned.mtimeNs ||
            (!original.isDirectory() && original.size !== cloned.size)
          ) {
            return `the clone's ${entry || "top folder"} differs in mode, size or mtime`;
          }
        }
        return undefined;
      },
      catch: failed,
    });
    const attempt = Effect.gen(function* () {
      // An interrupted promise keeps writing, so only the clone, a child process, stops early.
      yield* Effect.uninterruptible(writeTree);
      yield* clone(source, target).pipe(
        // The cloner never ran, such as `cp` failing to start.
        Effect.mapError((error): ProbeResult =>
          PlatformError.isPlatformError(error.cause)
            ? failed(error)
            : { _tag: "Refused", cause: error },
        ),
      );
      const differs = yield* sameStats;
      return differs === undefined ? { _tag: "Clones" as const } : failed(differs);
    });
    const cleanup = Effect.promise(() =>
      Promise.all(
        [source, target].map((top) =>
          NodeFSP.rm(top, { recursive: true, force: true }).catch(() => undefined),
        ),
      ),
    );
    return yield* attempt.pipe(
      Effect.catch((result) => Effect.succeed(result)),
      Effect.ensuring(cleanup),
    );
  });

  const resolve = Effect.fn("WorktreeCheckoutSites.resolve")(function* (
    setting: string,
  ): Effect.fn.Return<State> {
    const location = resolveWorktreesDirectory(setting, config.worktreesDir, path, home);
    // The probe creates the location anyway; resolving it after keeps its real path stable.
    if (mode === "probed" && location !== null) {
      yield* fileSystem
        .makeDirectory(location, { recursive: true })
        .pipe(Effect.ignore, Effect.uninterruptible);
    }
    const observed = yield* observe(setting);
    if (observed === undefined) return { _tag: "Off" };
    const { root, usable } = observed;
    for (const refused of observed.refused) {
      yield* Effect.logInfo("Not using this checkout cache folder", {
        ...refused,
        root,
      });
    }
    if (mode === "anyLocation") {
      const folder = usable[0] && (yield* ledger.record({ home: usable[0].folder }));
      return folder ? { _tag: "AnyLocation", site: yield* siteFor(folder) } : { _tag: "Off" };
    }
    // Every probe clones into the location's reserved folder, so it is recorded first.
    const inRoot = usable.length === 0 ? undefined : yield* ledger.record({ root });
    let winner: RecordedFolder | undefined;
    for (const candidate of inRoot === undefined ? [] : usable) {
      const folder =
        candidate.kind === "inRoot" ? inRoot : yield* ledger.record({ home: candidate.folder });
      if (folder === undefined) break;
      const result = yield* probe(folder, root);
      if (result._tag === "Clones") {
        winner = folder;
        break;
      }
      // A refusal is the drive's answer; a failure, such as `cp` failing to start, needs a look.
      yield* (result._tag === "Refused" ? Effect.logInfo : Effect.logWarning)(
        "Checkout cache folder did not clone copy-on-write to the worktree location",
        { folder, root, cause: result.cause },
      );
    }
    // Removes the reserved folder only while it is empty; a cache inside it is recreated on demand.
    yield* Effect.promise(() =>
      NodeFSP.rmdir(path.join(root, CHECKOUT_CACHE_FOLDER)).catch(() => undefined),
    );
    return winner === undefined
      ? { _tag: "Unusable", observed }
      : { _tag: "OnRoot", site: yield* siteFor(winner), observed };
  });

  /** The setting to probe again: pending, or the location, a drive or a link differs from before. */
  const staleSetting = Effect.fn("WorktreeCheckoutSites.staleSetting")(function* (
    current: State,
    requested: string,
  ) {
    if (current._tag === "Pending") return current.setting ?? requested;
    if (current._tag !== "OnRoot" && current._tag !== "Unusable") return undefined;
    const now = yield* observe(current.observed.setting);
    return now?.fingerprint === current.observed.fingerprint ? undefined : current.observed.setting;
  });

  // Resolves again only what is still stale once this fiber holds the lock.
  const settle = Effect.fn("WorktreeCheckoutSites.settle")(
    function* (requested: string) {
      const current = yield* Ref.get(state);
      const setting = yield* staleSetting(current, requested);
      if (setting === undefined) return current;
      const next = yield* resolve(setting);
      yield* transition(next);
      return next;
    },
    (effect) => lock.withPermits(1)(effect),
  );

  const apply = Effect.fn("WorktreeCheckoutSites.apply")(
    function* (retention: CheckoutCacheRetention) {
      const observed = retention.enabled ? yield* observe(retention.current) : undefined;
      const next: State =
        observed === undefined
          ? { _tag: "Off" }
          : {
              _tag: "Pending",
              setting: retention.current,
              keep: new Set(observed.usable.map(({ folder }) => folder)),
            };
      const homeCacheDir = yield* homeFolder;
      // Recorded while kept, so turning the setting off later deletes it, even upstream's macOS cache.
      if (kept(next).has(homeCacheDir)) yield* ledger.record({ home: homeCacheDir });
      if (mode === "anyLocation") return yield* transition(next);
      const { folders, roots } = yield* ledger.entries(homeCacheDir);
      // Listed before any probe starts, so the removal below never takes a later probe's folders.
      const leftovers = (yield* Effect.forEach(folders, leftoversOf)).flat();
      yield* transition(next);
      // Deleting a whole cache takes seconds, and the next `select` must not wait on it.
      const reserved = new Set(observed === undefined ? roots : [...roots, observed.root]);
      yield* Effect.forEach(
        leftovers,
        (leftover) => fileSystem.remove(leftover, { recursive: true }).pipe(Effect.ignore),
        { discard: true },
      ).pipe(
        Effect.andThen(Effect.forEach(reserved, ageOutOtherHomes, { discard: true })),
        Effect.forkIn(scope),
      );
    },
    (effect) => lock.withPermits(1)(effect),
  );

  /** The cache to clone from for a worktree in this location, if it is the one in use. */
  const select = Effect.fn("WorktreeCheckoutSites.select")(function* (
    worktreesDirectorySetting: string,
  ) {
    let current = yield* Ref.get(state);
    if ((yield* staleSetting(current, worktreesDirectorySetting)) !== undefined) {
      current = yield* settle(worktreesDirectorySetting);
    }
    if (current._tag === "AnyLocation") return current.site.lease;
    if (current._tag !== "OnRoot") return undefined;
    const root = yield* rootOf(worktreesDirectorySetting);
    return root === current.observed.root ? current.site.lease : undefined;
  });

  return { apply, select };
});
