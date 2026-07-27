import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { CredentialsStoreLive } from "../../Auth/Credentials.ts";
import { decodeFqn, encodeFqn } from "../../FQN.ts";
import { STATE_STORE_VERSION } from "../../State/HttpStateApi.ts";
import {
  State,
  StateStoreError,
  type PersistedState,
  type StateService,
} from "../../State/State.ts";
import { encodeState, reviveState } from "../../State/StateEncoding.ts";
import { recordStateStoreInit } from "../../Telemetry/Metrics.ts";
import { AwsAuth } from "../AuthProvider.ts";
import * as AwsCredentials from "../Credentials.ts";
import * as Endpoint from "../Endpoint.ts";
import {
  AWSEnvironment,
  Default as DefaultEnvironment,
} from "../Environment.ts";
import * as AwsRegion from "../Region.ts";

/**
 * The bookkeeping object that stores a stack's resolved output. Lives
 * alongside the resource objects under the same stage prefix, so it
 * must be filtered out of `list` results before FQN decoding.
 */
const OUTPUT_FILE = "__stack_output__.json";

/** Maximum number of keys S3 accepts in a single DeleteObjects call. */
const DELETE_BATCH_SIZE = 1000;

export interface S3StateOptions {
  /**
   * Name of the S3 bucket that holds the state objects. The bucket is
   * created on first use if it does not exist.
   *
   * The bucket is created in the account-regional namespace, so custom
   * names must follow the `<prefix>-<accountId>-<region>-an` convention.
   *
   * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/gpbucketnamespaces.html#account-regional-gp-buckets
   * @default `alchemy-state-{accountId}-{region}-an`
   */
  bucketName?: string;
  /**
   * Key prefix within the bucket under which all state objects are
   * stored, e.g. `"alchemy"`. A trailing `/` is appended automatically.
   *
   * @default "" (bucket root)
   */
  prefix?: string;
}

/** Context required by the distilled S3 operations. */
type S3Deps = Credentials | HttpClient | Region;

/**
 * State store backed by an AWS S3 bucket.
 *
 * Stack state is persisted as JSON objects in an account-regional S3
 * bucket, laid out exactly like the local state store's file tree with
 * the bucket (plus optional `prefix`) taking the place of the
 * `.alchemy/state` directory:
 *
 * ```
 * s3://{bucket}/{prefix}{stack}/{stage}/{fqn}.json
 * s3://{bucket}/{prefix}{stack}/{stage}/__stack_output__.json
 * ```
 *
 * The bucket is created lazily on the first state operation if it does
 * not already exist — nothing touches AWS credentials at layer
 * construction time.
 *
 * @resource
 *
 * @section Using the S3 State Store
 * Pass `AWS.state()` as the `state` option of a Stack. By default the
 * state is stored in an account-regional bucket named
 * `alchemy-state-{accountId}-{region}-an`.
 *
 * @example Default bucket
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 *
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   { providers: AWS.providers(), state: AWS.state() },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * @example Custom bucket and key prefix
 * ```typescript
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: AWS.providers(),
 *     state: AWS.state({
 *       bucketName: "my-company-state",
 *       prefix: "alchemy",
 *     }),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 */
export const state = (options: S3StateOptions = {}) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const context = yield* Effect.context<S3Deps | AWSEnvironment>();

      const make = makeS3State(options).pipe(
        recordStateStoreInit,
        Effect.orDie,
        Effect.provideContext(context),
      );

      return yield* Effect.cached(make);
    }),
  ).pipe(
    Layer.provideMerge(AwsRegion.fromEnvironment),
    Layer.provideMerge(AwsCredentials.fromEnvironment),
    Layer.provideMerge(Endpoint.fromEnvironment),
    Layer.provideMerge(DefaultEnvironment),
    Layer.provideMerge(AwsAuth),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );

/**
 * Construct an S3-backed {@link StateService}.
 *
 * Construction itself never touches AWS — environment resolution and
 * the ensure-bucket-exists check are deferred into a cached Effect
 * that runs once, on the first state operation.
 */
