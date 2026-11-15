// @effect-diagnostics nodeBuiltinImport:off - Fixtures drive git and cp directly and plant folders.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as CheckoutCloner from "../../vcs/CheckoutCloner.ts";
import { makeGitVcsDriverCore } from "../../vcs/GitVcsDriverCore.ts";
import { CHECKOUT_CACHE_FOLDER, homeKey } from "./checkoutCacheSites.ts";
import { makeWorktreeCheckoutSites } from "./worktreeCheckoutSites.ts";

type Sites = Effect.Success<ReturnType<typeof makeWorktreeCheckoutSites>>;

// Records which cache folder each instance, clear and schedule went to; clear and schedule only
// fork background work.
const calls = vi.hoisted(() => [] as Array<{ readonly op: string; readonly cacheDir: string }>);
vi.mock("../../vcs/worktreeCheckoutCache.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../vcs/worktreeCheckoutCache.ts")>();
  const { Effect: E } = await import("effect");
  const record = (op: string, cacheDir: string) => E.sync(() => void calls.push({ op, cacheDir }));
  const makeWorktreeCheckoutCache: typeof actual.makeWorktreeCheckoutCache = (input) =>
    actual.makeWorktreeCheckoutCache(input).pipe(
      E.tap(() => record("make", input.cacheDir)),
      E.map((cache) =>
        cache === undefined
          ? undefined
          : {
              ...cache,
              clear: record("clear", input.cacheDir).pipe(E.andThen(cache.clear)),
              schedule: (worktreePath: string, generation: number) =>
                record("schedule", input.cacheDir).pipe(
                  E.andThen(cache.schedule(worktreePath, generation)),
                ),
            },
      ),
    );
  return { ...actual, makeWorktreeCheckoutCache };
});

// The driver's own instance, so tests never put a second owner on the driver's cache folders.
const driverSites = vi.hoisted(() => [] as Array<Sites>);
vi.mock("./worktreeCheckoutSites.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./worktreeCheckoutSites.ts")>();
  const { Effect: E } = await import("effect");
  const makeWorktreeCheckoutSites: typeof actual.makeWorktreeCheckoutSites = (input) =>
    actual
      .makeWorktreeCheckoutSites(input)
      .pipe(E.tap((sites) => E.sync(() => void driverSites.push(sites))));
  return { ...actual, makeWorktreeCheckoutSites };
});

const layerTest = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-reflink-sites-test-",
}).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

// `cp -a` keeps mtimes like a reflink clone, on any drive.
const copyClone = (source: string, destination: string) =>
  Effect.try({
    try: () => void NodeChildProcess.execFileSync("cp", ["-a", source, destination]),
    catch: (cause) => new CheckoutCloner.CheckoutCloneError({ source, destination, cause }),
  });
const failingClone = (source: string, destination: string) =>
  Effect.fail(new CheckoutCloner.CheckoutCloneError({ source, destination }));

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
const sh = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }).trim();

const plant = (folder: string) => {
  NodeFS.mkdirSync(folder, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(folder, "marker"), "x");
  return NodePath.join(folder, "marker");
};
const isLink = (target: string) => NodeFS.lstatSync(target).isSymbolicLink();

