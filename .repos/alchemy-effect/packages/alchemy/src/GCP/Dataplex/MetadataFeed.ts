import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as pubsub from "@distilled.cloud/gcp/pubsub_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { waitForOperation } from "./operations.ts";
import {
  fingerprint,
  hasAlchemyLabelMap,
  lastSegment,
  listMetadataFeeds,
  locationParent,
  normalizeLocation,
  parseResourceName,
  replaceIfChanged,
  toPhysicalRfc1035,
  userLabels,
} from "./shared.ts";

export type MetadataFeedScope = {
  /** Listen to every entry in the organization. */
  organizationLevel?: boolean;
  /** Projects whose entries are published (`projects/{project}`). */
  projects?: string[];
  /** Entry groups whose entries are published. */
  entryGroups?: string[];
};

export type MetadataFeedFilters = {
  /** Entry types to listen to. */
  entryTypes?: string[];
  /** Aspect types to listen to. */
  aspectTypes?: string[];
  /** Change types (`CREATE`, `UPDATE`, `DELETE`). */
  changeTypes?: Array<
    | dataplex.GoogleCloudDataplexV1MetadataFeedFiltersChangeTypesItemEnum
    | (string & {})
  >;
};

export type MetadataFeedProps = {
  /**
   * Feed id (the `{metadataFeed}` segment of
   * `projects/{project}/locations/{location}/metadataFeeds/{metadataFeed}`).
   * If omitted, a unique name is generated. Immutable — changing it
   * replaces the feed.
   */
  metadataFeedId?: string;
  /**
   * Region. Immutable — changing it replaces the feed.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Scope of catalog changes to publish. Defaults to the current project.
   */
  scope?: MetadataFeedScope;
  /**
   * Filters on entry types, aspect types, and change types.
   */
  filters?: MetadataFeedFilters;
  /**
   * Pub/Sub topic that receives feed messages
   * (`projects/{project}/topics/{topic}`). Grant the Dataplex service
   * account `roles/pubsub.publisher` on the topic.
   */
  pubsubTopic?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MetadataFeed = Resource<
  "GCP.Dataplex.MetadataFeed",
  MetadataFeedProps,
  {
    /** Full resource name `.../metadataFeeds/{metadataFeed}`. */
    name: string;
    /** Feed id. */
    metadataFeedId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Organization-level scope. */
    organizationLevel: boolean;
    /** Scoped projects. */
    projects: string[];
    /** Scoped entry groups. */
    entryGroups: string[];
    /** Destination Pub/Sub topic. */
    pubsubTopic: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-assigned uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex metadata feed that publishes catalog changes to Pub/Sub.
 *
 * Changing `metadataFeedId` or `location` replaces the feed. Scope,
 * filters, destination topic, and labels update in place.
 *
 * ### Creating a Feed
 * **Example:** Project-scoped feed
 * ```typescript
 * const feed = yield* GCP.Dataplex.MetadataFeed("Catalog", {
 *   pubsubTopic: topic.name,
 *   scope: { projects: [`projects/${project}`] },
 *   labels: { env: "dev" },
 * });
 * ```
 *
 * **Example:** Filtered create events
 * ```typescript
 * const feed = yield* GCP.Dataplex.MetadataFeed("Catalog", {
 *   pubsubTopic: topic.name,
 *   filters: { changeTypes: ["CREATE"] },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const MetadataFeed = Resource<MetadataFeed>("GCP.Dataplex.MetadataFeed");

export class MetadataFeedNotResolved extends Data.TaggedError(
  "GCP.Dataplex.MetadataFeedNotResolved",
)<{
  name: string;
}> {}

export class MetadataFeedStillExists extends Data.TaggedError(
  "GCP.Dataplex.MetadataFeedStillExists",
)<{
  name: string;
}> {}

const resourceName = (project: string, location: string, feedId: string) =>
  `${locationParent(project, location)}/metadataFeeds/${feedId}`;

const scopeBody = (
  project: string,
  scope: MetadataFeedScope | undefined,
): dataplex.GoogleCloudDataplexV1MetadataFeedScope => ({
  organizationLevel: scope?.organizationLevel === true ? true : undefined,
  projects:
    scope?.projects ??
    (scope?.organizationLevel === true || (scope?.entryGroups?.length ?? 0) > 0
      ? undefined
      : [`projects/${project}`]),
  entryGroups: scope?.entryGroups,
});

const toAttrs = (
  feed: dataplex.GoogleCloudDataplexV1MetadataFeed,
  project: string,
) => {
  const name = feed.name ?? "";
  const parsed = parseResourceName(name, "metadataFeeds");
  return {
    name,
    metadataFeedId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    organizationLevel: feed.scope?.organizationLevel === true,
    projects: feed.scope?.projects ?? [],
    entryGroups: feed.scope?.entryGroups ?? [],
    pubsubTopic: feed.pubsubTopic,
    labels: userLabels(feed.labels),
    uid: feed.uid,
    createTime: feed.createTime,
    updateTime: feed.updateTime,
  };
};

const getByName = (name: string) =>
  dataplex
    .getProjectsLocationsMetadataFeeds({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const topicResource = (topic: string, project: string) =>
  topic.includes("/") ? topic : `projects/${project}/topics/${topic}`;

const grantDataplexPubsub = (project: string, topic: string | undefined) =>
  Effect.gen(function* () {
    if (topic === undefined || topic.length === 0) return;
    const resource = topicResource(topic, project);
    const projectResource = yield* resourcemanager
      .getProjects({ name: `projects/${project}` })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    const projectNumber = lastSegment(projectResource?.name ?? "");
    if (projectNumber.length === 0) return;
    const member = `serviceAccount:service-${projectNumber}@gcp-sa-dataplex.iam.gserviceaccount.com`;
    const policy = yield* pubsub.getIamPolicyProjectsTopics({ resource });
    const bindings = (policy.bindings ?? []).map((binding) => ({
      ...binding,
      members: [...(binding.members ?? [])],
    }));
    for (const role of ["roles/pubsub.publisher", "roles/pubsub.viewer"]) {
      const binding = bindings.find((item) => item.role === role);
      if (binding?.members?.includes(member)) continue;
      if (binding) {
        binding.members = [...(binding.members ?? []), member];
      } else {
        bindings.push({ role, members: [member] });
      }
    }
    yield* pubsub.setIamPolicyProjectsTopics({
      resource,
      body: { policy: { ...policy, bindings } },
    });
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "Conflict" || error._tag === "TooManyRequests",
      times: 5,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (feed): feed is dataplex.GoogleCloudDataplexV1MetadataFeed =>
        feed !== undefined,
      () => new MetadataFeedNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataplex.MetadataFeedNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((feed) =>
      feed === undefined
        ? Effect.void
        : Effect.fail(new MetadataFeedStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Dataplex.MetadataFeedStillExists",
      times: 10,
      schedule: Schedule.spaced("3 seconds"),
    }),
  );

export const MetadataFeedProvider = () =>
  Provider.succeed(MetadataFeed, {
    stables: [
      "name",
      "metadataFeedId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.metadataFeedId ?? output?.metadataFeedId;
      const nextId = news.metadataFeedId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        replaceIfChanged(previousId, nextId) ||
        (output !== undefined && previousLocation !== nextLocation)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const feedId = yield* toPhysicalRfc1035(
        id,
        olds?.metadataFeedId,
        output?.metadataFeedId,
      );
      const name = output?.name ?? resourceName(env.project, location, feedId);
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
        const feeds = yield* listMetadataFeeds(env.project, env.region);
        return feeds
          .filter((feed) => hasAlchemyLabelMap(feed.labels))
          .map((feed) => toAttrs(feed, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const feedId = yield* toPhysicalRfc1035(
        id,
        news.metadataFeedId,
        output?.metadataFeedId,
      );
      const name = output?.name ?? resourceName(env.project, location, feedId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const scope = scopeBody(env.project, news.scope);
      const filters = news.filters;
      yield* grantDataplexPubsub(env.project, news.pubsubTopic);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsMetadataFeeds({
            parent: locationParent(env.project, location),
            metadataFeedId: feedId,
            body: {
              scope,
              filters,
              labels: desiredLabels,
              pubsubTopic: news.pubsubTopic,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(name);
      }

      if (current === undefined) {
        return yield* new MetadataFeedNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const scopeChanged = fingerprint(current.scope) !== fingerprint(scope);
      const filtersChanged =
        fingerprint(current.filters) !== fingerprint(filters);
      const topicChanged =
        (current.pubsubTopic ?? "") !== (news.pubsubTopic ?? "");

      if (labelsChanged || scopeChanged || filtersChanged || topicChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          scopeChanged ? "scope" : undefined,
          filtersChanged ? "filters" : undefined,
          topicChanged ? "pubsub_topic" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation = yield* dataplex.patchProjectsLocationsMetadataFeeds({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            scope,
            filters,
            labels: desiredLabels,
            pubsubTopic: news.pubsubTopic,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dataplex
        .deleteProjectsLocationsMetadataFeeds({ name: output.name })
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
