import * as clouddeploy from "@distilled.cloud/gcp/clouddeploy_v1";
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
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type SkaffoldGitSource = {
  /** Git repository URL. */
  repo?: string;
  /** Path relative to the repository root. */
  path?: string;
  /** Git ref (branch, tag, or commit). */
  ref?: string;
};

export type SkaffoldGCBRepoSource = {
  /** Cloud Build 2nd gen repository resource name. */
  repository?: string;
  /** Path relative to the repository root. */
  path?: string;
  /** Git ref (branch, tag, or commit). */
  ref?: string;
};

export type SkaffoldGCSSource = {
  /** Cloud Storage source URI. */
  source?: string;
  /** Path relative to the source root. */
  path?: string;
};

export type SkaffoldModules = {
  /** Configs to use from the module. */
  configs?: string[];
  /** Git source for the Skaffold configs. */
  git?: SkaffoldGitSource;
  /** Google Cloud Build repository source. */
  googleCloudBuildRepo?: SkaffoldGCBRepoSource;
  /** Cloud Storage source. */
  googleCloudStorage?: SkaffoldGCSSource;
};

export type CustomTargetSkaffoldActions = {
  /**
   * Skaffold custom action responsible for deploy operations.
   */
  deployAction?: string;
  /**
   * Skaffold custom action responsible for render operations. If omitted,
   * Cloud Deploy runs `skaffold render`.
   */
  renderAction?: string;
  /**
   * Skaffold modules Cloud Deploy includes before diagnose.
   */
  includeSkaffoldModules?: SkaffoldModules[];
};

export type ContainerTask = {
  /** Container image to execute. */
  image?: string;
  /** Container arguments. Overrides the image default. */
  args?: string[];
  /** Environment variables set in the container. */
  env?: Record<string, string>;
  /** Container entrypoint. Overrides the image default. */
  command?: string[];
};

export type Task = {
  /** Container executed in the Cloud Build environment. */
  container?: ContainerTask;
};

export type CustomTargetTasks = {
  /**
   * Task responsible for render operations. If omitted, Cloud Deploy
   * performs its default render.
   */
  render?: Task;
  /**
   * Task responsible for deploy operations.
   */
  deploy?: Task;
};

