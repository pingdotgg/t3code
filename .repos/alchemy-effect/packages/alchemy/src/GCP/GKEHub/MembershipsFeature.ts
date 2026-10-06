import * as gkehub from "@distilled.cloud/gcp/gkehub_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
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
import {
  fieldMask,
  fingerprint,
  listLabeledPages,
  membershipName,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type FeatureSpec = gkehub.FeatureSpec;
export type FeatureState = gkehub.FeatureState;

export type MembershipsFeatureProps = {
  /**
   * Parent Fleet membership. Full name
   * `projects/{project}/locations/{location}/memberships/{membership}`
   * or the membership id (combined with `location`). Immutable —
   * changing it replaces the feature.
   */
  membership: string;
  /**
   * Location of the parent membership (`global`, `us-central1`, …).
   * Used when `membership` is a bare id. Immutable — changing it
   * replaces the feature. Fleet memberships are typically `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Feature id (the `{feature}` segment of
   * `.../memberships/{membership}/features/{feature}`). Well-known Fleet
   * Feature names such as `configmanagement`, `servicemesh`, or
   * `policycontroller`. If omitted, a unique RFC1035 name is generated.
   * Immutable — changing it replaces the feature.
   */
  featureId?: string;
  /**
   * Per-feature spec for this membership (Config Management, Service
   * Mesh, Policy Controller, …).
   */
  spec?: FeatureSpec;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MembershipsFeature = Resource<
  "GCP.GKEHub.MembershipsFeature",
  MembershipsFeatureProps,
  {
    /** Full resource name. */
    name: string;
    /** Feature id (last path segment). */
    featureId: string;
    /** Parent membership resource name. */
    membership: string;
    /** Membership id (last path segment of the parent). */
    membershipId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Per-feature spec. */
    spec: FeatureSpec | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Lifecycle of the MembershipFeature resource. */
    lifecycleState: string | undefined;
    /** High-level Feature state. */
    state: FeatureState | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** RFC3339 deletion timestamp. */
    deleteTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A GKE Hub MembershipFeature — the per-membership settings for a Fleet
 * Feature such as Config Management or Service Mesh.
 *
 * Changing `featureId`, `membership`, or `location` replaces the
 * feature. Spec and labels update in place.
 *
 * ### Creating a Membership Feature
 * **Example:** Config Management on a membership
 * ```typescript
 * const feature = yield* GCP.GKEHub.MembershipsFeature("ConfigSync", {
 *   membership: "projects/my-project/locations/global/memberships/app",
 *   featureId: "configmanagement",
 *   spec: {
 *     configmanagement: {
 *       configSync: { enabled: true, sourceFormat: "unstructured" },
 *     },
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** Service Mesh
 * ```typescript
 * const feature = yield* GCP.GKEHub.MembershipsFeature("Mesh", {
 *   membership: membership.name,
 *   featureId: "servicemesh",
 *   spec: {
 *     servicemesh: { management: "MANAGEMENT_AUTOMATIC" },
 *   },
 * });
 * ```
 *
 * ### Updating a Membership Feature
 * **Example:** Spec and labels
 * ```typescript
 * // Same logical id, changed props: updated in place.
 * const feature = yield* GCP.GKEHub.MembershipsFeature("ConfigSync", {
 *   membership: membership.name,
 *   featureId: "configmanagement",
 *   spec: {
 *     configmanagement: {
 *       configSync: { enabled: true, preventDrift: true },
 *     },
 *   },
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category GKEHub
 */
export const MembershipsFeature = Resource<MembershipsFeature>(
  "GCP.GKEHub.MembershipsFeature",
);

const resourceName = (membership: string, featureId: string) =>
  `${membership}/features/${featureId}`;

const toAttrs = (item: gkehub.MembershipFeature, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "features");
  return {
    name,
    featureId: parsed.id,
    membership: parsed.parent,
    membershipId: parsed.membershipId,
    project: parsed.project || project,
    location: parsed.location,
    spec: item.spec,
    labels: userLabels(item.labels),
    lifecycleState: item.lifecycleState?.state,
    state: item.state,
    createTime: item.createTime,
    updateTime: item.updateTime,
    deleteTime: item.deleteTime,
  };
};

const getByName = (name: string) =>
  gkehub
    .getProjectsLocationsMembershipsFeatures({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listChildren = (parent: string) =>
  listLabeledPages(
    gkehub.listProjectsLocationsMembershipsFeatures.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.membershipFeatures,
    (item) => item.labels,
  );

const listOwned = (project: string) =>
  gkehub.listProjectsLocations
    .pages({ name: `projects/${project}`, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.locations ?? [])),
      Stream.map((location) => location.locationId),
      Stream.filter(
        (locationId): locationId is string =>
          locationId !== undefined && locationId.length > 0,
      ),
      Stream.runCollect,
      Effect.flatMap((locations) =>
        Effect.forEach(
          Array.from(locations),
          (location) =>
            listChildren(
              `projects/${project}/locations/${location}/memberships/-`,
            ),
          { concurrency: 4 },
        ),
      ),
      Effect.map((pages) => pages.flat()),
    );

export const MembershipsFeatureProvider = () =>
  Provider.succeed(MembershipsFeature, {
    stables: [
      "name",
      "featureId",
      "membership",
      "membershipId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      return replaceOnIdentity({
        previousId: olds?.featureId ?? output?.featureId,
        nextId: news.featureId ?? olds?.featureId ?? output?.featureId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: location,
        previousParent: olds?.membership ?? output?.membership,
        nextParent: membershipName(news.membership, env.project, location),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const featureId = yield* toPhysicalId(
        id,
        olds?.featureId,
        output?.featureId,
        "feature",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const membership = membershipName(
        olds?.membership ?? output?.membership ?? "",
        env.project,
        location,
      );
      const name = output?.name ?? resourceName(membership, featureId);
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const featureId = yield* toPhysicalId(
        id,
        news.featureId,
        output?.featureId,
        "feature",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const membership = membershipName(news.membership, env.project, location);
      const name = resourceName(membership, featureId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* gkehub
          .createProjectsLocationsMembershipsFeatures({
            parent: membership,
            featureId,
            body: {
              labels: desiredLabels,
              spec: news.spec,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          // ALREADY_EXISTS (6): a concurrent create won the race.
          yield* waitForOperation(created).pipe(
            Effect.catchTag("GCP.OperationFailed", (error) =>
              error.code === 6 ? Effect.void : Effect.fail(error),
            ),
          );
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const specChanged =
        news.spec !== undefined &&
        fingerprint(current.spec) !== fingerprint(news.spec);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        specChanged && "spec",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* gkehub.patchProjectsLocationsMembershipsFeatures({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              labels: desiredLabels,
              spec: news.spec,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* gkehub
        .deleteProjectsLocationsMembershipsFeatures({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        // NOT_FOUND (5): the feature was already gone.
        yield* waitForOperation(operation).pipe(
          Effect.catchTag("GCP.OperationFailed", (error) =>
            error.code === 5 ? Effect.void : Effect.fail(error),
          ),
        );
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
