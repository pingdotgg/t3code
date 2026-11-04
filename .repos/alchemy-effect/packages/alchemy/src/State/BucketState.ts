import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { decodeFqn, encodeFqn } from "../FQN.ts";
import { STATE_STORE_VERSION } from "./HttpStateApi.ts";
import { StateStoreError, type PersistedState, type StateService } from "./State.ts";
import { encodeState, reviveState } from "./StateEncoding.ts";

/**
 * A state store over an object storage bucket (S3, Cloud Storage, …).
 *
 * The store is laid out exactly like the local state store's file tree,
 * with the bucket (plus an optional prefix) in place of `.alchemy/state`:
 *
 * ```
 * {prefix}{stack}/{stage}/{fqn}.json
 * {prefix}{stack}/{stage}/__stack_output__.json
 * {prefix}{stack}/{stage}/__lease__.json
 * ```
 *
 * Concurrent deploys of one stack and stage share the `__lease__.json`
 * object, written with conditional puts. The second deploy fails
 * immediately instead of mixing rows. The holder refreshes the lease until
 * the store closes; a killed process stops refreshing, the lease expires,
 * and the next deploy can take it.
 *
 * Each backend supplies a {@link BucketObjects}: plain object operations
 * plus a version token (an S3 ETag, a Cloud Storage generation) for the
 * conditional writes the lease needs.
 */

/** The bookkeeping object that stores a stack's resolved output. */
const OUTPUT_FILE = "__stack_output__.json";

/**
 * Per `(stack, stage)` lease. A delete of the stage leaves it in place so
 * the lock outlives the objects it was guarding; the store deletes it on
 * close.
 */
/** The lease token `alchemy state migrate` leaves on a stage it moved to DynamoDB. */
const MIGRATED_TOKEN = "migrated:dynamodb";

const LEASE_FILE = "__lease__.json";

/** How long a lease stays valid without a refresh. */
const LEASE_TTL_MS = 60_000;

/** How long a passing lease check is trusted. A failure is never cached. */
const LEASE_CHECK_TTL_MS = 5_000;

/** A write condition, in terms of the backend's version token. */
export type WriteCondition =
  /** Only create the object; fail if it exists. */
  | { readonly ifAbsent: true }
  /** Only overwrite the object at exactly this version. */
  | { readonly ifVersion: string };

/**
 * The object operations a bucket backend implements. Every operation is
 * self-contained (`R = never`) and fails with {@link StateStoreError}.
 */
export interface BucketObjects {
  /** Every key under `prefix`, across pagination. */
  readonly listKeys: (prefix: string) => Effect.Effect<ReadonlyArray<string>, StateStoreError>;
  /**
   * The immediate "directory" names under `prefix` (delimiter `/`), without
   * the prefix or the trailing slash.
   */
  readonly listChildren: (prefix: string) => Effect.Effect<ReadonlyArray<string>, StateStoreError>;
  /** An object's text and version, or `undefined` when it doesn't exist. */
  readonly read: (
    key: string,
  ) => Effect.Effect<
    { readonly text: string; readonly version: string } | undefined,
    StateStoreError
  >;
  /**
   * Write an object. Returns its new version, or `undefined` when
   * `condition` did not hold.
   */
  readonly write: (
    key: string,
    body: string,
    condition?: WriteCondition,
  ) => Effect.Effect<string | undefined, StateStoreError>;
  /**
   * Delete an object, only at `ifVersion` when given. Deleting a missing
   * object, or one at another version, succeeds without deleting.
   */
  readonly delete: (key: string, ifVersion?: string) => Effect.Effect<void, StateStoreError>;
  /** Delete many objects. Missing objects are ignored. */
  readonly deleteMany: (keys: ReadonlyArray<string>) => Effect.Effect<void, StateStoreError>;
}

export interface BucketStateOptions {
  /** The store's id, e.g. `"s3"` or `"gcs"`. */
  readonly id: string;
  /** How errors name the store, e.g. `"S3"` or `"Cloud Storage"`. */
  readonly label: string;
  /** Key prefix within the bucket. A trailing `/` is added. */
  readonly prefix?: string;
  /**
   * The bucket's objects. Runs once, on the first state operation, and is
   * cached: ensure the bucket exists here, never at construction.
   */
  readonly objects: Effect.Effect<BucketObjects, StateStoreError>;
}

/**
 * Tokens of the leases this process holds, so a conflict with one of them
 * can say the holder is an earlier, still-open build in the same process.
 */
