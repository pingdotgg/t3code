import * as config from "@distilled.cloud/gcp/config_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  expandNamed,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  serviceAccountName,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type PreviewProps = {
  /**
   * Preview id (the `{preview}` segment of
   * `projects/{project}/locations/{location}/previews/{preview}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the preview.
   */
  previewId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the preview. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * Terraform blueprint to preview. Required unless `deployment` is set.
   * There is no update API — changing the blueprint replaces the preview.
   */
  terraformBlueprint?: config.TerraformBlueprint;
  /**
   * Existing deployment whose current state is used as the preview
   * baseline, as
   * `projects/{project}/locations/{location}/deployments/{deployment}`
   * or a deployment id. Changing it replaces the preview.
   */
  deployment?: string;
  /**
   * Preview mode (`DEFAULT` or `DELETE`). Changing it replaces the
   * preview.
   */
  previewMode?: config.PreviewPreviewModeEnum | (string & {});
  /**
   * Service account used to preview resources. Format
   * `projects/{project}/serviceAccounts/{email}`, or an email / account
   * id which is expanded. Required by the API. Changing it replaces the
   * preview.
   */
  serviceAccount: string;
  /**
   * GCS prefix for Cloud Build logs and artifacts (`gs://{bucket}/{folder}`).
   * Changing it replaces the preview.
   */
  artifactsGcsBucket?: string;
  /**
   * Cloud Build worker pool
   * `projects/{project}/locations/{location}/workerPools/{workerPoolId}`.
   * Changing it replaces the preview.
   */
  workerPool?: string;
  /**
   * Terraform version constraint (e.g. `"=1.5.7"`). Changing it replaces
   * the preview.
   */
  tfVersionConstraint?: string;
  /**
   * Terraform provider source configuration. Changing it replaces the
   * preview.
   */
  providerConfig?: config.ProviderConfig;
  /**
   * User annotations. Changing them replaces the preview (no patch API).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   * Changing them replaces the preview (no patch API).
   */
  labels?: Record<string, string>;
};

