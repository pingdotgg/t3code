import * as secretmanager from "@distilled.cloud/gcp/secretmanager_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  ALCHEMY_LABEL_PREFIX,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type {
  CustomerManagedEncryption,
  Rotation,
  SecretTopic,
} from "./Secret.ts";

export type LocationsSecretProps = {
  /**
   * Secret id (the `{secret}` segment of
   * `projects/{project}/locations/{location}/secrets/{secret}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id. Max
   * 255 characters; letters, numbers, hyphens, and underscores. Changing it
   * replaces the secret.
   */
  secretId?: string;
  /**
   * Secret Manager location (`us-central1`, `us-east1`, …). Immutable —
   * changing it replaces the secret. `US-CENTRAL1` is accepted and
   * normalized to `us-central1`. Regional secrets live only in this
   * location (use {@link Secret} for automatic/user-managed replication).
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Custom metadata. Distinct from labels; not used for ownership.
   */
  annotations?: Record<string, string>;
  /**
   * Cloud KMS CryptoKey used to encrypt versions
   * (`projects/{project}/locations/{location}/keyRings/{keyRing}/cryptoKeys/{cryptoKey}`).
   * Must live in the same location as the secret. Empty or omitted uses
   * Google-managed encryption. Updates apply to versions added afterwards.
   */
  customerManagedEncryption?: CustomerManagedEncryption;
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

export type LocationsSecret = Resource<
  "GCP.SecretManager.LocationsSecret",
  LocationsSecretProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/secrets/{secret}`. */
    name: string;
    /** Secret id (last path segment). */
    secretId: string;
    /** Project id. */
    project: string;
    /** Location id (`us-central1`, …). */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Custom annotations. */
    annotations: Record<string, string>;
    /** CMEK used for new versions, if set. */
    customerManagedEncryption: CustomerManagedEncryption | undefined;
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
 * A regional Google Cloud Secret Manager secret. Payloads stay in one
 * location (`projects/{project}/locations/{location}/secrets/{secret}`).
 * For automatically replicated secrets, use {@link Secret}.
 *
 * Changing `secretId` or `location` replaces the secret.
 *
 * ### Creating a LocationsSecret
 * **Example:** Generated name in us-central1
 * ```typescript
 * const secret = yield* GCP.SecretManager.LocationsSecret("ApiKey", {});
 * ```
 *
 * **Example:** Explicit id, location, labels, and annotations
 * ```typescript
 * const secret = yield* GCP.SecretManager.LocationsSecret("ApiKey", {
 *   secretId: "order-api-key",
 *   location: "us-central1",
 *   labels: { env: "prod" },
 *   annotations: { owner: "payments" },
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
export const LocationsSecret = Resource<LocationsSecret>(
  "GCP.SecretManager.LocationsSecret",
);

export class LocationsSecretNotResolved extends Data.TaggedError(
  "GCP.SecretManager.LocationsSecretNotResolved",
)<{
  name: string;
}> {}

const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

const normalizeLocation = (
  location: string | undefined,
  defaultLocation: string,
) => lastSegment(location ?? defaultLocation).toLowerCase();

const resourceName = (project: string, location: string, secretId: string) =>
  `projects/${project}/locations/${location}/secrets/${secretId}`;

const parseName = (name: string, defaultLocation: string) => {
  const parts = name.split("/").filter((part) => part.length > 0);
  const secretsAt = parts.lastIndexOf("secrets");
  const locationsAt = parts.lastIndexOf("locations");
  const projectsAt = parts.lastIndexOf("projects");
  return {
    project:
      projectsAt >= 0 && parts[projectsAt + 1] ? parts[projectsAt + 1]! : "",
    location:
      locationsAt >= 0 && parts[locationsAt + 1]
        ? parts[locationsAt + 1]!
        : defaultLocation,
    secretId:
      secretsAt >= 0 && parts[secretsAt + 1]
        ? parts[secretsAt + 1]!
        : lastSegment(name),
  };
};

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

const toCmek = (
  encryption: secretmanager.CustomerManagedEncryption | undefined,
): CustomerManagedEncryption | undefined => {
  if (encryption === undefined || encryption.kmsKeyName === undefined) {
    return undefined;
  }
  return { kmsKeyName: encryption.kmsKeyName };
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

const cmekEqual = (
  left: CustomerManagedEncryption | undefined,
  right: CustomerManagedEncryption | undefined,
) => (left?.kmsKeyName ?? "") === (right?.kmsKeyName ?? "");

const toAttrs = (
  secret: secretmanager.Secret,
  project: string,
  region: string,
) => {
  const name = secret.name ?? "";
  const parsed = parseName(name, region);
  return {
    name,
    secretId: parsed.secretId,
    project: parsed.project || project,
    location: parsed.location,
    labels: userLabels(secret.labels),
    annotations: userAnnotations(secret.annotations),
    customerManagedEncryption: toCmek(secret.customerManagedEncryption),
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
    .getProjectsLocationsSecrets({ name })
    .pipe(Effect.catchTag(["NotFound"], () => Effect.succeed(undefined)));

const hasAlchemyLabelMap = (
  labels: Record<string, string | undefined> | null | undefined,
) =>
  Object.keys(labels ?? {}).some((key) => key.startsWith(ALCHEMY_LABEL_PREFIX));

const collectSecretPages = (parent: string) =>
  secretmanager.listProjectsLocationsSecrets
    .pages({
      parent,
      pageSize: 1000,
      filter: "labels.alchemy-id:*",
    })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.secrets ?? []),
      ),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const toCreateBody = (
  news: LocationsSecretProps,
  labels: Record<string, string>,
): secretmanager.Secret => ({
  labels,
  annotations: news.annotations,
  customerManagedEncryption: news.customerManagedEncryption,
  expireTime: news.expireTime,
  ttl: news.expireTime === undefined ? news.ttl : undefined,
  topics: news.topics,
  rotation: news.rotation,
  versionAliases: news.versionAliases,
  versionDestroyTtl: news.versionDestroyTtl,
});

export const LocationsSecretProvider = () =>
  Provider.succeed(LocationsSecret, {
    stables: ["name", "secretId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.secretId ?? output?.secretId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const idChanged =
        previousId !== undefined &&
        news.secretId !== undefined &&
        previousId !== news.secretId;
      const locationChanged = previousLocation !== nextLocation;
      if (!idChanged && !locationChanged) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const secretId = yield* toId(id, olds?.secretId, output?.secretId);
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, secretId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const aggregated = yield* collectSecretPages(
          `projects/${env.project}/locations/-`,
        );
        const secrets =
          aggregated.length > 0
            ? aggregated
            : yield* collectSecretPages(
                `projects/${env.project}/locations/${env.region}`,
              );
        return secrets
          .filter(
            (secret) =>
              (secret.name ?? "").includes("/locations/") &&
              hasAlchemyLabelMap(secret.labels),
          )
          .map((secret) => toAttrs(secret, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const secretId = yield* toId(id, news.secretId, output?.secretId);
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, secretId);
      const parent = `projects/${env.project}/locations/${location}`;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const desiredAliases = news.versionAliases ?? {};
      const desiredTopics = news.topics ?? [];
      const desiredRotation = news.rotation;
      const desiredDestroyTtl = news.versionDestroyTtl;
      const desiredCmek = news.customerManagedEncryption;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* secretmanager
          .createProjectsLocationsSecrets({
            parent,
            secretId,
            body: toCreateBody(news, desiredLabels),
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new LocationsSecretNotResolved({ name });
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
      const cmekChanged = !cmekEqual(
        toCmek(current.customerManagedEncryption),
        desiredCmek,
      );
      const expireTimeChanged =
        news.expireTime !== undefined &&
        (current.expireTime ?? "") !== news.expireTime;
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
        cmekChanged ||
        expireTimeChanged ||
        ttlChanged
      ) {
        current = yield* secretmanager.patchProjectsLocationsSecrets({
          name,
          updateMask: [
            labelsChanged ? "labels" : undefined,
            annotationsChanged ? "annotations" : undefined,
            aliasesChanged ? "versionAliases" : undefined,
            topicsChanged ? "topics" : undefined,
            rotationChanged ? "rotation" : undefined,
            destroyTtlChanged ? "versionDestroyTtl" : undefined,
            cmekChanged ? "customerManagedEncryption" : undefined,
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
            customerManagedEncryption: desiredCmek,
            expireTime: news.expireTime,
            ttl: ttlChanged ? news.ttl : undefined,
          },
        });
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* secretmanager
        .deleteProjectsLocationsSecrets({ name: output.name })
        .pipe(Effect.catchTag(["NotFound"], () => Effect.void));
    }),
  });
