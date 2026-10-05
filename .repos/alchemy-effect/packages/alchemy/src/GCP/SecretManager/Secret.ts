import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { DeleteNotConfirmed } from "../Errors.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type CustomerManagedEncryption = {
  /**
   * Cloud KMS CryptoKey used to encrypt secret payloads
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   */
  kmsKeyName?: string;
};

export type Replica = {
  /**
   * Replica location (e.g. `"us-central1"`).
   */
  location?: string;
  /**
   * Optional customer-managed encryption for this replica.
   */
  customerManagedEncryption?: CustomerManagedEncryption;
};

export type Replication = {
  /**
   * Replicate the secret without location restrictions.
   */
  automatic?: {
    customerManagedEncryption?: CustomerManagedEncryption;
  };
  /**
   * Replicate the secret only into the listed locations.
   */
  userManaged?: {
    replicas?: Replica[];
  };
};

export type Rotation = {
  /**
   * Timestamp in UTC when the next rotation notification should fire.
   */
  nextRotationTime?: string;
  /**
   * Period between rotation notifications (e.g. `"3600s"`).
   */
  rotationPeriod?: string;
};

export type SecretTopic = {
  /**
   * Pub/Sub topic resource name (`projects/{project}/topics/{topic}`).
   */
  name?: string;
};

export type SecretProps = {
  /**
   * Secret id (the `{secret}` segment of
   * `projects/{project}/secrets/{secret}`). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Max 255 characters;
   * letters, numbers, hyphens, and underscores. Changing it replaces the
   * secret.
   */
  secretId?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Custom metadata. Distinct from labels; not used for ownership.
   */
  annotations?: Record<string, string>;
  /**
   * Immutable replication policy. Defaults to automatic replication.
   * Changing it replaces the secret.
   * @default { automatic: {} }
   */
  replication?: Replication;
  /**
   * Timestamp in UTC when the secret expires.
   */
  expireTime?: string;
  /**
   * Input-only TTL used to compute `expireTime` (e.g. `"86400s"`). Ignored
   * when `expireTime` is set.
   */
  ttl?: string;
  /**
   * Pub/Sub topics notified on control-plane events. Required when
   * `rotation` is set.
   */
  topics?: SecretTopic[];
  /**
   * Rotation policy. Requires `topics`.
   */
  rotation?: Rotation;
  /**
   * Mapping from version alias to version id.
   */
  versionAliases?: Record<string, string>;
  /**
   * Delay before a destroyed version is permanently deleted (e.g.
   * `"86400s"`).
   */
  versionDestroyTtl?: string;
};

export type Secret = Resource<
  "GCP.SecretManager.Secret",
  SecretProps,
  {
    /** Full resource name `projects/{project}/secrets/{secret}`. */
    name: string;
    /** Secret id (last path segment). */
    secretId: string;
    /** Project id. */
    project: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Custom annotations. */
    annotations: Record<string, string>;
    /** Replication policy. Immutable after create. */
    replication: Replication | undefined;
    /** Expiration timestamp, if set. */
    expireTime: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** Server etag. */
    etag: string | undefined;
    /** Pub/Sub notification topics. */
    topics: SecretTopic[];
    /** Rotation policy, if set. */
    rotation: Rotation | undefined;
    /** Version alias map. */
    versionAliases: Record<string, string>;
    /** Delayed-destroy TTL, if set. */
    versionDestroyTtl: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Secret Manager secret (metadata and replication). Secret
 * payloads live on versions — use `AddSecretVersion` and
 * `AccessSecretVersion` to write and read them.
 *
 * Changing `secretId` or `replication` replaces the secret.
 *
 * ### Creating a Secret
 * **Example:** Generated name
 * ```typescript
 * const secret = yield* GCP.SecretManager.Secret("ApiKey", {});
 * ```
 *
 * **Example:** Explicit id, labels, and annotations
 * ```typescript
 * const secret = yield* GCP.SecretManager.Secret("ApiKey", {
 *   secretId: "order-api-key",
 *   labels: { env: "prod" },
 *   annotations: { owner: "payments" },
 * });
 * ```
 *
 * ### Replication
 * **Example:** User-managed replicas
 * ```typescript
 * const secret = yield* GCP.SecretManager.Secret("RegionalKey", {
 *   replication: {
 *     userManaged: {
 *       replicas: [{ location: "us-central1" }],
 *     },
 *   },
 * });
 * ```
 *
 * ### Secret Versions
 * **Example:** Add and access a version
 * ```typescript
 * const addVersion = yield* GCP.SecretManager.AddSecretVersion(secret);
 * yield* addVersion({ payload: { data: btoa("hello") } });
 * const access = yield* GCP.SecretManager.AccessSecretVersion(secret);
 * const { payload } = yield* access();
 * ```
 *
 * @resource
 * @category SecretManager
 */
export const Secret = Resource<Secret>("GCP.SecretManager.Secret");

export class SecretNotResolved extends Data.TaggedError(
  "GCP.SecretManager.SecretNotResolved",
)<{
  name: string;
}> {}

const DEFAULT_REPLICATION: Replication = { automatic: {} };

const secretIdOf = (name: string) => name.split("/").pop() ?? name;

const resourceName = (project: string, secretId: string) =>
  `projects/${project}/secrets/${secretId}`;

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const userAnnotations = (
  annotations: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(annotations);

const userAliases = (
  aliases: Record<string, string | undefined> | null | undefined,
): Record<string, string> => tagRecord(aliases);

const toId = (id: string, secretId: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      secretId ??
      existing ??
      (yield* createPhysicalName({ id, maxLength: 255, lowercase: true }))
    );
  });

