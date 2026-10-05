import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  lastSegment,
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
  toNetworkResource,
  toResourcePath,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "interceptEndpointGroupAssociations";

export type InterceptEndpointGroupAssociationLocationDetail = {
  /** Cloud location, e.g. `us-central1-a`. */
  location: string | undefined;
  /** Association state in this location (`ACTIVE`, `OUT_OF_SYNC`, …). */
  state: string | undefined;
};

export type InterceptEndpointGroupAssociationProps = {
  /**
   * Association id (the `{interceptEndpointGroupAssociation}` segment of
   * `projects/{project}/locations/{location}/interceptEndpointGroupAssociations/{interceptEndpointGroupAssociation}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the association.
   */
  interceptEndpointGroupAssociationId?: string;
  /**
   * Location of the association. Associations are global — always
   * `"global"`. Immutable — changing it replaces the association.
   * `GLOBAL` is accepted and normalized to `global`.
   * @default "global"
   */
  location?: string;
  /**
   * Endpoint group this association is connected to, as a full resource
   * name. Immutable — changing it replaces the association.
   */
  interceptEndpointGroup: string;
  /**
   * VPC to associate, as a name (`app-vpc`), resource path, or Compute
   * self-link. Immutable — changing it replaces the association.
   */
  network: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type InterceptEndpointGroupAssociation = Resource<
  "GCP.NetworkSecurity.InterceptEndpointGroupAssociation",
  InterceptEndpointGroupAssociationProps,
  {
    /** Full resource name. */
    name: string;
    /** Association id (last path segment). */
    interceptEndpointGroupAssociationId: string;
    /** Project id. */
    project: string;
    /** Location id. Always `"global"`. */
    location: string;
    /** Connected endpoint group resource name. */
    interceptEndpointGroup: string | undefined;
    /** Associated VPC resource path. */
    network: string | undefined;
    /** VPC network id (last path segment). */
    networkName: string | undefined;
    /** Data-path network cookie used by GENEVE. */
    networkCookie: number | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Whether the API is still reconciling intended vs actual state. */
    reconciling: boolean;
    /** Locations configured on the linked endpoint group. */
    locations: InterceptEndpointGroupAssociationLocationDetail[];
    /** Locations where the association is present. */
    locationsDetails: InterceptEndpointGroupAssociationLocationDetail[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Security Integration intercept endpoint-group association —
 * the link between a VPC and an intercept endpoint group.
 *
 * Creating an association does not enable intercept by itself; a firewall
 * policy with intercept rules must also target the network. Changing
 * `interceptEndpointGroupAssociationId`, `location`,
 * `interceptEndpointGroup`, or `network` replaces the association. Labels
 * update in place.
 *
 * ### Creating an Association
 * **Example:** Generated name
 * ```typescript
 * const association = yield* GCP.NetworkSecurity.InterceptEndpointGroupAssociation("Link", {
 *   interceptEndpointGroup: endpoints.name,
 *   network: vpc.selfLink,
 * });
 * ```
 *
 * **Example:** Named association with labels
 * ```typescript
 * const association = yield* GCP.NetworkSecurity.InterceptEndpointGroupAssociation("Link", {
 *   interceptEndpointGroupAssociationId: "app-intercept-ega",
 *   interceptEndpointGroup: endpoints.name,
 *   network: "projects/my-project/global/networks/app-vpc",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Association
 * **Example:** Labels
 * ```typescript
 * const association = yield* GCP.NetworkSecurity.InterceptEndpointGroupAssociation("Link", {
 *   interceptEndpointGroupAssociationId: "app-intercept-ega",
 *   interceptEndpointGroup: endpoints.name,
 *   network: vpc.selfLink,
 *   labels: { env: "prod", role: "nsi" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const InterceptEndpointGroupAssociation =
  Resource<InterceptEndpointGroupAssociation>(
    "GCP.NetworkSecurity.InterceptEndpointGroupAssociation",
  );

export class InterceptEndpointGroupAssociationNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.InterceptEndpointGroupAssociationNotResolved",
)<{
  name: string;
}> {}

export class InterceptEndpointGroupAssociationFailed extends Data.TaggedError(
  "GCP.NetworkSecurity.InterceptEndpointGroupAssociationFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class InterceptEndpointGroupAssociationStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.InterceptEndpointGroupAssociationStillExists",
)<{
  name: string;
}> {}

const isPendingState = (state: string | undefined) =>
  state === "CREATING" || state === "DELETING" || state === "STATE_UNSPECIFIED";

const toLocationDetails = (
  details:
    | networksecurity.InterceptLocationList
    | networksecurity.InterceptEndpointGroupAssociationLocationDetailsList
    | undefined,
): InterceptEndpointGroupAssociationLocationDetail[] =>
  (details ?? []).map((item) => ({
    location: item.location,
    state: item.state,
  }));

const toAttrs = (
  association: networksecurity.InterceptEndpointGroupAssociation,
  project: string,
) => {
  const name = association.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    interceptEndpointGroupAssociationId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    interceptEndpointGroup: association.interceptEndpointGroup,
    network: association.network,
    networkName: association.network
      ? lastSegment(association.network)
      : undefined,
    networkCookie: association.networkCookie,
    labels: userLabels(association.labels),
    state: association.state,
    reconciling: association.reconciling === true,
    locations: toLocationDetails(association.locations),
    locationsDetails: toLocationDetails(association.locationsDetails),
    createTime: association.createTime,
    updateTime: association.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsInterceptEndpointGroupAssociations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (
        association,
      ): association is networksecurity.InterceptEndpointGroupAssociation =>
        association !== undefined,
      () => new InterceptEndpointGroupAssociationNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (association) => association.state !== "DELETE_FAILED",
      (association) =>
        new InterceptEndpointGroupAssociationFailed({
          name,
          state: association.state,
        }),
    ),
    Effect.filterOrFail(
      (association) => !isPendingState(association.state),
      () => new InterceptEndpointGroupAssociationNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.NetworkSecurity.InterceptEndpointGroupAssociationNotResolved",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((association) =>
      association === undefined
        ? Effect.void
        : Effect.fail(
            new InterceptEndpointGroupAssociationStillExists({ name }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.NetworkSecurity.InterceptEndpointGroupAssociationStillExists",
      times: 10,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsInterceptEndpointGroupAssociations
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.interceptEndpointGroupAssociations ?? []),
      ),
      Stream.filter((association) =>
        Object.keys(association.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((association) => toAttrs(association, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const InterceptEndpointGroupAssociationProvider = () =>
  Provider.succeed(InterceptEndpointGroupAssociation, {
    stables: [
      "name",
      "interceptEndpointGroupAssociationId",
      "project",
      "location",
      "interceptEndpointGroup",
      "network",
      "networkCookie",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.interceptEndpointGroupAssociationId ??
        output?.interceptEndpointGroupAssociationId;
      const nextId = news.interceptEndpointGroupAssociationId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
      );
      const previousGroup = lastSegment(
        olds?.interceptEndpointGroup ?? output?.interceptEndpointGroup ?? "",
      );
      const nextGroup = lastSegment(news.interceptEndpointGroup);
      const previousNetwork = lastSegment(
        olds?.network ?? output?.networkName ?? output?.network ?? "",
      );
      const nextNetwork = lastSegment(news.network);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousGroup.length > 0 && previousGroup !== nextGroup) ||
        (previousNetwork.length > 0 && previousNetwork !== nextNetwork);
      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const interceptEndpointGroupAssociationId = yield* toId(
        id,
        olds?.interceptEndpointGroupAssociationId,
        output?.interceptEndpointGroupAssociationId,
        "iega",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ??
        resourceName(
          env.project,
          location,
          COLLECTION,
          interceptEndpointGroupAssociationId,
        );
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
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const interceptEndpointGroupAssociationId = yield* toId(
        id,
        news.interceptEndpointGroupAssociationId,
        output?.interceptEndpointGroupAssociationId,
        "iega",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        interceptEndpointGroupAssociationId,
      );
      const interceptEndpointGroup = toResourcePath(
        news.interceptEndpointGroup,
      );
      const network = toNetworkResource(env.project, news.network);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsInterceptEndpointGroupAssociations({
            parent: parentOf(env.project, location),
            interceptEndpointGroupAssociationId,
            body: {
              interceptEndpointGroup,
              network,
              labels: desiredLabels,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new InterceptEndpointGroupAssociationNotResolved({
          name,
        });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;

      if (labelsChanged) {
        const operation =
          yield* networksecurity.patchProjectsLocationsInterceptEndpointGroupAssociations(
            {
              name: current.name ?? name,
              updateMask: "labels",
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsInterceptEndpointGroupAssociations({
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
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(output.name);
    }),
  });