const heldInProcess = new Set<string>();

interface LeaseRecord {
  readonly token: string;
  readonly expiresAt: number;
}

interface HeldLease {
  readonly checkLive: Effect.Effect<void, StateStoreError>;
}

/**
 * A passing check is trusted for `ttlMs`, so a burst of operations does
 * one round-trip. A failing check is never cached.
 */
const amortizeCheck = (
  checkLive: Effect.Effect<void, StateStoreError>,
  ttlMs: number,
): Effect.Effect<void, StateStoreError> => {
  let lastOkAt: number | undefined;
  return Effect.suspend(() => {
    if (lastOkAt !== undefined && Date.now() - lastOkAt < ttlMs) {
      return Effect.void;
    }
    return checkLive.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          lastOkAt = Date.now();
        }),
      ),
    );
  });
};

const parseLease = (text: string): LeaseRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return typeof parsed === "object" &&
    parsed !== null &&
    "token" in parsed &&
    "expiresAt" in parsed &&
    typeof parsed.token === "string" &&
    typeof parsed.expiresAt === "number"
    ? { token: parsed.token, expiresAt: parsed.expiresAt }
    : { token: "", expiresAt: 0 };
};

/**
 * Construct a bucket-backed {@link StateService}. Leases are bound to the
 * ambient scope; callers that need them to outlive the first operation
 * bind this effect to a longer scope with `Scope.provide`.
 */
