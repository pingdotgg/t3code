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
  lastSegment,
  normalizeLocation,
  parentOf,
  parseResourceName,
  resourceName,
  toId,
  toResourcePath,
  userLabels,
} from "./names.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "mirroringDeployments";
const DEFAULT_LOCATION = "us-central1-a";

export type MirroringDeploymentProps = {
  /**
   * Deployment id (the `{mirroringDeployment}` segment of
   * `projects/{project}/locations/{location}/mirroringDeployments/{mirroringDeployment}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the deployment.
   */
  mirroringDeploymentId?: string;
  /**
   * Zone of the deployment (e.g. `us-central1-a`). Immutable — changing
   * it replaces the deployment. `US-CENTRAL1-A` is accepted and
   * normalized to `us-central1-a`.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Parent mirroring deployment group, as a full resource name.
   * Immutable — changing it replaces the deployment.
   */
  mirroringDeploymentGroup: string;
  /**
   * Regional forwarding rule that fronts the mirroring collectors, as a
   * resource path or Compute self-link. Immutable — changing it replaces
   * the deployment.
   */
  forwardingRule: string;
  /**
   * Human-readable description of the deployment.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MirroringDeployment = Resource<
  "GCP.NetworkSecurity.MirroringDeployment",
  MirroringDeploymentProps,
  {
    /** Full resource name. */
    name: string;
    /** Deployment id (last path segment). */
    mirroringDeploymentId: string;
    /** Project id. */
    project: string;
    /** Zone id (e.g. `us-central1-a`). */
    location: string;
    /** Parent deployment group resource name. */
    mirroringDeploymentGroup: string | undefined;
    /** Collector forwarding-rule resource path. */
    forwardingRule: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported lifecycle state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Whether the API is still reconciling intended vs actual state. */
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
 * A Network Security Integration mirroring deployment — a zonal GENEVE
 * collector, typically an internal passthrough load balancer, that
 * belongs to a global mirroring deployment group.
 *
 * Changing `mirroringDeploymentId`, `location`, `mirroringDeploymentGroup`,
 * or `forwardingRule` replaces the deployment. Description and labels
 * update in place.
 *
 * ### Creating a Deployment
 * **Example:** Generated name
 * ```typescript
 * const deployment = yield* GCP.NetworkSecurity.MirroringDeployment("Collector", {
 *   location: "us-central1-a",
 *   mirroringDeploymentGroup: group.name,
 *   forwardingRule: rule.selfLink,
 * });
 * ```
 *
 * **Example:** Named deployment with labels
 * ```typescript
 * const deployment = yield* GCP.NetworkSecurity.MirroringDeployment("Collector", {
 *   mirroringDeploymentId: "app-collector-a",
 *   location: "us-central1-a",
 *   mirroringDeploymentGroup: group.name,
 *   forwardingRule: rule.selfLink,
 *   description: "zone a collector",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Deployment
 * **Example:** Description and labels
 * ```typescript
 * const deployment = yield* GCP.NetworkSecurity.MirroringDeployment("Collector", {
 *   mirroringDeploymentId: "app-collector-a",
 *   location: "us-central1-a",
 *   mirroringDeploymentGroup: group.name,
 *   forwardingRule: rule.selfLink,
 *   description: "zone a collector v2",
 *   labels: { env: "prod", role: "nsi" },
 * });
 * ```
 *
 * @resource
 * @category NetworkSecurity
 */
export const MirroringDeployment = Resource<MirroringDeployment>(
  "GCP.NetworkSecurity.MirroringDeployment",
);

export class MirroringDeploymentNotResolved extends Data.TaggedError(
  "GCP.NetworkSecurity.MirroringDeploymentNotResolved",
)<{
  name: string;
}> {}

export class MirroringDeploymentFailed extends Data.TaggedError(
  "GCP.NetworkSecurity.MirroringDeploymentFailed",
)<{
  name: string;
  state: string | undefined;
}> {}

export class MirroringDeploymentStillExists extends Data.TaggedError(
  "GCP.NetworkSecurity.MirroringDeploymentStillExists",
)<{
  name: string;
}> {}

const isPendingState = (state: string | undefined) =>
  state === "CREATING" || state === "DELETING" || state === "STATE_UNSPECIFIED";

const toForwardingRule = (value: string) => {
  const path = toResourcePath(value);
  const match = path.match(
    /projects\/[^/]+\/regions\/[^/]+\/forwardingRules\/[^/]+/,
  );
  return match ? match[0]! : path;
};

const toAttrs = (
  deployment: networksecurity.MirroringDeployment,
  project: string,
) => {
  const name = deployment.name ?? "";
  const parsed = parseResourceName(name, COLLECTION);
  return {
    name,
    mirroringDeploymentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_LOCATION,
    mirroringDeploymentGroup: deployment.mirroringDeploymentGroup,
    forwardingRule: deployment.forwardingRule,
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
    .getProjectsLocationsMirroringDeployments({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.filterOrFail(
      (deployment): deployment is networksecurity.MirroringDeployment =>
        deployment !== undefined,
      () => new MirroringDeploymentNotResolved({ name }),
    ),
    Effect.filterOrFail(
      (deployment) => deployment.state !== "DELETE_FAILED",
      (deployment) =>
        new MirroringDeploymentFailed({ name, state: deployment.state }),
    ),
    Effect.filterOrFail(
      (deployment) => !isPendingState(deployment.state),
      () => new MirroringDeploymentNotResolved({ name }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.MirroringDeploymentNotResolved",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((deployment) =>
      deployment === undefined
        ? Effect.void
        : Effect.fail(new MirroringDeploymentStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.NetworkSecurity.MirroringDeploymentStillExists",
      times: 10,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const listOwned = (project: string) =>
  networksecurity.listProjectsLocationsMirroringDeployments
    .pages({
      parent: parentOf(project, "-"),
      pageSize: 1000,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.mirroringDeployments ?? []),
      ),
      Stream.filter((deployment) =>
        Object.keys(deployment.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((deployment) => toAttrs(deployment, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const MirroringDeploymentProvider = () =>
  Provider.succeed(MirroringDeployment, {
    stables: [
      "name",
      "mirroringDeploymentId",
      "project",
      "location",
      "mirroringDeploymentGroup",
      "forwardingRule",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.mirroringDeploymentId ?? output?.mirroringDeploymentId;
      const nextId = news.mirroringDeploymentId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_LOCATION,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_LOCATION,
      );
      const previousGroup = lastSegment(
        olds?.mirroringDeploymentGroup ??
          output?.mirroringDeploymentGroup ??
          "",
      );
      const nextGroup = lastSegment(news.mirroringDeploymentGroup);
      const previousRule = lastSegment(
        olds?.forwardingRule ?? output?.forwardingRule ?? "",
      );
      const nextRule = lastSegment(news.forwardingRule);
      const replace =
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousGroup.length > 0 && previousGroup !== nextGroup) ||
        (previousRule.length > 0 && previousRule !== nextRule);
      if (!replace) return undefined;
      return { action: "replace" as const };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const mirroringDeploymentId = yield* toId(
        id,
        olds?.mirroringDeploymentId,
        output?.mirroringDeploymentId,
        "mdep",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_LOCATION,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, mirroringDeploymentId);
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
      const mirroringDeploymentId = yield* toId(
        id,
        news.mirroringDeploymentId,
        output?.mirroringDeploymentId,
        "mdep",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_LOCATION,
      );
      const name = resourceName(
        env.project,
        location,
        COLLECTION,
        mirroringDeploymentId,
      );
      const mirroringDeploymentGroup = toResourcePath(
        news.mirroringDeploymentGroup,
      );
      const forwardingRule = toForwardingRule(news.forwardingRule);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networksecurity
          .createProjectsLocationsMirroringDeployments({
            parent: parentOf(env.project, location),
            mirroringDeploymentId,
            body: {
              mirroringDeploymentGroup,
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
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new MirroringDeploymentNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");

      if (labelsChanged || descriptionChanged) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          descriptionChanged ? "description" : undefined,
        ].filter((field): field is string => field !== undefined);
        const operation =
          yield* networksecurity.patchProjectsLocationsMirroringDeployments({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilReady(current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networksecurity
        .deleteProjectsLocationsMirroringDeployments({
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
        yield* waitForOperation(operation, {
          notFoundOk: true,
        });
      }
      yield* waitUntilGone(output.name);
    }),
  });
