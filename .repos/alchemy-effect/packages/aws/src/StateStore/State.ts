import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { type BucketObjects, makeBucketState } from "alchemy/State/BucketState";
import * as Provisioning from "alchemy/State/Provisioning";
import { State, StateStoreError } from "alchemy/State/State";
import { recordStateStoreInit } from "alchemy/Telemetry/Metrics";
import { globalLogs } from "alchemy/Util/LogRecord";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as LogLevel from "effect/LogLevel";
import * as References from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { AwsAuth } from "../AuthProvider.ts";
import * as AwsCredentials from "../Credentials.ts";
import * as Endpoint from "../Endpoint.ts";
import { AWSEnvironment, providedOrDefault } from "../Environment.ts";
import * as AwsRegion from "../Region.ts";
import { syncBucketEncryption, type BucketEncryption } from "../S3/Bucket.ts";

/** Maximum number of keys S3 accepts in a single DeleteObjects call. */
const DELETE_BATCH_SIZE = 1000;

export interface S3StateOptions {
  /**
   * A store other than the account's default, by logical name: its bucket is
   * `alchemy-state-<name>-<accountId>-<region>-an`. The bucket is created on
   * first use, except in CI, where `alchemy state bootstrap --backend aws
   * --name <name>` provisions it ahead.
   *
   * @default the account's default store, `alchemy-state-<accountId>-<region>-an`
   */
  name?: string;
  /**
   * A full bucket name instead of one derived from {@link S3StateOptions.name},
   * e.g. an existing bucket. Created on first use like a named store's, in the
   * account-regional namespace, so it must follow the
   * `<prefix>-<accountId>-<region>-an` convention.
   *
   * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/gpbucketnamespaces.html#account-regional-gp-buckets
   */
  bucketName?: string;
  /**
   * Key prefix within the bucket under which all state objects are
   * stored, e.g. `"alchemy"`. A trailing `/` is appended automatically.
   *
   * @default "" (bucket root)
   */
  prefix?: string;
  /**
   * Default encryption enforced on every fresh state-service initialization.
   * Omission restores AES256, no KMS key, bucket keys disabled, and no blocked
   * encryption types. Set `blockedEncryptionTypes: ["SSE-C"]` to block
   * customer-provided keys. Existing encrypted state objects are not rewritten.
   *
   * @default `{ sseAlgorithm: "AES256", bucketKeyEnabled: false, blockedEncryptionTypes: [] }`
   */
  encryption?: BucketEncryption;
}

/** Whether a state bucket exists. */
export const stateBucketExists = (bucket: string) =>
  s3.headBucket({ Bucket: bucket }).pipe(
    Effect.as(true),
    Effect.catchTag(["NotFound", "NoSuchBucket"], () => Effect.succeed(false)),
  );

/** Context required by the distilled S3 operations. */
type S3Deps = Credentials | HttpClient | Region;

/**
 * Run with Debug and Trace records switched off.
 *
 * The AWS client logs every request payload and parsed response at Debug. For
 * this store those are the serialized state objects, whose values include
 * secrets Alchemy generated and keeps, so a Debug floor inherited from where
 * the store is built (the CLI's run log sets one) must not reach them. Floors
 * already stricter than Info are left alone.
 */
