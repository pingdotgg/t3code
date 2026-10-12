import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { PluginInstallationId, PluginSettingsValues } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import {
  SecretStorePersistError,
  SecretStoreRemoveError,
  ServerSecretStore,
} from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PluginCatalog from "./PluginCatalog.ts";
import { loadPluginDirectory } from "./PluginManifestLoader.ts";
import * as PluginSettings from "./PluginSettings.ts";
import * as PluginSupervisor from "./PluginSupervisor.ts";

const FIXTURE_DIR = `${import.meta.dirname}/testFixtures/settingsPlugin`;
// Children run the real CLI entry, which routes `__plugin-host` to the child runtime.
const BIN_PATH = `${import.meta.dirname}/../bin.ts`;
// Or a stand-in that speaks the IPC directly, as a plugin writing raw lines to fd 3 could.
const RAW_CHILD_PATH = `${import.meta.dirname}/testFixtures/rawHostCallChild.mjs`;
const SECRET = "s3cret-token-value";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parseManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * A secret store in memory, so a test can see exactly what was saved and deleted. `faults`
 * makes the next writes fail after saving (as an interrupted save would) or deletes fail, and
 * `beforeSet` and `beforeGet` hold writes and reads.
 */
const makeSecretStore = () => {
  const entries = new Map<string, Uint8Array>();
  const faults = { set: false, remove: false };
  const hooks: { beforeSet: Effect.Effect<void>; beforeGet: Effect.Effect<void> } = {
    beforeSet: Effect.void,
    beforeGet: Effect.void,
  };
  const service = ServerSecretStore.of({
    get: (name) =>
      Effect.suspend(() => hooks.beforeGet).pipe(
        Effect.andThen(Effect.sync(() => Option.fromUndefinedOr(entries.get(name)))),
      ),
    set: (name, value) =>
      Effect.suspend(() => hooks.beforeSet).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            entries.set(name, value);
            return faults.set
              ? Effect.fail(new SecretStorePersistError({ resource: name, cause: "fault" }))
              : Effect.void;
          }),
        ),
      ),
    create: (name, value) => Effect.sync(() => void entries.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = entries.get(name) ?? new Uint8Array(bytes);
        entries.set(name, value);
        return value;
      }),
    remove: (name) =>
      Effect.suspend(() =>
        faults.remove
          ? Effect.fail(new SecretStoreRemoveError({ resource: name, cause: "fault" }))
          : Effect.sync(() => void entries.delete(name)),
      ),
  });
  return { entries, faults, hooks, service };
};

/** Starts a supervisor, catalogue and settings in `scope`, as one server start would. */
const startPlugins = Effect.fn("startPlugins")(function* (
  scope: Scope.Scope,
  secretStore: ServerSecretStore["Service"],
  limits?: PluginSettings.PluginStorageLimits,
  /** Runs as each settings host call starts, so a test can see that one arrived. */
  onHostCall: (method: string) => Effect.Effect<void> = () => Effect.void,
) {
  const supervisor = yield* PluginSupervisor.make({
    heapLimitMb: 64,
    activationTimeout: "10 seconds",
    stopGrace: "1 second",
  }).pipe(
    Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]),
    Effect.provideService(Scope.Scope, scope),
  );
  const catalog = yield* PluginCatalog.make().pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
    Effect.provideService(Scope.Scope, scope),
  );
  const settings = yield* PluginSettings.make(limits).pipe(
    Effect.provideService(PluginSupervisor.PluginSupervisor, {
      ...supervisor,
      serveHostMethod: (method, handler) =>
        supervisor.serveHostMethod(method, (call) =>
          onHostCall(method).pipe(Effect.andThen(handler(call))),
        ),
    }),
    Effect.provideService(PluginCatalog.PluginCatalog, catalog),
    Effect.provideService(ServerSecretStore, secretStore),
    Effect.provideService(Scope.Scope, scope),
  );
  return { supervisor, catalog, settings };
});

/** Writes the fixture's manifest into `directory`, with `manifest` overriding its keys. */
const writeManifest = Effect.fn("writeManifest")(function* (
  directory: string,
  manifest: Record<string, unknown> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixture = parseManifest(yield* fs.readFileString(path.join(FIXTURE_DIR, "t3-plugin.json")));
  yield* fs.writeFileString(
    path.join(directory, "t3-plugin.json"),
    toJson({ ...fixture, ...manifest }),
  );
});

/** Copies the fixture into a scoped temp directory, optionally under a changed manifest. */
const preparePlugin = Effect.fn("preparePlugin")(function* (
  manifest: Record<string, unknown> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-settings-" });
  yield* fs.copyFile(path.join(FIXTURE_DIR, "main.mjs"), path.join(directory, "main.mjs"));
  yield* writeManifest(directory, manifest);
  return directory;
});

/** A plugin directory for the raw IPC child, which reads `config` from `raw-child.json`. */
const prepareRawPlugin = Effect.fn("prepareRawPlugin")(function* (
  id: string,
  config: Record<string, unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* preparePlugin({ id });
  yield* fs.writeFileString(path.join(directory, "raw-child.json"), toJson(config));
  return { directory, registration: yield* loadPluginDirectory(directory) };
});

/** A supervisor whose children run `childPath`. */
const makeSupervisor = (
  scope: Scope.Scope,
  childPath: string,
  options: Partial<PluginSupervisor.PluginSupervisorOptions> = {},
) =>
  PluginSupervisor.make({ heapLimitMb: 64, stopGrace: "1 second", ...options }).pipe(
    Effect.provideService(HostProcess.Arguments, [process.execPath, childPath]),
    Effect.provideService(Scope.Scope, scope),
  );

