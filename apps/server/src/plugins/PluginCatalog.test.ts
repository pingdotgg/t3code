import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  PluginInstallationId,
  pluginInstallationStatus,
  type PluginId,
  type PluginInstallation,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginCatalog from "./PluginCatalog.ts";
import type { PluginRegistration } from "./PluginManifestLoader.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;

type Catalog = PluginCatalog.PluginCatalog["Service"];

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Starts a catalogue and its supervisor in `scope`, as one server start would. */
const startCatalog = Effect.fn("startCatalog")(function* (scope: Scope.Scope) {
  const supervisor = yield* PluginSupervisor.make({
    heapLimitMb: 64,
    activationTimeout: "10 seconds",
    stopGrace: "1 second",
  }).pipe(
    Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]),
    Effect.provideService(Scope.Scope, scope),
  );
  return yield* PluginCatalog.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
    Effect.provideService(Scope.Scope, scope),
  );
});

/**
 * Writes a plugin whose activation leaves a marker outside its own directory:
 * a plugin writing into its directory changes its own digest.
 */
const preparePlugin = Effect.fn("preparePlugin")(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-catalog-" });
  const directory = path.join(root, "plugin");
  yield* fs.makeDirectory(directory);
  const marker = path.join(root, "activated");
  const entry = path.join(directory, "main.mjs");
  yield* fs.writeFileString(
    entry,
    [
      `import * as NodeFS from "node:fs";`,
      `export function activate(context) {`,
      `  NodeFS.writeFileSync(${toJson(marker)}, String(process.pid));`,
      `  context.proposed.handle("ping", (input) => ({ pid: process.pid, input }));`,
      `}`,
      ``,
    ].join("\n"),
  );
  yield* fs.writeFileString(
    path.join(directory, "t3-plugin.json"),
    toJson({
      id,
      name: id,
      version: "1.0.0",
      apiVersion: 1,
      entry: "main.mjs",
      proposedApi: true,
    }),
  );
  const edit = (line: string) =>
    fs
      .readFileString(entry)
      .pipe(Effect.flatMap((content) => fs.writeFileString(entry, `${content}// ${line}\n`)));
  return { directory, marker, edit };
});

/** Waits, through the subscription, for a snapshot that satisfies `predicate`. */
const awaitSnapshot = (
  catalog: Catalog,
  predicate: (installations: ReadonlyArray<PluginInstallation>) => boolean,
) =>
  catalog.subscribe.pipe(
    Stream.filter((snapshot) => predicate(snapshot.installations)),
    Stream.runHead,
    Effect.map((snapshot) => Option.getOrThrow(snapshot).installations),
  );

/** A step a test can stop at: `reached` completes when it is entered, `release` lets it go on. */
interface Hold {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const makeHold = Effect.gen(function* () {
  const hold: Hold = {
    reached: yield* Deferred.make<void>(),
    release: yield* Deferred.make<void>(),
  };
  return hold;
});

const passHold = (hold: Hold | undefined) =>
  hold === undefined
    ? Effect.void
    : Deferred.succeed(hold.reached, undefined).pipe(Effect.andThen(Deferred.await(hold.release)));

/**
 * A supervisor without processes that behaves like the real one at its
 * boundary: registration by plugin id, revocation at the start of `disable`,
 * and `invoke` answering with the registered directory. Tests can hold
 * `enable` and `disable` open.
 */
const makeStubSupervisor = Effect.gen(function* () {
  const registrations = new Map<PluginId, PluginRegistration>();
  const invoked: Array<string> = [];
  const holds: { enable?: Hold; disable?: Hold } = {};
  const events = yield* PubSub.unbounded<PluginSupervisor.PluginSupervisorEvent>();
  const service = PluginSupervisor.PluginSupervisor.of({
    enable: (registration) =>
      Effect.suspend(() => {
        const pluginId = registration.manifest.id;
        if (registrations.has(pluginId))
          return Effect.fail(new PluginSupervisor.PluginAlreadyEnabledError({ pluginId }));
        registrations.set(pluginId, registration);
        return passHold(holds.enable);
      }),
    disable: (pluginId) =>
      Effect.suspend(() => {
        registrations.delete(pluginId);
        return passHold(holds.disable);
      }),
    resume: () => Effect.void,
    invoke: (pluginId) =>
      Effect.suspend(() => {
        const registration = registrations.get(pluginId);
        if (registration === undefined)
          return Effect.fail(new PluginSupervisor.PluginNotEnabledError({ pluginId }));
        invoked.push(registration.directory);
        return Effect.succeed(registration.directory);
      }),
    state: (pluginId) =>
      Effect.sync(() =>
        registrations.has(pluginId) ? Option.some({ _tag: "idle" as const }) : Option.none(),
      ),
    subscribe: PubSub.subscribe(events),
  });
  return { service, registrations, invoked, holds };
});

/** The real file system, except that the next read of a held directory waits for its hold. */
const makeHoldingFileSystem = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  let held: { readonly directory: string; readonly hold: Hold } | undefined;
  const fileSystem: FileSystem.FileSystem = {
    ...fs,
    realPath: (target) =>
      Effect.suspend(() => {
        if (held === undefined || !target.startsWith(held.directory)) return fs.realPath(target);
        const { hold } = held;
        held = undefined;
        return passHold(hold).pipe(Effect.andThen(fs.realPath(target)));
      }),
  };
  const holdDirectory = Effect.fn("holdDirectory")(function* (directory: string) {
    const hold = yield* makeHold;
    held = { directory, hold };
    return hold;
  });
  return { fileSystem, holdDirectory };
});

