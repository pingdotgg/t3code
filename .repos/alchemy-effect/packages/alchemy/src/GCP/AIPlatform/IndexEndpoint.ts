import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  alchemyIdFilter,
  createInternalLabels,
  hasAlchemyPrefix,
  labelsDiffer,
  listLocations,
  locationOf,
  lastSegment,
  normalizeLocation,
  projectOf,
  resourceNameFromOperation,
  toDisplayName,
  toLabels,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

export type IndexEndpointProps = {
  /**
   * Vertex AI location (`us-central1`, …). Immutable — changing it
   * replaces the endpoint. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name (max 128 Unicode characters). Generated from the stack,
   * stage, and logical id when omitted.
   */
  displayName?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * When true, the deployed index is reachable through a public endpoint.
   * @default true
   */
  publicEndpointEnabled?: boolean;
  /**
   * VPC network to peer, as
   * `projects/{projectNumber}/global/networks/{network}`. Mutually
   * exclusive with private service connect. Immutable.
   */
  network?: string;
  /**
   * Customer-managed encryption key. Immutable.
   */
  encryptionSpec?: aiplatform.GoogleCloudAiplatformV1EncryptionSpec;
  /**
   * Private Service Connect config. Mutually exclusive with `network`.
   * Immutable.
   */
  privateServiceConnectConfig?: aiplatform.GoogleCloudAiplatformV1PrivateServiceConnectConfig;
};

