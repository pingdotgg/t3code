import * as deploymentmanager from "@distilled.cloud/gcp/deploymentmanager_v2";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fingerprint,
  getDeployment,
  getManifest,
  labelsToRecord,
  listOwnedDeployments,
  recordToLabels,
  ResourceNotResolved,
  sameText,
  settleDeployment,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type ImportFile = {
  /**
   * Import name, as referenced from `target.config` (`path` / `type`).
   */
  name?: string;
  /**
   * Full contents of the imported template or file.
   */
  content?: string;
};

export type ConfigFile = {
  /**
   * YAML configuration that lists the resources in this deployment.
   */
  content: string;
};

export type TargetConfiguration = {
  /**
   * Root configuration file for the deployment.
   */
  config: ConfigFile;
  /**
   * Templates or other files imported by `config`.
   */
  imports?: ImportFile[];
};

export type DeploymentProps = {
  /**
   * Deployment name. If omitted, a unique RFC1035 name is generated
   * from the stack, stage, and logical id. Immutable — changing it
   * replaces the deployment.
   */
  deploymentId?: string;
  /**
   * User-provided description of the deployment.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Keys and values must match `[a-z]([-a-z0-9]*[a-z0-9])?`.
   */
  labels?: Record<string, string>;
  /**
   * Configuration and imports that describe the resources to deploy.
   */
  target: TargetConfiguration;
  /**
   * Policy for creating resources in the configuration
   * (`CREATE_OR_ACQUIRE` or `ACQUIRE`).
   * @default "CREATE_OR_ACQUIRE"
   */
  createPolicy?:
    | deploymentmanager.InsertDeploymentsCreatePolicyEnum
    | (string & {});
  /**
   * Policy for deleting resources when the deployment is destroyed
   * (`DELETE` or `ABANDON`).
   * @default "DELETE"
   */
  deletePolicy?:
    | deploymentmanager.DeleteDeploymentsDeletePolicyEnum
    | (string & {});
  /**
   * When true, create or update shell resources without instantiating
   * them. A later reconcile with `preview: false` deploys the preview.
   * @default false
   */
  preview?: boolean;
};

export type Deployment = Resource<
  "GCP.DeploymentManager.Deployment",
  DeploymentProps,
  {
    /** Deployment name (RFC1035). */
    name: string;
    /** Deployment id; same as `name`. */
    deploymentId: string;
    /** Project id. */
    project: string;
    /** User description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Optimistic-locking fingerprint for update, stop, and cancelPreview. */
    fingerprint: string | undefined;
    /** URL of the last successfully deployed manifest. */
    manifest: string | undefined;
    /** Server-defined URL for the deployment. */
    selfLink: string | undefined;
    /** RFC3339 creation timestamp. */
    insertTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-assigned numeric id. */
    id: string | undefined;
    /**
     * True when Deployment Manager is previewing an update (`update` is
     * present on the live resource).
     */
    preview: boolean;
    /** Delete policy applied when destroying this deployment. */
    deletePolicy: string;
  },
  never,
  Providers
>;

/**
 * A Google Cloud Deployment Manager deployment — a configuration that
 * creates and manages a set of Google Cloud resources together.
 *
 * Changing `deploymentId` replaces the deployment. Description, labels,
 * target configuration, and `preview` update in place. Create, patch,
 * and delete return long-running operations.
 *
 * ### Creating a Deployment
 * **Example:** Generated name
 * ```typescript
 * const deployment = yield* GCP.DeploymentManager.Deployment("App", {
 *   target: {
 *     config: {
 *       content: `resources:
 * - name: topic
 *   type: pubsub.v1.topic
 *   properties:
 *     topic: my-topic
 * `,
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** Explicit name, labels, and imported template
 * ```typescript
 * const deployment = yield* GCP.DeploymentManager.Deployment("App", {
 *   deploymentId: "order-events",
 *   description: "pubsub topic for orders",
 *   labels: { env: "prod" },
 *   target: {
 *     config: {
 *       content: `imports:
 * - path: topic.jinja
 * resources:
 * - name: topic
 *   type: topic.jinja
 * `,
 *     },
 *     imports: [
 *       {
 *         name: "topic.jinja",
 *         content: `resources:
 * - name: topic
 *   type: pubsub.v1.topic
 *   properties:
 *     topic: {{ env["deployment"] }}
 * `,
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * ### Updating a Deployment
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Labels and description
 * ```typescript
 * const deployment = yield* GCP.DeploymentManager.Deployment("App", {
 *   description: "pubsub topic for orders (prod)",
 *   labels: { env: "prod", team: "platform" },
 *   target: existingTarget,
 * });
 * ```
 *
 * @resource
 * @category DeploymentManager
 */
export const Deployment = Resource<Deployment>(
  "GCP.DeploymentManager.Deployment",
);

const DEFAULT_CREATE_POLICY = "CREATE_OR_ACQUIRE";
const DEFAULT_DELETE_POLICY = "DELETE";