const setup = (
  clone: (
    source: string,
    destination: string,
  ) => Effect.Effect<void, CheckoutCloner.CheckoutCloneError>,
  options: {
    readonly wrapFileSystem?: (fileSystem: FileSystem.FileSystem) => FileSystem.FileSystem;
    readonly beforeSpawn?: (
      args: ReadonlyArray<string>,
      cwd: string | undefined,
    ) => Effect.Effect<void>;
    readonly platform?: NodeJS.Platform;
  } = {},
) =>
  Effect.gen(function* () {
    calls.length = 0;
    clones = 0;
    const fileSystem = yield* FileSystem.FileSystem;
    const root = NodeFS.realpathSync(
      yield* fileSystem.makeTempDirectoryScoped({ prefix: "reflink-sites-" }),
    );
    const repo = NodePath.join(root, "repo");
    NodeFS.mkdirSync(NodePath.join(repo, "src"), { recursive: true });
    sh(repo, ["init", "-q", "-b", "main"]);
    sh(repo, ["config", "user.name", "Test"]);
    sh(repo, ["config", "user.email", "test@test.com"]);
    NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# test\n");
    NodeFS.writeFileSync(NodePath.join(repo, "src", "tool.sh"), "#!/bin/sh\n", { mode: 0o755 });
    sh(repo, ["add", "."]);
    sh(repo, ["commit", "-qm", "initial"]);

    const spawned: Array<ReadonlyArray<string>> = [];
    const delegate = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawner = ChildProcessSpawner.make((command) => {
      const standard = ChildProcess.isStandardCommand(command) ? command : undefined;
      const args = standard?.args.map(String) ?? [];
      spawned.push(args);
      return (options.beforeSpawn?.(args, standard?.options.cwd) ?? Effect.void).pipe(
        Effect.andThen(delegate.spawn(command)),
      );
    });
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(CheckoutCloner.CheckoutCloner, clone),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          FileSystem.FileSystem,
          options.wrapFileSystem?.(fileSystem) ?? fileSystem,
        ),
        Effect.provideService(HostProcess.Environment, gitEnv),
        Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
      );
    const config = yield* ServerConfig.ServerConfig;
    const driver = yield* provide(makeGitVcsDriverCore());
    const sitesOf = (sites: Sites) => ({
      apply: (current: string, enabled = true) => provide(sites.apply({ enabled, current })),
      select: (setting: string) => provide(sites.select(setting)),
    });
    const stateDir = NodeFS.realpathSync(config.stateDir);
    const key = homeKey(stateDir);
    const location = (name: string) => NodePath.join(root, name);
    const cacheDir = (directory: string) => NodePath.join(directory, CHECKOUT_CACHE_FOLDER, key);
    const create = (name: string, worktreesDirectory: string, fastCheckout = true) =>
      provide(
        driver.createWorktree(
          { cwd: repo, refName: "main", newRefName: name, path: null },
          { fastCheckout, worktreesDirectory },
        ),
      ).pipe(Effect.map(({ worktree }) => worktree.path));
    const checkedOutWithGit = (worktreePath: string) =>
      spawned.some(
        (args) =>
          args.includes("add") && args.includes(worktreePath) && !args.includes("--no-checkout"),
      );
    return {
      config,
      driver,
      sites: sitesOf(driverSites.at(-1)!),
      // Another instance on the same state dir, as after a restart; it closes with its scope.
      restart: provide(makeWorktreeCheckoutSites({ execute: driver.execute })).pipe(
        Effect.map(sitesOf),
      ),
      ledgerFile: NodePath.join(stateDir, "worktree-checkout-caches.json"),
      stateDir,
      key,
      location,
      cacheDir,
      create,
      checkedOutWithGit,
    };
  });

const ENTRY = /^[0-9a-f]{40}-[0-9a-f]{16}$/;
const cachedEntries = (cacheDir: string) =>
  NodeFS.readdirSync(cacheDir)
    .filter((bucket) => !bucket.includes(".trash-"))
    .flatMap((bucket) => NodeFS.readdirSync(NodePath.join(cacheDir, bucket)))
    .filter((entry) => ENTRY.test(entry));

let clones = 0;
const counted =
  (clone: typeof copyClone): typeof copyClone =>
  (source, destination) =>
    Effect.suspend(() => {
      clones++;
      return clone(source, destination);
    });

const callsOf = (op: string) => calls.filter((call) => call.op === op).map((call) => call.cacheDir);
const cleared = () => callsOf("clear");
const scheduled = () => callsOf("schedule");

// Completes once each matcher has seen a removal, as `apply` deletes leftovers in the background.
const watchRemovals = Effect.gen(function* () {
  const done = yield* Deferred.make<void>();
  let pending: ReadonlyArray<(target: string) => boolean> | undefined;
  return {
    done,
    expect: (matchers: ReadonlyArray<(target: string) => boolean>) => {
      pending = matchers;
    },
    wrapFileSystem: (fileSystem: FileSystem.FileSystem): FileSystem.FileSystem => ({
      ...fileSystem,
      remove: (target, options) =>
        fileSystem.remove(target, options).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (pending === undefined) return Effect.void;
              pending = pending.filter((matches) => !matches(target));
              return pending.length === 0 ? Deferred.succeed(done, undefined) : Effect.void;
            }),
          ),
        ),
    }),
  };
});

