import * as networksecurity from "@distilled.cloud/gcp/networksecurity_v1";
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
import {
  DEFAULT_GLOBAL,
  canonicalizeLink,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  linkKey,
  normalizeLocation,
  parentOf,
  parseName,
  rfc1035,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "interceptDeploymentGroups";

export type InterceptDeploymentGroupState =
  | networksecurity.InterceptDeploymentGroupStateEnum
  | (string & {});

export type InterceptDeploymentGroupNestedDeployment = {
  /** Nested InterceptDeployment resource name. */
  name: string | undefined;
  /** Nested deployment state. */
  state: string | undefined;
};

export type InterceptLocation = {
  /** Cloud location (`us-central1-a`, `asia-south1`, …). */
  location: string | undefined;
  /** Association state in this location. */
  state: string | undefined;
};

export type InterceptConnectedEndpointGroup = {
  /** Connected InterceptEndpointGroup resource name. */
  name: string | undefined;
};

export type InterceptDeploymentGroupProps = {
  /**
   * Deployment group id (the `{interceptDeploymentGroup}` segment of
   * `projects/{project}/locations/global/interceptDeploymentGroups/{interceptDeploymentGroup}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the group.
   */
  interceptDeploymentGroupId?: string;
  /**
   * Location. Intercept deployment groups are global. Immutable —
   * changing it replaces the group.
   * @default "global"
   */
  location?: string;
  /**
   * VPC network used by every child deployment, e.g.
   * `projects/{project}/global/networks/{network}`. Immutable — changing
   * it replaces the group.
   */
  network: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type InterceptDeploymentGroup = Resource<
  "GCP.NetworkSecurity.InterceptDeploymentGroup",
  InterceptDeploymentGroupProps,
  {
    /** Full resource name `projects/{project}/locations/global/interceptDeploymentGroups/{interceptDeploymentGroup}`. */
    name: string;
    /** Deployment group id (last path segment). */
    interceptDeploymentGroupId: string;
    /** Project id. */
    project: string;
    /** Location id — always `"global"`. */
    location: string;
    /** VPC network resource name. */
    network: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Whether reconciling is in progress. */
    reconciling: boolean;
    /** Nested zonal deployments. */
    nestedDeployments: InterceptDeploymentGroupNestedDeployment[];
    /** Locations where the group is present. */
    locations: InterceptLocation[];
    /** Connected intercept endpoint groups. */
    connectedEndpointGroups: InterceptConnectedEndpointGroup[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global intercept deployment group — aggregates zonal intercept
 * backends into a single intercept service that consumers attach via
 * an endpoint group.
 *
 * Changing `interceptDeploymentGroupId`, `location`, or `network`
 * replaces the group. Description and labels update in place.
 *
 * ### Creating an InterceptDeploymentGroup
 * **Example:** Attach to a VPC
 * ```typescript
 * const group = yield* GCP.NetworkSecurity.InterceptDeploymentGroup("Inspect", {
 *   network: `projects/${vpc.project}/global/networks/${vpc.networkName}`,
 *   description: "prod intercept",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const InterceptDeploymentGroup = Resource<InterceptDeploymentGroup>(
  "GCP.NetworkSecurity.InterceptDeploymentGroup",
);

const resourceName = (
  project: string,
  location: string,
  interceptDeploymentGroupId: string,
) =>
  `projects/${project}/locations/${location}/interceptDeploymentGroups/${interceptDeploymentGroupId}`;

const toAttrs = (
  group: networksecurity.InterceptDeploymentGroup,
  project: string,
) => {
  const name = group.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    interceptDeploymentGroupId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    network: group.network ? canonicalizeLink(group.network) : undefined,
    description: group.description,
    labels: userLabels(group.labels),
    state: group.state,
    reconciling: group.reconciling === true,
    nestedDeployments: (group.nestedDeployments ?? []).map((deployment) => ({
      name: deployment.name,
      state: deployment.state,
    })),
    locations: (group.locations ?? []).map((location) => ({
      location: location.location,
      state: location.state,
    })),
    connectedEndpointGroups: (group.connectedEndpointGroups ?? []).map(
      (endpointGroup) => ({ name: endpointGroup.name }),
    ),
    createTime: group.createTime,
    updateTime: group.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsInterceptDeploymentGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const InterceptDeploymentGroupProvider = () =>
  Provider.succeed(InterceptDeploymentGroup, {
    stables: [
      "name",
      "interceptDeploymentGroupId",
      "project",
      "location",
      "network",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.interceptDeploymentGroupId ?? output?.interceptDeploymentGroupId;
      const nextId = news.interceptDeploymentGroupId
        ? rfc1035(news.interceptDeploymentGroupId, "intercept-deployment-group")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const previousNetwork = linkKey(olds?.network ?? output?.network);
      const nextNetwork = linkKey(news.network);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousNetwork.length > 0 && previousNetwork !== nextNetwork)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const interceptDeploymentGroupId = yield* toPhysicalId(
        id,
        olds?.interceptDeploymentGroupId,
        output?.interceptDeploymentGroupId,
        "intercept-deployment-group",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, interceptDeploymentGroupId);
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
        const items = yield* collectPages(
          networksecurity.listProjectsLocationsInterceptDeploymentGroups.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.interceptDeploymentGroups,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const interceptDeploymentGroupId = yield* toPhysicalId(
        id,
        news.interceptDeploymentGroupId,
        output?.interceptDeploymentGroupId,
        "intercept-deployment-group",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(
        env.project,
        location,
        interceptDeploymentGroupId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const network = canonicalizeLink(news.network);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsInterceptDeploymentGroups({
            parent: parentOf(env.project, location),
            interceptDeploymentGroupId,
            body: {
              network,
              description: news.description,
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
        current = yield* waitUntilReady(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networksecurity.patchProjectsLocationsInterceptDeploymentGroups(
            {
              name: current.name ?? name,
              updateMask: updateMask.join(","),
              body: {
                name: current.name ?? name,
                labels: desiredLabels,
                description: news.description,
              },
            },
          );
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsInterceptDeploymentGroups({
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
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