/** Starts waiting for the first log line of `pluginId` that satisfies `predicate`. */
const awaitLog = (
  supervisor: PluginSupervisor.PluginSupervisor["Service"],
  pluginId: string,
  predicate: (message: string) => boolean,
) =>
  supervisor.subscribe.pipe(
    Effect.flatMap((subscription) =>
      Stream.fromSubscription(subscription).pipe(
        Stream.filter((event) => event._tag === "Log" && event.pluginId === pluginId),
        Stream.map((event) => (event._tag === "Log" ? event.message : "")),
        Stream.filter(predicate),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.forkChild({ startImmediately: true }),
      ),
    ),
  );

/** Closes `scope` and starts the plugin services again on the same database, as a restart would. */
const restart = Effect.fn("restart")(function* (
  scope: Scope.Closeable,
  secretStore: ServerSecretStore["Service"],
) {
  yield* Scope.close(scope, Exit.void);
  const next = yield* Scope.make();
  return { scope: next, ...(yield* startPlugins(next, secretStore)) };
});

/** Adds, approves and enables the plugin in `directory`. */
const install = Effect.fn("install")(function* (
  catalog: PluginCatalog.PluginCatalog["Service"],
  directory: string,
) {
  const { installation } = yield* catalog.add({ directory });
  const installationId = installation.installationId;
  yield* catalog.consent({ installationId, digest: installation.source!.digest });
  yield* catalog.enable({ installationId });
  return installationId;
});

/** Waits, through the subscription, for values that satisfy `predicate`. */
const awaitValues = (
  settings: PluginSettings.PluginSettings["Service"],
  installationId: PluginInstallationId,
  predicate: (values: PluginSettingsValues) => boolean,
) =>
  settings
    .subscribe(installationId)
    .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow));

const parseRefusals = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const valueOf = (values: PluginSettingsValues, key: string) =>
  values.values.find((entry) => entry.key === key)?.value;

