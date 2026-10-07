/**
 * The environment's trusted local plugins: which directories were added, what
 * their exact bytes were, who consented to which bytes, and which are enabled.
 *
 * Nothing in a plugin directory runs until its current digest has consent and
 * the installation is enabled. Enabling registers it with the supervisor,
 * which still starts no process until the first invoke. The bytes are checked
 * again whenever they are about to matter: on add, refresh, consent, enable,
 * server start, and before an invoke that would start a fresh process. A
 * change found at any of those points disables the installation and leaves it
 * needing consent; it is never re-enabled automatically.
 *
 * Plugins are trusted OS-user code. The digest pins what the user agreed to
 * run, not what the directory's owner can do between checks.
 */
import {
  PluginCatalogError,
  PluginInstallation,
  pluginInstallationStatus,
  type PluginAddInput,
  type PluginCatalogSnapshot,
  type PluginConsentInput,
  type PluginId,
  type PluginInstallationInput,
  type PluginInstallationManifest,
  type PluginInstallationResult,
  type PluginManifest,
  type PluginRefreshInput,
  type PluginRemoveResult,
  type PluginSource,
  PluginInstallationId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { PluginEventDelivery } from "./PluginEventDelivery.ts";
import { loadPluginDirectory, type PluginRegistration } from "./PluginManifestLoader.ts";
import {
  defaultPluginSourceLimits,
  digestPluginSource,
  type PluginSourceLimits,
} from "./pluginSource.ts";
import { PluginSupervisor, type PluginInvokeError } from "./PluginSupervisor.ts";

/** What is persisted: the wire record without the live process and delivery states. */
const PluginInstallationRecord = PluginInstallation.mapFields(
  ({ hostState: _hostState, eventDelivery: _eventDelivery, ...fields }) => fields,
);
type PluginInstallationRecord = typeof PluginInstallationRecord.Type;

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginInstallationRecord));
const encodeRecord = Schema.encodeEffect(Schema.fromJsonString(PluginInstallationRecord));

/** One registration with the supervisor. A re-enable makes a new one; it is never mutated. */
interface Registration {
  readonly pluginId: PluginId;
  readonly generation: number;
}

interface Installation {
  record: PluginInstallationRecord;
  /** The registration this installation runs under, while enabled. */
  registered: Registration | undefined;
  /** Waits for the process of the last registration revoked here to exit. */
  stopping: Fiber.Fiber<void> | undefined;
}

type Inspection =
  | {
      readonly _tag: "ok";
      readonly registration: PluginRegistration;
      readonly source: PluginSource;
    }
  | { readonly _tag: "failed"; readonly reason: string };

/**
 * How long a call waits for startup to re-register enabled plugins before it
 * proceeds without them, matching the supervisor's default activation timeout.
 */
const STARTUP_RESTORE_WAIT = Duration.seconds(10);

/** What one admission attempt of `invoke` found. */
type Admission =
  | { readonly _tag: "called"; readonly value: Schema.Json }
  | { readonly _tag: "revoked" }
  /** A fresh process would start: the bytes must be checked against `consented` first. */
  | { readonly _tag: "check"; readonly consented: string };

const summarize = (manifest: PluginManifest): PluginInstallationManifest => ({
  id: manifest.id,
  name: manifest.name,
  version: manifest.version,
  ...(manifest.description === undefined ? {} : { description: manifest.description }),
  capabilities: manifest.capabilities,
  proposedApi: manifest.proposedApi,
  ...(manifest.tools === undefined || manifest.tools.length === 0 ? {} : { tools: manifest.tools }),
  ...(manifest.settings === undefined ? {} : { settings: manifest.settings }),
  ...(manifest.actions === undefined || manifest.actions.length === 0
    ? {}
    : { actions: manifest.actions }),
});

const catalogError = (
  reason: string,
  message: string,
  installationId?: PluginInstallationId,
): PluginCatalogError =>
  new PluginCatalogError({
    reason,
    message,
    ...(installationId === undefined ? {} : { installationId }),
  });