export type IndexEndpoint = Resource<
  "GCP.AIPlatform.IndexEndpoint",
  IndexEndpointProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/indexEndpoints/{indexEndpoint}`. */
    name: string;
    /** IndexEndpoint id (last path segment). */
    indexEndpointId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Whether a public endpoint is enabled. */
    publicEndpointEnabled: boolean;
    /** Public endpoint domain, if enabled. */
    publicEndpointDomainName: string | undefined;
    /** Peered VPC network, if set. */
    network: string | undefined;
    /** Deployed index resource names. */
    deployedIndexes: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Matching Engine IndexEndpoint that serves one or more
 * deployed indexes.
 *
 * Changing `location`, `network`, encryption, or private-service-connect
 * configuration replaces the endpoint. Display name, description, and
 * labels update in place.
 *
 * ### Creating an IndexEndpoint
 * **Example:** Public endpoint
 * ```typescript
 * const endpoint = yield* GCP.AIPlatform.IndexEndpoint("Search", {
 *   displayName: "product-search",
 *   publicEndpointEnabled: true,
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const IndexEndpoint = Resource<IndexEndpoint>(
  "GCP.AIPlatform.IndexEndpoint",
);

export class IndexEndpointNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.IndexEndpointNotResolved",
)<{
  name: string;
}> {}

export class IndexEndpointStillExists extends Data.TaggedError(
  "GCP.AIPlatform.IndexEndpointStillExists",
)<{
  name: string;
}> {}

const toAttrs = (
  endpoint: aiplatform.GoogleCloudAiplatformV1IndexEndpoint,
  project: string,
) => {
  const name = endpoint.name ?? "";
  return {
    name,
    indexEndpointId: lastSegment(name),
    project: projectOf(name, project),
    location: locationOf(name),
    displayName: endpoint.displayName,
    description: endpoint.description,
    labels: userLabels(endpoint.labels),
    publicEndpointEnabled: endpoint.publicEndpointEnabled === true,
    publicEndpointDomainName: endpoint.publicEndpointDomainName,
    network: endpoint.network,
    deployedIndexes: (endpoint.deployedIndexes ?? [])
      .map((item) => item.index)
      .filter((value): value is string => typeof value === "string"),
    createTime: endpoint.createTime,
    updateTime: endpoint.updateTime,
  };
};

const getByName = (name: string) =>
  aiplatform
    .getProjectsLocationsIndexEndpoints({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listPage = (parent: string, filter?: string) =>
  aiplatform.listProjectsLocationsIndexEndpoints
    .pages({ parent, pageSize: 100, filter })
    .pipe(
      Stream.runCollect,
      Effect.map((pages) =>
        Array.from(pages).flatMap((page) => page.indexEndpoints ?? []),
      ),
      Effect.catchTag("NotFound", () =>
        Effect.succeed([] as aiplatform.GoogleCloudAiplatformV1IndexEndpoint[]),
      ),
    );

const findOwned = (
  project: string,
  location: string,
  labels: Record<string, string>,
) =>
  listPage(
    `projects/${project}/locations/${location}`,
    alchemyIdFilter(labels),
  ).pipe(
    Effect.map(
      (items) =>
        items.find((item) => hasAlchemyPrefix(item.labels)) ?? undefined,
    ),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (endpoint): endpoint is aiplatform.GoogleCloudAiplatformV1IndexEndpoint =>
        endpoint !== undefined,
      () => new IndexEndpointNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.IndexEndpointNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (endpoint) => endpoint === undefined,
      () => new IndexEndpointStillExists({ name }),
    ),
    Effect.asVoid,
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.IndexEndpointStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const IndexEndpointProvider = () =>
  Provider.succeed(IndexEndpoint, {
    stables: [
      "name",
      "indexEndpointId",
      "project",
      "location",
      "network",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      if (!isResolved(news)) return undefined;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousNetwork = olds?.network ?? output?.network ?? "";
      const nextNetwork = news.network ?? previousNetwork;
      const previousKms = olds?.encryptionSpec?.kmsKeyName ?? "";
      const nextKms = news.encryptionSpec?.kmsKeyName ?? previousKms;
      if (
        previousLocation !== nextLocation ||
        previousNetwork !== nextNetwork ||
        nextKms !== previousKms
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const ownership = yield* createInternalLabels(id);
      const existing =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ?? (yield* findOwned(env.project, location, ownership));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          listLocations(env.region),
          (location) =>
            listPage(`projects/${env.project}/locations/${location}`),
          { concurrency: 4 },
        );
        return pages
          .flat()
          .filter((endpoint) => hasAlchemyPrefix(endpoint.labels))
          .map((endpoint) => toAttrs(endpoint, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const publicEndpointEnabled = news.publicEndpointEnabled ?? true;

      let current =
        (output?.name !== undefined
          ? yield* getByName(output.name)
          : undefined) ??
        (yield* findOwned(env.project, location, desiredLabels));

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsIndexEndpoints({
            parent: `projects/${env.project}/locations/${location}`,
            body: {
              displayName,
              description: news.description,
              labels: desiredLabels,
              publicEndpointEnabled,
              network: news.network,
              encryptionSpec: news.encryptionSpec,
              privateServiceConnectConfig: news.privateServiceConnectConfig,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created);
          const name = resourceNameFromOperation(done);
          current =
            name !== undefined
              ? yield* waitUntilExists(name)
              : yield* findOwned(env.project, location, desiredLabels);
        }
        if (current === undefined) {
          current = yield* findOwned(env.project, location, desiredLabels);
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new IndexEndpointNotResolved({
          name: output?.name ?? `${location}/indexEndpoints`,
        });
      }

      const name = current.name;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayChanged = (current.displayName ?? "") !== displayName;
      const labelsChanged = labelsDiffer(current.labels, desiredLabels);

      if (descriptionChanged || displayChanged || labelsChanged) {
        current = yield* aiplatform.patchProjectsLocationsIndexEndpoints({
          name,
          updateMask: [
            descriptionChanged ? "description" : undefined,
            displayChanged ? "display_name" : undefined,
            labelsChanged ? "labels" : undefined,
          ]
            .filter((field): field is string => field !== undefined)
            .join(","),
          body: {
            name,
            displayName,
            description: news.description,
            labels: desiredLabels,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* aiplatform
        .deleteProjectsLocationsIndexEndpoints({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