const toTopics = (topics: secretmanager.TopicList | null | undefined) =>
  (topics ?? [])
    .filter(
      (topic): topic is { name: string } => typeof topic.name === "string",
    )
    .map((topic) => ({ name: topic.name }));

const toRotation = (
  rotation: secretmanager.Rotation | undefined,
): Rotation | undefined => {
  if (rotation === undefined) return undefined;
  if (
    rotation.nextRotationTime === undefined &&
    rotation.rotationPeriod === undefined
  ) {
    return undefined;
  }
  return {
    nextRotationTime: rotation.nextRotationTime,
    rotationPeriod: rotation.rotationPeriod,
  };
};

const toReplication = (
  replication: secretmanager.Replication | undefined,
): Replication | undefined => {
  if (replication === undefined) return undefined;
  if (replication.userManaged !== undefined) {
    return {
      userManaged: {
        replicas: (replication.userManaged.replicas ?? []).map((replica) => ({
          location: replica.location,
          customerManagedEncryption: replica.customerManagedEncryption
            ? {
                kmsKeyName: replica.customerManagedEncryption.kmsKeyName,
              }
            : undefined,
        })),
      },
    };
  }
  if (replication.automatic !== undefined) {
    return {
      automatic: {
        customerManagedEncryption: replication.automatic
          .customerManagedEncryption
          ? {
              kmsKeyName:
                replication.automatic.customerManagedEncryption.kmsKeyName,
            }
          : undefined,
      },
    };
  }
  return undefined;
};

const desiredReplication = (
  replication: Replication | undefined,
): Replication => replication ?? DEFAULT_REPLICATION;

const replicationFingerprint = (
  replication: Replication | undefined,
): string => {
  const value = desiredReplication(replication);
  if (value.userManaged !== undefined) {
    const replicas = [...(value.userManaged.replicas ?? [])]
      .map((replica) => ({
        location: replica.location ?? "",
        kms: replica.customerManagedEncryption?.kmsKeyName ?? "",
      }))
      .sort((a, b) => a.location.localeCompare(b.location));
    return JSON.stringify({ userManaged: replicas });
  }
  return JSON.stringify({
    automatic: {
      kms: value.automatic?.customerManagedEncryption?.kmsKeyName ?? "",
    },
  });
};

const recordsEqual = (
  left: Record<string, string>,
  right: Record<string, string>,
) => {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && left[key] === right[key],
    )
  );
};

const topicsEqual = (left: SecretTopic[], right: SecretTopic[]) => {
  const a = left.map((topic) => topic.name ?? "").sort();
  const b = right.map((topic) => topic.name ?? "").sort();
  return a.length === b.length && a.every((name, index) => name === b[index]);
};

const rotationEqual = (
  left: Rotation | undefined,
  right: Rotation | undefined,
) =>
  (left?.nextRotationTime ?? "") === (right?.nextRotationTime ?? "") &&
  (left?.rotationPeriod ?? "") === (right?.rotationPeriod ?? "");

const toAttrs = (secret: secretmanager.Secret, project: string) => {
  const name = secret.name ?? "";
  return {
    name,
    secretId: secretIdOf(name),
    project,
    labels: userLabels(secret.labels),
    annotations: userAnnotations(secret.annotations),
    replication: toReplication(secret.replication),
    expireTime: secret.expireTime,
    createTime: secret.createTime,
    etag: secret.etag,
    topics: toTopics(secret.topics),
    rotation: toRotation(secret.rotation),
    versionAliases: userAliases(secret.versionAliases),
    versionDestroyTtl: secret.versionDestroyTtl,
  };
};

const getByName = (name: string) =>
  secretmanager
    .getProjectsSecrets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilMissing = (name: string) =>
  getByName(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (secret): boolean => secret === undefined,
      times: 30,
    }),
    Effect.flatMap((secret): Effect.Effect<void, DeleteNotConfirmed> =>
      secret === undefined
        ? Effect.void
        : Effect.fail(new DeleteNotConfirmed({ resource: name })),
    ),
  );

const toCreateBody = (
  news: SecretProps,
  labels: Record<string, string>,
): secretmanager.Secret => ({
  replication: desiredReplication(news.replication),
  labels,
  annotations: news.annotations,
  expireTime: news.expireTime,
  ttl: news.expireTime === undefined ? news.ttl : undefined,
  topics: news.topics,
  rotation: news.rotation,
  versionAliases: news.versionAliases,
  versionDestroyTtl: news.versionDestroyTtl,
});