const linkCases = [
  { name: "the location's cache folder", platform: "linux", link: "inRoot" },
  // At the default location, so the T3 home's cache is refused with it.
  { name: "the location's reserved folder", platform: "linux", link: "reserved" },
  { name: "the T3 home's cache on macOS", platform: "darwin", link: "home" },
] as const;

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("worktree checkout sites", () => {
  it.effect("checks out with Git and leaves nothing behind where cloning fails", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(failingClone);
      const location = fixture.location("worktrees");
      // No settings applied: the driver probes the location it is asked for.
      const created = yield* fixture.create("first", location);
      assert.isTrue(fixture.checkedOutWithGit(created));
      assert.isTrue(fixture.checkedOutWithGit(yield* fixture.create("second", location)));
      assert.isUndefined(yield* fixture.sites.select(location));
      assert.isFalse(NodeFS.existsSync(NodePath.join(location, CHECKOUT_CACHE_FOLDER)));
      assert.isFalse(NodeFS.existsSync(fixture.config.worktreeCheckoutCacheDir));
      assert.deepEqual(scheduled(), []);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("caches checkouts on the location's own drive and clones the next worktree", () =>
    Effect.gen(function* () {
      const published = yield* Deferred.make<void>();
      const fixture = yield* setup(copyClone, {
        wrapFileSystem: (fileSystem) => ({
          ...fileSystem,
          rename: (from, to) =>
            fileSystem
              .rename(from, to)
              .pipe(
                Effect.andThen(
                  ENTRY.test(NodePath.basename(to))
                    ? Deferred.succeed(published, undefined)
                    : Effect.void,
                ),
              ),
        }),
      });
      const location = fixture.location("worktrees");
      yield* fixture.driver.applyWorktreeCheckoutSettings({ enabled: true, current: location });
      const first = yield* fixture.create("first", location);
      assert.isTrue(fixture.checkedOutWithGit(first));
      assert.deepEqual(scheduled(), [fixture.cacheDir(location)]);
      yield* Deferred.await(published);
      assert.lengthOf(cachedEntries(fixture.cacheDir(location)), 1);

      const second = yield* fixture.create("second", location);
      assert.isFalse(fixture.checkedOutWithGit(second));
      assert.equal(sh(second, ["status", "--porcelain"]), "");
      assert.isFalse(NodeFS.existsSync(fixture.config.worktreeCheckoutCacheDir));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("turning it off clears the cache and retires leases taken before", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(copyClone);
      const location = fixture.location("worktrees");
      yield* fixture.sites.apply(location);
      const lease = yield* fixture.sites.select(location);
      assert.isDefined(lease);

      // Settings that keep the cache leave its builds running before the next probe.
      yield* fixture.sites.apply(location);
      yield* lease.schedule(location, yield* lease.currentGeneration);
      assert.deepEqual(scheduled(), [fixture.cacheDir(location)]);

      yield* fixture.sites.apply(location, false);
      assert.isUndefined(yield* fixture.sites.select(location));
      assert.deepEqual(cleared(), [fixture.cacheDir(location)]);
      // A creation that read the generation after the clear must not refill the cache.
      yield* lease.schedule(location, yield* lease.currentGeneration);
      assert.deepEqual(scheduled(), [fixture.cacheDir(location)]);

      yield* fixture.sites.apply(location);
      assert.strictEqual(yield* fixture.sites.select(location), lease);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "a build made after a clear that still waits behind a build runs after that clear",
    () =>
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const discarded = yield* Deferred.make<void>();
        const published = yield* Deferred.make<void>();
        let gated = false;
        let cacheRoot = "";
        const trash = new Set<string>();
        const events: Array<string> = [];
        const fixture = yield* setup(copyClone, {
          beforeSpawn: (args, cwd) => {
            events.push(`spawn ${cwd}`);
            if (gated || !(args.includes("read-tree") && args.includes("--reset"))) {
              return Effect.void;
            }
            gated = true;
            return Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            );
          },
          wrapFileSystem: (fileSystem) => ({
            ...fileSystem,
            rename: (from, to) =>
              fileSystem.rename(from, to).pipe(
                Effect.andThen(() => {
                  if (from === cacheRoot) trash.add(to);
                  return ENTRY.test(NodePath.basename(to))
                    ? Deferred.succeed(published, undefined)
                    : Effect.void;
                }),
              ),
            remove: (target, options) =>
              fileSystem.remove(target, options).pipe(
                Effect.andThen(() => {
                  if (!trash.has(target)) return Effect.void;
                  events.push("discarded");
                  return Deferred.succeed(discarded, undefined);
                }),
              ),
          }),
        });
        const location = fixture.location("worktrees");
        cacheRoot = fixture.cacheDir(location);
        const apply = (enabled: boolean) =>
          fixture.driver.applyWorktreeCheckoutSettings({ enabled, current: location });
        yield* apply(true);
        yield* fixture.create("first", location);
        yield* Deferred.await(reached);
        // The clear waits for the first build; the second worktree's build is scheduled after it.
        yield* apply(false);
        yield* apply(true);
        const second = yield* fixture.create("second", location);
        const createdAt = events.length;
        yield* Deferred.succeed(release, undefined);
        yield* Deferred.await(discarded);
        assert.notInclude(events.slice(createdAt, events.indexOf("discarded")), `spawn ${second}`);
        yield* Deferred.await(published);
        assert.lengthOf(cachedEntries(cacheRoot), 1);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("moving the location clears the old cache, but an alias of it is the same place", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(copyClone);
      const first = fixture.location("first");
      const second = fixture.location("second");
      yield* fixture.sites.apply(first);
      assert.isDefined(yield* fixture.sites.select(first));
      yield* fixture.sites.apply(second);
      assert.deepEqual(cleared(), [fixture.cacheDir(first)]);
      assert.isUndefined(yield* fixture.sites.select(first));
      assert.isDefined(yield* fixture.sites.select(second));

      const alias = fixture.location("alias");
      NodeFS.symlinkSync(second, alias);
      yield* fixture.sites.apply(alias);
      assert.deepEqual([...new Set(cleared())], [fixture.cacheDir(first)]);
      assert.isDefined(yield* fixture.sites.select(alias));
      assert.isDefined(yield* fixture.sites.select(second));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([true, false])(
    "the default location prefers the T3 home's cache and clears the one that loses (home clones: %s)",
    (homeClones) =>
      Effect.gen(function* () {
        let legacy = "";
        const fixture = yield* setup((source, destination) =>
          !homeClones && source.startsWith(legacy)
            ? failingClone(source, destination)
            : copyClone(source, destination),
        );
        legacy = fixture.config.worktreeCheckoutCacheDir;
        const inRoot = fixture.cacheDir(fixture.config.worktreesDir);
        const [winner, loser] = homeClones ? [legacy, inRoot] : [inRoot, legacy];
        NodeFS.mkdirSync(loser, { recursive: true });

        yield* fixture.sites.apply("");
        const lease = yield* fixture.sites.select("");
        assert.isDefined(lease);
        yield* lease.schedule(fixture.config.worktreesDir, yield* lease.currentGeneration);
        assert.deepEqual(scheduled(), [winner]);
        assert.deepEqual(cleared(), [loser]);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("macOS keeps one cache in the T3 home for every location, without probing", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(counted(copyClone), { platform: "darwin" });
      const legacy = fixture.config.worktreeCheckoutCacheDir;
      const first = fixture.location("first");
      const second = fixture.location("second");
      // Off at boot keeps a cache this state dir never used, such as another state dir's.
      const foreign = plant(legacy);
      yield* fixture.sites.apply(first, false);
      assert.deepEqual(cleared(), []);
      assert.isTrue(NodeFS.existsSync(foreign));

      yield* fixture.sites.apply(first);
      const lease = yield* fixture.sites.select(first);
      assert.isDefined(lease);
      assert.strictEqual(yield* fixture.sites.select(second), lease);
      yield* lease.schedule(first, yield* lease.currentGeneration);
      assert.deepEqual(scheduled(), [legacy]);

      yield* fixture.sites.apply(second);
      assert.deepEqual(cleared(), []);
      assert.strictEqual(yield* fixture.sites.select(second), lease);

      // Kept once, so a later run that turns it off deletes it.
      const restarted = yield* fixture.restart;
      yield* restarted.apply(second, false);
      assert.deepEqual(cleared(), [legacy]);
      yield* fixture.sites.apply(second, false);
      assert.isUndefined(yield* fixture.sites.select(second));
      assert.strictEqual(clones, 0);
      assert.isFalse(NodeFS.existsSync(NodePath.join(first, CHECKOUT_CACHE_FOLDER)));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each(linkCases)(
    "a cache folder that is a link is never used, written or cleared: $name",
    ({ name, platform, link }) =>
      Effect.gen(function* () {
        const fixture = yield* setup(counted(copyClone), { platform });
        const setting = link === "reserved" ? "" : fixture.location("worktrees");
        const location = setting === "" ? fixture.config.worktreesDir : setting;
        const target = fixture.location("elsewhere");
        const marker = plant(target);
        const linked = {
          inRoot: fixture.cacheDir(location),
          reserved: NodePath.join(location, CHECKOUT_CACHE_FOLDER),
          home: fixture.config.worktreeCheckoutCacheDir,
        }[link];
        NodeFS.mkdirSync(NodePath.dirname(linked), { recursive: true });
        NodeFS.symlinkSync(target, linked);

        yield* fixture.sites.apply(setting);
        assert.isTrue(fixture.checkedOutWithGit(yield* fixture.create("first", setting)), name);
        yield* fixture.sites.apply(setting, false);
        assert.deepEqual(NodeFS.readdirSync(target), ["marker"], name);
        assert.isTrue(isLink(linked) && NodeFS.existsSync(marker), name);
        assert.strictEqual(clones, 0, name);
        assert.deepEqual([...scheduled(), ...cleared()], [], name);
        if (link !== "home") {
          assert.isFalse(NodeFS.existsSync(fixture.config.worktreeCheckoutCacheDir), name);
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("a T3 home cache whose link text names a folder through `..` is not used", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(copyClone);
      const legacy = fixture.config.worktreeCheckoutCacheDir;
      const inRoot = fixture.cacheDir(fixture.config.worktreesDir);
      // Lexically `<t>/missing-cache`, which exists; the kernel resolves `elsewhere/missing-cache`.
      NodeFS.mkdirSync(fixture.location("elsewhere/deep"), { recursive: true });
      NodeFS.symlinkSync(fixture.location("elsewhere/deep"), fixture.location("alias"));
      const marker = plant(fixture.location("missing-cache"));
      NodeFS.symlinkSync(`${fixture.location("alias")}/../missing-cache`, legacy);

      yield* fixture.sites.apply("");
      const lease = yield* fixture.sites.select("");
      assert.isDefined(lease);
      yield* lease.schedule(fixture.config.worktreesDir, yield* lease.currentGeneration);
      yield* fixture.sites.apply("", false);
      assert.deepEqual(callsOf("make"), [inRoot]);
      assert.deepEqual(scheduled(), [inRoot]);
      assert.deepEqual(cleared(), [inRoot]);
      assert.isTrue(isLink(legacy));
      assert.isTrue(NodeFS.existsSync(marker));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("sweeps only this home's leftovers next to the folders it recorded", () =>
    Effect.gen(function* () {
      const removals = yield* watchRemovals;
      const fixture = yield* setup(copyClone, { wrapFileSystem: removals.wrapFileSystem });
      const location = fixture.config.worktreesDir;
      const reserved = NodePath.join(location, CHECKOUT_CACHE_FOLDER);
      // Records both of the default location's cache folders.
      yield* fixture.sites.apply("");
      assert.isDefined(yield* fixture.sites.select(""));
      const own = [
        NodePath.join(reserved, `${fixture.key}.trash-1`),
        NodePath.join(reserved, `${fixture.key}.probe-${fixture.key}-2-clone`),
        `${fixture.config.worktreeCheckoutCacheDir}.probe-${fixture.key}-3`,
      ];
      const foreign = [
        NodePath.join(reserved, "0123456789abcdef.trash-1"),
        // Another state dir of this T3 home probes next to the same home cache folder.
        `${fixture.config.worktreeCheckoutCacheDir}.probe-0123456789abcdef-4`,
        NodePath.join(reserved, "notes"),
        NodePath.join(location, "repo", "branch"),
      ];
      [...own, ...foreign].forEach(plant);

      removals.expect(own.map((folder) => (target: string) => target === folder));
      yield* fixture.sites.apply("");
      yield* Deferred.await(removals.done);
      assert.deepEqual(
        own.filter((folder) => NodeFS.existsSync(folder)),
        [],
      );
      assert.deepEqual(
        foreign.filter((folder) => NodeFS.existsSync(folder)),
        foreign,
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "deletes other T3 homes' caches unused for 30 days, and nothing else (moved away: %s)",
    (movedAway) =>
      Effect.gen(function* () {
        // Also where this home cached before it moved away: the ledger still names that location.
        const removals = yield* watchRemovals;
        const fixture = yield* setup(copyClone, { wrapFileSystem: removals.wrapFileSystem });
        const location = fixture.location("worktrees");
        const reserved = NodePath.join(location, CHECKOUT_CACHE_FOLDER);
        if (movedAway) {
          yield* fixture.sites.apply(location);
          assert.isDefined(yield* fixture.sites.select(location));
        }
        // Seconds, as utimes takes them.
        const now = 1_900_000_000;
        yield* TestClock.setTime(now * 1000);
        const old = now - 31 * 24 * 60 * 60;
        const recent = now - 24 * 60 * 60;
        const plantAged = (name: string, home: number, bucket: number) => {
          const folder = NodePath.join(reserved, name);
          NodeFS.mkdirSync(NodePath.join(folder, "bucket"), { recursive: true });
          NodeFS.utimesSync(NodePath.join(folder, "bucket"), bucket, bucket);
          NodeFS.utimesSync(folder, home, home);
          return folder;
        };
        const abandoned = plantAged("aaaaaaaaaaaaaaaa", old, old);
        // A trash folder a crash left behind; renaming keeps the age of what it holds.
        const trash = plantAged("dddddddddddddddd.trash-1", old, old);
        const kept = [
          plantAged("bbbbbbbbbbbbbbbb", old, recent),
          plantAged("cccccccccccccccc", recent, old),
          plantAged("eeeeeeeeeeeeeeee.trash-1", recent, recent),
          plantAged("notes", old, old),
          ...(movedAway ? [] : [plantAged(fixture.key, old, old)]),
        ];
        const oldLink = NodePath.join(reserved, "ffffffffffffffff");
        NodeFS.symlinkSync(plantAged("old-target", old, old), oldLink);

        removals.expect([
          (target) => target.startsWith(`${abandoned}.trash-`),
          (target) => target === trash,
        ]);
        yield* fixture.sites.apply(movedAway ? fixture.location("moved") : location);
        yield* Deferred.await(removals.done);
        assert.deepEqual(
          NodeFS.readdirSync(reserved).filter((name) => /^[ad]{16}/.test(name)),
          [],
        );
        assert.deepEqual(
          kept.filter((folder) => NodeFS.existsSync(folder)),
          kept,
        );
        assert.isTrue(isLink(oldLink));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "probes again when the location's drive changes, and a failed probe keeps the cache",
    () =>
      Effect.gen(function* () {
        let moved = false;
        let failing = false;
        const fixture = yield* setup(
          counted((source, destination) =>
            failing ? failingClone(source, destination) : copyClone(source, destination),
          ),
          {
            wrapFileSystem: (fileSystem) => ({
              ...fileSystem,
              stat: (target) =>
                fileSystem
                  .stat(target)
                  .pipe(Effect.map((info) => (moved ? { ...info, dev: info.dev + 1n } : info))),
            }),
          },
        );
        const location = fixture.location("worktrees");
        yield* fixture.sites.apply(location);
        assert.isDefined(yield* fixture.sites.select(location));
        const built = NodePath.join(fixture.cacheDir(location), "bucket");
        NodeFS.mkdirSync(built, { recursive: true });

        // A remount keeps the path, and the probe on the new drive fails, maybe only for now.
        moved = true;
        failing = true;
        assert.isUndefined(yield* fixture.sites.select(location));
        const probes = clones;
        assert.isUndefined(yield* fixture.sites.select(location));
        assert.strictEqual(clones, probes);
        assert.deepEqual(cleared(), []);
        assert.isTrue(NodeFS.existsSync(built));

        moved = false;
        failing = false;
        assert.isDefined(yield* fixture.sites.select(location));
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("never uses a cache folder mounted from another drive than the location", () =>
    Effect.gen(function* () {
      let mounted = "";
      const fixture = yield* setup(counted(copyClone), {
        wrapFileSystem: (fileSystem) => ({
          ...fileSystem,
          stat: (target) =>
            fileSystem
              .stat(target)
              .pipe(
                Effect.map((info) =>
                  mounted !== "" && target.startsWith(mounted)
                    ? { ...info, dev: info.dev + 1n }
                    : info,
                ),
              ),
        }),
      });
      const location = fixture.location("worktrees");
      mounted = fixture.cacheDir(location);
      NodeFS.mkdirSync(mounted, { recursive: true });
      yield* fixture.sites.apply(location);
      assert.isUndefined(yield* fixture.sites.select(location));
      assert.strictEqual(clones, 0);
      assert.deepEqual(cleared(), []);

      mounted = "";
      assert.isDefined(yield* fixture.sites.select(location));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("probes again when the location's link leads somewhere else", () =>
    Effect.gen(function* () {
      const fixture = yield* setup((source, destination) =>
        destination.includes(`${NodePath.sep}second${NodePath.sep}`)
          ? failingClone(source, destination)
          : copyClone(source, destination),
      );
      const first = fixture.location("first");
      const second = fixture.location("second");
      NodeFS.mkdirSync(first);
      NodeFS.mkdirSync(second);
      const link = fixture.location("link");
      const retarget = (target: string) => {
        NodeFS.unlinkSync(link);
        NodeFS.symlinkSync(target, link);
      };
      NodeFS.symlinkSync(first, link);
      yield* fixture.sites.apply(link);
      assert.isDefined(yield* fixture.sites.select(link));

      retarget(second);
      assert.isUndefined(yield* fixture.sites.select(link));
      assert.isFalse(NodeFS.existsSync(NodePath.join(second, CHECKOUT_CACHE_FOLDER)));
      retarget(first);
      assert.isDefined(yield* fixture.sites.select(link));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("a location link led to another folder clears the cache it left behind", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(copyClone);
      const first = fixture.location("first");
      const second = fixture.location("second");
      NodeFS.mkdirSync(first);
      NodeFS.mkdirSync(second);
      const link = fixture.location("link");
      NodeFS.symlinkSync(first, link);
      yield* fixture.sites.apply(link);
      const left = yield* fixture.sites.select(link);
      assert.isDefined(left);

      NodeFS.unlinkSync(link);
      NodeFS.symlinkSync(second, link);
      const moved = yield* fixture.sites.select(link);
      assert.isDefined(moved);
      assert.notStrictEqual(moved, left);
      assert.deepEqual(cleared(), [fixture.cacheDir(first)]);
      yield* left.schedule(first, yield* left.currentGeneration);
      assert.deepEqual(scheduled(), []);

      yield* fixture.sites.apply(link, false);
      assert.deepEqual(
        [...new Set(cleared())].sort(),
        [fixture.cacheDir(first), fixture.cacheDir(second)].sort(),
      );
      assert.isUndefined(yield* fixture.sites.select(link));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([true, false])(
    "a later run clears the cache a location link led to before it moved (probe passes: %s)",
    (probePasses) =>
      Effect.gen(function* () {
        // Also when the probe there failed: the folder was recorded before the probe wrote in it.
        const fixture = yield* setup((source, destination) =>
          probePasses ? copyClone(source, destination) : failingClone(source, destination),
        );
        const first = fixture.location("first");
        const second = fixture.location("second");
        NodeFS.mkdirSync(first);
        NodeFS.mkdirSync(second);
        const link = fixture.location("link");
        NodeFS.symlinkSync(first, link);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const before = yield* fixture.restart;
            yield* before.apply(link);
            assert.strictEqual((yield* before.select(link)) !== undefined, probePasses);
          }),
        );
        plant(fixture.cacheDir(first));
        NodeFS.unlinkSync(link);
        NodeFS.symlinkSync(second, link);

        const after = yield* fixture.restart;
        yield* after.apply(link);
        assert.deepEqual(cleared(), [fixture.cacheDir(first)]);
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect(
    "a ledger names only this home's folders, a bad one names none, a stale temporary goes",
    () =>
      Effect.gen(function* () {
        const messages: Array<string> = [];
        const logger = Logger.layer(
          [Logger.make(({ message }) => void messages.push(String(message)))],
          { mergeWithExisting: false },
        );
        const fixture = yield* setup(copyClone);
        const location = fixture.location("worktrees");
        const own = plant(fixture.cacheDir(location));
        // A ledger copied from another home: its roots hold that home's key, not this one's.
        const foreignRoot = fixture.location("foreign");
        const foreignCache = plant(
          NodePath.join(foreignRoot, CHECKOUT_CACHE_FOLDER, "0123456789abcdef"),
        );
        const foreignHome = plant(fixture.location("other-home/caches/worktree-checkouts"));
        const staleTemporary = `${fixture.ledgerFile}.tmp-stale`;
        NodeFS.writeFileSync(staleTemporary, "{");
        for (const contents of [
          JSON.stringify({
            version: 1,
            home: true,
            inRoot: [foreignRoot],
            homeFolder: foreignHome,
          }),
          "{not json",
          JSON.stringify({ version: 2, home: true, inRoot: [location] }),
          JSON.stringify({
            version: 1,
            home: true,
            inRoot: ["relative", `${location}/../worktrees`],
          }),
        ]) {
          NodeFS.writeFileSync(fixture.ledgerFile, contents);
          const sites = yield* fixture.restart.pipe(Effect.provide(logger));
          yield* sites.apply(location, false);
        }
        assert.deepEqual(cleared(), []);
        assert.isTrue([own, foreignCache, foreignHome].every((file) => NodeFS.existsSync(file)));
        assert.isFalse(NodeFS.existsSync(staleTemporary));
        assert.lengthOf(
          messages.filter((message) => message.includes("unreadable checkout cache ledger")),
          2,
        );
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect.each([false, true])(
    "records a cache folder durably before writing there, and never writes one it could not (write fails: %s)",
    (failing) =>
      Effect.gen(function* () {
        const events: Array<string> = [];
        let stateDir = "";
        const fixture = yield* setup(
          (source, destination) =>
            Effect.sync(() => events.push("clone")).pipe(
              Effect.andThen(copyClone(source, destination)),
            ),
          {
            wrapFileSystem: (fileSystem) => ({
              ...fileSystem,
              open: (target, options) => {
                const ledger = NodePath.join(stateDir, "worktree-checkout-caches.json");
                const kind =
                  target === stateDir
                    ? "state dir"
                    : target.startsWith(`${ledger}.tmp-`)
                      ? "temporary"
                      : undefined;
                if (kind === undefined) return fileSystem.open(target, options);
                if (failing) {
                  return Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "open",
                      pathOrDescriptor: target,
                    }),
                  );
                }
                events.push(`open ${kind} ${options?.flag ?? "r"}`);
                return fileSystem.open(target, options).pipe(
                  Effect.map((file): FileSystem.File =>
                    Object.create(file, {
                      sync: {
                        get: () =>
                          Effect.sync(() => events.push(`sync ${kind}`)).pipe(
                            Effect.andThen(file.sync),
                          ),
                      },
                    }),
                  ),
                );
              },
              rename: (from, to) =>
                Effect.sync(() => {
                  if (NodePath.dirname(to) === stateDir) events.push("rename");
                }).pipe(Effect.andThen(fileSystem.rename(from, to))),
            }),
          },
        );
        stateDir = fixture.stateDir;
        const location = fixture.config.worktreesDir;
        const created = yield* fixture.create("first", location);
        if (failing) {
          assert.isTrue(fixture.checkedOutWithGit(created));
          assert.deepEqual(events, []);
          assert.isFalse(NodeFS.existsSync(NodePath.join(location, CHECKOUT_CACHE_FOLDER)));
          assert.isFalse(NodeFS.existsSync(fixture.config.worktreeCheckoutCacheDir));
          assert.isFalse(NodeFS.existsSync(fixture.ledgerFile));
        } else {
          const recorded = [
            "open temporary wx",
            "sync temporary",
            "rename",
            "open state dir r",
            "sync state dir",
          ];
          // The location's folder, then the T3 home's, each before the probe that writes there.
          assert.deepEqual(events.slice(0, 11), [...recorded, ...recorded, "clone"]);
        }
      }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("a slow deletion of leftovers never holds up the next select", () =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const removed = yield* Deferred.make<void>();
      let slow = "";
      const fixture = yield* setup(copyClone, {
        wrapFileSystem: (fileSystem) => ({
          ...fileSystem,
          remove: (target, options) =>
            target !== slow
              ? fileSystem.remove(target, options)
              : Deferred.succeed(reached, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(fileSystem.remove(target, options)),
                  Effect.andThen(Deferred.succeed(removed, undefined)),
                ),
        }),
      });
      const location = fixture.location("worktrees");
      yield* fixture.sites.apply(location);
      assert.isDefined(yield* fixture.sites.select(location));
      slow = NodePath.join(location, CHECKOUT_CACHE_FOLDER, `${fixture.key}.trash-1`);
      NodeFS.mkdirSync(slow, { recursive: true });

      yield* fixture.sites.apply(location);
      yield* Deferred.await(reached);
      assert.isDefined(yield* fixture.sites.select(location));
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(removed);
      assert.isFalse(NodeFS.existsSync(slow));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