/** A catalogue over the stub supervisor, reading files through `fileSystem`. */
const startStubCatalog = Effect.fn("startStubCatalog")(function* (
  scope: Scope.Scope,
  supervisor: PluginSupervisor.PluginSupervisor["Service"],
  fileSystem?: FileSystem.FileSystem,
) {
  return yield* PluginCatalog.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
    Effect.provideService(FileSystem.FileSystem, fileSystem ?? (yield* FileSystem.FileSystem)),
    Effect.provideService(Scope.Scope, scope),
  );
});

const pidOf = (value: unknown) => (value as { readonly pid: number }).pid;

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Each test gets its own database; the restart test shares one between two starts.
const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistence.layerMemory));

it.layer(NodeServices.layer)("PluginCatalog", (it) => {
  describe("consent", () => {
    it.effect("runs nothing until the exact bytes are approved, then starts on first use", () =>
      withDatabase(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const sql = yield* SqlClient.SqlClient;
          const catalog = yield* startCatalog(yield* Scope.Scope);
          const plugin = yield* preparePlugin("test.lazy");

          const relative = yield* catalog.add({ directory: "plugins/lazy" }).pipe(Effect.flip);
          expect(relative.reason).toBe("invalid-directory");

          const { installation: added } = yield* catalog.add({ directory: plugin.directory });
          const installationId = added.installationId;
          expect(pluginInstallationStatus(added)).toBe("needs-consent");
          expect(added).toMatchObject({ enabled: false, consent: null, generation: 0 });
          expect(added.manifest?.id).toBe("test.lazy");
          expect(added.hostState).toBeUndefined();
          const again = yield* catalog.add({ directory: plugin.directory }).pipe(Effect.flip);
          expect(again.reason).toBe("already-added");

          const unapproved = yield* catalog.enable({ installationId }).pipe(Effect.flip);
          expect(unapproved.reason).toBe("consent-required");
          const wrongDigest = yield* catalog
            .consent({ installationId, digest: `sha256:${"0".repeat(64)}` })
            .pipe(Effect.flip);
          expect(wrongDigest.reason).toBe("source-changed");

          const digest = added.source!.digest;
          const { installation: approved } = yield* catalog.consent({ installationId, digest });
          expect(pluginInstallationStatus(approved)).toBe("disabled");
          expect(approved.consent).toMatchObject({ digest, capabilities: [] });

          const { installation: enabled } = yield* catalog.enable({ installationId });
          expect(pluginInstallationStatus(enabled)).toBe("enabled");
          expect(enabled).toMatchObject({ generation: 1, hostState: { _tag: "idle" } });
          expect(yield* fs.exists(plugin.marker)).toBe(false);

          const pid = pidOf(yield* catalog.invoke(installationId, "ping", null));
          expect(isProcessAlive(pid)).toBe(true);
          yield* awaitSnapshot(catalog, ([row]) => row?.hostState?._tag === "running");

          const { installation: disabled } = yield* catalog.disable({ installationId });
          expect(isProcessAlive(pid)).toBe(false);
          expect(pluginInstallationStatus(disabled)).toBe("disabled");
          expect(disabled.hostState).toBeUndefined();
          const stopped = yield* catalog.invoke(installationId, "ping", null).pipe(Effect.flip);
          expect(stopped._tag).toBe("PluginCatalogError");

          expect((yield* catalog.enable({ installationId })).installation.generation).toBe(2);
          expect(yield* catalog.remove({ installationId })).toEqual({ installationId });
          expect((yield* catalog.list).installations).toEqual([]);
          expect(yield* sql`SELECT installation_id FROM plugin_installations`).toEqual([]);
        }),
      ),
    );

    it.effect("stops a plugin and asks again when its bytes change", () =>
      withDatabase(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const catalog = yield* startCatalog(yield* Scope.Scope);
          const plugin = yield* preparePlugin("test.changed");
          const { installation } = yield* catalog.add({ directory: plugin.directory });
          const installationId = installation.installationId;
          const firstDigest = installation.source!.digest;
          yield* catalog.consent({ installationId, digest: firstDigest });
          yield* catalog.enable({ installationId });
          const pid = pidOf(yield* catalog.invoke(installationId, "ping", null));

          yield* plugin.edit("changed while running");
          const [refreshed] = (yield* catalog.refresh({ installationId })).installations;
          expect(pluginInstallationStatus(refreshed!)).toBe("needs-consent");
          expect(refreshed!.enabled).toBe(false);
          expect(isProcessAlive(pid)).toBe(false);
          const changed = yield* catalog.enable({ installationId }).pipe(Effect.flip);
          expect(changed.reason).toBe("consent-required");
          const stale = yield* catalog
            .consent({ installationId, digest: firstDigest })
            .pipe(Effect.flip);
          expect(stale.reason).toBe("source-changed");

          yield* catalog.consent({ installationId, digest: refreshed!.source!.digest });
          yield* catalog.enable({ installationId });
          // Changed again with no refresh: the check before a fresh process catches it.
          yield* plugin.edit("changed before first use");
          yield* fs.remove(plugin.marker);
          const beforeStart = yield* catalog.invoke(installationId, "ping", null).pipe(Effect.flip);
          expect(beforeStart).toMatchObject({ reason: "source-changed" });
          expect(yield* fs.exists(plugin.marker)).toBe(false);
          const [revoked] = (yield* catalog.list).installations;
          expect(pluginInstallationStatus(revoked!)).toBe("needs-consent");
        }),
      ),
    );

    it.effect("checks the bytes when enabling an installation that is already enabled", () =>
      withDatabase(
        Effect.gen(function* () {
          const catalog = yield* startCatalog(yield* Scope.Scope);
          const plugin = yield* preparePlugin("test.enable-again");
          const { installation } = yield* catalog.add({ directory: plugin.directory });
          const installationId = installation.installationId;
          const approve = (digest: string) =>
            catalog
              .consent({ installationId, digest })
              .pipe(Effect.andThen(catalog.enable({ installationId })));
          const { installation: enabled } = yield* approve(installation.source!.digest);

          // Unchanged: the same registration, not a new generation.
          const { installation: same } = yield* catalog.enable({ installationId });
          expect(same).toMatchObject({ enabled: true, generation: enabled.generation });

          // Changed while registered but idle.
          yield* plugin.edit("changed while idle");
          const idle = yield* catalog.enable({ installationId }).pipe(Effect.flip);
          expect(idle.reason).toBe("consent-required");
          const [afterIdle] = (yield* catalog.list).installations;
          expect(pluginInstallationStatus(afterIdle!)).toBe("needs-consent");
          expect(afterIdle!.enabled).toBe(false);

          // Changed while its process runs: enabling again stops it.
          yield* approve(afterIdle!.source!.digest);
          const pid = pidOf(yield* catalog.invoke(installationId, "ping", null));
          yield* plugin.edit("changed while running");
          const running = yield* catalog.enable({ installationId }).pipe(Effect.flip);
          expect(running.reason).toBe("consent-required");
          expect(isProcessAlive(pid)).toBe(false);
          const [afterRunning] = (yield* catalog.list).installations;
          expect(pluginInstallationStatus(afterRunning!)).toBe("needs-consent");
          expect(afterRunning!.hostState).toBeUndefined();
        }),
      ),
    );

    it.effect("runs one directory per plugin id at a time", () =>
      withDatabase(
        Effect.gen(function* () {
          const catalog = yield* startCatalog(yield* Scope.Scope);
          const approve = Effect.fn(function* (directory: string) {
            const { installation } = yield* catalog.add({ directory });
            const installationId = installation.installationId;
            yield* catalog.consent({ installationId, digest: installation.source!.digest });
            return installationId;
          });
          const first = yield* approve((yield* preparePlugin("test.same")).directory);
          const second = yield* approve((yield* preparePlugin("test.same")).directory);

          yield* catalog.enable({ installationId: first });
          const conflict = yield* catalog.enable({ installationId: second }).pipe(Effect.flip);
          expect(conflict.reason).toBe("plugin-id-conflict");
          yield* catalog.disable({ installationId: first });
          const { installation } = yield* catalog.enable({ installationId: second });
          expect(installation.enabled).toBe(true);
        }),
      ),
    );

    it.effect("keeps disable and remove available when the directory is gone", () =>
      withDatabase(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const catalog = yield* startCatalog(yield* Scope.Scope);
          const plugin = yield* preparePlugin("test.gone");
          const { installation } = yield* catalog.add({ directory: plugin.directory });
          const installationId = installation.installationId;
          yield* catalog.consent({ installationId, digest: installation.source!.digest });
          yield* catalog.enable({ installationId });

          yield* fs.remove(plugin.directory, { recursive: true });
          const [missing] = (yield* catalog.refresh({})).installations;
          expect(pluginInstallationStatus(missing!)).toBe("unavailable");
          expect(missing).toMatchObject({ enabled: false, source: null });
          expect(missing!.problem).toContain("does not exist");
          expect(missing!.manifest?.id).toBe("test.gone");
          expect((yield* catalog.enable({ installationId }).pipe(Effect.flip)).reason).toBe(
            "unavailable",
          );
          expect((yield* catalog.disable({ installationId })).installation.enabled).toBe(false);
          yield* catalog.remove({ installationId });
          const unknown = yield* catalog
            .disable({ installationId: PluginInstallationId.make("missing") })
            .pipe(Effect.flip);
          expect(unknown.reason).toBe("not-found");
        }),
      ),
    );
  });

  describe("calls racing management", () => {
    it.effect("fails a call whose installation is replaced while its bytes are checked", () =>
      withDatabase(
        Effect.gen(function* () {
          const stub = yield* makeStubSupervisor;
          const files = yield* makeHoldingFileSystem;
          const catalog = yield* startStubCatalog(
            yield* Scope.Scope,
            stub.service,
            files.fileSystem,
          );
          const approve = Effect.fn(function* (directory: string) {
            const { installation } = yield* catalog.add({ directory });
            yield* catalog.consent({
              installationId: installation.installationId,
              digest: installation.source!.digest,
            });
            return installation;
          });
          const first = yield* approve((yield* preparePlugin("test.same")).directory);
          const second = yield* approve((yield* preparePlugin("test.same")).directory);
          yield* catalog.enable({ installationId: first.installationId });

          // The call stops in its byte check, before a fresh process would start.
          const hold = yield* files.holdDirectory(first.directory);
          const call = yield* catalog
            .invoke(first.installationId, "ping", null)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(hold.reached);
          yield* catalog.disable({ installationId: first.installationId });
          yield* catalog.enable({ installationId: second.installationId });
          yield* Deferred.succeed(hold.release, undefined);

          const refused = yield* Fiber.join(call).pipe(Effect.flip);
          expect(refused).toMatchObject({ _tag: "PluginCatalogError", reason: "unavailable" });
          expect(stub.invoked).toEqual([]);
          expect(yield* catalog.invoke(second.installationId, "ping", null)).toBe(second.directory);
        }),
      ),
    );

    it.effect(
      "fails a call when its installation is enabled again or names an old generation",
      () =>
        withDatabase(
          Effect.gen(function* () {
            const stub = yield* makeStubSupervisor;
            const files = yield* makeHoldingFileSystem;
            const catalog = yield* startStubCatalog(
              yield* Scope.Scope,
              stub.service,
              files.fileSystem,
            );
            const plugin = yield* preparePlugin("test.generation");
            const { installation } = yield* catalog.add({ directory: plugin.directory });
            const installationId = installation.installationId;
            yield* catalog.consent({ installationId, digest: installation.source!.digest });
            const { installation: enabled } = yield* catalog.enable({ installationId });

            const hold = yield* files.holdDirectory(installation.directory);
            const call = yield* catalog
              .invoke(installationId, "ping", null)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(hold.reached);
            yield* catalog.disable({ installationId });
            const { installation: again } = yield* catalog.enable({ installationId });
            yield* Deferred.succeed(hold.release, undefined);
            expect(yield* Fiber.join(call).pipe(Effect.flip)).toMatchObject({
              reason: "unavailable",
            });
            expect(stub.invoked).toEqual([]);

            expect(again.generation).toBe(enabled.generation + 1);
            const stale = yield* catalog
              .invoke(installationId, "ping", null, { generation: enabled.generation })
              .pipe(Effect.flip);
            expect(stale).toMatchObject({ reason: "generation-changed" });
            expect(stub.invoked).toEqual([]);
            expect(
              yield* catalog.invoke(installationId, "ping", null, { generation: again.generation }),
            ).toBe(installation.directory);
          }),
        ),
    );
  });

  describe("subscription", () => {
    it.effect("sends a snapshot only when a step changed what it shows", () =>
      withDatabase(
        Effect.gen(function* () {
          const stub = yield* makeStubSupervisor;
          const catalog = yield* startStubCatalog(yield* Scope.Scope, stub.service);
          const plugin = yield* preparePlugin("test.quiet");
          const { installation } = yield* catalog.add({ directory: plugin.directory });
          const installationId = installation.installationId;
          const digest = installation.source!.digest;
          yield* catalog.consent({ installationId, digest });

          const snapshots = yield* Queue.unbounded<ReadonlyArray<PluginInstallation>>();
          yield* catalog.subscribe.pipe(
            Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot.installations)),
            Effect.forkScoped,
          );
          const [initial] = yield* Queue.take(snapshots);
          expect(initial).toMatchObject({ enabled: false });

          // Failures and steps that find nothing new.
          yield* catalog.add({ directory: "relative" }).pipe(Effect.flip);
          yield* catalog.add({ directory: plugin.directory }).pipe(Effect.flip);
          yield* catalog
            .consent({ installationId, digest: `sha256:${"0".repeat(64)}` })
            .pipe(Effect.flip);
          yield* catalog.resume({ installationId }).pipe(Effect.flip);
          yield* catalog.refresh({});
          yield* catalog.disable({ installationId });

          yield* catalog.enable({ installationId });
          const [enabled] = yield* Queue.take(snapshots);
          expect(enabled).toMatchObject({ enabled: true, inspectedAt: initial!.inspectedAt });

          yield* catalog.enable({ installationId });
          yield* catalog.resume({ installationId });
          yield* catalog.disable({ installationId });
          const [disabled] = yield* Queue.take(snapshots);
          expect(disabled).toMatchObject({ enabled: false });
        }),
      ),
    );
  });

  describe("interrupted management", () => {
    /** An approved, enabled installation in a catalogue that can be restarted on the same database. */
    const enabledInStub = Effect.fn("enabledInStub")(function* () {
      const stub = yield* makeStubSupervisor;
      const before = yield* Scope.make();
      const catalog = yield* startStubCatalog(before, stub.service);
      const plugin = yield* preparePlugin("test.interrupted");
      const { installation } = yield* catalog.add({ directory: plugin.directory });
      const installationId = installation.installationId;
      yield* catalog.consent({ installationId, digest: installation.source!.digest });
      yield* catalog.enable({ installationId });
      return { stub, before, catalog, installationId };
    });

    /** Starts the catalogue again and waits until its startup re-registration has run. */
    const restart = Effect.fn("restart")(function* () {
      const stub = yield* makeStubSupervisor;
      const catalog = yield* startStubCatalog(yield* Scope.Scope, stub.service);
      // Management steps queue behind startup, so this returns after it.
      const { installations } = yield* catalog.refresh({});
      return { stub, installations };
    });

    const storedRows = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly record_json: string }>`
        SELECT record_json FROM plugin_installations
      `;
      return rows.map((row) => JSON.parse(row.record_json) as { readonly enabled: boolean });
    });

    it.effect("keeps a disable whose caller left while the process stopped", () =>
      withDatabase(
        Effect.gen(function* () {
          const { stub, before, catalog, installationId } = yield* enabledInStub();
          const stopping = yield* makeHold;
          stub.holds.disable = stopping;
          const disabling = yield* catalog
            .disable({ installationId })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(stopping.reached);
          yield* Fiber.interrupt(disabling);

          const [row] = (yield* catalog.list).installations;
          expect(row).toMatchObject({ enabled: false });
          expect(row!.hostState).toBeUndefined();
          expect(yield* storedRows).toMatchObject([{ enabled: false }]);
          expect(stub.registrations.size).toBe(0);
          yield* Deferred.succeed(stopping.release, undefined);
          yield* Scope.close(before, Exit.void);

          const after = yield* restart();
          expect(after.installations).toMatchObject([{ installationId, enabled: false }]);
          expect(after.stub.registrations.size).toBe(0);
        }),
      ),
    );

    it.effect("makes a repeated disable wait for the interrupted stop", () =>
      withDatabase(
        Effect.gen(function* () {
          const { stub, catalog, installationId } = yield* enabledInStub();
          const stopping = yield* makeHold;
          stub.holds.disable = stopping;
          const disabling = yield* catalog
            .disable({ installationId })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(stopping.reached);
          yield* Fiber.interrupt(disabling);

          const retry = yield* catalog
            .disable({ installationId })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;
          expect(retry.pollUnsafe()).toBeUndefined();
          expect(stub.registrations.size).toBe(0);

          yield* Deferred.succeed(stopping.release, undefined);
          const { installation } = yield* Fiber.join(retry);
          expect(installation).toMatchObject({ enabled: false });
          expect(installation.hostState).toBeUndefined();
          expect(stub.registrations.size).toBe(0);
        }),
      ),
    );

    it.effect("keeps a remove whose caller left while the process stopped", () =>
      withDatabase(
        Effect.gen(function* () {
          const { stub, before, catalog, installationId } = yield* enabledInStub();
          const stopping = yield* makeHold;
          stub.holds.disable = stopping;
          const removing = yield* catalog
            .remove({ installationId })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(stopping.reached);
          yield* Fiber.interrupt(removing);

          expect((yield* catalog.list).installations).toEqual([]);
          expect(yield* storedRows).toEqual([]);
          expect(stub.registrations.size).toBe(0);
          yield* Deferred.succeed(stopping.release, undefined);
          yield* Scope.close(before, Exit.void);

          const after = yield* restart();
          expect(after.installations).toEqual([]);
          expect(after.stub.registrations.size).toBe(0);
        }),
      ),
    );

    it.effect("finishes an enable whose caller left during registration", () =>
      withDatabase(
        Effect.gen(function* () {
          const { stub, before, catalog, installationId } = yield* enabledInStub();
          yield* catalog.disable({ installationId });
          const registering = yield* makeHold;
          stub.holds.enable = registering;
          const enabling = yield* catalog
            .enable({ installationId })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(registering.reached);
          const interrupting = yield* Fiber.interrupt(enabling).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.succeed(registering.release, undefined);
          yield* Fiber.join(interrupting);

          // Registered, saved, and shown together: never one without the others.
          const [row] = (yield* catalog.list).installations;
          expect(row).toMatchObject({ enabled: true, generation: 2 });
          expect(yield* storedRows).toMatchObject([{ enabled: true }]);
          expect(stub.registrations.size).toBe(1);
          yield* Scope.close(before, Exit.void);
        }),
      ),
    );

    it.effect("holds a call made during startup until the plugin is registered again", () =>
      withDatabase(
        Effect.gen(function* () {
          const { before, installationId } = yield* enabledInStub();
          yield* Scope.close(before, Exit.void);

          const stub = yield* makeStubSupervisor;
          const registering = yield* makeHold;
          stub.holds.enable = registering;
          const after = yield* startStubCatalog(yield* Scope.Scope, stub.service);
          // Runs before the catalogue's finalizers, so a failing test can still close its scope.
          yield* Effect.addFinalizer(() => Deferred.succeed(registering.release, undefined));
          yield* Deferred.await(registering.reached);
          const calling = yield* after
            .invoke(installationId, "ping", null)
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;
          expect(calling.pollUnsafe()).toBeUndefined();

          yield* Deferred.succeed(registering.release, undefined);
          const [directory] = [...stub.registrations.values()].map((r) => r.directory);
          expect(yield* Fiber.join(calling)).toBe(directory);
          expect(stub.invoked).toEqual([directory]);
        }),
      ),
    );

    it.effect("keeps a remove made as the catalogue starts", () =>
      withDatabase(
        Effect.gen(function* () {
          const { before, installationId } = yield* enabledInStub();
          yield* Scope.close(before, Exit.void);

          const stub = yield* makeStubSupervisor;
          const after = yield* startStubCatalog(yield* Scope.Scope, stub.service);
          yield* after.remove({ installationId });
          // A call waits for startup to finish restoring.
          yield* after.invoke(installationId, "ping", null).pipe(Effect.flip);

          expect((yield* after.list).installations).toEqual([]);
          expect(yield* storedRows).toEqual([]);
          expect(stub.registrations.size).toBe(0);
        }),
      ),
    );

    it.effect("keeps an enable made as the catalogue starts", () =>
      withDatabase(
        Effect.gen(function* () {
          const { before, installationId } = yield* enabledInStub();
          yield* Scope.close(before, Exit.void);

          const stub = yield* makeStubSupervisor;
          const after = yield* startStubCatalog(yield* Scope.Scope, stub.service);
          yield* after.enable({ installationId });
          const [directory] = [...stub.registrations.values()].map((r) => r.directory);
          expect(yield* after.invoke(installationId, "ping", null)).toBe(directory);

          const [row] = (yield* after.list).installations;
          expect(row).toMatchObject({ enabled: true, generation: 2 });
          expect(stub.registrations.size).toBe(1);
        }),
      ),
    );
  });

  describe("server restart", () => {
    it.effect("re-enables approved plugins without starting them and drops changed ones", () =>
      withDatabase(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const kept = yield* preparePlugin("test.kept");
          const changed = yield* preparePlugin("test.restart-changed");

          const before = yield* Scope.make();
          const first = yield* startCatalog(before);
          const ids = yield* Effect.forEach([kept, changed], (plugin) =>
            Effect.gen(function* () {
              const { installation } = yield* first.add({ directory: plugin.directory });
              const installationId = installation.installationId;
              yield* first.consent({ installationId, digest: installation.source!.digest });
              yield* first.enable({ installationId });
              return installationId;
            }),
          );
          const pid = pidOf(yield* first.invoke(ids[0]!, "ping", null));
          yield* Scope.close(before, Exit.void);
          expect(isProcessAlive(pid)).toBe(false);

          yield* fs.remove(kept.marker);
          yield* changed.edit("changed while the server was down");
          const after = yield* startCatalog(yield* Scope.Scope);
          const restarted = yield* awaitSnapshot(after, (rows) =>
            rows.every((row) => row.hostState?._tag === "idle" || !row.enabled),
          );
          const keptRow = restarted.find((row) => row.installationId === ids[0]);
          const changedRow = restarted.find((row) => row.installationId === ids[1]);
          expect(keptRow).toMatchObject({ enabled: true, generation: 2 });
          expect(pluginInstallationStatus(changedRow!)).toBe("needs-consent");
          expect(changedRow!.enabled).toBe(false);
          expect(yield* fs.exists(kept.marker)).toBe(false);

          const restartedPid = pidOf(yield* after.invoke(ids[0]!, "ping", null));
          expect(restartedPid).not.toBe(pid);
          expect(yield* fs.exists(kept.marker)).toBe(true);
        }),
      ),
    );
  });
});
