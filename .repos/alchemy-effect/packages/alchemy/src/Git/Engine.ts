/** Git operations without HTTP requests, user services, or authorization callbacks. */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { RuntimeContext } from "../RuntimeContext.ts";
import { PushDenied, RefConflict, RepoNotFound } from "./Api/Schema.ts";
import { BlobStore } from "./BlobStore.ts";
import { Hasher } from "./Hasher/Hasher.ts";
import { Operations, OperationsLive } from "./Operations.ts";
import { StoreError } from "./Protocol/Store.ts";
import {
  incomingStates,
  invalidPush,
  preparedStates,
  type PreparedPush,
  type PushInput,
  type RefUpdate,
} from "./Push.ts";
import { encodeStagedBatch } from "./PushWire.ts";
import { ulid } from "./RegistryObject.ts";
import {
  MAX_PACK_BYTES,
  PUSH_WAIT_TIMEOUT,
  RepoStore,
  ingestPackFrom,
  isolatePushGate,
  pushPermitsFor,
  type CommitPushInput,
  type IngestResult,
  type IngestStore,
  type RepoMetaData,
} from "./RepoObject.ts";
import { incomingKey, wirePackId } from "./Store/Keys.ts";
import { sliceRandomAccess } from "./Store/PackSource.ts";

const path = (repo: RepoMetaData) => ({ owner: repo.owner, repo: repo.name });

const asStoreError = (error: {
  readonly _tag: string;
  readonly reason?: string;
}) =>
  error instanceof StoreError
    ? error
    : new StoreError({
        reason: `${error._tag}${error.reason === undefined ? "" : `: ${error.reason}`}`,
      });

const scopedMutation = <A, E, R>(
  updates: ReadonlyArray<RefUpdate>,
  commit: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    let active = true;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        active = false;
      }),
    );
    return Object.freeze({
      updates: Object.freeze(
        updates.map((update) => Object.freeze({ ...update })),
      ),
      commit: Effect.suspend<A, E | StoreError, R>(() => {
        if (!active) return Effect.fail(invalidPush());
        active = false;
        return commit;
      }),
    });
  });

