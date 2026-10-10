import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type BackendBucketProps = {
  /**
   * Name of the backend bucket. If omitted, a unique RFC1035 name is
   * generated from the stack, stage, and logical id. Changing this
   * replaces the resource.
   */
  name?: string;
  /**
   * Cloud Storage bucket this backend serves. The bucket must already
   * exist in the same project.
   */
  bucketName: string;
  /**
   * Optional textual description. Alchemy ownership is stamped into the
   * stored description; this field is the user-facing portion.
   */
  description?: string;
  /**
   * Enable Cloud CDN for this backend bucket. Cannot be true when
   * `loadBalancingScheme` is `INTERNAL_MANAGED`.
   * @default false
   */
  enableCdn?: boolean;
  /**
   * Compress text responses using Brotli or gzip based on
   * `Accept-Encoding`.
   */
  compressionMode?: "AUTOMATIC" | "DISABLED";
  /**
   * Headers the Application Load Balancer should add to proxied
   * responses, e.g. `"X-Frame-Options: DENY"`.
   */
  customResponseHeaders?: string[];
  /**
   * Load balancing scheme. `INTERNAL_MANAGED` is required for
   * cross-region internal Application Load Balancers. Changing this
   * replaces the resource.
   */
  loadBalancingScheme?: "EXTERNAL_MANAGED" | "INTERNAL_MANAGED";
  /**
   * Cloud CDN policy. Only applied when set; omitted values leave the
   * observed policy in place.
   */
  cdnPolicy?: compute.BackendBucketCdnPolicy;
};