const desiredTarget = (
  target: TargetConfiguration,
): deploymentmanager.TargetConfiguration => ({
  config: { content: target.config.content },
  imports:
    target.imports === undefined
      ? undefined
      : target.imports.map((file) => ({
          name: file.name,
          content: file.content,
        })),
});

const observedTarget = (
  manifest: deploymentmanager.Manifest | undefined,
): TargetConfiguration | undefined => {
  if (manifest === undefined) return undefined;
  return {
    config: { content: manifest.config?.content ?? "" },
    imports: (manifest.imports ?? []).map((file) => ({
      name: file.name,
      content: file.content,
    })),
  };
};

const toAttrs = (
  item: deploymentmanager.Deployment,
  project: string,
  deletePolicy: string,
) => ({
  name: item.name ?? "",
  deploymentId: item.name ?? "",
  project,
  description: item.description,
  labels: userLabels(labelsToRecord(item.labels)),
  fingerprint: item.fingerprint,
  manifest: item.manifest,
  selfLink: item.selfLink,
  insertTime: item.insertTime,
  updateTime: item.updateTime,
  id: item.id,
  preview: item.update !== undefined,
  deletePolicy,
});

const replaceOnName = (input: {
  previousId: string | undefined;
  nextId: string | undefined;
}) => {
  if (
    input.previousId === undefined ||
    input.nextId === undefined ||
    input.nextId === input.previousId
  ) {
    return undefined;
  }
  return {
    action: "replace" as const,
    deleteFirst: false,
  };
};

export const DeploymentProvider = () =>
  Provider.succeed(Deployment, {
    stables: ["name", "deploymentId", "project", "id", "insertTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnName({
        previousId: olds?.deploymentId ?? output?.deploymentId,
        nextId: news.deploymentId ?? olds?.deploymentId ?? output?.deploymentId,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const deploymentId = yield* toPhysicalId(
        id,
        olds?.deploymentId,
        output?.deploymentId,
      );
      const existing = yield* getDeployment(
        env.project,
        output?.name ?? deploymentId,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        env.project,
        olds?.deletePolicy ?? output?.deletePolicy ?? DEFAULT_DELETE_POLICY,
      );
      return (yield* hasAlchemyLabels(id, labelsToRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwnedDeployments(env.project);
        return items.map((item) =>
          toAttrs(item, env.project, DEFAULT_DELETE_POLICY),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const deploymentId = yield* toPhysicalId(
        id,
        news.deploymentId,
        output?.deploymentId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const target = desiredTarget(news.target);
      const preview = news.preview === true;
      const createPolicy = news.createPolicy ?? DEFAULT_CREATE_POLICY;
      const deletePolicy = news.deletePolicy ?? DEFAULT_DELETE_POLICY;

      let current = yield* getDeployment(
        env.project,
        output?.name ?? deploymentId,
      );
      if (current !== undefined) {
        yield* settleDeployment(env.project, current);
        current = yield* getDeployment(
          env.project,
          current.name ?? deploymentId,
        );
      }

      if (current === undefined) {
        const created = yield* deploymentmanager
          .insertDeployments({
            project: env.project,
            preview,
            createPolicy,
            body: {
              name: deploymentId,
              description: news.description,
              labels: recordToLabels(desiredLabels),
              target,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(env.project, created);
        }
        current = yield* waitUntilExists(
          getDeployment(env.project, deploymentId),
          deploymentId,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name: deploymentId });
      }

      const name = current.name ?? deploymentId;
      const observedLabels = labelsToRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged = !sameText(
        current.description,
        news.description,
      );
      const observedPreview = current.update !== undefined;
      const previewChanged = observedPreview !== preview;
      const manifest = yield* getManifest(
        env.project,
        name,
        current.manifest ?? current.update?.manifest,
      );
      const targetChanged =
        olds === undefined
          ? fingerprint(observedTarget(manifest)) !== fingerprint(news.target)
          : fingerprint(olds.target) !== fingerprint(news.target);

      if (
        labelsChanged ||
        descriptionChanged ||
        previewChanged ||
        targetChanged
      ) {
        const operation = yield* deploymentmanager
          .patchDeployments({
            project: env.project,
            deployment: name,
            preview,
            createPolicy,
            deletePolicy,
            body: {
              name,
              fingerprint: current.fingerprint,
              description: news.description,
              labels: recordToLabels(desiredLabels),
              target,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        yield* waitForOperation(env.project, operation);
        current = yield* waitUntilExists(
          getDeployment(env.project, name),
          name,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      return toAttrs(current, env.project, deletePolicy);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getDeployment(env.project, output.name);
      if (existing !== undefined) {
        yield* settleDeployment(env.project, existing);
      }
      const operation = yield* deploymentmanager
        .deleteDeployments({
          project: env.project,
          deployment: output.name,
          deletePolicy: output.deletePolicy ?? DEFAULT_DELETE_POLICY,
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
        yield* waitForOperation(env.project, operation, { notFoundOk: true });
      }
      yield* waitUntilGone(
        getDeployment(env.project, output.name),
        output.name,
      );
    }),
  });