const make = Effect.gen(function* () {
  const operations = yield* Operations;
  const repos = yield* RepoStore;
  const blobs = yield* BlobStore;
  const hasher = yield* Hasher;
  const gate = yield* isolatePushGate;
  const owner = {};

  const get = (path: { readonly owner: string; readonly repo: string }) =>
    Effect.gen(function* () {
      const name = {
        owner: path.owner.toLowerCase(),
        repo: path.repo.toLowerCase().replace(/\.git$/, ""),
      };
      const entry = yield* operations.resolveCached(name.owner, name.repo);
      if (entry === undefined || entry.deletedAt !== null)
        return yield* new RepoNotFound(name);
      return yield* repos.getByName(entry.repoId).getRepoMeta();
    });

  const preparePush = (repo: RepoMetaData, input: PushInput) =>
    Effect.gen(function* () {
      const source = incomingStates.get(input);
      if (source === undefined || !source.active || source.claimed)
        return yield* invalidPush();
      source.claimed = true;
      const { feeder, receiving, packStart } = source;
      const stub = repos.getByName(repo.repoId);
      const staging: Array<Fiber.Fiber<void, StoreError>> = [];
      let active = true;
      let committed = false;
      let ingest: IngestResult | undefined;
      const receiveId = yield* ulid();
      const parkedKey = incomingKey(repo.repoId, receiveId);
      // Registered before ingest: cancellation and policy failure share the same owner.
      const begun = yield* Effect.acquireRelease(
        stub.beginPush({ commands: input.updates }),
        (begun) =>
          Effect.gen(function* () {
            active = false;
            if (begun._tag === "denied") return;
            yield* Fiber.interruptAll(staging.splice(0));
            if (committed) return;
            // Ask durable state before deleting bytes: an interrupted RPC may have committed.
            const keys = [
              parkedKey,
              ...(ingest?.resolvedKey?.split(",") ?? []),
            ].filter(Boolean);
            const packIds = keys.map((key) =>
              wirePackId(key.slice(key.lastIndexOf("/") + 1, -5)),
            );
            const aborted = yield* stub
              .abortPush(begun.pushId, packIds)
              .pipe(Effect.orElseSucceed(() => false));
            if (aborted) {
              yield* blobs.delete(keys).pipe(Effect.ignore);
            }
          }),
      );
      if (begun._tag === "denied")
        return yield* new PushDenied({
          ref: input.updates[0]?.ref ?? "",
          reason: begun.reason,
        });
      const pushId = begun.pushId;
      const permits = pushPermitsFor(source.declaredBytes);
      const acquired = yield* Effect.acquireRelease(
        Semaphore.take(gate, permits).pipe(
          Effect.timeoutOption(PUSH_WAIT_TIMEOUT),
        ),
        (acquired) =>
          Option.isSome(acquired)
            ? Semaphore.release(gate, permits)
            : Effect.void,
      );
      if (Option.isNone(acquired))
        return yield* new StoreError({ reason: "push admission timed out" });
      const started = Date.now();
      const stageGate = yield* Semaphore.make(6);
      const bases = new Map<
        string,
        Effect.Success<ReturnType<typeof stub.readPushBase>>
      >();
      const store: IngestStore = {
        insertStagedBatch: (id, objects) =>
          Effect.gen(function* () {
            const encoded = encodeStagedBatch(objects);
            const fiber = yield* Effect.forkDetach(
              Semaphore.withPermits(
                stageGate,
                1,
              )(
                stub
                  .stagePush(id, encoded)
                  .pipe(
                    Effect.mapError(asStoreError),
                    Effect.provide(RuntimeContext.phantom),
                  ),
              ),
            );
            staging.push(fiber);
          }),
        settle: Effect.gen(function* () {
          for (const fiber of staging) yield* Fiber.join(fiber);
          staging.length = 0;
        }),
        readBase: (oid) =>
          bases.has(oid)
            ? Effect.succeed(bases.get(oid))
            : stub.readPushBase(oid).pipe(
                Effect.mapError(asStoreError),
                Effect.tap((value) =>
                  Effect.sync(() => {
                    bases.set(oid, value);
                  }),
                ),
                Effect.provide(RuntimeContext.phantom),
              ),
      };
      const probe = yield* feeder.source.read(packStart, 12);
      if (probe.length > 0 && probe.length < 12) {
        return yield* new StoreError({ reason: "truncated pack header" });
      }
      const hasPack = probe.length === 12;
      if (hasPack) {
        ingest = yield* ingestPackFrom(
          sliceRandomAccess(feeder.source, packStart),
          {
            store,
            pushId,
            hasher,
            spill: {
              body: feeder.source,
              feeder,
              packStart,
              blobs,
              key: parkedKey,
              packId: wirePackId(receiveId),
              repoId: repo.repoId,
              threshold: MAX_PACK_BYTES,
            },
          },
        );
      }
      if (store.settle) yield* store.settle;
      const received = yield* Fiber.join(receiving).pipe(
        Effect.flatMap(Effect.fromResult),
      );
      const commitInput: CommitPushInput = {
        pushId,
        commands: input.updates,
        atomic: input.atomic,
        commits: ingest?.commits ?? [],
        referenced: ingest?.referenced ?? [],
        referencedParents: ingest?.referencedParents ?? [],
        promoted: ingest?.promoted ?? 0,
        stats: {
          objects: ingest?.objectCount ?? 0,
          bytes: hasPack ? received.total - packStart : 0,
          ingestMs: Date.now() - started,
          stageMs: ingest?.stageMs ?? 0,
          phases: ingest?.phases,
        },
      };
      // Connectivity is checked before application validation, then again at commit.
      yield* stub.validatePush(commitInput).pipe(Effect.mapError(asStoreError));
      const prepared: PreparedPush = Object.freeze({
        repo: Object.freeze({ ...repo }),
        updates: input.updates,
        readObject: (oid: string, maxBytes = 1024 * 1024) =>
          Effect.suspend(() =>
            !active || !source.active
              ? Effect.fail(invalidPush())
              : stub
                  .readPreparedObject(pushId, oid, maxBytes)
                  .pipe(Effect.mapError(asStoreError)),
          ),
      });
      preparedStates.set(prepared, {
        owner,
        commit: Effect.suspend(() => {
          if (!active || !source.active) return Effect.fail(invalidPush());
          active = false;
          return stub.commitPush(commitInput).pipe(
            Effect.mapError(asStoreError),
            Effect.tap((result) =>
              Effect.sync(() => {
                committed = result.results.some((ref) => ref.ok);
              }),
            ),
          );
        }),
      });
      return prepared;
    });

  const commitPush = (prepared: PreparedPush) =>
    Effect.suspend(() => {
      const state = preparedStates.get(prepared);
      return state?.owner === owner ? state.commit : Effect.fail(invalidPush());
    });

  const prepareRefUpdate = (
    repo: RepoMetaData,
    input: {
      readonly ref: string;
      readonly newOid: string;
      readonly expectedOid?: string | null;
    },
  ) =>
    Effect.gen(function* () {
      const stub = repos.getByName(repo.repoId);
      const current = yield* stub.getRef(input.ref).pipe(
        Effect.map((ref) => ref.oid),
        Effect.catchTag("RefNotFound", () => Effect.succeed("0".repeat(40))),
      );
      if (
        input.expectedOid !== undefined &&
        input.expectedOid !== (current === "0".repeat(40) ? null : current)
      )
        return yield* new RefConflict({
          ref: input.ref,
          currentOid: current as import("./Api.ts").Oid,
        });
      const update = { ref: input.ref, oldOid: current, newOid: input.newOid };
      const commit = stub.updateRef({
        name: input.ref,
        newOid: input.newOid,
        expectedOid: current === "0".repeat(40) ? null : current,
      });
      return yield* scopedMutation([update], commit);
    });

  const prepareRefRemoval = (
    repo: RepoMetaData,
    input: { readonly ref: string; readonly expectedOid?: string },
  ) =>
    Effect.gen(function* () {
      const stub = repos.getByName(repo.repoId);
      const current = yield* stub.getRef(input.ref);
      if (input.expectedOid !== undefined && input.expectedOid !== current.oid)
        return yield* new RefConflict({
          ref: input.ref,
          currentOid: current.oid as import("./Api.ts").Oid,
        });
      return yield* scopedMutation(
        [{ ref: input.ref, oldOid: current.oid, newOid: "0".repeat(40) }],
        stub.removeRef({ name: input.ref, expectedOid: current.oid }),
      );
    });

  const prepareMerge = (
    repo: RepoMetaData,
    input: Parameters<ReturnType<typeof repos.getByName>["mergePull"]>[0],
  ) =>
    Effect.gen(function* () {
      const stub = repos.getByName(repo.repoId);
      const pull = yield* stub.getPull(input.number);
      return yield* scopedMutation(
        [
          {
            ref: pull.baseRef,
            oldOid: pull.baseOid ?? "0".repeat(40),
            newOid: pull.headOid ?? "0".repeat(40),
          },
        ],
        stub.mergePull({
          ...input,
          expectedBaseOid: pull.baseOid ?? "0".repeat(40),
          expectedHeadOid:
            input.expectedHeadOid ?? pull.headOid ?? "0".repeat(40),
        }),
      );
    });

  // These operate on repository data; authorization is composed by the caller.
  return {
    repositories: {
      get,
      create: (
        payload: Parameters<typeof operations.repos.create>[0]["payload"],
      ) => operations.repos.create({ payload }),
      list: (query: Parameters<typeof operations.repos.list>[0]["query"]) =>
        operations.repos.list({ query }),
      update: (
        repo: RepoMetaData,
        payload: Parameters<typeof operations.repos.update>[0]["payload"],
      ) => operations.repos.update({ params: path(repo), payload }),
      remove: (repo: RepoMetaData) =>
        operations.repos.delete({ params: path(repo) }),
      fork: (
        repo: RepoMetaData,
        payload: Parameters<typeof operations.repos.fork>[0]["payload"],
      ) => operations.repos.fork({ params: path(repo), payload }),
      import: (
        payload: Parameters<typeof operations.repos.import>[0]["payload"],
      ) => operations.repos.import({ payload }),
      compact: (repo: RepoMetaData) =>
        operations.repos.compact({ params: path(repo) }),
    },
    refs: {
      list: (repo: RepoMetaData) => repos.getByName(repo.repoId).listRefs(),
      get: (repo: RepoMetaData, name: string) =>
        repos.getByName(repo.repoId).getRef(name),
      update: (
        repo: RepoMetaData,
        input: Parameters<ReturnType<typeof repos.getByName>["updateRef"]>[0],
      ) => repos.getByName(repo.repoId).updateRef(input),
      remove: (
        repo: RepoMetaData,
        input: Parameters<ReturnType<typeof repos.getByName>["removeRef"]>[0],
      ) => repos.getByName(repo.repoId).removeRef(input),
    },
    pulls: {
      create: (
        repo: RepoMetaData,
        payload: Parameters<typeof operations.pulls.create>[0]["payload"],
      ) => operations.pulls.create({ params: path(repo), payload }),
      list: (
        repo: RepoMetaData,
        query: Parameters<typeof operations.pulls.list>[0]["query"],
      ) => operations.pulls.list({ params: path(repo), query }),
      update: (
        repo: RepoMetaData,
        number: number,
        payload: Parameters<typeof operations.pulls.update>[0]["payload"],
      ) =>
        operations.pulls.update({ params: { ...path(repo), number }, payload }),
      get: (repo: RepoMetaData, number: number) =>
        repos.getByName(repo.repoId).getPull(number),
      merge: (
        repo: RepoMetaData,
        input: Parameters<ReturnType<typeof repos.getByName>["mergePull"]>[0],
      ) => repos.getByName(repo.repoId).mergePull(input),
    },
    objects: {
      commit: (repo: RepoMetaData, oid: string) =>
        operations.objects.commit({
          params: { ...path(repo), oid: oid as import("./Api.ts").Oid },
        }),
      file: (
        repo: RepoMetaData,
        input: Parameters<
          ReturnType<typeof repos.getByName>["readFileAtPath"]
        >[0],
      ) => repos.getByName(repo.repoId).readFileAtPath(input),
      log: (
        repo: RepoMetaData,
        query: Parameters<typeof operations.objects.log>[0]["query"],
      ) => operations.objects.log({ params: path(repo), query }),
      tree: (
        repo: RepoMetaData,
        oid: Parameters<typeof operations.objects.tree>[0]["params"]["oid"],
      ) => operations.objects.tree({ params: { ...path(repo), oid } }),
      diff: (
        repo: RepoMetaData,
        oid: Parameters<typeof operations.objects.diff>[0]["params"]["oid"],
      ) => operations.objects.diff({ params: { ...path(repo), oid } }),
      compare: (
        repo: RepoMetaData,
        query: Parameters<typeof operations.objects.compare>[0]["query"],
      ) => operations.objects.compare({ params: path(repo), query }),
      read: (repo: RepoMetaData, oid: string) =>
        repos.getByName(repo.repoId).readPushBase(oid),
    },
    preparePush,
    commitPush,
    prepareRefUpdate,
    prepareRefRemoval,
    prepareMerge,
  };
});

/** Git operations usable from HTTP handlers, jobs, and ordinary Effects. */
export class Engine extends Context.Service<
  Engine,
  Effect.Success<typeof make>
>()("alchemy/Git/Engine") {}

/**
 * Provides the Git engine using the application's repository, registry, blob, and hasher layers.
 *
 * @layer
 * @provides Git.Engine
 */
export const EngineLive = Layer.effect(Engine, make).pipe(
  Layer.provideMerge(OperationsLive),
);