export type Preview = Resource<
  "GCP.Config.Preview",
  PreviewProps,
  {
    /** Full resource name. */
    name: string;
    /** Preview id (last path segment). */
    previewId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Terraform blueprint that was previewed. */
    terraformBlueprint: config.TerraformBlueprint | undefined;
    /** Baseline deployment resource name. */
    deployment: string | undefined;
    /** Preview mode. */
    previewMode: string | undefined;
    /** Service account used for the preview. */
    serviceAccount: string | undefined;
    /** Artifacts bucket prefix. */
    artifactsGcsBucket: string | undefined;
    /** Cloud Build worker pool. */
    workerPool: string | undefined;
    /** Terraform version constraint. */
    tfVersionConstraint: string | undefined;
    /** Provider configuration. */
    providerConfig: config.ProviderConfig | undefined;
    /** Server-reported preview state. */
    state: string | undefined;
    /** Server-reported error code. */
    errorCode: string | undefined;
    /** Cloud Build id. */
    build: string | undefined;
    /** Preview artifacts. */
    previewArtifacts: config.PreviewArtifacts | undefined;
    /** Preview logs GCS URI. */
    logs: string | undefined;
    /** Resolved Terraform version. */
    tfVersion: string | undefined;
    /** User annotations. */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Infrastructure Manager preview — the Terraform plan Infra Manager
 * would apply to reach the desired blueprint (or to delete a
 * deployment).
 *
 * Previews have no patch API. Changing identity (`previewId`,
 * `location`) or any input (blueprint, service account, labels, …)
 * replaces the preview. Create and delete are long-running operations
 * and typically invoke Cloud Build.
 *
 * ### Creating a Preview
 * **Example:** Git blueprint
 * ```typescript
 * const preview = yield* GCP.Config.Preview("Plan", {
 *   serviceAccount:
 *     "projects/my-project/serviceAccounts/sa@my-project.iam.gserviceaccount.com",
 *   terraformBlueprint: {
 *     gitSource: {
 *       repo: "https://github.com/terraform-google-modules/terraform-docs-samples.git",
 *       directory: "storage/quickstart",
 *     },
 *   },
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Preview against an existing deployment
 * ```typescript
 * const preview = yield* GCP.Config.Preview("Plan", {
 *   serviceAccount:
 *     "projects/my-project/serviceAccounts/sa@my-project.iam.gserviceaccount.com",
 *   deployment: existingDeployment,
 *   previewMode: "DEFAULT",
 * });
 * ```
 *
 * @resource
 * @category Config
 */
export const Preview = Resource<Preview>("GCP.Config.Preview");

const resourceName = (project: string, location: string, previewId: string) =>
  `projects/${project}/locations/${location}/previews/${previewId}`;

const toAttrs = (item: config.Preview, project: string, region: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "previews", region);
  return {
    name,
    previewId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    terraformBlueprint: item.terraformBlueprint,
    deployment: item.deployment,
    previewMode: item.previewMode,
    serviceAccount: item.serviceAccount,
    artifactsGcsBucket: item.artifactsGcsBucket,
    workerPool: item.workerPool,
    tfVersionConstraint: item.tfVersionConstraint,
    providerConfig: item.providerConfig,
    state: item.state,
    errorCode: item.errorCode,
    build: item.build,
    previewArtifacts: item.previewArtifacts,
    logs: item.logs,
    tfVersion: item.tfVersion,
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    createTime: item.createTime,
  };
};

const snapshotOf = (input: {
  terraformBlueprint?: config.TerraformBlueprint;
  deployment?: string;
  previewMode?: string;
  serviceAccount?: string;
  artifactsGcsBucket?: string;
  workerPool?: string;
  tfVersionConstraint?: string;
  providerConfig?: config.ProviderConfig;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
}) => ({
  terraformBlueprint: input.terraformBlueprint,
  deployment: input.deployment,
  previewMode: input.previewMode,
  serviceAccount: input.serviceAccount,
  artifactsGcsBucket: input.artifactsGcsBucket,
  workerPool: input.workerPool,
  tfVersionConstraint: input.tfVersionConstraint,
  providerConfig: input.providerConfig,
  annotations: input.annotations ?? {},
  labels: toLabels(input.labels),
});

const getByName = (name: string) =>
  config
    .getProjectsLocationsPreviews({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      config.listProjectsLocationsPreviews.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.previews,
      (item) => item.labels,
    ),
  );

export const PreviewProvider = () =>
  Provider.succeed(Preview, {
    stables: ["name", "previewId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const extra =
        olds === undefined
          ? false
          : fingerprint(
              snapshotOf({
                terraformBlueprint: olds.terraformBlueprint,
                deployment:
                  olds.deployment === undefined
                    ? undefined
                    : expandNamed(
                        olds.deployment,
                        env.project,
                        location,
                        "deployments",
                      ),
                previewMode: olds.previewMode,
                serviceAccount: serviceAccountName(
                  olds.serviceAccount,
                  env.project,
                ),
                artifactsGcsBucket: olds.artifactsGcsBucket,
                workerPool: olds.workerPool,
                tfVersionConstraint: olds.tfVersionConstraint,
                providerConfig: olds.providerConfig,
                annotations: olds.annotations,
                labels: olds.labels,
              }),
            ) !==
            fingerprint(
              snapshotOf({
                terraformBlueprint: news.terraformBlueprint,
                deployment:
                  news.deployment === undefined
                    ? undefined
                    : expandNamed(
                        news.deployment,
                        env.project,
                        location,
                        "deployments",
                      ),
                previewMode: news.previewMode,
                serviceAccount: serviceAccountName(
                  news.serviceAccount,
                  env.project,
                ),
                artifactsGcsBucket: news.artifactsGcsBucket,
                workerPool: news.workerPool,
                tfVersionConstraint: news.tfVersionConstraint,
                providerConfig: news.providerConfig,
                annotations: news.annotations,
                labels: news.labels,
              }),
            );
      return replaceOnIdentity({
        previousId: olds?.previewId ?? output?.previewId,
        nextId: news.previewId ?? olds?.previewId ?? output?.previewId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const previewId = yield* toPhysicalId(
        id,
        olds?.previewId,
        output?.previewId,
        "preview",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, previewId);
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
      const previewId = yield* toPhysicalId(
        id,
        news.previewId,
        output?.previewId,
        "preview",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, previewId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const serviceAccount = serviceAccountName(
        news.serviceAccount,
        env.project,
      );
      const deployment =
        news.deployment === undefined
          ? undefined
          : expandNamed(news.deployment, env.project, location, "deployments");

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* config
          .createProjectsLocationsPreviews({
            parent: parentOf(env.project, location),
            previewId,
            body: {
              terraformBlueprint: news.terraformBlueprint,
              deployment,
              previewMode: news.previewMode,
              serviceAccount,
              artifactsGcsBucket: news.artifactsGcsBucket,
              workerPool: news.workerPool,
              tfVersionConstraint: news.tfVersionConstraint,
              providerConfig: news.providerConfig,
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

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* config
        .deleteProjectsLocationsPreviews({
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