const storageError = (cause: unknown) =>
  Effect.logWarning("Plugin catalogue storage failed", { cause }).pipe(
    Effect.andThen(Effect.fail(catalogError("storage", "Could not save the plugin catalogue."))),
  );

export class PluginCatalog extends Context.Service<
  PluginCatalog,
  {
    readonly list: Effect.Effect<PluginCatalogSnapshot>;
    /** Changes whenever `list` could show different installation records, so a reader can cache what it derives from them. */
    readonly revision: Effect.Effect<number>;
    /** One snapshot now, then a fresh one after every catalogue or plugin state change. */
    readonly subscribe: Stream.Stream<PluginCatalogSnapshot>;
    readonly add: (
      input: PluginAddInput,
    ) => Effect.Effect<PluginInstallationResult, PluginCatalogError>;
    readonly refresh: (
      input: PluginRefreshInput,
    ) => Effect.Effect<PluginCatalogSnapshot, PluginCatalogError>;
    readonly consent: (
      input: PluginConsentInput,
    ) => Effect.Effect<PluginInstallationResult, PluginCatalogError>;
    readonly enable: (
      input: PluginInstallationInput,
    ) => Effect.Effect<PluginInstallationResult, PluginCatalogError>;
    readonly disable: (
      input: PluginInstallationInput,
    ) => Effect.Effect<PluginInstallationResult, PluginCatalogError>;
    readonly remove: (
      input: PluginInstallationInput,
    ) => Effect.Effect<PluginRemoveResult, PluginCatalogError>;
    /** Clears the process's backoff, quarantine, or incompatibility, and restarts stopped event delivery. */
    readonly resume: (
      input: PluginInstallationInput,
    ) => Effect.Effect<PluginInstallationResult, PluginCatalogError>;
    /**
     * Replaces the files in an installation's directory and consents to
     * `digest`, as one management step: no other step, such as a disable from
     * another client, runs in between, and the installation stays revoked
     * throughout. The files are claimed first (see `changeFiles`), with
     * `paths` naming everywhere `swap` and `restore` move files. `swap` puts
     * the new files in place. If it fails, or the directory then does not hold
     * `digest`, `restore` puts the old files back. Afterwards the installation
     * is enabled again only if it was enabled and the bytes on disk have
     * consent: the new ones, or the old ones still.
     */
    readonly replace: (
      input: PluginConsentInput,
      files: {
        readonly paths: ReadonlyArray<string>;
        readonly swap: Effect.Effect<void, PluginCatalogError>;
        readonly restore: Effect.Effect<void, PluginCatalogError>;
      },
    ) => Effect.Effect<PluginInstallationResult, PluginCatalogError>;
    /**
     * Settles a `replace` that was cut short, by a crash or a failed `restore`,
     * as one management step. If the installation has consent to `digest`, the
     * replacement committed and nothing changes. Otherwise `files.restore`,
     * when given, puts the old files back after claiming `files.paths` (see
     * `changeFiles`), and the files are inspected again. The installation
     * stays disabled, and consent is never granted.
     */
    readonly settleReplace: (
      input: PluginConsentInput,
      files?: {
        readonly paths: ReadonlyArray<string>;
        readonly restore: Effect.Effect<void, PluginCatalogError>;
      },
    ) => Effect.Effect<"committed" | "rolled-back", PluginCatalogError>;
    /**
     * Runs `effect`, which moves or deletes files under `paths`, as one
     * management step. It fails `already-added`, and touches nothing, if any
     * installation is rooted in or around one of the paths. Otherwise every
     * process that ran from files there has exited before `effect` starts,
     * including one whose disable or remove was cut short.
     */
    readonly changeFiles: <A, E>(
      paths: ReadonlyArray<string>,
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | PluginCatalogError>;
    /**
     * Calls a handler of an enabled installation. A call that would start a
     * fresh process first checks the bytes still match the consent. Pass the
     * `generation` the caller saw to refuse a call that would reach a later
     * registration (`generation-changed`). A call whose installation is
     * disabled, removed, or re-registered before the supervisor takes it
     * fails; it never follows the plugin id to a replacement.
     */
    readonly invoke: (
      installationId: PluginInstallationId,
      handler: string,
      input: Schema.Json,
      options?: { readonly timeout?: Duration.Input; readonly generation?: number },
    ) => Effect.Effect<Schema.Json, PluginCatalogError | PluginInvokeError>;
  }
>()("t3/plugins/PluginCatalog") {}

export const make = Effect.fn("PluginCatalog.make")(function* (
  sourceLimits: PluginSourceLimits = defaultPluginSourceLimits,
) {
  const sql = yield* SqlClient.SqlClient;
  const supervisor = yield* PluginSupervisor;
  const crypto = yield* Crypto.Crypto;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const eventDeliveries = yield* Effect.serviceOption(PluginEventDelivery);

  const installations = new Map<PluginInstallationId, Installation>();
  // Management is rare and each step may wait for a process to exit; one at a time keeps the
  // catalogue, the table, and the supervisor in step.
  const lock = yield* Semaphore.make(1);
  /**
   * Processes still exiting after their registration was revoked, by the
   * directory they ran from. Kept apart from `registered`, since a disable
   * or remove whose caller went away no longer waits for its process.
   */
  const exiting = new Map<Fiber.Fiber<void>, string>();
  const changes = yield* PubSub.sliding<void>(1);
  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);
  // Counts changes a snapshot can show, so a step that changed nothing tells no one.
  let revision = 0;
  // Completes when startup has tried to re-register every enabled installation.
  const restored = yield* Deferred.make<void>();

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const save = (record: PluginInstallationRecord) =>
    encodeRecord(record).pipe(
      Effect.flatMap(
        (json) => sql`
          INSERT INTO plugin_installations (installation_id, directory, record_json)
          VALUES (${record.installationId}, ${record.directory}, ${json})
          ON CONFLICT (installation_id) DO UPDATE SET
            directory = excluded.directory,
            record_json = excluded.record_json
        `,
      ),
      Effect.asVoid,
      Effect.catch(storageError),
    );

  /** Saves `record` as enabled, with the event cursor its capabilities need, or neither. */
  const saveEnabled = (record: PluginInstallationRecord, capabilities: ReadonlyArray<string>) =>
    Option.match(eventDeliveries, {
      onNone: () => save(record),
      onSome: (delivery) =>
        sql
          .withTransaction(
            delivery
              .begin(record.installationId, capabilities)
              .pipe(Effect.catch(storageError), Effect.andThen(save(record))),
          )
          .pipe(Effect.catchTags({ SqlError: storageError })),
    });

  /** Saves `record` and then shows it, or neither. */
  const commit = (installation: Installation, record: PluginInstallationRecord) =>
    save(record).pipe(
      Effect.andThen(
        Effect.sync(() => {
          installation.record = record;
          revision++;
        }),
      ),
      Effect.uninterruptible,
    );

  const inspect = (directory: string): Effect.Effect<Inspection> =>
    loadPluginDirectory(directory).pipe(
      Effect.flatMap((registration) =>
        digestPluginSource(registration.directory, sourceLimits).pipe(
          Effect.map((source) => ({ _tag: "ok" as const, registration, source })),
        ),
      ),
      Effect.catch((error) => Effect.succeed({ _tag: "failed" as const, reason: error.reason })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const isReady = (record: PluginInstallationRecord) =>
    pluginInstallationStatus({ ...record, enabled: true }) === "enabled";

  /**
   * Revokes the installation's registration and returns the fiber that waits
   * for its process to exit. The supervisor revokes as soon as `disable`
   * starts, so this starts it at once; only the wait may be cut short. An
   * installation already revoked returns its earlier stop, so a retry still
   * waits for that process and never touches a replacement under the same id.
   */
  const unregister = Effect.fnUntraced(function* (installation: Installation) {
    const registered = installation.registered;
    if (registered === undefined) return installation.stopping;
    installation.registered = undefined;
    revision++;
    const stopping = yield* supervisor
      .disable(registered.pluginId)
      .pipe(Effect.forkIn(scope, { startImmediately: true }));
    installation.stopping = stopping;
    exiting.set(stopping, installation.record.directory);
    stopping.addObserver(() => exiting.delete(stopping));
    return stopping;
  });

  /**
   * Saves `record` (normally with `enabled: false`), revokes the registration,
   * and waits for the process to exit. The row is written first and
   * everything but the wait finishes even if the caller goes away, so a
   * disable that was cut short never comes back enabled at the next start. A
   * failed save changes nothing.
   */
  const revoke = (installation: Installation, record: PluginInstallationRecord) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (record !== installation.record) yield* commit(installation, record);
        const stopping = yield* unregister(installation);
        if (stopping) yield* restore(Fiber.join(stopping));
      }),
    );

  /**
   * Inspects the directory again and records the result. An enabled
   * installation whose bytes no longer match its consent is stopped and
   * disabled.
   */
  const reinspect = Effect.fnUntraced(function* (installation: Installation) {
    const inspection = yield* inspect(installation.record.directory);
    const current = installation.record;
    const found =
      inspection._tag === "ok"
        ? {
            manifest: summarize(inspection.registration.manifest),
            source: inspection.source,
            problem: null,
          }
        : { manifest: current.manifest, source: null, problem: inspection.reason };
    // The same result keeps the record as it was, `inspectedAt` included.
    if (
      Equal.equals(found, {
        manifest: current.manifest,
        source: current.source,
        problem: current.problem,
      })
    )
      return inspection;
    const record: PluginInstallationRecord = { ...current, ...found, inspectedAt: yield* now };
    if (record.enabled && !isReady(record)) {
      yield* Effect.logWarning("Plugin source changed; disabling until consent is renewed", {
        installationId: record.installationId,
        directory: record.directory,
      });
      yield* revoke(installation, { ...record, enabled: false });
    } else {
      yield* commit(installation, record);
    }
    return inspection;
  });

  /**
   * Registers a ready installation with the supervisor under a new generation
   * and saves it as enabled. Both happen or neither, even if the caller is
   * interrupted.
   */
  const register = Effect.fnUntraced(function* (
    installation: Installation,
    registration: PluginRegistration,
  ) {
    const pluginId = registration.manifest.id;
    const holder = [...installations.values()].find(
      (other) => other !== installation && other.registered?.pluginId === pluginId,
    );
    if (holder)
      return yield* catalogError(
        "plugin-id-conflict",
        `Another enabled plugin already uses the id ${pluginId} (${holder.record.directory}). Disable it first.`,
        installation.record.installationId,
      );
    yield* supervisor
      .enable({ ...registration, installationId: installation.record.installationId })
      .pipe(
        Effect.mapError(() =>
          catalogError(
            "plugin-id-conflict",
            `A plugin with the id ${pluginId} is already running.`,
            installation.record.installationId,
          ),
        ),
      );
    const record = {
      ...installation.record,
      enabled: true,
      generation: installation.record.generation + 1,
    };
    yield* saveEnabled(record, registration.manifest.capabilities).pipe(
      Effect.tapError(() => supervisor.disable(pluginId)),
    );
    // Together, so an invoke never sees the new registration with the old generation.
    installation.record = record;
    installation.registered = { pluginId, generation: record.generation };
    revision++;
  }, Effect.uninterruptible);

  const find = (installationId: PluginInstallationId) =>
    Effect.suspend(() => {
      const installation = installations.get(installationId);
      return installation
        ? Effect.succeed(installation)
        : Effect.fail(
            catalogError("not-found", "That plugin is not installed here.", installationId),
          );
    });

  const toWire = Effect.fnUntraced(function* (installation: Installation) {
    const registered = installation.registered;
    if (registered === undefined) return installation.record;
    const hostState = yield* supervisor.state(registered.pluginId);
    const eventDelivery = Option.isSome(eventDeliveries)
      ? yield* eventDeliveries.value.state(
          installation.record.installationId,
          registered.generation,
        )
      : Option.none();
    const wire: PluginInstallation = {
      ...installation.record,
      ...(Option.isSome(hostState) ? { hostState: hostState.value } : {}),
      ...(Option.isSome(eventDelivery) ? { eventDelivery: eventDelivery.value } : {}),
    };
    return wire;
  });

  const list = Effect.suspend(() =>
    Effect.forEach(
      [...installations.values()].sort(
        (a, b) =>
          a.record.addedAt.localeCompare(b.record.addedAt) ||
          a.record.installationId.localeCompare(b.record.installationId),
      ),
      toWire,
    ),
  ).pipe(Effect.map((installations) => ({ installations })));

  const result = (installation: Installation) =>
    toWire(installation).pipe(Effect.map((wire) => ({ installation: wire })));

  /** Runs a management step under the lock and tells subscribers if it changed anything, even when it then failed. */
  const managed = <A, E>(effect: Effect.Effect<A, E>) =>
    lock.withPermit(
      Effect.suspend(() => {
        const before = revision;
        return effect.pipe(
          Effect.ensuring(Effect.suspend(() => (revision === before ? Effect.void : notify))),
        );
      }),
    );

  const add = Effect.fn("PluginCatalog.add")(function* (input: PluginAddInput) {
    if (!path.isAbsolute(input.directory))
      return yield* catalogError(
        "invalid-directory",
        "Enter the plugin directory's absolute path on the server's machine.",
      );
    const inspection = yield* inspect(input.directory);
    if (inspection._tag === "failed")
      return yield* catalogError("invalid-directory", inspection.reason);
    const directory = inspection.registration.directory;
    const existing = [...installations.values()].find(
      (installation) => installation.record.directory === directory,
    );
    if (existing)
      return yield* catalogError(
        "already-added",
        `${directory} is already installed.`,
        existing.record.installationId,
      );
    const installationId = PluginInstallationId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
    const at = yield* now;
    const record: PluginInstallationRecord = {
      installationId,
      generation: 0,
      directory,
      manifest: summarize(inspection.registration.manifest),
      source: inspection.source,
      problem: null,
      inspectedAt: at,
      consent: null,
      enabled: false,
      addedAt: at,
    };
    const installation: Installation = { record, registered: undefined, stopping: undefined };
    yield* save(record).pipe(
      Effect.andThen(
        Effect.sync(() => {
          installations.set(installationId, installation);
          revision++;
        }),
      ),
      Effect.uninterruptible,
    );
    return yield* result(installation);
  });

  const refresh = Effect.fn("PluginCatalog.refresh")(function* (input: PluginRefreshInput) {
    const targets =
      input.installationId === undefined
        ? [...installations.values()]
        : [yield* find(input.installationId)];
    yield* Effect.forEach(targets, reinspect, { discard: true });
    return yield* list;
  });

  const consent = Effect.fn("PluginCatalog.consent")(function* (input: PluginConsentInput) {
    const installation = yield* find(input.installationId);
    const inspection = yield* reinspect(installation);
    if (inspection._tag === "failed")
      return yield* catalogError("unavailable", inspection.reason, input.installationId);
    if (inspection.source.digest !== input.digest)
      return yield* catalogError(
        "source-changed",
        "The plugin's files changed after they were reviewed. Review the current version.",
        input.installationId,
      );
    yield* commit(installation, {
      ...installation.record,
      consent: {
        digest: inspection.source.digest,
        capabilities: inspection.registration.manifest.capabilities,
        grantedAt: yield* now,
      },
    });
    return yield* result(installation);
  });

  const enable = Effect.fn("PluginCatalog.enable")(function* (input: PluginInstallationInput) {
    const installation = yield* find(input.installationId);
    // Checked even when already enabled: changed bytes stop it and need consent again.
    const inspection = yield* reinspect(installation);
    if (inspection._tag === "failed")
      return yield* catalogError("unavailable", inspection.reason, input.installationId);
    if (!isReady(installation.record))
      return yield* catalogError(
        "consent-required",
        installation.record.consent === null
          ? "Review and approve the plugin before enabling it."
          : "The plugin's files changed since they were approved. Review the current version.",
        input.installationId,
      );
    // Already enabled with these bytes: keep the registration and its generation.
    if (installation.registered !== undefined) return yield* result(installation);
    yield* register(installation, inspection.registration);
    return yield* result(installation);
  });

  const disableInstallation = (installation: Installation) =>
    revoke(
      installation,
      installation.record.enabled
        ? { ...installation.record, enabled: false }
        : installation.record,
    );

  const overlaps = (a: string, b: string) =>
    a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);

  /**
   * The one rule for moving or deleting files under `paths`, run inside a
   * management step: no installation but `owner` may be rooted in or around
   * them, `owner` is disabled, and every process that ran from files there
   * has exited before this returns.
   */
  const claimFiles = Effect.fnUntraced(function* (
    paths: ReadonlyArray<string>,
    owner?: Installation,
  ) {
    const other = [...installations.values()].find(
      (installation) =>
        installation !== owner &&
        paths.some((target) => overlaps(target, installation.record.directory)),
    );
    if (other)
      return yield* catalogError(
        "already-added",
        `${other.record.directory} is installed as a plugin, so its files were left in place.`,
        other.record.installationId,
      );
    if (owner) yield* disableInstallation(owner);
    yield* Effect.forEach(
      [...exiting].filter(([, directory]) => paths.some((target) => overlaps(target, directory))),
      ([stopping]) => Fiber.await(stopping),
      { discard: true },
    );
  });

  const disable = Effect.fn("PluginCatalog.disable")(function* (input: PluginInstallationInput) {
    const installation = yield* find(input.installationId);
    yield* disableInstallation(installation);
    return yield* result(installation);
  });

  const remove = Effect.fn("PluginCatalog.remove")(function* (input: PluginInstallationInput) {
    const installation = yield* find(input.installationId);
    // Forgotten durably first, like disable, so an interrupted remove does not come back.
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM plugin_installations WHERE installation_id = ${input.installationId}`.pipe(
          Effect.catch(storageError),
        );
        installations.delete(input.installationId);
        revision++;
        const stopping = yield* unregister(installation);
        if (stopping) yield* restore(Fiber.join(stopping));
      }),
    );
    return { installationId: input.installationId };
  });

  const replace = Effect.fn("PluginCatalog.replace")(function* (
    input: PluginConsentInput,
    files: Parameters<PluginCatalog["Service"]["replace"]>[1],
  ) {
    const installation = yield* find(input.installationId);
    const wasEnabled = installation.record.enabled;
    yield* claimFiles([installation.record.directory, ...files.paths], installation);
    const enableAgain = (inspection: Inspection) =>
      wasEnabled && inspection._tag === "ok" && isReady(installation.record)
        ? register(installation, inspection.registration)
        : Effect.void;
    const inspection = yield* files.swap.pipe(
      Effect.andThen(reinspect(installation)),
      Effect.filterOrFail(
        (inspection): inspection is Extract<Inspection, { readonly _tag: "ok" }> =>
          inspection._tag === "ok" && inspection.source.digest === input.digest,
        () =>
          catalogError(
            "source-changed",
            "The new files changed after they were reviewed, so the old ones were put back.",
            input.installationId,
          ),
      ),
      Effect.tap((inspection) =>
        Effect.gen(function* () {
          yield* commit(installation, {
            ...installation.record,
            consent: {
              digest: inspection.source.digest,
              capabilities: inspection.registration.manifest.capabilities,
              grantedAt: yield* now,
            },
          });
        }),
      ),
      Effect.tapError(() =>
        files.restore.pipe(
          Effect.andThen(reinspect(installation)),
          Effect.flatMap(enableAgain),
          Effect.catch((error) =>
            Effect.logWarning("Could not put a plugin's old files back", {
              installationId: input.installationId,
              detail: error.message,
            }),
          ),
        ),
      ),
    );
    yield* enableAgain(inspection);
    return yield* result(installation);
  }, Effect.uninterruptible);

  const settleReplace = Effect.fn("PluginCatalog.settleReplace")(function* (
    input: PluginConsentInput,
    files: Parameters<PluginCatalog["Service"]["settleReplace"]>[1],
  ) {
    const installation = yield* find(input.installationId);
    if (installation.record.consent?.digest === input.digest) return "committed" as const;
    if (files !== undefined) {
      yield* claimFiles([installation.record.directory, ...files.paths], installation);
      yield* files.restore;
      yield* reinspect(installation);
    }
    return "rolled-back" as const;
  }, Effect.uninterruptible);

  const changeFiles = <A, E>(paths: ReadonlyArray<string>, effect: Effect.Effect<A, E>) =>
    claimFiles(paths).pipe(Effect.andThen(effect), Effect.uninterruptible);

  const resume = Effect.fn("PluginCatalog.resume")(function* (input: PluginInstallationInput) {
    const installation = yield* find(input.installationId);
    if (installation.registered === undefined)
      return yield* catalogError("unavailable", "The plugin is not enabled.", input.installationId);
    yield* supervisor.resume(installation.registered.pluginId).pipe(Effect.ignore);
    if (Option.isSome(eventDeliveries)) yield* eventDeliveries.value.resume(input.installationId);
    return yield* result(installation);
  });

  /**
   * Re-checks that `registered` is still this installation's registration and, unless the call
   * would start a fresh process with unchecked bytes, hands the call to the supervisor. It runs
   * in a fiber that starts synchronously, so no management step can revoke or replace the
   * registration between the check and the supervisor admitting the call.
   */
  const admit = (
    installation: Installation,
    registered: Registration,
    verified: string | undefined,
    call: (pluginId: PluginId) => Effect.Effect<Schema.Json, PluginInvokeError>,
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.forkChild(
        Effect.suspend((): Effect.Effect<Admission, PluginInvokeError> => {
          if (
            installations.get(installation.record.installationId) !== installation ||
            installation.registered !== registered ||
            installation.record.consent === null
          )
            return Effect.succeed({ _tag: "revoked" });
          const consented = installation.record.consent.digest;
          return supervisor
            .state(registered.pluginId)
            .pipe(
              Effect.flatMap((state): Effect.Effect<Admission, PluginInvokeError> =>
                Option.isSome(state) && state.value._tag === "idle" && verified !== consented
                  ? Effect.succeed({ _tag: "check", consented })
                  : call(registered.pluginId).pipe(
                      Effect.map((value) => ({ _tag: "called", value })),
                    ),
              ),
            );
        }),
        { startImmediately: true },
      ).pipe(
        Effect.flatMap((fiber) =>
          restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))),
        ),
      ),
    );

  const invoke: PluginCatalog["Service"]["invoke"] = Effect.fn("PluginCatalog.invoke")(
    function* (installationId, handler, input, options) {
      // A call right after a restart waits for its installation to be registered again.
      yield* Deferred.await(restored).pipe(Effect.timeoutOption(STARTUP_RESTORE_WAIT));
      const installation = yield* find(installationId);
      const registered = installation.registered;
      if (registered === undefined)
        return yield* catalogError("unavailable", "The plugin is not enabled.", installationId);
      if (options?.generation !== undefined && options.generation !== registered.generation)
        return yield* catalogError(
          "generation-changed",
          "The plugin was enabled again since this call was prepared.",
          installationId,
        );
      const call = (pluginId: PluginId) =>
        supervisor.invoke(
          pluginId,
          handler,
          input,
          options?.timeout === undefined ? undefined : { timeout: options.timeout },
        );
      let verified: string | undefined;
      while (true) {
        const admission = yield* admit(installation, registered, verified, call);
        if (admission._tag === "called") return admission.value;
        if (admission._tag === "revoked")
          return yield* catalogError(
            "unavailable",
            "The plugin was disabled or replaced before the call started.",
            installationId,
          );
        const inspection = yield* inspect(installation.record.directory);
        if (inspection._tag === "ok" && inspection.source.digest === admission.consented) {
          verified = admission.consented;
          continue;
        }
        // Skip the record if it was disabled or removed meanwhile, so it is not written back.
        yield* managed(
          Effect.suspend(() =>
            installations.get(installationId) === installation &&
            installation.registered === registered
              ? reinspect(installation)
              : Effect.void,
          ),
        );
        return yield* catalogError(
          "source-changed",
          "The plugin's files changed since they were approved, so it was disabled.",
          installationId,
        );
      }
    },
  );

  // Load what was installed before this start.
  const rows = yield* sql<{ readonly record_json: string }>`
    SELECT record_json FROM plugin_installations
  `.pipe(Effect.orDie);
  for (const row of rows) {
    const decoded = yield* decodeRecord(row.record_json).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      yield* Effect.logWarning("Skipping an unreadable plugin installation row");
      continue;
    }
    installations.set(decoded.value.installationId, {
      record: decoded.value,
      registered: undefined,
      stopping: undefined,
    });
  }

  // Plugin state changes reach subscribers as fresh snapshots.
  const supervisorEvents = yield* supervisor.subscribe;
  yield* Stream.fromSubscription(supervisorEvents).pipe(
    Stream.filter((event) => event._tag === "StateChanged"),
    Stream.runForEach(() => notify),
    Effect.forkScoped,
  );

  // So do changes of event delivery state.
  if (Option.isSome(eventDeliveries)) {
    const deliveryChanges = yield* eventDeliveries.value.changes;
    yield* Stream.fromSubscription(deliveryChanges).pipe(
      Stream.runForEach(() => notify),
      Effect.forkScoped,
    );
  }

  // Re-register what was enabled, off the startup path. Changed bytes are disabled here;
  // nothing starts a process until it is used. Starting at once takes the lock before this
  // returns, so no management step can act on an installation still waiting to be restored.
  yield* managed(
    Effect.forEach(
      [...installations.values()].filter((installation) => installation.record.enabled),
      (installation) =>
        reinspect(installation).pipe(
          Effect.flatMap((inspection) =>
            inspection._tag === "ok" && installation.record.enabled
              ? register(installation, inspection.registration)
              : Effect.void,
          ),
          Effect.catch((error) =>
            Effect.logWarning("Could not re-enable a plugin at startup", {
              installationId: installation.record.installationId,
              detail: error.message,
            }).pipe(Effect.andThen(disableInstallation(installation).pipe(Effect.ignore))),
          ),
        ),
      { discard: true },
    ),
  ).pipe(
    Effect.ensuring(Deferred.succeed(restored, undefined)),
    Effect.forkIn(scope, { startImmediately: true }),
  );

  return PluginCatalog.of({
    list,
    revision: Effect.sync(() => revision),
    subscribe: Stream.unwrap(
      // Subscribe before the first snapshot so a change in between is not lost.
      PubSub.subscribe(changes).pipe(
        Effect.map((subscription) =>
          Stream.concat(
            Stream.fromEffect(list),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list)),
          ).pipe(
            // A plugin state event and the step that caused it can describe the same snapshot.
            Stream.changes,
          ),
        ),
      ),
    ),
    add: (input) => managed(add(input)),
    refresh: (input) => managed(refresh(input)),
    consent: (input) => managed(consent(input)),
    enable: (input) => managed(enable(input)),
    disable: (input) => managed(disable(input)),
    remove: (input) => managed(remove(input)),
    resume: (input) => managed(resume(input)),
    replace: (input, files) => managed(replace(input, files)),
    settleReplace: (input, files) => managed(settleReplace(input, files)),
    changeFiles: (paths, effect) => managed(changeFiles(paths, effect)),
    invoke,
  });
});

export const layer = (sourceLimits?: PluginSourceLimits) =>
  Layer.effect(PluginCatalog, make(sourceLimits));