export const withoutSdkDebugLogs = Effect.updateService(References.MinimumLogLevel, (level) =>
  LogLevel.isLessThan(level, "Info") ? "Info" : level,
);

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
 * s3://{bucket}/{prefix}{stack}/{stage}/__lease__.json
 * ```
 *
 * Concurrent deploys of one stack and stage share an `__lease__.json`
 * object written with `If-None-Match` / `If-Match`. The second deploy
 * fails immediately instead of mixing rows. The holder refreshes the
 * lease until the store closes. A killed process stops refreshing, the
 * lease expires, and the next deploy can take it.
 *
 * The bucket is created lazily on the first state operation if it does
 * not already exist — nothing touches AWS credentials at layer
 * construction time.
 *
 *
 * ### Using the S3 State Store
 * Pass `AWS.state({ backend: "s3" })` as the `state` option of a Stack. By
 * default the state is stored in an account-regional bucket named
 * `alchemy-state-{accountId}-{region}-an`.
 *
 * **Example:** Default bucket
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "@alchemy.run/aws";
 *
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   { providers: AWS.providers(), state: AWS.state({ backend: "s3" }) },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * **Example:** Custom bucket and key prefix
 * ```typescript
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: AWS.providers(),
 *     state: AWS.state({
 *       name: "my-company-state",
 *       prefix: "alchemy",
 *       encryption: {
 *         sseAlgorithm: "aws:kms",
 *         kmsMasterKeyId: "alias/alchemy-state",
 *       },
 *     }),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * ### Supplying the AWS Environment
 * The store resolves its account, region and credentials from the configured
 * profile, CI credentials or the ambient AWS environment. Provide an
 * `AWSEnvironment` to use another credential source; provide the same layer
 * to `AWS.providers()` so the state bucket and every resource share it.
 *
 * **Example:** Deploy-role credentials shared with the providers
 * ```typescript
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: AWS.providers().pipe(Layer.provide(environment)),
 *     state: AWS.state({ name: "my-company-state" }).pipe(Layer.provide(environment)),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * ### Managing SSE-C Restrictions
 * **Example:** Block customer-provided encryption keys on the state bucket
 * ```typescript
 * const stateStore = AWS.state({
 *   encryption: {
 *     sseAlgorithm: "AES256",
 *     blockedEncryptionTypes: ["SSE-C"],
 *   },
 * });
 * ```
 *
 * Omitted `blockedEncryptionTypes` is equivalent to `[]`: no encryption types
 * are blocked, so SSE-C writes are permitted via AWS's `NONE` value. Removing
 * an explicit block clears it. Omitting `encryption` restores AES256, no KMS
 * key, disabled bucket keys, and no encryption restrictions. Existing objects
 * are not rewritten.
 */
export const s3State = (options: S3StateOptions = {}) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<S3Deps | AWSEnvironment>();

      // Bind the lease to this layer's scope. The cached effect runs on
      // the first state operation, which may sit in a shorter scope.
      const make = Scope.provide(makeS3State(options), scope).pipe(
        recordStateStoreInit,
        // Account-level: filed in the global run log, not the project's.
        globalLogs,
        Effect.orDie,
        Effect.provideContext(context),
      );

      return yield* Effect.cached(make);
    }),
  ).pipe(Layer.provideMerge(stateEnvironment()), Layer.orDie);

/**
 * Construct an S3-backed {@link StateService}.
 *
 * Construction itself never touches AWS — environment resolution and
 * the ensure-bucket-exists check are deferred into a cached Effect
 * that runs once, on the first state operation.
 */
export const makeS3State = (options: S3StateOptions = {}) =>
  Effect.gen(function* () {
    // Captured under `withoutSdkDebugLogs` (below), so every store call runs
    // with the raised floor.
    const context = yield* Effect.context<S3Deps | AWSEnvironment>();

    const toError = (cause: unknown) =>
      new StateStoreError({
        message: cause instanceof Error ? cause.message : `S3 state store error: ${String(cause)}`,
        cause: cause instanceof Error ? cause : undefined,
      });

    // Close over the captured context so every operation is self-contained.
    const run = <A, E>(effect: Effect.Effect<A, E, S3Deps>): Effect.Effect<A, StateStoreError> =>
      effect.pipe(Effect.provideContext(context), Effect.mapError(toError));

    // Anything that touches AWS credentials must NOT run at layer
    // construction time. Resolving the environment (account/region),
    // deriving the bucket name, and ensuring the bucket exists all run on
    // the first state operation; `makeBucketState` caches the result.
    const objects = Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      if (options.name !== undefined) yield* Provisioning.storeName(options.name);
      const bucketName =
        options.bucketName ?? createStateBucketName(accountId, region, options.name);
      const ensure = ensureStateBucket(bucketName, region, options);
      // First use creates the bucket (except in CI); every use converges
      // its settings.
      yield* (yield* stateBucketExists(bucketName))
        ? ensure
        : Provisioning.deployMissing(
            {
              backend: "aws-s3",
              name: options.name,
              label: `S3 state bucket '${bucketName}'`,
              configured: options.bucketName !== undefined,
            },
            ensure,
          );
      return s3Objects(bucketName, run);
    }).pipe(Effect.provideContext(context), Effect.mapError(toError));

    return yield* makeBucketState({ id: "s3", label: "S3", prefix: options.prefix, objects });
  }).pipe(withoutSdkDebugLogs);

/** The S3 {@link BucketObjects} of `bucket`, versioned by ETag. */
const s3Objects = (
  bucket: string,
  run: <A, E>(effect: Effect.Effect<A, E, S3Deps>) => Effect.Effect<A, StateStoreError>,
): BucketObjects => ({
  listKeys: (prefix) =>
    run(
      s3.listObjectsV2.pages({ Bucket: bucket, Prefix: prefix }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.Contents ?? [])),
        Stream.map((object) => object.Key),
        Stream.filter((key): key is string => key !== undefined),
        Stream.runCollect,
        Effect.map((keys) => Array.from(keys)),
      ),
    ),
  listChildren: (prefix) =>
    run(
      s3.listObjectsV2.pages({ Bucket: bucket, Prefix: prefix, Delimiter: "/" }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.CommonPrefixes ?? [])),
        // `{prefix}{name}/` -> `{name}`
        Stream.map((common) => common.Prefix),
        Stream.filter((p): p is string => p !== undefined),
        Stream.map((p) => p.slice(prefix.length, -1)),
        Stream.runCollect,
        Effect.map((names) => Array.from(names)),
      ),
    ),
  read: (key) =>
    run(
      s3.getObject({ Bucket: bucket, Key: key }).pipe(
        Effect.flatMap((result) =>
          result.Body === undefined
            ? Effect.undefined
            : result.Body.pipe(
                Stream.decodeText,
                Stream.mkString,
                Effect.map((text) => ({ text, version: result.ETag ?? "" })),
              ),
        ),
        Effect.catchTag("NoSuchKey", () => Effect.undefined),
      ),
    ),
  write: (key, body, condition) =>
    run(
      s3
        .putObject({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
          ...(condition === undefined
            ? {}
            : "ifAbsent" in condition
              ? { IfNoneMatch: "*" }
              : { IfMatch: condition.ifVersion }),
        })
        .pipe(
          Effect.flatMap((result) =>
            result.ETag === undefined
              ? Effect.fail(
                  new StateStoreError({
                    message: `S3 state object '${key}' was written without an ETag`,
                  }),
                )
              : Effect.succeed<string | undefined>(result.ETag),
          ),
          Effect.retry({
            while: (error) => error._tag === "ConditionalRequestConflict",
            schedule: Schedule.spaced("200 millis"),
            times: 4,
          }),
          // A lost condition: 412, or 409 after retries.
          Effect.catchTag(
            ["PreconditionFailed", "ConditionalRequestConflict"],
            () => Effect.undefined,
          ),
        ),
    ),
  delete: (key, ifVersion) =>
    run(
      s3
        .deleteObject({
          Bucket: bucket,
          Key: key,
          ...(ifVersion === undefined ? {} : { IfMatch: ifVersion }),
        })
        .pipe(Effect.asVoid),
    ),
  deleteMany: (keys) =>
    run(
      Effect.forEach(
        Array.from({ length: Math.ceil(keys.length / DELETE_BATCH_SIZE) }, (_, i) =>
          keys.slice(i * DELETE_BATCH_SIZE, (i + 1) * DELETE_BATCH_SIZE),
        ),
        (batch) =>
          s3.deleteObjects({
            Bucket: bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        { discard: true },
      ),
    ),
});

/**
 * Build the default account-regional state bucket name.
 *
 * Account-regional buckets must follow the naming convention:
 *   `<prefix>-<accountId>-<region>-an`
 *
 * @see https://docs.aws.amazon.com/AmazonS3/latest/userguide/gpbucketnamespaces.html#account-regional-gp-buckets
 */
export const createStateBucketName = (accountId: string, region: string, name?: string) =>
  `alchemy-state-${name === undefined ? "" : `${name}-`}${accountId}-${region}-an`.toLowerCase();

/**
 * Observe-then-ensure the state bucket: head it, create it if missing
 * (tolerating create races), and wait for it to become available.
 */
const ensureStateBucket = (bucket: string, region: string, options: S3StateOptions) =>
  Effect.gen(function* () {
    // An absent bucket surfaces as either `NotFound` (the HEAD 404) or
    // `NoSuchBucket` depending on the namespace/path — treat both as "create
    // it". Catching only `NotFound` let a deleted state bucket (e.g. after a
    // nuke) escape as an uncaught `NoSuchBucket` instead of being recreated.
    const exists = yield* s3.headBucket({ Bucket: bucket }).pipe(
      Effect.map(() => true),
      Effect.catchTag(["NotFound", "NoSuchBucket"], () => Effect.succeed(false)),
    );
    if (!exists) {
      yield* Effect.logInfo(`S3 state store: creating bucket ${bucket} in ${region}`);
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
          // Many callers race to create the shared default state bucket on
          // first use. The loser sees the create already done
          // (`BucketAlreadyOwnedByYou`/`BucketAlreadyExists`) or mid-flight
          // (`OperationAborted`). All mean "someone else is creating it".
          Effect.catchTag(
            ["BucketAlreadyOwnedByYou", "BucketAlreadyExists", "OperationAborted"],
            () => Effect.void,
          ),
        );

      // Wait for the bucket to become available. Under a concurrent create
      // the bucket is briefly not yet head-able and object/configuration ops
      // would race ahead of it.
      yield* s3.headBucket({ Bucket: bucket }).pipe(
        Effect.retry({
          while: (error) => error._tag === "NotFound" || error._tag === "NoSuchBucket",
          schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(10)]),
        }),
      );
    }

    // Secure defaults are reconciled for BOTH newly-created and existing
    // buckets. This makes AWS.state converge out-of-band drift and explicit
    // custom buckets rather than only securing the greenfield path.
    const desiredVersioning = "Enabled";
    const observedVersioning = yield* s3.getBucketVersioning({
      Bucket: bucket,
    });
    if (observedVersioning.Status !== desiredVersioning) {
      yield* s3.putBucketVersioning({
        Bucket: bucket,
        VersioningConfiguration: { Status: desiredVersioning },
      });
    }

    yield* syncBucketEncryption(bucket, options.encryption);

    const desiredPublicAccess: s3.PublicAccessBlockConfiguration = {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    };
    const observedPublicAccess = yield* s3.getPublicAccessBlock({ Bucket: bucket }).pipe(
      Effect.map((result) => result.PublicAccessBlockConfiguration),
      Effect.catchTag("NoSuchPublicAccessBlockConfiguration", () => Effect.undefined),
    );
    const publicAccessFingerprint = (config: s3.PublicAccessBlockConfiguration | undefined) =>
      JSON.stringify({
        blockAcls: config?.BlockPublicAcls ?? false,
        ignoreAcls: config?.IgnorePublicAcls ?? false,
        blockPolicy: config?.BlockPublicPolicy ?? false,
        restrictBuckets: config?.RestrictPublicBuckets ?? false,
      });
    if (
      publicAccessFingerprint(observedPublicAccess) !== publicAccessFingerprint(desiredPublicAccess)
    ) {
      yield* s3.putPublicAccessBlock({
        Bucket: bucket,
        PublicAccessBlockConfiguration: desiredPublicAccess,
      });
    }

    const desiredOwnership = "BucketOwnerEnforced";
    const observedOwnership = yield* s3.getBucketOwnershipControls({ Bucket: bucket }).pipe(
      Effect.map((result) => result.OwnershipControls?.Rules?.[0]?.ObjectOwnership),
      Effect.catchTag("OwnershipControlsNotFoundError", () => Effect.undefined),
    );
    if (observedOwnership !== desiredOwnership) {
      yield* s3.putBucketOwnershipControls({
        Bucket: bucket,
        OwnershipControls: {
          Rules: [{ ObjectOwnership: desiredOwnership }],
        },
      });
    }
  }).pipe(
    // The whole observe→create→wait sequence races other first-callers of the
    // shared bucket; `OperationAborted` (conflicting create) and a transiently
    // absent bucket (`NoSuchBucket`/`NotFound`) are the faces of that race.
    // Retry the entire sequence so a concurrent create that is still settling
    // converges instead of surfacing as a `StateStoreError`.
    Effect.retry({
      while: (e) =>
        e._tag === "OperationAborted" || e._tag === "NoSuchBucket" || e._tag === "NotFound",
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(10)]),
    }),
  );

/** The profile's AWS environment, resolved the way {@link state} resolves it. */
export const stateEnvironment = () =>
  // Fresh per call: these derive from the environment below, and shared
  // (memoized) instances built for another environment in the same run
  // would shadow an `AWSEnvironment` provided to this layer.
  Layer.fresh(AwsRegion.fromEnvironment).pipe(
    Layer.provideMerge(Layer.fresh(AwsCredentials.fromEnvironment)),
    Layer.provideMerge(Layer.fresh(Endpoint.fromEnvironment)),
    Layer.provideMerge(providedOrDefault()),
    Layer.provideMerge(AwsAuth),
    Layer.provideMerge(CredentialsStoreLive),
  );

/**
 * Create the state bucket with its secure defaults, or converge an existing
 * one to them: what first use of {@link state} does. With `kmsKeyId`,
 * objects are encrypted with that KMS key.
 */
export const provisionStateBucket = (
  bucket: string,
  region: string,
  kmsKeyId?: string,
): Effect.Effect<void, StateStoreError, S3Deps> =>
  ensureStateBucket(
    bucket,
    region,
    kmsKeyId === undefined
      ? {}
      : {
          encryption: { sseAlgorithm: "aws:kms", kmsMasterKeyId: kmsKeyId, bucketKeyEnabled: true },
        },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new StateStoreError({
          message: `Could not provision state bucket ${bucket}: ${cause._tag}`,
          cause: cause instanceof Error ? cause : undefined,
        }),
    ),
  );