export const makeBucketState = (options: BucketStateOptions) =>
  Effect.gen(function* () {
    const leaseScope = yield* Effect.scope;
    const prefix = options.prefix ? `${options.prefix.replace(/\/+$/, "")}/` : "";
    const objects = yield* Effect.cached(options.objects);
    const use = <A>(
      f: (objects: BucketObjects) => Effect.Effect<A, StateStoreError>,
    ): Effect.Effect<A, StateStoreError> => objects.pipe(Effect.flatMap(f));

    const stagePrefix = ({ stack, stage }: { stack: string; stage: string }) =>
      `${prefix}${stack}/${stage}/`;
    const resourceKey = (request: { stack: string; stage: string; fqn: string }) =>
      `${stagePrefix(request)}${encodeFqn(request.fqn)}.json`;
    const outputKey = (request: { stack: string; stage: string }) =>
      `${stagePrefix(request)}${OUTPUT_FILE}`;
    const leaseKey = (request: { stack: string; stage: string }) =>
      `${stagePrefix(request)}${LEASE_FILE}`;

    const readJson = <T>(key: string) =>
      use((o) => o.read(key)).pipe(
        Effect.flatMap((object) =>
          object === undefined
            ? Effect.undefined
            : Effect.try({
                try: () => JSON.parse(object.text, reviveState) as T,
                catch: (cause) =>
                  new StateStoreError({
                    message: `Failed to parse state object '${key}'`,
                    cause: cause instanceof Error ? cause : undefined,
                  }),
              }),
        ),
      );

    const writeJson = (key: string, value: unknown) =>
      use((o) => o.write(key, JSON.stringify(encodeState(value), null, 2)));

    /** Delete every object under `keyPrefix`, except leases. Idempotent. */
    const deleteAll = (keyPrefix: string) =>
      use((o) =>
        o.listKeys(keyPrefix).pipe(
          // Leave the lease object. Releasing it here would open the stage
          // before this delete finishes, and the store still holds the lock.
          Effect.map((keys) => keys.filter((key) => !key.endsWith(`/${LEASE_FILE}`))),
          Effect.flatMap((keys) => (keys.length === 0 ? Effect.void : o.deleteMany(keys))),
        ),
      );

    const heldError = (stack: string, stage: string, holder: string | undefined) =>
      // The message always starts "another deploy holds": callers match on it
      // (the AWS migration tells a held stage from a failed one by it).
      new StateStoreError({
        message:
          holder !== undefined && heldInProcess.has(holder)
            ? `another deploy holds the ${options.label} state lock '${stack}/${stage}': this process holds it, from an earlier operation on this stage that is still open. Run each operation in its own Effect.scoped so its build closes first.`
            : `another deploy holds the ${options.label} state lock '${stack}/${stage}'`,
      });

    const lostError = (stack: string, stage: string) =>
      new StateStoreError({
        message: `the ${options.label} state lock '${stack}/${stage}' was lost mid-run; refusing to continue unlocked`,
      });

    const readLease = (key: string) =>
      use((o) => o.read(key)).pipe(
        Effect.map((object) =>
          object === undefined
            ? undefined
            : { version: object.version, record: parseLease(object.text) },
        ),
      );

    const putLease = (key: string, record: LeaseRecord, condition: WriteCondition) =>
      use((o) => o.write(key, JSON.stringify(record), condition));

    const acquireLease = (stack: string, stage: string) =>
      Effect.gen(function* () {
        const key = leaseKey({ stack, stage });
        const token = yield* Effect.sync(() => crypto.randomUUID());
        const now = yield* Clock.currentTimeMillis;
        const fresh: LeaseRecord = { token, expiresAt: now + LEASE_TTL_MS };
        let version = yield* putLease(key, fresh, { ifAbsent: true });
        if (version === undefined) {
          const existing = yield* readLease(key);
          const stillHeld = existing === undefined || existing.record.expiresAt > now;
          if (existing?.record.token === MIGRATED_TOKEN) {
            return yield* new StateStoreError({
              message: `${heldError(stack, stage, undefined).message}: the stage moved to a DynamoDB state store. Deploy it with a version of alchemy that has AWS.state() on DynamoDB, or run 'alchemy state migrate --rollback' with that version to move it back.`,
            });
          }
          if (stillHeld) {
            return yield* heldError(stack, stage, existing?.record.token);
          }
          const replaced = yield* putLease(key, fresh, { ifVersion: existing.version });
          if (replaced === undefined) {
            return yield* heldError(stack, stage, undefined);
          }
          version = replaced;
        }

        heldInProcess.add(token);
        const cursor = { version, lost: false };
        const gate = Semaphore.makeUnsafe(1);

        const renew = Semaphore.withPermits(
          gate,
          1,
        )(
          Effect.gen(function* () {
            if (cursor.lost) return;
            const renewedAt = yield* Clock.currentTimeMillis;
            const next = yield* putLease(
              key,
              { token, expiresAt: renewedAt + LEASE_TTL_MS },
              { ifVersion: cursor.version },
            );
            if (next === undefined) cursor.lost = true;
            else cursor.version = next;
          }),
        ).pipe(
          Effect.retry({
            while: () => !cursor.lost,
            schedule: Schedule.spaced("1 second"),
            times: 3,
          }),
          Effect.catch(() =>
            Effect.sync(() => {
              cursor.lost = true;
            }),
          ),
        );

        const verify = Semaphore.withPermits(
          gate,
          1,
        )(
          Effect.gen(function* () {
            if (cursor.lost) return yield* lostError(stack, stage);
            const existing = yield* readLease(key);
            if (existing === undefined || existing.record.token !== token) {
              cursor.lost = true;
              return yield* lostError(stack, stage);
            }
            const observedAt = yield* Clock.currentTimeMillis;
            if (existing.record.expiresAt <= observedAt) {
              // The lease lapsed without anyone taking it: a refresh queued
              // behind a large deploy's writes missed its window. Take it
              // back at the version we read, so a deploy that took it in
              // the meantime wins and this one stops.
              const reclaimed = yield* putLease(
                key,
                { token, expiresAt: observedAt + LEASE_TTL_MS },
                { ifVersion: existing.version },
              );
              if (reclaimed === undefined) {
                cursor.lost = true;
                return yield* lostError(stack, stage);
              }
              cursor.version = reclaimed;
              return;
            }
            cursor.version = existing.version;
          }),
        );

        // Interrupt the refresh before releasing, so a refresh cannot
        // land after the lease has been released.
        yield* Scope.addFinalizer(
          leaseScope,
          Semaphore.withPermits(
            gate,
            1,
          )(
            Effect.gen(function* () {
              cursor.lost = true;
              heldInProcess.delete(token);
              // Read the version we actually hold. A refresh that landed
              // after the cursor was last stored would make a release
              // against the old version a no-op, and the lease would stay.
              const existing = yield* readLease(key);
              if (existing === undefined || existing.record.token !== token) return;
              // Delete rather than expire: a leftover lease object would keep
              // a destroyed stage listed by `listStages`.
              yield* use((o) => o.delete(key, existing.version));
            }).pipe(Effect.ignore),
          ),
        );
        yield* renew.pipe(
          Effect.delay(Duration.millis(Math.floor(LEASE_TTL_MS / 3))),
          Effect.forever,
          Effect.interruptible,
          Effect.forkIn(leaseScope),
        );

        return { checkLive: amortizeCheck(verify, LEASE_CHECK_TTL_MS) } satisfies HeldLease;
      });

    // One lease per (stack, stage), taken on the first operation and held
    // for the store's lifetime. The mutex keeps two concurrent first
    // operations in this process from contending with each other.
    const leaseMutex = Semaphore.makeUnsafe(1);
    const leases = new Map<string, Effect.Effect<HeldLease, StateStoreError>>();

    const leaseFor = (stack: string, stage: string): Effect.Effect<HeldLease, StateStoreError> =>
      Semaphore.withPermits(
        leaseMutex,
        1,
      )(
        Effect.gen(function* () {
          const key = `${stack}/${stage}`;
          const existing = leases.get(key);
          if (existing !== undefined) return existing;
          // Drop a failed acquire. Caching it would make the next operation
          // report the same holder after that holder has gone.
          const cached = yield* Effect.cached(
            acquireLease(stack, stage).pipe(
              Effect.tapError(() =>
                Effect.sync(() => {
                  if (leases.get(key) === cached) {
                    leases.delete(key);
                  }
                }),
              ),
            ),
          );
          leases.set(key, cached);
          return cached;
        }),
      ).pipe(Effect.flatMap((lease) => lease));

    const guarded = <A>(
      request: { stack: string; stage: string },
      op: Effect.Effect<A, StateStoreError>,
    ): Effect.Effect<A, StateStoreError> =>
      leaseFor(request.stack, request.stage).pipe(
        Effect.flatMap((lease) => lease.checkLive),
        Effect.andThen(op),
      );

    const verifyHeldLeases: Effect.Effect<void, StateStoreError> = Effect.suspend(() =>
      Effect.forEach(
        Array.from(leases.values()),
        (lease) => lease.pipe(Effect.flatMap((held) => held.checkLive)),
        { discard: true },
      ),
    );

    const listChildren = (keyPrefix: string) =>
      use((o) => o.listChildren(keyPrefix)).pipe(Effect.map((names) => Array.from(names)));

    const state: StateService = {
      id: options.id,
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () => verifyHeldLeases.pipe(Effect.andThen(listChildren(prefix))),
      listStages: (stack: string) =>
        verifyHeldLeases.pipe(Effect.andThen(listChildren(`${prefix}${stack}/`))),
      get: (request) => guarded(request, readJson<PersistedState>(resourceKey(request))),
      getReplacedResources: Effect.fn(function* (request) {
        return (yield* Effect.forEach(yield* state.list(request), (fqn) =>
          state.get({
            stack: request.stack,
            stage: request.stage,
            fqn,
          }),
        )).filter((r) => r?.status === "replaced");
      }),
      set: (request) =>
        guarded(
          request,
          writeJson(resourceKey(request), request.value).pipe(Effect.as(request.value)),
        ),
      delete: (request) =>
        guarded(
          request,
          use((o) => o.delete(resourceKey(request))),
        ),
      // A stack-wide delete locks every stage it is about to remove, so a
      // concurrent deploy fails the lease instead of racing the delete.
      deleteStack: ({ stack, stage }) =>
        stage === undefined
          ? verifyHeldLeases.pipe(
              Effect.andThen(state.listStages(stack)),
              Effect.flatMap((stages) =>
                Effect.forEach(
                  stages,
                  (found) =>
                    guarded(
                      { stack, stage: found },
                      deleteAll(stagePrefix({ stack, stage: found })),
                    ),
                  { discard: true },
                ),
              ),
              Effect.andThen(deleteAll(`${prefix}${stack}/`)),
            )
          : guarded({ stack, stage }, deleteAll(stagePrefix({ stack, stage }))),
      list: (request) =>
        guarded(
          request,
          use((o) => o.listKeys(stagePrefix(request))).pipe(
            Effect.map((keys) =>
              keys
                .map((key) => key.slice(stagePrefix(request).length))
                // Filter bookkeeping before decoding — `decodeFqn` replaces
                // `__` with `/`, which would turn `__stack_output__` into
                // `/stack_output/` and slip past the filter.
                .filter(
                  (file) => file !== OUTPUT_FILE && file !== LEASE_FILE && file.endsWith(".json"),
                )
                .map((file) => decodeFqn(file.replace(/\.json$/, ""))),
            ),
          ),
        ),
      getOutput: (request) => guarded(request, readJson(outputKey(request))),
      setOutput: (request) =>
        guarded(
          request,
          writeJson(outputKey(request), request.value).pipe(Effect.as(request.value)),
        ),
    };
    return state;
  });