export type BackendBucket = Resource<
  "GCP.Compute.BackendBucket",
  BackendBucketProps,
  {
    /** RFC1035 resource name. */
    name: string;
    /** Cloud Storage bucket name. */
    bucketName: string;
    /** Project id. */
    project: string;
    /** User-facing description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Whether Cloud CDN is enabled. */
    enableCdn: boolean;
    /** Compression mode, if set. */
    compressionMode: string | undefined;
    /** Response headers added by the load balancer. */
    customResponseHeaders: string[];
    /** Load balancing scheme, if set. */
    loadBalancingScheme: string | undefined;
    /** Cloud CDN policy, if configured. */
    cdnPolicy: compute.BackendBucketCdnPolicy | undefined;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Server-assigned numeric id. */
    id: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine backend bucket that fronts a Cloud Storage
 * bucket for HTTP(S) load balancing.
 *
 * Compute Engine backend buckets have no labels field, so Alchemy
 * stamps ownership into the description (`[alchemy alchemy-stack=…
 * alchemy-stage=… alchemy-id=…]`) so `list` / `pnpm nuke:gcp` can find
 * them.
 *
 * ### Creating a Backend Bucket
 * **Example:** Generated name in front of a Storage bucket
 * ```typescript
 * const assets = yield* GCP.Storage.Bucket("assets", {
 *   forceDestroy: true,
 * });
 * const backend = yield* GCP.Compute.BackendBucket("cdn", {
 *   bucketName: assets.bucketName,
 *   description: "static assets",
 * });
 * ```
 *
 * **Example:** Explicit name with Cloud CDN
 * ```typescript
 * const backend = yield* GCP.Compute.BackendBucket("cdn", {
 *   name: "app-static",
 *   bucketName: assets.bucketName,
 *   enableCdn: true,
 *   compressionMode: "AUTOMATIC",
 *   customResponseHeaders: ["X-Frame-Options: DENY"],
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const BackendBucket = Resource<BackendBucket>(
  "GCP.Compute.BackendBucket",
);

export class BackendBucketNotResolved extends Data.TaggedError(
  "GCP.Compute.BackendBucketNotResolved",
)<{
  name: string;
}> {}

const rfc1035 = (name: string): string => {
  let next = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!/^[a-z]/.test(next)) {
    next = `b${next}`;
  }
  next = next.slice(0, 63).replace(/-+$/, "");
  return next.length > 0 ? next : "backend";
};

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return rfc1035(
      yield* createPhysicalName({
        id,
        maxLength: 63,
        lowercase: true,
      }),
    );
  });

const encodeDescription = (
  user: string | undefined,
  labels: Record<string, string>,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return user ? `${marker}\n${user}` : marker;
};

const parseDescription = (
  description: string | undefined,
): { labels: Record<string, string>; user: string | undefined } => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, user: description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, user: description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, user: rest.length > 0 ? rest : undefined };
};

const hasOwnershipMarker = (description: string | undefined): boolean =>
  (description ?? "").startsWith("[alchemy ");

const toAttrs = (bucket: compute.BackendBucket, project: string) => ({
  name: bucket.name ?? "",
  bucketName: bucket.bucketName ?? "",
  project,
  description: parseDescription(bucket.description).user,
  enableCdn: bucket.enableCdn === true,
  compressionMode: bucket.compressionMode,
  customResponseHeaders: bucket.customResponseHeaders ?? [],
  loadBalancingScheme: bucket.loadBalancingScheme,
  cdnPolicy: bucket.cdnPolicy,
  selfLink: bucket.selfLink,
  creationTimestamp: bucket.creationTimestamp,
  id: bucket.id,
});

const sameList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean => JSON.stringify(left ?? []) === JSON.stringify(right ?? []);

const normalizeCdnPolicy = (
  policy: compute.BackendBucketCdnPolicy | undefined,
): compute.BackendBucketCdnPolicy | undefined => {
  if (policy === undefined) return undefined;
  const { signedUrlKeyNames: _signed, ...rest } = policy;
  return rest;
};

const sameCdnPolicy = (
  left: compute.BackendBucketCdnPolicy | undefined,
  right: compute.BackendBucketCdnPolicy | undefined,
): boolean =>
  JSON.stringify(normalizeCdnPolicy(left) ?? null) ===
  JSON.stringify(normalizeCdnPolicy(right) ?? null);

const getByName = (project: string, name: string) =>
  compute
    .getBackendBuckets({ project, backendBucket: name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const awaitResource = (project: string, name: string) =>
  getByName(project, name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (bucket) => bucket !== undefined,
      times: 8,
    }),
  );

export const BackendBucketProvider = () =>
  Provider.succeed(BackendBucket, {
    stables: ["name", "project", "selfLink", "creationTimestamp", "id"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.name ?? output?.name;
      if (
        news.name !== undefined &&
        previousName !== undefined &&
        news.name !== previousName
      ) {
        return { action: "replace" as const };
      }
      const previousScheme =
        olds?.loadBalancingScheme ?? output?.loadBalancingScheme;
      const nextScheme = news.loadBalancingScheme;
      if ((previousScheme ?? "") !== (nextScheme ?? "")) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousName !== undefined &&
            (news.name === undefined || news.name === previousName),
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const name = yield* toName(id, olds?.name, output?.name);
      const existing = yield* getByName(env.project, name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const parsed = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, parsed.labels))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listBackendBuckets
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((item) => hasOwnershipMarker(item.description)),
            Stream.map((item) => toAttrs(item, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const name = yield* toName(id, news.name, output?.name);
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(news.description, ownership);
      const enableCdn = news.enableCdn === true;
      const desiredHeaders = news.customResponseHeaders ?? [];

      let current = yield* getByName(env.project, name);

      if (current === undefined) {
        const inserted = yield* compute
          .insertBackendBuckets({
            project: env.project,
            body: {
              name,
              bucketName: news.bucketName,
              description: desiredDescription,
              enableCdn,
              compressionMode: news.compressionMode,
              customResponseHeaders:
                desiredHeaders.length > 0 ? desiredHeaders : undefined,
              loadBalancingScheme: news.loadBalancingScheme,
              cdnPolicy: news.cdnPolicy,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (inserted !== undefined) {
          current = yield* awaitResource(env.project, name);
        } else {
          current = yield* getByName(env.project, name);
        }
      }

      if (current === undefined) {
        return yield* new BackendBucketNotResolved({ name });
      }

      const observedDescription = current.description ?? "";
      const descriptionChanged = observedDescription !== desiredDescription;
      const bucketChanged = (current.bucketName ?? "") !== news.bucketName;
      const cdnChanged = (current.enableCdn === true) !== enableCdn;
      const compressionChanged =
        news.compressionMode !== undefined &&
        (current.compressionMode ?? "") !== news.compressionMode;
      const headersChanged = !sameList(
        current.customResponseHeaders,
        desiredHeaders,
      );
      const policyChanged =
        news.cdnPolicy !== undefined &&
        !sameCdnPolicy(current.cdnPolicy, news.cdnPolicy);

      if (
        descriptionChanged ||
        bucketChanged ||
        cdnChanged ||
        compressionChanged ||
        headersChanged ||
        policyChanged
      ) {
        yield* compute
          .patchBackendBuckets({
            project: env.project,
            backendBucket: name,
            body: {
              bucketName: news.bucketName,
              description: desiredDescription,
              enableCdn,
              compressionMode: news.compressionMode,
              customResponseHeaders: desiredHeaders,
              cdnPolicy: news.cdnPolicy,
            },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* awaitResource(env.project, name);
      }

      if (current === undefined) {
        return yield* new BackendBucketNotResolved({ name });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      yield* compute
        .deleteBackendBuckets({
          project: env.project,
          backendBucket: output.name,
        })
        .pipe(
          Effect.flatMap((operation) =>
            waitGlobalOperation(env.project, operation),
          ),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