export type CustomTargetTypeProps = {
  /**
   * Custom target type id (the `{customTargetType}` segment of
   * `projects/{project}/locations/{location}/customTargetTypes/{customTargetType}`).
   * If omitted, a unique RFC1035 name is generated from the stack, stage,
   * and logical id. Immutable — changing it replaces the type.
   */
  customTargetTypeId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the type. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Human-readable description. Max length 255 characters.
   */
  description?: string;
  /**
   * Skaffold custom actions used to render and deploy this type. Provide
   * either `customActions` or `tasks`.
   */
  customActions?: CustomTargetSkaffoldActions;
  /**
   * Render and deploy tasks for this type. Provide either `customActions`
   * or `tasks`.
   */
  tasks?: CustomTargetTasks;
  /**
   * User annotations (not used by Cloud Deploy).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type CustomTargetType = Resource<
  "GCP.CloudDeploy.CustomTargetType",
  CustomTargetTypeProps,
  {
    /** Full resource name. */
    name: string;
    /** Custom target type id (last path segment). */
    customTargetTypeId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Human-readable description. */
    description: string | undefined;
    /** Skaffold custom actions, if configured. */
    customActions: CustomTargetSkaffoldActions | undefined;
    /** Render and deploy tasks, if configured. */
    tasks: CustomTargetTasks | undefined;
    /** User annotations. */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-computed etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Deploy custom target type — a reusable render/deploy
 * definition for deploying to systems besides the supported runtimes.
 *
 * Changing `customTargetTypeId` or `location` replaces the type.
 * Description, labels, annotations, `customActions`, and `tasks` update
 * in place.
 *
 * ### Creating a Custom Target Type
 * **Example:** Skaffold custom actions
 * ```typescript
 * const type = yield* GCP.CloudDeploy.CustomTargetType("Helm", {
 *   customActions: { deployAction: "helm-deploy" },
 *   description: "helm custom target",
 * });
 * ```
 *
 * **Example:** Container tasks
 * ```typescript
 * const type = yield* GCP.CloudDeploy.CustomTargetType("Helm", {
 *   tasks: {
 *     deploy: {
 *       container: { image: "us-docker.pkg.dev/my-project/tools/deploy:latest" },
 *     },
 *   },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Custom Target Type
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Description and labels
 * ```typescript
 * const type = yield* GCP.CloudDeploy.CustomTargetType("Helm", {
 *   customActions: { deployAction: "helm-deploy" },
 *   description: "helm custom target v2",
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category CloudDeploy
 */
export const CustomTargetType = Resource<CustomTargetType>(
  "GCP.CloudDeploy.CustomTargetType",
);

const resourceName = (
  project: string,
  location: string,
  customTargetTypeId: string,
) =>
  `projects/${project}/locations/${location}/customTargetTypes/${customTargetTypeId}`;

const toCustomActions = (
  value: clouddeploy.CustomTargetSkaffoldActions | undefined,
): CustomTargetSkaffoldActions | undefined =>
  value === undefined
    ? undefined
    : {
        deployAction: value.deployAction,
        renderAction: value.renderAction,
        includeSkaffoldModules: value.includeSkaffoldModules,
      };

const toContainerTask = (
  value: clouddeploy.ContainerTask | undefined,
): ContainerTask | undefined =>
  value === undefined
    ? undefined
    : {
        image: value.image,
        args: value.args,
        env: value.env === undefined ? undefined : stringMap(value.env),
        command: value.command,
      };

const toTask = (value: clouddeploy.Task | undefined): Task | undefined =>
  value === undefined
    ? undefined
    : { container: toContainerTask(value.container) };

const toTasks = (
  value: clouddeploy.CustomTargetTasks | undefined,
): CustomTargetTasks | undefined =>
  value === undefined
    ? undefined
    : {
        render: toTask(value.render),
        deploy: toTask(value.deploy),
      };

const toAttrs = (item: clouddeploy.CustomTargetType, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "customTargetTypes");
  return {
    name,
    customTargetTypeId: item.customTargetTypeId ?? parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: item.description,
    customActions: toCustomActions(item.customActions),
    tasks: toTasks(item.tasks),
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  clouddeploy
    .getProjectsLocationsCustomTargetTypes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      clouddeploy.listProjectsLocationsCustomTargetTypes.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.customTargetTypes,
      (item) => item.labels,
    ),
  );

export const CustomTargetTypeProvider = () =>
  Provider.succeed(CustomTargetType, {
    stables: [
      "name",
      "customTargetTypeId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.customTargetTypeId ?? output?.customTargetTypeId,
        nextId:
          news.customTargetTypeId ??
          olds?.customTargetTypeId ??
          output?.customTargetTypeId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const customTargetTypeId = yield* toPhysicalId(
        id,
        olds?.customTargetTypeId,
        output?.customTargetTypeId,
        "customtargettype",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, customTargetTypeId);
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
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const customTargetTypeId = yield* toPhysicalId(
        id,
        news.customTargetTypeId,
        output?.customTargetTypeId,
        "customtargettype",
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceName(env.project, location, customTargetTypeId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* clouddeploy
          .createProjectsLocationsCustomTargetTypes({
            parent: parentOf(env.project, location),
            customTargetTypeId,
            body: {
              description: news.description,
              customActions: news.customActions,
              tasks: news.tasks,
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
        !sameText(current.description, news.description) && "description",
        fingerprint(toCustomActions(current.customActions)) !==
          fingerprint(news.customActions) && "customActions",
        fingerprint(toTasks(current.tasks)) !== fingerprint(news.tasks) &&
          "tasks",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* clouddeploy.patchProjectsLocationsCustomTargetTypes({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              description: news.description,
              customActions: news.customActions,
              tasks: news.tasks,
              annotations: desiredAnnotations,
              labels: desiredLabels,
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
      const operation = yield* clouddeploy
        .deleteProjectsLocationsCustomTargetTypes({
          name: output.name,
          allowMissing: true,
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