export const makeS3State = (options: S3StateOptions = {}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<S3Deps | AWSEnvironment>();

    const prefix = options.prefix
      ? `${options.prefix.replace(/\/+$/, "")}/`
      : "";

    const toError = (cause: unknown) =>
      new StateStoreError({
        message:
          cause instanceof Error
            ? cause.message
            : `S3 state store error: ${String(cause)}`,
        cause: cause instanceof Error ? cause : undefined,
      });

    // Anything that touches AWS credentials must NOT run at layer
    // construction time. Resolving the environment (account/region),
    // deriving the bucket name, and ensuring the bucket exists are all
    // deferred into this cached Effect: `Effect.cached` memoizes the
    // result and locks concurrent first callers onto a single in-flight
    // run, so the bucket is ensured exactly once — lazily, on first use
    // of the state store.
    const bucket = yield* Effect.cached(
      Effect.gen(function* () {
        const { accountId, region } = yield* AWSEnvironment.current;
        const bucketName =
          options.bucketName ?? createStateBucketName(accountId, region);
        yield* ensureStateBucket(bucketName, region);
        return bucketName;
      }).pipe(Effect.provideContext(context), Effect.mapError(toError)),
    );

    // Close over the captured context so every StateService method is
    // self-contained (`R = never`), matching the StateService contract.
    const run = <A, E>(
      f: (bucket: string) => Effect.Effect<A, E, S3Deps>,
    ): Effect.Effect<A, StateStoreError> =>
      bucket.pipe(
        Effect.flatMap((bucket) =>
          f(bucket).pipe(
            Effect.provideContext(context),
            Effect.mapError(toError),
          ),
        ),
      );

    const stagePrefix = ({ stack, stage }: { stack: string; stage: string }) =>
      `${prefix}${stack}/${stage}/`;

    const resourceKey = (request: {
      stack: string;
      stage: string;
      fqn: string;
    }) => `${stagePrefix(request)}${encodeFqn(request.fqn)}.json`;

    const outputKey = (request: { stack: string; stage: string }) =>
      `${stagePrefix(request)}${OUTPUT_FILE}`;

    /** All object keys under `keyPrefix`, across pagination. */
    const listKeys = (bucket: string, keyPrefix: string) =>
      s3.listObjectsV2.pages({ Bucket: bucket, Prefix: keyPrefix }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.Contents ?? [])),
        Stream.map((object) => object.Key),
        Stream.filter((key): key is string => key !== undefined),
        Stream.runCollect,
        Effect.map((keys) => Array.from(keys)),
      );

    /**
     * Immediate "subdirectory" names under `keyPrefix`, derived from
     * S3 CommonPrefixes (delimiter `/`), across pagination.
     */
    const listChildren = (bucket: string, keyPrefix: string) =>
      s3.listObjectsV2
        .pages({ Bucket: bucket, Prefix: keyPrefix, Delimiter: "/" })
        .pipe(
          Stream.flatMap((page) =>
            Stream.fromIterable(page.CommonPrefixes ?? []),
          ),
          // `{keyPrefix}{name}/` -> `{name}`
          Stream.map((common) => common.Prefix),
          Stream.filter((p): p is string => p !== undefined),
          Stream.map((p) => p.slice(keyPrefix.length, -1)),
          Stream.runCollect,
          Effect.map((names) => Array.from(names)),
        );

    /** Read and revive a JSON object; `undefined` when the key is absent. */
    const readJson = <T>(bucket: string, key: string) =>
      s3.getObject({ Bucket: bucket, Key: key }).pipe(
        Effect.flatMap((result) =>
          result.Body === undefined
            ? Effect.succeed(undefined)
            : Stream.mkString(Stream.decodeText(result.Body)).pipe(
                Effect.flatMap((text) =>
                  Effect.try({
                    try: () => JSON.parse(text, reviveState) as T,
                    catch: (cause) =>
                      new StateStoreError({
                        message: `Failed to parse state object '${key}'`,
                        cause: cause instanceof Error ? cause : undefined,
                      }),
                  }),
                ),
              ),
        ),
        Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
      );

    const writeJson = (bucket: string, key: string, value: unknown) =>
      s3.putObject({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(encodeState(value), null, 2),
        ContentType: "application/json",
      });

    /** Delete every object under `keyPrefix` in batches. Idempotent. */
    const deleteAll = (bucket: string, keyPrefix: string) =>
      Effect.gen(function* () {
        const keys = yield* listKeys(bucket, keyPrefix);
        for (let i = 0; i < keys.length; i += DELETE_BATCH_SIZE) {
          yield* s3.deleteObjects({
            Bucket: bucket,
            Delete: {
              Objects: keys
                .slice(i, i + DELETE_BATCH_SIZE)
                .map((Key) => ({ Key })),
              Quiet: true,
            },
          });
        }
      });

    const state: StateService = {
      id: "s3",
      getVersion: () => Effect.succeed(STATE_STORE_VERSION),
      listStacks: () => run((bucket) => listChildren(bucket, prefix)),
      listStages: (stack: string) =>
        run((bucket) => listChildren(bucket, `${prefix}${stack}/`)),
      get: (request) =>
        run((bucket) => readJson<PersistedState>(bucket, resourceKey(request))),
      getReplacedResources: Effect.fn(function* (request) {
        return (yield* Effect.all(
          (yield* state.list(request)).map((fqn) =>
            state.get({
              stack: request.stack,
              stage: request.stage,
              fqn,
            }),
          ),
        )).filter((r) => r?.status === "replaced");
      }),
      set: (request) =>
        run((bucket) =>
          writeJson(bucket, resourceKey(request), request.value),
        ).pipe(Effect.map(() => request.value)),
      delete: (request) =>
        run((bucket) =>
          s3.deleteObject({ Bucket: bucket, Key: resourceKey(request) }),
        ).pipe(Effect.asVoid),
      deleteStack: ({ stack, stage }) =>
        run((bucket) =>
          deleteAll(
            bucket,
            stage === undefined
              ? `${prefix}${stack}/`
              : stagePrefix({ stack, stage }),
          ),
        ),
      list: (request) =>
        run((bucket) => listKeys(bucket, stagePrefix(request))).pipe(
          Effect.map((keys) =>
            keys
              .map((key) => key.slice(stagePrefix(request).length))
              // Filter the bookkeeping file before decoding — `decodeFqn`
              // replaces `__` with `/`, which would turn the literal name
              // `__stack_output__` into `/stack_output/` and slip past
              // the filter, leaving the engine to look up a non-existent
              // resource.
              .filter((file) => file !== OUTPUT_FILE && file.endsWith(".json"))
              .map((file) => decodeFqn(file.replace(/\.json$/, ""))),
          ),
        ),
      getOutput: (request) =>
        run((bucket) => readJson(bucket, outputKey(request))),
      setOutput: (request) =>
        run((bucket) =>
          writeJson(bucket, outputKey(request), request.value),
        ).pipe(Effect.map(() => request.value)),
    };
    return state;
  });