export const SecretProvider = () =>
  Provider.succeed(Secret, {
    stables: ["name", "secretId", "project", "createTime", "replication"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.secretId ?? output?.secretId;
      const nextId = news.secretId ?? previousId;
      const idChanged =
        previousId !== undefined &&
        news.secretId !== undefined &&
        previousId !== news.secretId;
      const replicationChanged =
        replicationFingerprint(olds?.replication ?? output?.replication) !==
        replicationFingerprint(news.replication);

      if (!idChanged && !replicationChanged) return undefined;
      return {
        action: "replace" as const,
        deleteFirst:
          replicationChanged &&
          !idChanged &&
          previousId !== undefined &&
          nextId === previousId,
      };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const secretId = yield* toId(id, olds?.secretId, output?.secretId);
      const name = output?.name ?? resourceName(env.project, secretId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* secretmanager.listProjectsSecrets
          .pages({
            parent: `projects/${env.project}`,
            pageSize: 1000,
            filter: "labels.alchemy-id:*",
          })
          .pipe(Stream.runCollect);
        return Array.from(pages).flatMap((page) =>
          (page.secrets ?? [])
            .filter((secret) =>
              Object.keys(secret.labels ?? {}).some((key) =>
                key.startsWith("alchemy-"),
              ),
            )
            .map((secret) => toAttrs(secret, env.project)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const secretId = yield* toId(id, news.secretId, output?.secretId);
      const name = resourceName(env.project, secretId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const desiredAliases = news.versionAliases ?? {};
      const desiredTopics = news.topics ?? [];
      const desiredRotation = news.rotation;
      const desiredDestroyTtl = news.versionDestroyTtl;

      let current = yield* getByName(name);
      const desiredReplicationFp = replicationFingerprint(news.replication);

      // Replication is immutable. If the observed secret has a different
      // policy (replacement or adoption), delete and recreate.
      if (
        current !== undefined &&
        replicationFingerprint(toReplication(current.replication)) !==
          desiredReplicationFp
      ) {
        yield* secretmanager
          .deleteProjectsSecrets({ name: current.name ?? name })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* waitUntilMissing(name);
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* secretmanager
          .createProjectsSecrets({
            parent: `projects/${env.project}`,
            secretId,
            body: toCreateBody(news, desiredLabels),
          })
          .pipe(
            // A just-deleted secret (replacement) keeps its id reserved for
            // a few seconds after reads report it missing.
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              schedule: Schedule.spaced("1 second"),
              times: 10,
            }),
            Effect.catchTag("Conflict", () => getByName(name)),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new SecretNotResolved({ name });
      }

      if (
        replicationFingerprint(toReplication(current.replication)) !==
        desiredReplicationFp
      ) {
        return yield* new SecretNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const annotationsChanged = !recordsEqual(
        userAnnotations(current.annotations),
        desiredAnnotations,
      );
      const aliasesChanged = !recordsEqual(
        userAliases(current.versionAliases),
        desiredAliases,
      );
      const topicsChanged = !topicsEqual(
        toTopics(current.topics),
        desiredTopics,
      );
      const rotationChanged = !rotationEqual(
        toRotation(current.rotation),
        desiredRotation,
      );
      const destroyTtlChanged =
        (current.versionDestroyTtl ?? "") !== (desiredDestroyTtl ?? "");
      const expireTimeChanged =
        news.expireTime !== undefined &&
        (current.expireTime ?? "") !== news.expireTime;
      // `ttl` is input-only and recomputes expireTime from now. Apply it only
      // when the observed secret has no expiration, otherwise every reconcile
      // would reset the clock.
      const ttlChanged =
        news.expireTime === undefined &&
        news.ttl !== undefined &&
        (current.expireTime === undefined || current.expireTime === "");

      if (
        labelsChanged ||
        annotationsChanged ||
        aliasesChanged ||
        topicsChanged ||
        rotationChanged ||
        destroyTtlChanged ||
        expireTimeChanged ||
        ttlChanged
      ) {
        current = yield* secretmanager.patchProjectsSecrets({
          name,
          updateMask: [
            labelsChanged ? "labels" : undefined,
            annotationsChanged ? "annotations" : undefined,
            aliasesChanged ? "versionAliases" : undefined,
            topicsChanged ? "topics" : undefined,
            rotationChanged ? "rotation" : undefined,
            destroyTtlChanged ? "versionDestroyTtl" : undefined,
            expireTimeChanged ? "expireTime" : undefined,
            ttlChanged ? "ttl" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            labels: desiredLabels,
            annotations: desiredAnnotations,
            versionAliases: desiredAliases,
            topics: desiredTopics,
            rotation: desiredRotation,
            versionDestroyTtl: desiredDestroyTtl,
            expireTime: news.expireTime,
            ttl: ttlChanged ? news.ttl : undefined,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* secretmanager
        .deleteProjectsSecrets({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilMissing(output.name);
    }),
  });
