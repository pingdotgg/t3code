import * as crypto from "node:crypto";
import type { Credentials } from "@distilled.cloud/gcp/Credentials";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { type BucketObjects, makeBucketState } from "alchemy/State/BucketState";
import * as Provisioning from "alchemy/State/Provisioning";
import { State, StateStoreError } from "alchemy/State/State";
import { recordStateStoreInit } from "alchemy/Telemetry/Metrics";
import { globalLogs } from "alchemy/Util/LogRecord";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { GcpAuth } from "../AuthProvider.ts";
import * as GcpCredentials from "../Credentials.ts";
import { fromCredentials, GcpEnvironment } from "../Environment.ts";
import { makeObjectMedia } from "../Storage/ObjectMedia.ts";

export interface GcsStateOptions {
  /**
   * A store other than the project's default, by logical name: its bucket is
   * `alchemy-state-<name>-<project>`. The bucket is created on first use,
   * except in CI, where `alchemy state bootstrap --backend gcp --name <name>`
   * provisions it ahead.
   *
   * @default the project's default store, `alchemy-state-<project>`
   */
  name?: string;
  /**
   * A full bucket name instead of one derived from {@link GcsStateOptions.name},
   * e.g. an existing bucket. Created on first use if it does not exist.
   */
  bucketName?: string;
  /**
   * Key prefix within the bucket under which all state objects are stored,
   * e.g. `"alchemy"`. A trailing `/` is appended automatically.
   *
   * @default "" (bucket root)
   */
  prefix?: string;
  /**
   * Location of a bucket the store creates, e.g. `"us-central1"` or the
   * multi-region `"US"`. An existing bucket keeps its location.
   *
   * @default the profile's region, else `us-central1`
   */
  location?: string;
}

/** Context required by the distilled Cloud Storage operations. */
type GcsDeps = Credentials | HttpClient;

/** Cloud Storage bucket names are at most 63 characters. */
const BUCKET_NAME_MAX = 63;

/**
 * Build the default state bucket name, `alchemy-state-[<name>-]<project>`.
 * Bucket names are global, and project ids are unique, so the name is
 * deterministic per project. A name too long for Cloud Storage replaces the
 * project id with a hash of it.
 */
export const createStateBucketName = (project: string, name?: string) => {
  const base = `alchemy-state-${name === undefined ? "" : `${name}-`}`;
  const full = `${base}${project}`.toLowerCase();
  if (full.length <= BUCKET_NAME_MAX) return full;
  const hash = crypto.createHash("sha256").update(project).digest("hex").slice(0, 16);
  return `${base}${hash}`.toLowerCase();
};

/** Whether a state bucket exists. */
export const stateBucketExists = (bucket: string) =>
  storage.getBuckets({ bucket }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

/**
 * State store backed by a Google Cloud Storage bucket.
 *
 * Stack state is persisted as JSON objects in a bucket in your project,
 * laid out like the local state store's file tree:
 *
 * ```
 * gs://{bucket}/{prefix}{stack}/{stage}/{fqn}.json
 * gs://{bucket}/{prefix}{stack}/{stage}/__stack_output__.json
 * gs://{bucket}/{prefix}{stack}/{stage}/__lease__.json
 * ```
 *
 * Concurrent deploys of one stack and stage share an `__lease__.json`
 * object written with `ifGenerationMatch` preconditions. The second deploy
 * fails immediately instead of mixing rows.
 *
 * The bucket is created on the first state operation if it does not
 * exist, with uniform bucket-level access, public access prevention, and
 * object versioning. Project Owners and Editors get
 * `roles/storage.objectAdmin` on it, since uniform access otherwise leaves
 * them unable to read objects. Nothing touches GCP credentials at layer
 * construction time.
 *
 * ### Using the Cloud Storage State Store
 * Pass `GCP.state()` as the `state` option of a Stack. By default the state
 * is stored in a bucket named `alchemy-state-{project}`.
 *
 * **Example:** Default bucket
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as GCP from "@alchemy.run/gcp";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyApp",
 *   { providers: GCP.providers(), state: GCP.state() },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 *
 * **Example:** Named store with a key prefix
 * ```typescript
 * export default Alchemy.Stack(
 *   "MyApp",
 *   {
 *     providers: GCP.providers(),
 *     state: GCP.state({ name: "platform", prefix: "alchemy" }),
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 *
 * ### Provisioning in CI
 * In CI (`CI=true`) a missing bucket fails the run instead of being
 * created. Create it once ahead of time:
 *
 * **Example:** Bootstrap the bucket
 * ```sh
 * alchemy state bootstrap --backend gcp --profile <your-ci-profile>
 * ```
 *
 * @resource
 */
export const state = (options: GcsStateOptions = {}) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const context = yield* Effect.context<GcsDeps | GcpEnvironment>();

      // Bind the lease to this layer's scope. The cached effect runs on the
      // first state operation, which may sit in a shorter scope.
      const make = Scope.provide(makeGcsState(options), scope).pipe(
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
 * Construct a Cloud Storage-backed `StateService`. Resolving the project and
 * ensuring the bucket run on the first state operation.
 */
export const makeGcsState = (options: GcsStateOptions = {}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<GcsDeps | GcpEnvironment>();

    const toError = (cause: unknown) =>
      new StateStoreError({
        message:
          cause instanceof Error
            ? cause.message
            : typeof cause === "object" && cause !== null && "_tag" in cause
              ? `Cloud Storage state store error: ${String(cause._tag)}`
              : `Cloud Storage state store error: ${String(cause)}`,
        cause: cause instanceof Error ? cause : undefined,
      });

    const run = <A, E>(effect: Effect.Effect<A, E, GcsDeps>): Effect.Effect<A, StateStoreError> =>
      effect.pipe(Effect.provideContext(context), Effect.mapError(toError));

    const objects = Effect.gen(function* () {
      const { project, region } = yield* GcpEnvironment.current;
      if (options.name !== undefined) yield* Provisioning.storeName(options.name);
      const bucketName = options.bucketName ?? createStateBucketName(project, options.name);
      const ensure = ensureStateBucket(bucketName, project, options.location ?? region);
      yield* (yield* stateBucketExists(bucketName))
        ? ensure
        : Provisioning.deployMissing(
            {
              backend: "gcp",
              name: options.name,
              label: `Cloud Storage state bucket '${bucketName}'`,
              configured: options.bucketName !== undefined,
            },
            ensure,
          );
      const media = yield* makeObjectMedia;
      return gcsObjects(bucketName, media, run);
    }).pipe(Effect.provideContext(context), Effect.mapError(toError));

    return yield* makeBucketState({
      id: "gcs",
      label: "Cloud Storage",
      prefix: options.prefix,
      objects,
    });
  });

type ObjectMedia = Effect.Success<typeof makeObjectMedia>;

/** The Cloud Storage {@link BucketObjects} of `bucket`, versioned by generation. */
const gcsObjects = (
  bucket: string,
  media: ObjectMedia,
  run: <A, E>(effect: Effect.Effect<A, E, GcsDeps>) => Effect.Effect<A, StateStoreError>,
): BucketObjects => ({
  listKeys: (prefix) =>
    run(
      storage.listObjects.pages({ bucket, prefix }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
        Stream.map((object) => object.name),
        Stream.filter((name): name is string => name !== undefined),
        Stream.runCollect,
        Effect.map((names) => Array.from(names)),
      ),
    ),
  listChildren: (prefix) =>
    run(
      storage.listObjects.pages({ bucket, prefix, delimiter: "/" }).pipe(
        Stream.flatMap((page) => Stream.fromIterable(page.prefixes ?? [])),
        // `{prefix}{name}/` -> `{name}`
        Stream.map((p) => p.slice(prefix.length, -1)),
        Stream.runCollect,
        Effect.map((names) => Array.from(names)),
      ),
    ),
  read: (key) =>
    run(
      media.download({ bucket, object: key }).pipe(
        Effect.map((object) => ({
          text: new TextDecoder().decode(object.body),
          version: object.generation ?? "",
        })),
        Effect.catchTag("GCP.Storage.ObjectNotFound", () => Effect.undefined),
      ),
    ),
  write: (key, body, condition) =>
    run(
      media
        .upload(bucket, {
          name: key,
          body,
          contentType: "application/json",
          ifGenerationMatch:
            condition === undefined
              ? undefined
              : "ifAbsent" in condition
                ? "0"
                : condition.ifVersion,
        })
        .pipe(
          Effect.map((object): string | undefined => object.generation ?? ""),
          // A lost condition answers 412.
          Effect.catchIf(
            (error) => error._tag === "GCP.Storage.ObjectRequestFailed" && error.status === 412,
            () => Effect.undefined,
          ),
        ),
    ),
  delete: (key, ifVersion) =>
    run(
      storage
        .deleteObjects({
          bucket,
          object: key,
          ...(ifVersion === undefined ? {} : { ifGenerationMatch: ifVersion }),
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag(["NotFound", "ObjectPreconditionFailed"], () => Effect.void),
        ),
    ),
  deleteMany: (keys) =>
    run(
      Effect.forEach(
        keys,
        (object) =>
          storage.deleteObjects({ bucket, object }).pipe(
            Effect.asVoid,
            Effect.catchTag("NotFound", () => Effect.void),
          ),
        { concurrency: 16, discard: true },
      ),
    ),
});

/** Settings every state bucket converges to. */
const desiredIamConfiguration = {
  uniformBucketLevelAccess: { enabled: true },
  publicAccessPrevention: "enforced",
};

/** The role that lets project owners and editors read and write state. */
const STATE_OBJECT_ROLE = "roles/storage.objectAdmin";

/**
 * With uniform bucket-level access, project Owners and Editors only hold
 * `storage.legacyBucketOwner`/`legacyBucketWriter`, which can list and
 * write objects but not read them. Grant them object access on the state
 * bucket so anyone who can deploy to the project can use the store.
 */
const syncStateBucketAccess = (bucket: string, project: string) =>
  Effect.gen(function* () {
    const members = [`projectOwner:${project}`, `projectEditor:${project}`];
    const policy = yield* storage.getIamPolicyBuckets({ bucket });
    const bindings = policy.bindings ?? [];
    const existing = bindings.find(
      (binding) => binding.role === STATE_OBJECT_ROLE && binding.condition === undefined,
    );
    const missing = members.filter((member) => !(existing?.members ?? []).includes(member));
    if (missing.length === 0) return;
    yield* storage.setIamPolicyBuckets({
      bucket,
      body: {
        ...policy,
        bindings: existing
          ? bindings.map((binding) =>
              binding === existing
                ? { ...binding, members: [...(binding.members ?? []), ...missing] }
                : binding,
            )
          : [...bindings, { role: STATE_OBJECT_ROLE, members }],
      },
    });
  }).pipe(
    Effect.retry({
      // A concurrent policy write, or a just-created bucket not yet visible.
      while: (error) =>
        error._tag === "IamPolicyEtagMismatch" ||
        error._tag === "Conflict" ||
        error._tag === "NotFound",
      schedule: Schedule.spaced("1 second"),
      times: 8,
    }),
  );

/**
 * Observe-then-ensure the state bucket: create it if missing (tolerating
 * create races), then converge uniform access, public access prevention,
 * versioning, and object access for project owners and editors.
 */
const ensureStateBucket = (bucket: string, project: string, location: string) =>
  Effect.gen(function* () {
    const observed = yield* storage
      .getBuckets({ bucket })
      .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
    if (observed === undefined) {
      yield* Effect.logInfo(`Cloud Storage state store: creating bucket ${bucket} in ${location}`);
      yield* storage
        .insertBuckets({
          project,
          body: {
            name: bucket,
            location,
            iamConfiguration: desiredIamConfiguration,
            versioning: { enabled: true },
          },
        })
        .pipe(
          // A concurrent first use created it first.
          Effect.catchTag("Conflict", () => Effect.void),
        );
    } else {
      const drifted =
        observed.iamConfiguration?.uniformBucketLevelAccess?.enabled !== true ||
        observed.iamConfiguration?.publicAccessPrevention !== "enforced" ||
        observed.versioning?.enabled !== true;
      if (drifted) {
        yield* storage.patchBuckets({
          bucket,
          body: {
            iamConfiguration: desiredIamConfiguration,
            versioning: { enabled: true },
          },
        });
      }
    }
    yield* syncStateBucketAccess(bucket, project);
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "Conflict",
      schedule: Schedule.max([Schedule.spaced("2 seconds"), Schedule.recurs(5)]),
    }),
  );

/** The profile's GCP environment, resolved the way {@link state} resolves it. */
export const stateEnvironment = () =>
  // Fresh per call, so an environment provided to this layer is not
  // shadowed by one memoized for another stack in the same run.
  Layer.fresh(fromCredentials()).pipe(
    Layer.provideMerge(Layer.fresh(GcpCredentials.fromAuthProvider())),
    Layer.provideMerge(GcpAuth),
    Layer.provideMerge(CredentialsStoreLive),
  );

/**
 * Create the state bucket with its secure defaults, or converge an existing
 * one to them: what first use of {@link state} does.
 */
export const provisionStateBucket = (
  bucket: string,
  project: string,
  location: string,
): Effect.Effect<void, StateStoreError, GcsDeps> =>
  ensureStateBucket(bucket, project, location).pipe(
    Effect.mapError(
      (cause) =>
        new StateStoreError({
          message: `Could not provision state bucket ${bucket}: ${cause._tag}`,
        }),
    ),
  );