const countRows = Effect.fn("countRows")(function* (installationId: PluginInstallationId) {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM plugin_settings WHERE installation_id = ${installationId}
  `;
  const secrets = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM plugin_setting_secrets WHERE installation_id = ${installationId}
  `;
  const storage = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM plugin_storage WHERE installation_id = ${installationId}
  `;
  return { settings: settings[0]!.count, secrets: secrets[0]!.count, storage: storage[0]!.count };
});

// Each test gets its own database.
const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(SqlitePersistence.layerMemory));

it.layer(NodeServices.layer)("PluginSettings", (it) => {
  describe("values", () => {
    it.effect("saves what the plugin reads and never sends a secret back", () =>
      withDatabase(
        Effect.gen(function* () {
          const secrets = makeSecretStore();
          const { catalog, settings } = yield* startPlugins(yield* Scope.Scope, secrets.service);
          const installationId = yield* install(catalog, yield* preparePlugin());

          // The catalogue carries the declared fields for clients to render.
          const listed = (yield* catalog.list).installations[0]!;
          expect(listed.manifest?.settings?.map((field) => field.key)).toEqual([
            "apiUrl",
            "token",
            "verbose",
            "retries",
            "mode",
          ]);

          const initial = yield* awaitValues(settings, installationId, () => true);
          expect(initial).toEqual({ installationId, values: [], secrets: [] });
          // Unsaved fields read as their defaults; a secret without a value reads as unset.
          expect(yield* catalog.invoke(installationId, "activationMode", null)).toBe("safe");
          expect(yield* catalog.invoke(installationId, "read", { key: "retries" })).toEqual({
            value: 2,
          });
          expect(yield* catalog.invoke(installationId, "read", { key: "token" })).toEqual({
            unset: true,
          });

          const watching = yield* awaitValues(
            settings,
            installationId,
            (values) => values.secrets.length > 0,
          ).pipe(Effect.forkChild({ startImmediately: true }));
          const saved = yield* settings.update({
            installationId,
            changes: [
              { key: "apiUrl", value: "https://other.example.com" },
              { key: "token", value: SECRET },
              { key: "verbose", value: true },
              { key: "retries", value: 4 },
              { key: "mode", value: "fast" },
            ],
          });
          expect(saved.secrets).toEqual(["token"]);
          expect(valueOf(saved, "retries")).toBe(4);
          expect(valueOf(saved, "token")).toBeUndefined();
          expect(toJson(saved)).not.toContain(SECRET);
          // Every subscriber hears about the change, still without the secret.
          const heard = yield* Fiber.join(watching);
          expect(heard).toEqual(saved);

          for (const [key, value] of [
            ["apiUrl", "https://other.example.com"],
            ["token", SECRET],
            ["verbose", true],
            ["retries", 4],
            ["mode", "fast"],
          ] as const)
            expect(yield* catalog.invoke(installationId, "read", { key })).toEqual({ value });
          const undeclared = yield* catalog.invoke(installationId, "attempt", {
            method: "get",
            key: "missing",
          });
          expect(undeclared).toEqual({
            ok: false,
            message: '"missing" is not a declared setting.',
          });

          // Clearing returns a field to its default and deletes a secret.
          const cleared = yield* settings.update({
            installationId,
            changes: [
              { key: "token", value: null },
              { key: "retries", value: null },
              { key: "verbose", value: null },
            ],
          });
          expect(cleared.secrets).toEqual([]);
          expect(valueOf(cleared, "retries")).toBeUndefined();
          // A reset boolean keeps no override, so the plugin reads whatever its default is.
          expect(valueOf(cleared, "verbose")).toBeUndefined();
          expect(yield* catalog.invoke(installationId, "read", { key: "verbose" })).toEqual({
            value: false,
          });
          expect(secrets.entries.size).toBe(0);
          expect(yield* catalog.invoke(installationId, "read", { key: "token" })).toEqual({
            unset: true,
          });
          expect(yield* catalog.invoke(installationId, "read", { key: "retries" })).toEqual({
            value: 2,
          });
        }),
      ),
    );

    it.effect("checks every change before saving any, without repeating the value", () =>
      withDatabase(
        Effect.gen(function* () {
          const secrets = makeSecretStore();
          const { catalog, settings } = yield* startPlugins(yield* Scope.Scope, secrets.service);
          const installationId = yield* install(catalog, yield* preparePlugin());
          const reject = (changes: Parameters<typeof settings.update>[0]["changes"]) =>
            settings.update({ installationId, changes }).pipe(Effect.flip);

          for (const [changes, message] of [
            [[{ key: "nope", value: "x" }], 'This plugin has no setting "nope".'],
            [[{ key: "verbose", value: "yes" }], "Verbose logging must be on or off."],
            [[{ key: "retries", value: 9 }], "Retries must be at most 5."],
            [[{ key: "retries", value: 1.5 }], "Retries must be a whole number."],
            [[{ key: "mode", value: "turbo" }], "Mode must be one of its options."],
            [[{ key: "token", value: "" }], "API token must be non-empty text."],
            [
              [
                { key: "mode", value: "fast" },
                { key: "mode", value: "safe" },
              ],
              '"mode" is changed twice.',
            ],
            // A valid change next to an invalid one is not saved either.
            [
              [
                { key: "token", value: SECRET },
                { key: "retries", value: -1 },
              ],
              "Retries must be at least 0.",
            ],
          ] as const) {
            const error = yield* reject(changes);
            expect(error).toMatchObject({ reason: "invalid-setting", message });
          }
          const tooLong = yield* reject([{ key: "token", value: SECRET.repeat(1000) }]);
          expect(tooLong.message).not.toContain(SECRET);
          expect(yield* countRows(installationId)).toEqual({ settings: 0, secrets: 0, storage: 0 });
          expect(secrets.entries.size).toBe(0);

          const unknown = yield* settings
            .update({
              installationId: "missing" as PluginInstallationId,
              changes: [{ key: "mode", value: "fast" }],
            })
            .pipe(Effect.flip);
          expect(unknown.reason).toBe("not-found");
        }),
      ),
    );

    it.effect("refuses manifests whose settings it cannot honor", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog } = yield* startPlugins(yield* Scope.Scope, makeSecretStore().service);
          const field = { type: "text", key: "a", label: "A" };
          for (const [manifest, problem] of [
            [{ capabilities: [] }, 'declares settings without the "settings" capability'],
            [{ proposedApi: false }, 'needs "proposedApi": true'],
            [{ settings: [field, field] }, "settings: keys repeat."],
            [
              {
                settings: [
                  { ...field, type: "select", options: [{ value: "x", label: "X" }], default: "y" },
                ],
              },
              "a: the default is invalid.",
            ],
            [{ settings: [{ ...field, type: "number", min: 2, max: 1 }] }, "min is greater"],
          ] as const) {
            const error = yield* catalog
              .add({ directory: yield* preparePlugin(manifest) })
              .pipe(Effect.flip);
            expect(error.reason).toBe("invalid-directory");
            expect(error.message).toContain(problem);
          }
        }),
      ),
    );
  });

  describe("storage", () => {
    it.effect("keeps a bounded private store per installation", () =>
      withDatabase(
        Effect.gen(function* () {
          const { catalog } = yield* startPlugins(yield* Scope.Scope, makeSecretStore().service, {
            maxKeyLength: 8,
            maxValueBytes: 100,
            maxKeys: 2,
            maxTotalBytes: 150,
          });
          const first = yield* install(catalog, yield* preparePlugin());
          const second = yield* install(
            catalog,
            yield* preparePlugin({ id: "test.settings-other" }),
          );
          const attempt = (installationId: PluginInstallationId, key: string, value: unknown) =>
            catalog.invoke(installationId, "attempt", {
              method: "set",
              key,
              value: value as Schema.Json,
            });

          expect(yield* attempt(first, "a", { n: 1 })).toEqual({ ok: true, result: null });
          expect(yield* catalog.invoke(first, "load", { key: "a" })).toEqual({
            value: { n: 1 },
          });
          // Another installation sees nothing of it.
          expect(yield* catalog.invoke(second, "load", { key: "a" })).toEqual({ missing: true });

          expect(yield* attempt(first, "big", "x".repeat(200))).toMatchObject({
            ok: false,
            message: "The value is 202 bytes; the limit is 100.",
          });
          expect(yield* attempt(first, "much-too-long", 1)).toMatchObject({ ok: false });
          expect(yield* attempt(first, "bad\nkey", 1)).toMatchObject({ ok: false });
          expect(yield* attempt(first, "b", "y".repeat(60))).toEqual({ ok: true, result: null });
          expect(yield* attempt(first, "c", 1)).toEqual({
            ok: false,
            message: "The plugin already stores 2 keys.",
          });
          // Replacing a key counts its new size, not both.
          expect(yield* attempt(first, "a", "z".repeat(90))).toMatchObject({
            ok: false,
            message: "Saving this would store more than 150 bytes for the plugin.",
          });
          expect(yield* attempt(first, "a", "z".repeat(40))).toEqual({ ok: true, result: null });
          expect(yield* catalog.invoke(first, "keys", null)).toEqual(["a", "b"]);

          yield* catalog.invoke(first, "drop", { key: "a" });
          expect(yield* catalog.invoke(first, "load", { key: "a" })).toEqual({ missing: true });
          expect(yield* catalog.invoke(first, "keys", null)).toEqual(["b"]);
        }),
      ),
    );

    it.effect("lets a plugin wait for at most 16 host calls at a time", () =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const supervisor = yield* PluginSupervisor.make({ heapLimitMb: 64 }).pipe(
          Effect.provideService(HostProcess.Arguments, [process.execPath, BIN_PATH]),
          Effect.provideService(Scope.Scope, scope),
        );
        const release = yield* Deferred.make<void>();
        let inFlight = 0;
        yield* supervisor
          .serveHostMethod("storage.get", () =>
            Effect.sync(() => inFlight++).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ found: false, value: null }),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, scope));
        yield* supervisor
          .serveHostMethod("settings.get", () => Effect.succeed({ value: null }))
          .pipe(Effect.provideService(Scope.Scope, scope));
        const registration = yield* loadPluginDirectory(yield* preparePlugin());
        yield* supervisor.enable(registration);
        const refused = yield* supervisor.subscribe.pipe(
          Effect.map((subscription) =>
            Stream.fromSubscription(subscription).pipe(
              Stream.filter(
                (event) => event._tag === "Log" && event.message === "host-call-refused",
              ),
              Stream.runHead,
            ),
          ),
        );
        const waitingForRefusal = yield* refused.pipe(Effect.forkChild({ startImmediately: true }));

        const burst = yield* supervisor
          .invoke(registration.manifest.id, "burst", { count: 17 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Fiber.join(waitingForRefusal);
        yield* Deferred.succeed(release, undefined);
        const results = (yield* Fiber.join(burst)) as ReadonlyArray<string>;
        expect(results.filter((result) => result === "ok")).toHaveLength(16);
        expect(results.filter((result) => result !== "ok")).toEqual([
          "16 calls to the server are already in flight.",
        ]);
        expect(inFlight).toBe(16);
      }),
    );
  });

  describe("lifetime", () => {
    it.effect("keeps values across disable and re-enable, and deletes them on remove", () =>
      withDatabase(
        Effect.gen(function* () {
          const secrets = makeSecretStore();
          const { catalog, settings } = yield* startPlugins(yield* Scope.Scope, secrets.service);
          const installationId = yield* install(catalog, yield* preparePlugin());
          yield* settings.update({
            installationId,
            changes: [
              { key: "token", value: SECRET },
              { key: "mode", value: "fast" },
            ],
          });
          yield* catalog.invoke(installationId, "store", { key: "cursor", value: 42 });

          yield* catalog.disable({ installationId });
          // Disabled plugins keep their values and can still be configured.
          yield* settings.update({ installationId, changes: [{ key: "verbose", value: true }] });
          yield* catalog.enable({ installationId });
          expect(yield* catalog.invoke(installationId, "read", { key: "token" })).toEqual({
            value: SECRET,
          });
          expect(yield* catalog.invoke(installationId, "load", { key: "cursor" })).toEqual({
            value: 42,
          });
          expect(yield* countRows(installationId)).toEqual({ settings: 2, secrets: 1, storage: 1 });
          expect(secrets.entries.size).toBe(1);

          // The settings stream ends once the cleanup after the removal has run.
          const ended = yield* settings
            .subscribe(installationId)
            .pipe(Stream.runDrain, Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* catalog.remove({ installationId });
          expect((yield* Fiber.join(ended)).reason).toBe("not-found");
          expect(yield* countRows(installationId)).toEqual({ settings: 0, secrets: 0, storage: 0 });
          expect(secrets.entries.size).toBe(0);
          const late = yield* settings
            .update({ installationId, changes: [{ key: "mode", value: "safe" }] })
            .pipe(Effect.flip);
          expect(late.reason).toBe("not-found");
          expect(yield* countRows(installationId)).toEqual({ settings: 0, secrets: 0, storage: 0 });
        }),
      ),
    );

    it.effect("deletes what an earlier run left for removed installations at start", () =>
      withDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const secrets = makeSecretStore();
          const gone = "gone-installation" as PluginInstallationId;
          yield* sql`
            INSERT INTO plugin_settings (installation_id, key, value_json)
            VALUES (${gone}, 'mode', '"fast"')
          `;
          yield* sql`
            INSERT INTO plugin_setting_secrets (installation_id, key, saved)
            VALUES (${gone}, 'token', 1)
          `;
          yield* sql`
            INSERT INTO plugin_storage (installation_id, key, value_json, bytes)
            VALUES (${gone}, 'cursor', '1', 1)
          `;
          const secretName = `plugin-setting-${Buffer.from(gone).toString("base64url")}-${Buffer.from("token").toString("base64url")}`;
          secrets.entries.set(secretName, new TextEncoder().encode(SECRET));

          yield* startPlugins(yield* Scope.Scope, secrets.service);
          expect(yield* countRows(gone)).toEqual({ settings: 0, secrets: 0, storage: 0 });
          expect(secrets.entries.size).toBe(0);
        }),
      ),
    );

    it.effect("refuses settings and storage to a registration without the capability", () =>
      Effect.gen(function* () {
        const methods = new Map<string, PluginSupervisor.PluginHostMethod>();
        const supervisor = PluginSupervisor.PluginSupervisor.of({
          enable: () => Effect.void,
          disable: () => Effect.void,
          resume: () => Effect.void,
          invoke: () => Effect.succeed(null),
          state: () => Effect.succeedNone,
          subscribe: Effect.die("unused"),
          serveHostMethod: (method, handler) =>
            Effect.sync(() => void methods.set(method, handler)),
        });
        const catalog = PluginCatalog.PluginCatalog.of({
          list: Effect.succeed({ installations: [] }),
          revision: Effect.succeed(0),
          subscribe: Stream.empty,
          add: () => Effect.die("unused"),
          refresh: () => Effect.die("unused"),
          consent: () => Effect.die("unused"),
          enable: () => Effect.die("unused"),
          disable: () => Effect.die("unused"),
          remove: () => Effect.die("unused"),
          resume: () => Effect.die("unused"),
          replace: () => Effect.die("unused"),
          settleReplace: () => Effect.die("unused"),
          changeFiles: () => Effect.die("unused"),
          invoke: () => Effect.die("unused"),
        });
        yield* PluginSettings.make().pipe(
          Effect.provideService(PluginSupervisor.PluginSupervisor, supervisor),
          Effect.provideService(PluginCatalog.PluginCatalog, catalog),
          Effect.provideService(ServerSecretStore, makeSecretStore().service),
          Effect.provide(SqlitePersistence.layerMemory),
        );
        const registration = yield* loadPluginDirectory(
          yield* preparePlugin({ capabilities: [], settings: undefined }),
        );
        for (const method of ["settings.get", "storage.get", "storage.set", "storage.keys"]) {
          const error = yield* methods.get(method)!({
            registration: { ...registration, installationId: "x" as PluginInstallationId },
            input: { key: "a", value: 1 },
            admitted: Effect.void,
          }).pipe(Effect.flip);
          expect(error.message).toBe('The plugin did not declare the "settings" capability.');
        }
      }),
    );
  });

  describe("host calls", () => {
    /** Serves `storage.get` with a call held until `release`, recording how it ended. */
    const holdStorageGet = Effect.fn("holdStorageGet")(function* (
      supervisor: PluginSupervisor.PluginSupervisor["Service"],
    ) {
      const scope = yield* Scope.Scope;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const ended = yield* Deferred.make<Exit.Exit<unknown, unknown>>();
      const counts = { reads: 0, writes: 0 };
      yield* supervisor
        .serveHostMethod("settings.get", () =>
          Effect.sync(() => {
            counts.reads++;
            return { value: null };
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      yield* supervisor
        .serveHostMethod("storage.get", () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            // Stands for a side effect after an awaited host operation.
            Effect.andThen(Effect.sync(() => counts.writes++)),
            Effect.as({ found: false, value: null }),
            Effect.onExit((exit) => Deferred.succeed(ended, exit)),
          ),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      return { started, release, ended, counts };
    });

    it.effect("ends a disabled generation's host work and refuses its later calls", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor(yield* Scope.Scope, BIN_PATH);
        const held = yield* holdStorageGet(supervisor);
        const registration = yield* loadPluginDirectory(yield* preparePlugin());
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);
        const load = yield* supervisor
          .invoke(pluginId, "load", { key: "a" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(held.started);
        const deactivated = yield* awaitLog(supervisor, pluginId, (message) =>
          message.startsWith("deactivate:"),
        );
        const readsBefore = held.counts.reads;

        yield* supervisor.disable(pluginId);
        // The held call ended with its generation, before disable returned.
        expect(yield* Deferred.isDone(held.ended)).toBe(true);
        expect(Exit.hasInterrupts(yield* Deferred.await(held.ended))).toBe(true);
        expect((yield* Fiber.join(load))._tag).toBe("PluginStoppedError");
        // deactivate() asked for a setting after the revocation: refused, never served.
        expect(yield* Fiber.join(deactivated)).toBe("deactivate: The plugin was stopped.");
        expect(held.counts.reads).toBe(readsBefore);
        yield* Deferred.succeed(held.release, undefined);
        expect(held.counts.writes).toBe(0);
      }),
    );

    it.effect("ends host work of a process that exits", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor(yield* Scope.Scope, BIN_PATH);
        const held = yield* holdStorageGet(supervisor);
        const registration = yield* loadPluginDirectory(yield* preparePlugin());
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);
        const load = yield* supervisor
          .invoke(pluginId, "load", { key: "a" })
          .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(held.started);

        const crashed = yield* supervisor.invoke(pluginId, "exit", null).pipe(Effect.flip);
        expect(crashed._tag).toBe("PluginCrashedError");
        expect(Exit.hasInterrupts(yield* Deferred.await(held.ended))).toBe(true);
        expect((yield* Fiber.join(load))._tag).toBe("PluginCrashedError");
        yield* Deferred.succeed(held.release, undefined);
        expect(held.counts.writes).toBe(0);
      }),
    );

    it.effect("waits for host work still ending when disabling a process that exited", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor(yield* Scope.Scope, BIN_PATH);
        const started = yield* Deferred.make<void>();
        const ending = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const order: Array<string> = [];
        yield* supervisor.serveHostMethod("settings.get", () => Effect.succeed({ value: null }));
        yield* supervisor.serveHostMethod("storage.get", () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            // Stands for cleanup that outlasts the process, such as releasing a lock.
            Effect.onInterrupt(() =>
              Deferred.succeed(ending, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.sync(() => order.push("host work ended"))),
              ),
            ),
          ),
        );
        const registration = yield* loadPluginDirectory(yield* preparePlugin());
        const pluginId = registration.manifest.id;
        yield* supervisor.enable(registration);
        yield* supervisor
          .invoke(pluginId, "load", { key: "a" })
          .pipe(Effect.ignore, Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        yield* supervisor
          .invoke(pluginId, "exit", null)
          .pipe(Effect.ignore, Effect.forkChild({ startImmediately: true }));
        // The process has exited and its host work is ending.
        yield* Deferred.await(ending);

        const disabling = yield* supervisor
          .disable(pluginId)
          .pipe(
            Effect.andThen(Effect.sync(() => order.push("disabled"))),
            Effect.forkChild({ startImmediately: true }),
          );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(disabling);
        expect(order).toEqual(["host work ended", "disabled"]);
      }),
    );

    it.effect("drops a write that waited for the settings lock past its generation", () =>
      withDatabase(
        Effect.gen(function* () {
          const secrets = makeSecretStore();
          const storeArrived = yield* Deferred.make<void>();
          const readArrived = yield* Deferred.make<void>();
          const { catalog, settings } = yield* startPlugins(
            yield* Scope.Scope,
            secrets.service,
            undefined,
            (method) =>
              method === "storage.set"
                ? Deferred.succeed(storeArrived, undefined)
                : Deferred.isDone(storeArrived).pipe(
                    Effect.flatMap((stored) =>
                      stored ? Deferred.succeed(readArrived, undefined) : Effect.void,
                    ),
                  ),
          );
          const installationId = yield* install(catalog, yield* preparePlugin());
          expect(yield* catalog.invoke(installationId, "read", { key: "mode" })).toEqual({
            value: "safe",
          });

          // A client save holds the settings lock while its secret is written.
          const writing = yield* Deferred.make<void>();
          const finishWrite = yield* Deferred.make<void>();
          secrets.hooks.beforeSet = Deferred.succeed(writing, undefined).pipe(
            Effect.andThen(Deferred.await(finishWrite)),
          );
          const saving = yield* settings
            .update({ installationId, changes: [{ key: "token", value: SECRET }] })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(writing);
          const storing = yield* catalog
            .invoke(installationId, "store", { key: "cursor", value: 1 })
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(storeArrived);
          // So does its read of the secret being saved.
          const reading = yield* catalog
            .invoke(installationId, "read", { key: "token" })
            .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(readArrived);

          // The plugin's write waits for the lock while the plugin is disabled and enabled again.
          yield* catalog.disable({ installationId });
          // Disabling ended the waiting read instead of waiting for the lock itself.
          expect((yield* Fiber.join(reading))._tag).toBe("PluginStoppedError");
          yield* catalog.enable({ installationId });
          yield* Deferred.succeed(finishWrite, undefined);
          expect((yield* Fiber.join(saving)).secrets).toEqual(["token"]);
          yield* Fiber.join(storing);
          expect((yield* countRows(installationId)).storage).toBe(0);

          // The new generation saves as usual.
          yield* catalog.invoke(installationId, "store", { key: "cursor", value: 2 });
          expect(yield* catalog.invoke(installationId, "load", { key: "cursor" })).toEqual({
            value: 2,
          });
        }),
      ),
    );

    // Below the channel's 64 KiB buffer a full bound can come without a write that waits for drain.
    it.effect.each([
      { maxMessageBytes: 128 * 1024, answerBytes: 60_000 },
      { maxMessageBytes: 32 * 1024, answerBytes: 20_000 },
    ])(
      "stops reading a plugin that does not read its answers, and loses none ($maxMessageBytes bytes)",
      ({ maxMessageBytes, answerBytes }) => {
        const backedUp = Deferred.makeUnsafe<void>();
        const logger = Logger.make(({ message }) => {
          if (String(message).includes("not reading the server's answers"))
            Deferred.doneUnsafe(backedUp, Exit.void);
        });
        return Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const supervisor = yield* makeSupervisor(yield* Scope.Scope, RAW_CHILD_PATH, {
            maxMessageBytes,
          });
          let served = 0;
          yield* supervisor
            .serveHostMethod("flood.get", () =>
              Effect.sync(() => {
                served++;
                return { data: "x".repeat(answerBytes) };
              }),
            )
            .pipe(Effect.provideService(Scope.Scope, yield* Scope.Scope));
          const requests = 400;
          const flood = yield* prepareRawPlugin("test.flood", {
            mode: "flood",
            requests,
            method: "flood.get",
          });
          const echo = yield* prepareRawPlugin("test.echo", { mode: "echo" });
          yield* supervisor.enable(flood.registration);
          yield* supervisor.enable(echo.registration);
          const summary = yield* awaitLog(supervisor, "test.flood", (message) =>
            message.startsWith("answered"),
          );
          const first = yield* supervisor
            .invoke(flood.registration.manifest.id, "ping", 1)
            .pipe(Effect.forkChild({ startImmediately: true }));

          yield* Deferred.await(backedUp);
          // Other plugins keep working while this one is not read.
          expect(yield* supervisor.invoke(echo.registration.manifest.id, "ping", 2)).toBe(2);
          // Without backpressure all 400 answers would sit in the server's write buffer.
          expect(served).toBeGreaterThan(0);
          expect(served).toBeLessThan(40);

          // Once the plugin reads again, every request gets exactly one answer.
          const pid = Number(yield* fs.readFileString(path.join(flood.directory, "raw-child.pid")));
          process.kill(pid, "SIGUSR2");
          const answered = yield* Fiber.join(summary);
          const [, total, refused, messages] = /^answered (\d+), refused (\d+): (.*)$/.exec(
            answered,
          )!;
          expect(Number(total)).toBe(requests);
          expect(served + Number(refused)).toBe(requests);
          // A refusal can only be the cap, while answers wait for the plugin to read.
          for (const message of parseRefusals(messages!))
            expect(message).toBe("16 calls to the server are already in flight.");
          expect(yield* Fiber.join(first)).toBe(1);
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      },
    );

    it.effect("refuses past 16 host calls from a plugin that bypasses the API", () =>
      Effect.gen(function* () {
        const supervisor = yield* makeSupervisor(yield* Scope.Scope, RAW_CHILD_PATH);
        const release = yield* Deferred.make<void>();
        let inFlight = 0;
        yield* supervisor
          .serveHostMethod("burst.get", () =>
            Effect.sync(() => inFlight++).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(null),
            ),
          )
          .pipe(Effect.provideService(Scope.Scope, yield* Scope.Scope));
        const burst = yield* prepareRawPlugin("test.burst", {
          mode: "burst",
          requests: 17,
          method: "burst.get",
        });
        const pluginId = burst.registration.manifest.id;
        yield* supervisor.enable(burst.registration);
        const refused = yield* awaitLog(supervisor, pluginId, (message) =>
          message.startsWith("refused"),
        );
        const summary = yield* awaitLog(supervisor, pluginId, (message) =>
          message.startsWith("answered"),
        );
        expect(yield* supervisor.invoke(pluginId, "ping", 1)).toBe(1);
        expect(yield* Fiber.join(refused)).toBe(
          "refused: 16 calls to the server are already in flight.",
        );
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(summary)).toBe(
          'answered 17, refused 1: ["16 calls to the server are already in flight."]',
        );
        expect(inFlight).toBe(16);
      }),
    );
  });

  describe("secrets", () => {
    it.effect("keeps a secret's row until its file is deleted, so cleanup always finishes", () =>
      withDatabase(
        Effect.gen(function* () {
          const secrets = makeSecretStore();
          let run = yield* restart(yield* Scope.make(), secrets.service);
          const installationId = yield* install(run.catalog, yield* preparePlugin());
          const saveToken = run.settings.update({
            installationId,
            changes: [{ key: "token", value: SECRET }],
          });
          yield* saveToken;

          // A clear whose file deletion fails reads as cleared, and keeps the row that finds it.
          secrets.faults.remove = true;
          const clearing = yield* run.settings
            .update({ installationId, changes: [{ key: "token", value: null }] })
            .pipe(Effect.flip);
          expect(clearing.reason).toBe("storage");
          expect((yield* awaitValues(run.settings, installationId, () => true)).secrets).toEqual(
            [],
          );
          expect(yield* run.catalog.invoke(installationId, "read", { key: "token" })).toEqual({
            unset: true,
          });
          expect(secrets.entries.size).toBe(1);
          secrets.faults.remove = false;
          run = yield* restart(run.scope, secrets.service);
          expect(secrets.entries.size).toBe(0);
          expect(yield* countRows(installationId)).toEqual({
            settings: 0,
            secrets: 0,
            storage: 0,
          });

          // A save interrupted after its file was written is found the same way.
          secrets.faults.set = true;
          const saving = yield* run.settings
            .update({ installationId, changes: [{ key: "token", value: SECRET }] })
            .pipe(Effect.flip);
          expect(saving.reason).toBe("storage");
          expect(secrets.entries.size).toBe(1);
          expect((yield* awaitValues(run.settings, installationId, () => true)).secrets).toEqual(
            [],
          );
          secrets.faults.set = false;
          run = yield* restart(run.scope, secrets.service);
          expect(secrets.entries.size).toBe(0);
          expect((yield* countRows(installationId)).secrets).toBe(0);

          // A removal whose file deletion fails finishes at the next start.
          yield* run.settings.update({
            installationId,
            changes: [{ key: "token", value: SECRET }],
          });
          secrets.faults.remove = true;
          const ended = yield* run.settings
            .subscribe(installationId)
            .pipe(Stream.runDrain, Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* run.catalog.remove({ installationId });
          expect((yield* Fiber.join(ended)).reason).toBe("not-found");
          expect(secrets.entries.size).toBe(1);
          expect((yield* countRows(installationId)).secrets).toBe(1);
          secrets.faults.remove = false;
          run = yield* restart(run.scope, secrets.service);
          expect(secrets.entries.size).toBe(0);
          expect(yield* countRows(installationId)).toEqual({
            settings: 0,
            secrets: 0,
            storage: 0,
          });
          yield* Scope.close(run.scope, Exit.void);
        }),
      ),
    );

    it.effect("never lets a plugin read a secret whose save did not finish", () =>
      withDatabase(
        Effect.gen(function* () {
          const secrets = makeSecretStore();
          const { catalog, settings } = yield* startPlugins(yield* Scope.Scope, secrets.service);
          const installationId = yield* install(catalog, yield* preparePlugin());
          yield* settings.update({
            installationId,
            changes: [{ key: "token", value: "old-valid" }],
          });

          // The plugin's read has found the saved secret and is about to read its file.
          const reading = yield* Deferred.make<void>();
          const finishRead = yield* Deferred.make<void>();
          secrets.hooks.beforeGet = Deferred.succeed(reading, undefined).pipe(
            Effect.andThen(Deferred.await(finishRead)),
          );
          const read = yield* catalog
            .invoke(installationId, "read", { key: "token" })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(reading);

          // Meanwhile a client clears it, then a new save fails after writing its file.
          const changing = yield* Effect.gen(function* () {
            yield* settings.update({ installationId, changes: [{ key: "token", value: null }] });
            secrets.faults.set = true;
            return yield* settings
              .update({ installationId, changes: [{ key: "token", value: "new-failed" }] })
              .pipe(Effect.flip);
          }).pipe(Effect.forkChild({ startImmediately: true }));

          secrets.hooks.beforeGet = Effect.void;
          yield* Deferred.succeed(finishRead, undefined);
          // The read sees the secret saved when it started, never the unfinished one.
          expect(yield* Fiber.join(read)).toEqual({ value: "old-valid" });
          expect((yield* Fiber.join(changing)).reason).toBe("storage");
          expect(yield* catalog.invoke(installationId, "read", { key: "token" })).toEqual({
            unset: true,
          });
        }),
      ),
    );

    it.effect("keeps only the fields the manifest declares now", () =>
      withDatabase(
        Effect.gen(function* () {
          const secrets = makeSecretStore();
          const { catalog, settings } = yield* startPlugins(yield* Scope.Scope, secrets.service);
          const directory = yield* preparePlugin();
          const installationId = yield* install(catalog, directory);
          const redeclare = (fields: ReadonlyArray<Record<string, unknown>>) =>
            writeManifest(directory, { settings: fields }).pipe(
              Effect.andThen(catalog.refresh({ installationId })),
            );
          yield* settings.update({
            installationId,
            changes: [
              { key: "token", value: SECRET },
              { key: "mode", value: "fast" },
            ],
          });

          // A secret field that becomes text loses its secret before the text is saved.
          yield* redeclare([{ type: "text", key: "token", label: "API token" }]);
          const retyped = yield* settings.update({
            installationId,
            changes: [{ key: "token", value: "plain" }],
          });
          expect(retyped).toEqual({
            installationId,
            values: [{ key: "token", value: "plain" }],
            secrets: [],
          });
          expect(secrets.entries.size).toBe(0);
          expect(yield* countRows(installationId)).toEqual({
            settings: 1,
            secrets: 0,
            storage: 0,
          });

          // Manifests that keep renaming 32 fields keep 32 values, and frames stay one size.
          const sizes = [];
          for (const generation of [0, 1, 2]) {
            const keys = Array.from(
              { length: 32 },
              (_, index) => `g${generation}k${String(index).padStart(2, "0")}`,
            );
            yield* redeclare(keys.map((key) => ({ type: "text", key, label: key })));
            const saved = yield* settings.update({
              installationId,
              changes: keys.map((key) => ({ key, value: "v".repeat(2000) })),
            });
            expect(saved.values.map((entry) => entry.key)).toEqual(keys);
            expect(yield* countRows(installationId)).toEqual({
              settings: 32,
              secrets: 0,
              storage: 0,
            });
            sizes.push(toJson(saved).length);
          }
          expect(new Set(sizes).size).toBe(1);

          // Values of fields no longer declared are not sent, even before the next save.
          yield* redeclare([{ type: "boolean", key: "verbose", label: "Verbose" }]);
          expect(yield* awaitValues(settings, installationId, () => true)).toEqual({
            installationId,
            values: [],
            secrets: [],
          });
        }),
      ),
    );

    it.effect("sends open subscriptions the new fields when the declaration changes", () =>
      withDatabase(
        Effect.gen(function* () {
          const secrets = makeSecretStore();
          const { catalog, settings } = yield* startPlugins(yield* Scope.Scope, secrets.service);
          const directory = yield* preparePlugin();
          const installationId = yield* install(catalog, directory);
          yield* settings.update({
            installationId,
            changes: [
              { key: "token", value: SECRET },
              { key: "mode", value: "fast" },
            ],
          });
          const first = yield* Deferred.make<void>();
          const snapshots = yield* settings.subscribe(installationId).pipe(
            Stream.tap(() => Deferred.succeed(first, undefined)),
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Deferred.await(first);

          yield* writeManifest(directory, {
            settings: [{ type: "boolean", key: "verbose", label: "Verbose" }],
          });
          yield* catalog.refresh({ installationId });
          expect(yield* Fiber.join(snapshots)).toEqual([
            { installationId, values: [{ key: "mode", value: "fast" }], secrets: ["token"] },
            { installationId, values: [], secrets: [] },
          ]);
        }),
      ),
    );

    it.effect("saves nothing new while a retired secret cannot be deleted", () =>
      withDatabase(
        Effect.gen(function* () {
          const secrets = makeSecretStore();
          const { catalog, settings } = yield* startPlugins(yield* Scope.Scope, secrets.service);
          const directory = yield* preparePlugin();
          const installationId = yield* install(catalog, directory);
          const declare = (generation: number) =>
            Effect.gen(function* () {
              const keys = Array.from(
                { length: 32 },
                (_, index) => `g${generation}k${String(index).padStart(2, "0")}`,
              );
              yield* writeManifest(directory, {
                settings: keys.map((key) => ({ type: "secret", key, label: key })),
              });
              yield* catalog.refresh({ installationId });
              return keys.map((key) => ({ key, value: SECRET }));
            });
          yield* settings.update({ installationId, changes: yield* declare(0) });
          expect(secrets.entries.size).toBe(32);

          // Renaming every field while deletes fail refuses each save and stores nothing more.
          secrets.faults.remove = true;
          for (const generation of [1, 2, 3]) {
            const refused = yield* settings
              .update({ installationId, changes: yield* declare(generation) })
              .pipe(Effect.flip);
            expect(refused.reason).toBe("storage");
            expect(secrets.entries.size).toBe(32);
            expect(yield* countRows(installationId)).toEqual({
              settings: 0,
              secrets: 32,
              storage: 0,
            });
          }
          // A secret field retyped as text keeps its secret and gets no value beside it.
          yield* writeManifest(directory, {
            settings: [{ type: "text", key: "g0k00", label: "g0k00" }],
          });
          yield* catalog.refresh({ installationId });
          const retyped = yield* settings
            .update({ installationId, changes: [{ key: "g0k00", value: "plain" }] })
            .pipe(Effect.flip);
          expect(retyped.reason).toBe("storage");
          expect(yield* countRows(installationId)).toEqual({
            settings: 0,
            secrets: 32,
            storage: 0,
          });

          // Once deletes work, the next save retires the old secrets first.
          secrets.faults.remove = false;
          const changes = yield* declare(3);
          const saved = yield* settings.update({ installationId, changes });
          expect(saved.secrets).toEqual(changes.map((change) => change.key));
          expect(secrets.entries.size).toBe(32);
          expect(yield* countRows(installationId)).toEqual({
            settings: 0,
            secrets: 32,
            storage: 0,
          });

          const ended = yield* settings
            .subscribe(installationId)
            .pipe(Stream.runDrain, Effect.flip, Effect.forkChild({ startImmediately: true }));
          yield* catalog.remove({ installationId });
          expect((yield* Fiber.join(ended)).reason).toBe("not-found");
          expect(secrets.entries.size).toBe(0);
          expect(yield* countRows(installationId)).toEqual({
            settings: 0,
            secrets: 0,
            storage: 0,
          });
        }),
      ),
    );
  });
});