/**
 * Build the default account-regional state bucket name.
 *
 * Account-regional buckets must follow the naming convention:
 *   `<prefix>-<accountId>-<region>-an`
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/gpbucketnamespaces.html#account-regional-gp-buckets
 */
export const createStateBucketName = (accountId: string, region: string) =>
  `alchemy-state-${accountId}-${region}-an`.toLowerCase();

/**
 * Observe-then-ensure the state bucket: head it, create it if missing
 * (tolerating create races), and wait for it to become available.
 */
const ensureStateBucket = (bucket: string, region: string) =>
  Effect.gen(function* () {
    // An absent bucket surfaces as either `NotFound` (the HEAD 404) or
    // `NoSuchBucket` depending on the namespace/path — treat both as "create
    // it". Catching only `NotFound` let a deleted state bucket (e.g. after a
    // nuke) escape as an uncaught `NoSuchBucket` instead of being recreated.
    const exists = yield* s3.headBucket({ Bucket: bucket }).pipe(
      Effect.map(() => true),
      Effect.catchTag(["NotFound", "NoSuchBucket"], () =>
        Effect.succeed(false),
      ),
    );
    if (exists) {
      return;
    }

    yield* Effect.logInfo(
      `S3 state store: creating bucket ${bucket} in ${region}`,
    );
    yield* s3
      .createBucket({
        Bucket: bucket,
        // account-regional namespace: the bucket name only needs to be
        // unique within this account+region, so deterministic default
        // names can't collide with other AWS customers.
        BucketNamespace: "account-regional",
        // us-east-1 rejects an explicit LocationConstraint
        ...(region === "us-east-1"
          ? {}
          : {
              CreateBucketConfiguration: {
                LocationConstraint: region as s3.BucketLocationConstraint,
              },
            }),
      })
      .pipe(
        // Many callers race to create the shared default state bucket on first
        // use. The loser sees the create already done
        // (`BucketAlreadyOwnedByYou`/`BucketAlreadyExists`) or mid-flight
        // (`OperationAborted` — "a conflicting conditional operation is in
        // progress"). All mean "someone else is creating it" — fall through to
        // the readiness wait.
        Effect.catchTag(
          [
            "BucketAlreadyOwnedByYou",
            "BucketAlreadyExists",
            "OperationAborted",
          ],
          () => Effect.void,
        ),
      );

    // Wait for the bucket to become available. Under a concurrent create the
    // bucket is briefly not yet head-able (NotFound/NoSuchBucket) and object
    // ops would race ahead of it — keep polling until HEAD succeeds.
    yield* s3
      .headBucket({ Bucket: bucket })
      .pipe(
        Effect.retry(
          Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(15)]),
        ),
      );
  }).pipe(
    // The whole observe→create→wait sequence races other first-callers of the
    // shared bucket; `OperationAborted` (conflicting create) and a transiently
    // absent bucket (`NoSuchBucket`/`NotFound`) are the faces of that race.
    // Retry the entire sequence so a concurrent create that is still settling
    // converges instead of surfacing as a `StateStoreError`.
    Effect.retry({
      while: (e) =>
        e._tag === "OperationAborted" ||
        e._tag === "NoSuchBucket" ||
        e._tag === "NotFound",
      schedule: Schedule.max([
        Schedule.spaced("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );
