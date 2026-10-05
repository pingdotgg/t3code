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
  DEFAULT_ZONE,
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

const COLLECTION = "interceptDeployments";

export type InterceptDeploymentState =
  | networksecurity.InterceptDeploymentStateEnum
  | (string & {});

export type InterceptDeploymentProps = {
  /**
   * Deployment id (the `{interceptDeployment}` segment of
   * `projects/{project}/locations/{location}/interceptDeployments/{interceptDeployment}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Immutable — changing it replaces the deployment.
   */
  interceptDeploymentId?: string;
  /**
   * Zone of the deployment (`us-central1-a`, …). Immutable — changing
   * it replaces the deployment. `US-CENTRAL1-A` is accepted and
   * normalized to `us-central1-a`.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Parent InterceptDeploymentGroup resource name
   * (`projects/{project}/locations/global/interceptDeploymentGroups/{interceptDeploymentGroup}`).
   * Immutable — changing it replaces the deployment.
   */
  interceptDeploymentGroup: string;
  /**
   * Regional forwarding rule that fronts interceptors, e.g.
   * `projects/{project}/regions/{region}/forwardingRules/{forwardingRule}`.
   * Immutable — changing it replaces the deployment.
   */
  forwardingRule: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type InterceptDeployment = Resource<
  "GCP.NetworkSecurity.InterceptDeployment",
  InterceptDeploymentProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/interceptDeployments/{interceptDeployment}`. */
    name: string;
    /** Deployment id (last path segment). */
    interceptDeploymentId: string;
    /** Project id. */
    project: string;
    /** Zone id (`us-central1-a`). */
    location: string;
    /** Parent InterceptDeploymentGroup resource name. */
    interceptDeploymentGroup: string | undefined;
    /** Forwarding rule resource name. */
    forwardingRule: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Whether reconciling is in progress. */
    reconciling: boolean;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A zonal intercept deployment — a GENEVE backend (typically an
 * internal passthrough load balancer) that belongs to a global
 * InterceptDeploymentGroup.
 *
 * Changing `interceptDeploymentId`, `location`, `interceptDeploymentGroup`,
 * or `forwardingRule` replaces the deployment. Description and labels
 * update in place.
 *
 * ### Creating an InterceptDeployment
 * **Example:** Attach a forwarding rule to a group
 * ```typescript
 * const deployment = yield* GCP.NetworkSecurity.InterceptDeployment(
 *   "ZoneA",
 *   {
 *     location: "us-central1-a",
 *     interceptDeploymentGroup: group.name,
 *     forwardingRule: rule.selfLink,
 *     description: "us-central1-a interceptors",
 *   },
 * );
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const InterceptDeployment = Resource<InterceptDeployment>(
  "GCP.NetworkSecurity.InterceptDeployment",
);

const resourceName = (
  project: string,
  location: string,
  interceptDeploymentId: string,
) =>
  `projects/${project}/locations/${location}/interceptDeployments/${interceptDeploymentId}`;

const toAttrs = (
  deployment: networksecurity.InterceptDeployment,
  project: string,
) => {
  const name = deployment.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  return {
    name,
    interceptDeploymentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_ZONE,
    interceptDeploymentGroup: deployment.interceptDeploymentGroup
      ? canonicalizeLink(deployment.interceptDeploymentGroup)
      : undefined,
    forwardingRule: deployment.forwardingRule
      ? canonicalizeLink(deployment.forwardingRule)
      : undefined,
    description: deployment.description,
    labels: userLabels(deployment.labels),
    state: deployment.state,
    reconciling: deployment.reconciling === true,
    createTime: deployment.createTime,
    updateTime: deployment.updateTime,
  };
};

const getByName = (name: string) =>
  networksecurity
    .getProjectsLocationsInterceptDeployments({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const InterceptDeploymentProvider = () =>
  Provider.succeed(InterceptDeployment, {
    stables: [
      "name",
      "interceptDeploymentId",
      "project",
      "location",
      "interceptDeploymentGroup",
      "forwardingRule",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.interceptDeploymentId ?? output?.interceptDeploymentId;
      const nextId = news.interceptDeploymentId
        ? rfc1035(news.interceptDeploymentId, "intercept-deployment")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const previousGroup = linkKey(
        olds?.interceptDeploymentGroup ?? output?.interceptDeploymentGroup,
      );
      const nextGroup = linkKey(news.interceptDeploymentGroup);
      const previousRule = linkKey(
        olds?.forwardingRule ?? output?.forwardingRule,
      );
      const nextRule = linkKey(news.forwardingRule);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousGroup.length > 0 && previousGroup !== nextGroup) ||
        (previousRule.length > 0 && previousRule !== nextRule)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const interceptDeploymentId = yield* toPhysicalId(
        id,
        olds?.interceptDeploymentId,
        output?.interceptDeploymentId,
        "intercept-deployment",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, interceptDeploymentId);
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
          networksecurity.listProjectsLocationsInterceptDeployments.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.interceptDeployments,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const interceptDeploymentId = yield* toPhysicalId(
        id,
        news.interceptDeploymentId,
        output?.interceptDeploymentId,
        "intercept-deployment",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const name = resourceName(env.project, location, interceptDeploymentId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const interceptDeploymentGroup = canonicalizeLink(
        news.interceptDeploymentGroup,
      );
      const forwardingRule = canonicalizeLink(news.forwardingRule);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsInterceptDeployments({
            parent: parentOf(env.project, location),
            interceptDeploymentId,
            body: {
              interceptDeploymentGroup,
              forwardingRule,
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
          yield* networksecurity.patchProjectsLocationsInterceptDeployments({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
            },
          });
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
        .deleteProjectsLocationsInterceptDeployments({ name: output.name })
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
