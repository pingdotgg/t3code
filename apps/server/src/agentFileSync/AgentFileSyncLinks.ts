// @effect-diagnostics nodeBuiltinImport:off -- Subscriptions use random durable identifiers.
import * as NodeCrypto from "node:crypto";
import {
  AgentFileSyncBundle,
  AgentFileSyncError,
  AgentFileSyncLink,
  type AgentFileSyncSubscribeInput,
  type AgentFileSyncRefreshInput,
  type AgentFileSyncManageInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as AgentFileSync from "./AgentFileSync.ts";

type State = readonly (AgentFileSyncLink & { readonly previous: AgentFileSyncBundle })[];
const SavedLinks = Schema.Array(AgentFileSyncLink);
const encode = Schema.encodeSync(Schema.fromJsonString(SavedLinks));
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(SavedLinks));
const encodeBundle = Schema.encodeSync(Schema.fromJsonString(AgentFileSyncBundle));
const decodeBundle = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentFileSyncBundle));
const bundleRevision = (bundle: typeof AgentFileSyncBundle.Type) =>
  NodeCrypto.createHash("sha256").update(encodeBundle(bundle)).digest("hex");
const Pending = Schema.Struct({ revision: Schema.String, bundle: AgentFileSyncBundle });
const encodePending = Schema.encodeSync(Schema.fromJsonString(Pending));
const decodePending = Schema.decodeUnknownEffect(Schema.fromJsonString(Pending));
const pendingKey = (id: string) => `agent-file-sync-pending-${id}`;
const SECRET = "agent-file-sync-links";
const baselineKey = (link: AgentFileSyncLink) =>
  `agent-file-sync-baseline-${NodeCrypto.createHash("sha256").update(`${link.id}\0${link.revision}`).digest("hex")}`;

