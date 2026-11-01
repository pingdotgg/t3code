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

export type EnvironmentsUserWorkloadsSecretProps = {
  /**
   * Parent environment resource name
   * (`projects/{project}/locations/{location}/environments/{environment}`).
   * Immutable — changing it replaces the Secret.
   */
  environmentName: string;
  /**
   * Secret id (the last path segment). If omitted, a unique RFC1035 name
   * is generated from the stack, stage, and logical id. Must start with a
   * lowercase letter, be 1-63 characters, and match
   * `[a-z]([-a-z0-9]*[a-z0-9])?`. Immutable — changing it replaces the
   * Secret.
   */
  secretId?: string;
  /**
   * Kubernetes Secret data as key-value pairs. Values must be
   * base64-encoded strings. Stored exactly as given: Secrets have no
   * labels, so Alchemy tracks them by name.
   *
   * `secrets.get` clears data values in the response; keys remain.
   */
  data?: Record<string, string>;
};

export type EnvironmentsUserWorkloadsSecret = Resource<
  "GCP.Composer.EnvironmentsUserWorkloadsSecret",
  EnvironmentsUserWorkloadsSecretProps,
  {
    /** Full resource name `{environment}/userWorkloadsSecrets/{secretId}`. */
    name: string;
    /** Secret id (last path segment). */
    secretId: string;
    /** Parent environment resource name. */
    environmentName: string;
    /** Project id. */
    project: string;
    /** Region id (`us-central1`, …). */
    location: string;
    /** Parent environment id. */
    environmentId: string;
    /**
     * Secret data. `secrets.get` clears
     * values, so this may contain empty strings after a refresh.
     */
    data: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A user workloads Secret for Airflow tasks that run with the Kubernetes
 * executor or KubernetesPodOperator.
 *
 * Supported on Cloud Composer 3 (`composer-3-airflow-2` and newer).
 * Secrets have no labels field, so Alchemy tracks them by name and
 * never adds keys to `data`. `environmentName` and `secretId` are
 * identity — changing either replaces the Secret. Data values must be
 * base64-encoded.
 *
 * ### Creating a User Workloads Secret
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
 * const secret = yield* GCP.Composer.EnvironmentsUserWorkloadsSecret(
 *   "TaskSecret",
 *   {
 *     environmentName: airflow.name,
 *     data: { password: btoa("s3cret") },
 *   },
 * );
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const secret = yield* GCP.Composer.EnvironmentsUserWorkloadsSecret(
 *   "TaskSecret",
 *   {
 *     environmentName: airflow.name,
 *     secretId: "task-secret",
 *     data: { token: btoa("abc123") },
 *   },
 * );
 * ```
 *
 * ### Updating data
 * **Example:** Rotate a value
 * ```typescript
 * const secret = yield* GCP.Composer.EnvironmentsUserWorkloadsSecret(
 *   "TaskSecret",
 *   {
 *     environmentName: airflow.name,
 *     secretId: "task-secret",
 *     data: { token: btoa("rotated") },
 *   },
 * );
 * ```
 *
 * @resource
 * @category Composer
 */
export const EnvironmentsUserWorkloadsSecret =
  Resource<EnvironmentsUserWorkloadsSecret>(
    "GCP.Composer.EnvironmentsUserWorkloadsSecret",
  );

export class EnvironmentsUserWorkloadsSecretNotResolved extends Data.TaggedError(
  "GCP.Composer.EnvironmentsUserWorkloadsSecretNotResolved",
)<{
  name: string;
}> {}

export class EnvironmentsUserWorkloadsSecretStillExists extends Data.TaggedError(
  "GCP.Composer.EnvironmentsUserWorkloadsSecretStillExists",
)<{
  name: string;
}> {}

const resourceName = (environmentName: string, secretId: string) =>
  `${environmentParent(environmentName)}/userWorkloadsSecrets/${secretId}`;

const toAttrs = (
  secret: composer.UserWorkloadsSecret,
  environmentName: string,
) => {
  const name = secret.name ?? resourceName(environmentName, "");
  const parsed = parseWorkloadName(name);
  const parent = environmentParent(environmentName || name);
  return {
    name,
    secretId: parsed.secretId ?? lastSegment(name),
    environmentName: parent,
    project: parsed.project,
    location: parsed.location,
    environmentId: parsed.environmentId,
    data: mapOf(secret.data),
  };
};

const getByName = (name: string) =>
  composer
    .getProjectsLocationsEnvironmentsUserWorkloadsSecrets({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((current) =>
      current === undefined
        ? Effect.void
        : Effect.fail(new EnvironmentsUserWorkloadsSecretStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag ===
        "GCP.Composer.EnvironmentsUserWorkloadsSecretStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const keysOf = (map: Record<string, string>) =>
  Object.keys(map).sort().join("\0");

const valuesCleared = (map: Record<string, string>) =>
  Object.values(map).every((value) => value.length === 0);

export const EnvironmentsUserWorkloadsSecretProvider = () =>
  Provider.succeed(EnvironmentsUserWorkloadsSecret, {
    stables: [
      "name",
      "secretId",
      "environmentName",
      "project",
      "location",
      "environmentId",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.secretId ?? output?.secretId;
      const idChanged =
        previousId !== undefined &&
        news.secretId !== undefined &&
        news.secretId !== previousId;
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
      const secretId = yield* toPhysicalId(
        id,
        olds?.secretId,
        output?.secretId,
      );
      const name = output?.name ?? resourceName(environmentName, secretId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, environmentName);
      // No labels: a generated id embeds stack/stage/id, and a row we
      // created is in state. Only an explicit id found without state is
      // ambiguous.
      return output === undefined && olds?.secretId !== undefined
        ? Unowned(attrs)
        : attrs;
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const secretId = yield* toPhysicalId(id, news.secretId, output?.secretId);
      const parent = environmentParent(news.environmentName);
      const name = resourceName(parent, secretId);
      const desiredData = mapOf(news.data);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* composer
          .createProjectsLocationsEnvironmentsUserWorkloadsSecrets({
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
        return yield* new EnvironmentsUserWorkloadsSecretNotResolved({ name });
      }

      const observed = mapOf(current.data);
      const observedCleared = valuesCleared(observed);
      const keysChanged = keysOf(observed) !== keysOf(desiredData);
      const desiredUserChanged = dataKey(news.data) !== dataKey(olds?.data);
      const shouldSync =
        (!observedCleared && dataKey(observed) !== dataKey(desiredData)) ||
        (observedCleared && (keysChanged || desiredUserChanged));

      if (shouldSync) {
        current =
          yield* composer.updateProjectsLocationsEnvironmentsUserWorkloadsSecrets(
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
        .deleteProjectsLocationsEnvironmentsUserWorkloadsSecrets({
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
