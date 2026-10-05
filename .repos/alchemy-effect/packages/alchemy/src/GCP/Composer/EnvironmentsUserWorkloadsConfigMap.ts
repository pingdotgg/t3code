import * as composer from "@distilled.cloud/gcp/composer_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  dataKey,
  environmentParent,
  lastSegment,
  mapOf,
  parseWorkloadName,
  toPhysicalId,
} from "./internal.ts";

export type EnvironmentsUserWorkloadsConfigMapProps = {
  /**
   * Parent environment resource name
   * (`projects/{project}/locations/{location}/environments/{environment}`).
   * Immutable — changing it replaces the ConfigMap.
   */
  environmentName: string;
  /**
   * ConfigMap id (the last path segment). If omitted, a unique RFC1035
   * name is generated from the stack, stage, and logical id. Must start
   * with a lowercase letter, be 1-63 characters, and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable — changing it replaces the
   * ConfigMap.
   */
  configMapId?: string;
  /**
   * Kubernetes ConfigMap data as key-value pairs. Stored exactly as
   * given: ConfigMaps have no labels, so Alchemy tracks them by name.
   */
  data?: Record<string, string>;
};

export type EnvironmentsUserWorkloadsConfigMap = Resource<
  "GCP.Composer.EnvironmentsUserWorkloadsConfigMap",
  EnvironmentsUserWorkloadsConfigMapProps,
  {
    /** Full resource name `{environment}/userWorkloadsConfigMaps/{configMapId}`. */
    name: string;
    /** ConfigMap id (last path segment). */
    configMapId: string;
    /** Parent environment resource name. */
    environmentName: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** Parent environment id. */
    environmentId: string;
    /** ConfigMap data. */
    data: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A user workloads ConfigMap for Airflow tasks that run with the
 * Kubernetes executor or KubernetesPodOperator.
 *
 * Supported on Cloud Composer 3 (`composer-3-airflow-2` and newer).
 * ConfigMaps have no labels field, so Alchemy tracks them by name and
 * never adds keys to `data`. `environmentName` and `configMapId` are
 * identity — changing either replaces the ConfigMap.
 *
 * ### Creating a User Workloads ConfigMap
 * **Example:** Generated name
 * ```typescript
 * const airflow = yield* GCP.Composer.Environment("Airflow", {
 *   config: {
 *     environmentSize: "ENVIRONMENT_SIZE_SMALL",
 *     nodeConfig: {
 *       serviceAccount: "composer-env@my-project.iam.gserviceaccount.com",
 *     },
 *     softwareConfig: { imageVersion: "composer-3-airflow-2" },
 *   },
 * });
 * const config = yield* GCP.Composer.EnvironmentsUserWorkloadsConfigMap(
 *   "TaskConfig",
 *   {
 *     environmentName: airflow.name,
 *     data: { LOG_LEVEL: "INFO" },
 *   },
 * );
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const config = yield* GCP.Composer.EnvironmentsUserWorkloadsConfigMap(
 *   "TaskConfig",
 *   {
 *     environmentName: airflow.name,
 *     configMapId: "task-config",
 *     data: { LOG_LEVEL: "DEBUG", REGION: "us-central1" },
 *   },
 * );
 * ```
 *
 * ### Updating data
 * **Example:** Change ConfigMap values
 * ```typescript
 * const config = yield* GCP.Composer.EnvironmentsUserWorkloadsConfigMap(
 *   "TaskConfig",
 *   {
 *     environmentName: airflow.name,
 *     configMapId: "task-config",
 *     data: { LOG_LEVEL: "WARN" },
 *   },
 * );
 * ```
 *
 * @resource
 * @category Composer
 */
export const EnvironmentsUserWorkloadsConfigMap =
  Resource<EnvironmentsUserWorkloadsConfigMap>(
    "GCP.Composer.EnvironmentsUserWorkloadsConfigMap",
  );

export class EnvironmentsUserWorkloadsConfigMapNotResolved extends Data.TaggedError(
  "GCP.Composer.EnvironmentsUserWorkloadsConfigMapNotResolved",
)<{
  name: string;
}> {}

export class EnvironmentsUserWorkloadsConfigMapStillExists extends Data.TaggedError(
  "GCP.Composer.EnvironmentsUserWorkloadsConfigMapStillExists",
)<{
  name: string;
}> {}

const resourceName = (environmentName: string, configMapId: string) =>
  `${environmentParent(environmentName)}/userWorkloadsConfigMaps/${configMapId}`;

const toAttrs = (
  configMap: composer.UserWorkloadsConfigMap,
  environmentName: string,
) => {
  const name = configMap.name ?? resourceName(environmentName, "");
  const parsed = parseWorkloadName(name);
  const parent = environmentParent(environmentName || name);
  return {
    name,
    configMapId: parsed.configMapId ?? lastSegment(name),
    environmentName: parent,
    project: parsed.project,
    location: parsed.location,
    environmentId: parsed.environmentId,
    data: mapOf(configMap.data),
  };
};

const getByName = (name: string) =>
  composer
    .getProjectsLocationsEnvironmentsUserWorkloadsConfigMaps({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((current) =>
      current === undefined
        ? Effect.void
        : Effect.fail(
            new EnvironmentsUserWorkloadsConfigMapStillExists({ name }),
          ),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.Composer.EnvironmentsUserWorkloadsConfigMapStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const EnvironmentsUserWorkloadsConfigMapProvider = () =>
  Provider.succeed(EnvironmentsUserWorkloadsConfigMap, {
    stables: [
      "name",
      "configMapId",
      "environmentName",
      "project",
      "location",
      "environmentId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.configMapId ?? output?.configMapId;
      const idChanged =
        previousId !== undefined &&
        news.configMapId !== undefined &&
        news.configMapId !== previousId;
      const previousParent = olds?.environmentName ?? output?.environmentName;
      const parentChanged =
        previousParent !== undefined &&
        environmentParent(news.environmentName) !==
          environmentParent(previousParent);
      if (!idChanged && !parentChanged) return undefined;
      return { action: "replace" as const, deleteFirst: false };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const environmentName = olds?.environmentName ?? output?.environmentName;
      if (environmentName === undefined) return undefined;
      const configMapId = yield* toPhysicalId(
        id,
        olds?.configMapId,
        output?.configMapId,
      );
      const name = output?.name ?? resourceName(environmentName, configMapId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, environmentName);
      // No labels: a generated id embeds stack/stage/id, and a row we
      // created is in state. Only an explicit id found without state is
      // ambiguous.
      return output === undefined && olds?.configMapId !== undefined
        ? Unowned(attrs)
        : attrs;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const configMapId = yield* toPhysicalId(
        id,
        news.configMapId,
        output?.configMapId,
      );
      const parent = environmentParent(news.environmentName);
      const name = resourceName(parent, configMapId);
      const desiredData = mapOf(news.data);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* composer
          .createProjectsLocationsEnvironmentsUserWorkloadsConfigMaps({
            parent,
            body: {
              name,
              data: desiredData,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new EnvironmentsUserWorkloadsConfigMapNotResolved({
          name,
        });
      }

      if (dataKey(current.data) !== dataKey(desiredData)) {
        current =
          yield* composer.updateProjectsLocationsEnvironmentsUserWorkloadsConfigMaps(
            {
              name: current.name ?? name,
              body: {
                name: current.name ?? name,
                data: desiredData,
              },
            },
          );
      }

      return toAttrs(current, parent);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* composer
        .deleteProjectsLocationsEnvironmentsUserWorkloadsConfigMaps({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(output.name);
    }),
  });