export class AgentFileSyncLinks extends Context.Service<
  AgentFileSyncLinks,
  {
    readonly list: Effect.Effect<readonly AgentFileSyncLink[]>;
    readonly subscribe: <E = never, R = never>(
      input: AgentFileSyncSubscribeInput,
      beforeWrite?: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<void, AgentFileSyncError | E, R>;
    readonly refresh: (input: AgentFileSyncRefreshInput) => Effect.Effect<void, AgentFileSyncError>;
    readonly manage: <E = never, R = never>(
      input: AgentFileSyncManageInput,
      beforeWrite?: Effect.Effect<unknown, E, R>,
    ) => Effect.Effect<void, AgentFileSyncError | E, R>;
  }
>()("t3/agentFileSync/AgentFileSyncLinks") {}

const make = Effect.gen(function* () {
  const files = yield* AgentFileSync.AgentFileSync;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const fs = yield* FileSystem.FileSystem;
  const home = yield* HostProcess.HomeDirectory;
  const path = yield* Path.Path;
  let writable = true;
  const metadata = yield* secrets.get(SECRET).pipe(
    Effect.flatMap((stored) =>
      Option.isSome(stored)
        ? decode(Buffer.from(stored.value).toString("utf8"))
        : Effect.succeed([]),
    ),
    Effect.catch(() => {
      writable = false;
      return Effect.logWarning("Ignoring unreadable agent file sync subscriptions").pipe(
        Effect.as([]),
      );
    }),
  );
  const loadBaseline = Effect.fn("AgentFileSyncLinks.loadBaseline")(
    function* (link: AgentFileSyncLink) {
      const baseline = yield* secrets.get(baselineKey(link));
      if (Option.isNone(baseline)) return yield* new AgentFileSyncError({ reason: "io" });
      const previous = yield* decodeBundle(Buffer.from(baseline.value).toString("utf8"));
      if (bundleRevision(previous) !== link.revision)
        return yield* new AgentFileSyncError({ reason: "changed" });
      return { ...link, previous };
    },
    Effect.catch(() => {
      writable = false;
      return Effect.logWarning("Ignoring an unreadable agent file sync baseline").pipe(
        Effect.as(null),
      );
    }),
  );
  let state: State = (yield* Effect.forEach(metadata, loadBaseline)).filter(
    (link) => link !== null,
  );
  // Lock acquisition stays cancellable; an admitted mutation must settle files, catalog, and recovery data together.
  const lock = yield* Semaphore.make(1);
  // A recovered subset cannot replace the durable catalog without dropping unreadable subscriptions.
  const assertWritable = Effect.suspend(() =>
    writable ? Effect.void : Effect.fail(new AgentFileSyncError({ reason: "unreadable-state" })),
  );
  const persist = Effect.fn("AgentFileSyncLinks.persist")(function* (next: State) {
    const oldKeys = new Set(state.map(baselineKey));
    const nextKeys = new Set(next.map(baselineKey));
    const nextCatalog = encode(next.map(({ previous: _previous, ...link }) => link));
    const previousCatalog = encode(state.map(({ previous: _previous, ...link }) => link));
    const result = yield* Effect.gen(function* () {
      // Publish immutable baselines before the catalog so interrupted writes leave the prior state readable.
      for (const link of next) {
        if (oldKeys.has(baselineKey(link))) continue;
        yield* secrets
          .set(baselineKey(link), Buffer.from(encodeBundle(link.previous)))
          .pipe(Effect.mapError((cause) => new AgentFileSyncError({ reason: "io", cause })));
      }
      yield* secrets
        .set(SECRET, Buffer.from(nextCatalog))
        .pipe(Effect.mapError((cause) => new AgentFileSyncError({ reason: "io", cause })));
    }).pipe(Effect.result);
    if (result._tag === "Failure") {
      // Storage may report failure after rename. Confirm publication before rolling back files or metadata.
      const saved = yield* secrets.get(SECRET).pipe(
        Effect.flatMap((stored) =>
          Option.isSome(stored)
            ? decode(Buffer.from(stored.value).toString("utf8"))
            : Effect.succeed([]),
        ),
        Effect.result,
      );
      if (
        saved._tag === "Failure" ||
        (encode(saved.success) !== nextCatalog && encode(saved.success) !== previousCatalog)
      ) {
        writable = false;
        return yield* new AgentFileSyncError({ reason: "unreadable-state", cause: result.failure });
      }
      if (encode(saved.success) !== nextCatalog) {
        for (const key of nextKeys) {
          if (oldKeys.has(key)) continue;
          yield* secrets
            .remove(key)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not remove an unpublished agent file sync baseline"),
              ),
            );
        }
        return yield* result.failure;
      }
      yield* Effect.logWarning("Sync catalog publication was confirmed after a storage error");
    }
    state = next;
    for (const key of oldKeys) {
      if (nextKeys.has(key)) continue;
      yield* secrets
        .remove(key)
        .pipe(
          Effect.catch(() =>
            Effect.logWarning("Could not remove an obsolete agent file sync baseline"),
          ),
        );
    }
  });
  // File contents stay on the destination. Clients only need the selection and generation.
  const list = Effect.sync(() => state.map(({ previous: _previous, ...link }) => link));
  const subscribe: AgentFileSyncLinks["Service"]["subscribe"] = Effect.fn(
    "AgentFileSyncLinks.subscribe",
  )(function* <E = never, R = never>(
    input: AgentFileSyncSubscribeInput,
    beforeWrite?: Effect.Effect<unknown, E, R>,
  ) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        yield* assertWritable;
        if (state.length >= 20)
          return yield* new AgentFileSyncError({ reason: "subscription-limit" });
        const destination = yield* fs
          .realPath(input.cwd ?? home)
          .pipe(Effect.mapError((cause) => new AgentFileSyncError({ reason: "io", cause })));
        const destinations = input.bundle.map((item) => ({
          ...item,
          absolute: path.join(destination, item.path),
        }));
        const contains = (parent: string, child: string) => {
          const relative = path.relative(parent, child);
          return (
            relative === "" ||
            (!path.isAbsolute(relative) &&
              relative !== ".." &&
              !relative.startsWith(`..${path.sep}`))
          );
        };
        for (const job of state) {
          const existing = yield* fs
            .realPath(job.scope.cwd ?? home)
            .pipe(Effect.orElseSucceed(() => null));
          if (existing === null) continue;
          if (
            job.previous.some((resource) =>
              destinations.some((item) => {
                const absolute = path.join(existing, resource.path);
                return (
                  absolute === item.absolute ||
                  (resource.kind === "skill" && contains(absolute, item.absolute)) ||
                  (item.kind === "skill" && contains(item.absolute, absolute))
                );
              }),
            )
          )
            return yield* new AgentFileSyncError({ reason: "overlap" });
        }
        // Initial setup can replace several unrelated files. Keep recovery data until it commits.
        const result = yield* files.apply(input, true, beforeWrite);
        const published = yield* Effect.gen(function* () {
          if (result.failures.length)
            return yield* new AgentFileSyncError({ reason: "io", path: result.failures[0]!.path });
          yield* persist([
            ...state,
            {
              id: NodeCrypto.randomUUID(),
              scope: input.cwd ? { cwd: input.cwd } : {},
              sourceEnvironmentId: input.sourceEnvironmentId,
              selection: input.selection,
              label: input.label,
              previous: input.bundle,
              paused: false,
              error: null,
              lastSyncedAt: yield* Clock.currentTimeMillis,
              generation: 0,
              revision: bundleRevision(input.bundle),
            },
          ]);
        }).pipe(Effect.result);
        if (published._tag === "Failure") {
          if (published.failure.reason === "unreadable-state" && result.undoId)
            return yield* new AgentFileSyncError({
              reason: "recovery",
              path: result.undoId,
              cause: published.failure,
            });
          if (result.undoId) {
            const restored = yield* files.undo({ undoId: result.undoId }).pipe(Effect.result);
            if (restored._tag === "Failure" || restored.success.failures.length)
              return yield* new AgentFileSyncError({
                reason: "recovery",
                path: result.undoId,
                cause: published.failure,
              });
          }
          return yield* published.failure;
        }
        if (result.undoId)
          yield* files
            .discard({ undoId: result.undoId })
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not remove a completed sync setup receipt"),
              ),
            );
      }).pipe(Effect.uninterruptible),
    );
  });
  const removePending = Effect.fn("AgentFileSyncLinks.removePending")(function* (id: string) {
    yield* secrets
      .remove(pendingKey(id))
      .pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not remove a completed agent file sync update"),
        ),
      );
  });
  const pause = Effect.fn("AgentFileSyncLinks.pause")(function* (
    job: State[number],
    error: AgentFileSyncError,
  ) {
    yield* persist(
      state.map((entry) =>
        entry.id === job.id
          ? { ...entry, error: error.message, paused: true, generation: entry.generation + 1 }
          : entry,
      ),
    );
  });
  const commitRefresh = Effect.fn("AgentFileSyncLinks.commitRefresh")(function* (
    job: State[number],
    bundle: AgentFileSyncBundle | null,
  ) {
    const result = yield* files
      .reconcile({ ...job.scope, previous: job.previous, bundle: bundle ?? job.previous })
      .pipe(Effect.result);
    if (result._tag === "Success" && bundle === null && job.error === null) return;
    if (result._tag === "Failure") {
      yield* pause(job, result.failure);
      return yield* result.failure;
    }
    const next = {
      ...job,
      previous: bundle ?? job.previous,
      revision: bundle ? bundleRevision(bundle) : job.revision,
      error: null,
      lastSyncedAt: yield* Clock.currentTimeMillis,
      generation: job.generation + 1,
    };
    yield* persist(state.map((entry) => (entry.id === job.id ? next : entry)));
    if (bundle !== null) yield* removePending(job.id);
  });
  const refresh: AgentFileSyncLinks["Service"]["refresh"] = Effect.fn("AgentFileSyncLinks.refresh")(
    function* (input) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          yield* assertWritable;
          const job = state.find((entry) => entry.id === input.id);
          // Several clients may relay the same subscription. A stale client must re-read it.
          if (!job || job.paused || job.generation !== input.generation) return;
          const pending = yield* secrets.get(pendingKey(job.id)).pipe(
            Effect.flatMap((saved) =>
              Option.isSome(saved)
                ? decodePending(Buffer.from(saved.value).toString("utf8"))
                : Effect.succeed(null),
            ),
            Effect.mapError((cause) => new AgentFileSyncError({ reason: "io", cause })),
          );
          // A published baseline may lag the filesystem after a failed save or a server restart.
          // Finish that update before accepting a newer source snapshot.
          if (pending !== null && pending.revision === job.revision) {
            yield* commitRefresh(job, pending.bundle);
            return;
          }
          if (pending !== null) yield* removePending(job.id);
          if (input.bundle !== null) {
            yield* files
              .preview({ ...job.scope, bundle: input.bundle }, job.previous)
              .pipe(Effect.tapError((error) => pause(job, error)));
            yield* secrets
              .set(
                pendingKey(job.id),
                Buffer.from(encodePending({ revision: job.revision, bundle: input.bundle })),
              )
              .pipe(Effect.mapError((cause) => new AgentFileSyncError({ reason: "io", cause })));
          }
          yield* commitRefresh(job, input.bundle);
        }).pipe(Effect.uninterruptible),
      );
    },
  );
  const manage: AgentFileSyncLinks["Service"]["manage"] = Effect.fn("AgentFileSyncLinks.manage")(
    function* <E = never, R = never>(
      input: AgentFileSyncManageInput,
      beforeWrite?: Effect.Effect<unknown, E, R>,
    ) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          yield* assertWritable;
          const job = state.find((entry) => entry.id === input.id);
          if (!job || (input.generation !== undefined && input.generation !== job.generation))
            return;
          if (beforeWrite) yield* beforeWrite;
          yield* persist(
            input.action === "remove"
              ? state.filter((entry) => entry.id !== input.id)
              : state.map((entry) =>
                  entry.id === input.id
                    ? {
                        ...entry,
                        paused: input.action === "pause",
                        error: input.action === "pause" ? (input.error ?? null) : null,
                        generation: entry.generation + 1,
                      }
                    : entry,
                ),
          );
          if (input.action === "remove") yield* removePending(job.id);
        }).pipe(Effect.uninterruptible),
      );
    },
  );
  return AgentFileSyncLinks.of({ list, subscribe, refresh, manage });
});
export const layer = Layer.effect(AgentFileSyncLinks, make);
