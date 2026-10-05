import * as config from "@distilled.cloud/gcp/config_v1";
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
  expandNamed,
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type DeploymentUnit = {
  /**
   * Unit id. Must be unique within the deployment group.
   */
  id?: string;
  /**
   * Existing deployment this unit points at, as
   * `projects/{project}/locations/{location}/deployments/{deployment}`
   * or a deployment id (expanded in the group's location).
   */
  deployment?: string;
  /**
   * IDs of other units in this group that must finish first.
   */
  dependencies?: string[];
};

export type DeploymentGroupProps = {
  /**
   * Deployment group id (the `{deploymentGroup}` segment of
   * `projects/{project}/locations/{location}/deploymentGroups/{deploymentGroup}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the group.
   */
  deploymentGroupId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the group. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Deployment units arranged as a DAG. Units may reference an existing
   * deployment or act as placeholders for a later provision call.
   */
  deploymentUnits?: DeploymentUnit[];
  /**
   * User annotations (not used by Infra Manager).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type DeploymentGroup = Resource<
  "GCP.Config.DeploymentGroup",
  DeploymentGroupProps,
  {
    /** Full resource name. */
    name: string;
    /** Deployment group id (last path segment). */
    deploymentGroupId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Deployment units. */
    deploymentUnits: DeploymentUnit[];
    /** Server-reported resource state. */
    state: string | undefined;
    /** Extra state information. */
    stateDescription: string | undefined;
    /** Server-reported provisioning state. */
    provisioningState: string | undefined;
    /** Extra provisioning-state information. */
    provisioningStateDescription: string | undefined;
    /** User annotations. */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Infrastructure Manager deployment group — a DAG of deployment units
 * provisioned together.
 *
 * Changing `deploymentGroupId` or `location` replaces the group. Units,
 * labels, and annotations update in place. Create, patch, and delete are
 * long-running operations.
 *
 * ### Creating a Deployment Group
 * **Example:** Generated name
 * ```typescript
 * const group = yield* GCP.Config.DeploymentGroup("App", {
 *   deploymentUnits: [{ id: "network", dependencies: [] }],
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const group = yield* GCP.Config.DeploymentGroup("App", {
 *   deploymentGroupId: "app-group",
 *   deploymentUnits: [
 *     { id: "network", dependencies: [] },
 *     { id: "cluster", dependencies: ["network"] },
 *   ],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Deployment Group
 * **Example:** Labels and units
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const group = yield* GCP.Config.DeploymentGroup("App", {
 *   deploymentGroupId: "app-group",
 *   deploymentUnits: [
 *     { id: "network", dependencies: [] },
 *     { id: "cluster", dependencies: ["network"] },
 *     { id: "apps", dependencies: ["cluster"] },
 *   ],
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category Config
 */
export const DeploymentGroup = Resource<DeploymentGroup>(
  "GCP.Config.DeploymentGroup",
);

const resourceName = (
  project: string,
  location: string,
  deploymentGroupId: string,
) =>
  `projects/${project}/locations/${location}/deploymentGroups/${deploymentGroupId}`;

const toUnits = (
  units: readonly config.DeploymentUnit[] | undefined,
  project: string,
  location: string,
): DeploymentUnit[] =>
  (units ?? []).map((unit) => ({
    id: unit.id,
    deployment:
      unit.deployment === undefined
        ? undefined
        : expandNamed(unit.deployment, project, location, "deployments"),
    dependencies: unit.dependencies,
  }));

const desiredUnits = (
  units: readonly DeploymentUnit[] | undefined,
  project: string,
  location: string,
): config.DeploymentUnit[] =>
  (units ?? []).map((unit) => ({
    id: unit.id,
    deployment:
      unit.deployment === undefined
        ? undefined
        : expandNamed(unit.deployment, project, location, "deployments"),
    dependencies: unit.dependencies,
  }));

const toAttrs = (
  item: config.DeploymentGroup,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "deploymentGroups", region);
  const resolvedProject = parsed.project || project;
  return {
    name,
    deploymentGroupId: parsed.id,
    project: resolvedProject,
    location: parsed.location,
    deploymentUnits: toUnits(
      item.deploymentUnits,
      resolvedProject,
      parsed.location,
    ),
    state: item.state,
    stateDescription: item.stateDescription,
    provisioningState: item.provisioningState,
    provisioningStateDescription: item.provisioningStateDescription,
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  config
    .getProjectsLocationsDeploymentGroups({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      config.listProjectsLocationsDeploymentGroups.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.deploymentGroups,
      (item) => item.labels,
    ),
  );

/** Deployment group ids are at most 40 characters. */
const MAX_DEPLOYMENT_GROUP_ID_LENGTH = 40;

export const DeploymentGroupProvider = () =>
  Provider.succeed(DeploymentGroup, {
    stables: ["name", "deploymentGroupId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.deploymentGroupId ?? output?.deploymentGroupId,
        nextId:
          news.deploymentGroupId ??
          olds?.deploymentGroupId ??
          output?.deploymentGroupId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const deploymentGroupId = yield* toPhysicalId(
        id,
        olds?.deploymentGroupId,
        output?.deploymentGroupId,
        "deploymentgroup",
        MAX_DEPLOYMENT_GROUP_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, deploymentGroupId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const deploymentGroupId = yield* toPhysicalId(
        id,
        news.deploymentGroupId,
        output?.deploymentGroupId,
        "deploymentgroup",
        MAX_DEPLOYMENT_GROUP_ID_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, deploymentGroupId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const units = desiredUnits(news.deploymentUnits, env.project, location);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* config
          .createProjectsLocationsDeploymentGroups({
            parent: parentOf(env.project, location),
            deploymentGroupId,
            body: {
              deploymentUnits: units,
              annotations: desiredAnnotations,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        fingerprint(toUnits(current.deploymentUnits, env.project, location)) !==
          fingerprint(units) && "deploymentUnits",
      ]);

      if (mask.length > 0) {
        const operation = yield* config.patchProjectsLocationsDeploymentGroups({
          name: current.name ?? name,
          updateMask: mask,
          body: {
            labels: desiredLabels,
            annotations: desiredAnnotations,
            deploymentUnits: units,
          },
        });
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* config
        .deleteProjectsLocationsDeploymentGroups({
          name: output.name,
          force: true,
          deploymentReferencePolicy: "IGNORE_DEPLOYMENT_REFERENCES",
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
