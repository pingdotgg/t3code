import * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import * as Effect from "effect/Effect";
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
  compact,
  expandParent,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  toPhysicalId,
  userAnnotations,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type ArtifactConfig = {
  /**
   * URI of the artifact that is deployed (without tag or digest), e.g.
   * `us-docker.pkg.dev/{project}/{repo}/image`. Immutable per entry.
   */
  uri?: string;
  /**
   * Artifact Analysis project that stores provenance.
   */
  googleArtifactAnalysis?: {
    projectId?: string;
  };
  /**
   * Artifact Registry package that stores the artifact.
   */
  googleArtifactRegistry?: {
    artifactRegistryPackage?: string;
    projectId?: string;
  };
};

export type InsightsConfigProjects = {
  /**
   * Project ids to track with this InsightsConfig.
   */
  projectIds?: string[];
};

export type InsightsConfigProps = {
  /**
   * Insights config id (the `{insightsConfig}` segment of
   * `projects/{project}/locations/{location}/insightsConfigs/{insightsConfig}`).
   * If omitted, a unique RFC1035 name is generated. Immutable —
   * changing it replaces the config.
   */
  insightsConfigId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the config. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile
   *   region, else `us-central1`)
   */
  location?: string;
  /**
   * App Hub application to associate, as
   * `projects/{project}/locations/{location}/applications/{application}`
   * or the application id (combined with `location`).
   */
  appHubApplication?: string;
  /**
   * Projects to track with this InsightsConfig.
   */
  projects?: InsightsConfigProjects;
  /**
   * Artifact configurations of the artifacts that are deployed.
   */
  artifactConfigs?: ArtifactConfig[];
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * User annotations (AIP-148).
   */
  annotations?: Record<string, string>;
};

export type InsightsConfig = Resource<
  "GCP.DeveloperConnect.InsightsConfig",
  InsightsConfigProps,
  {
    /** Full resource name. */
    name: string;
    /** Insights config id (last path segment). */
    insightsConfigId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** App Hub application resource name, if any. */
    appHubApplication: string | undefined;
    /** Projects tracked by this config. */
    projects: InsightsConfigProjects | undefined;
    /** Artifact configurations. */
    artifactConfigs: ArtifactConfig[];
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** User annotations. */
    annotations: Record<string, string>;
    /** Runtime configurations discovered for the application. */
    runtimeConfigs: developerconnect.RuntimeConfig[] | undefined;
    /** Server-reported state (`PENDING`, `COMPLETE`, `ERROR`). */
    state: string | undefined;
    /** True while Developer Connect is reconciling the config. */
    reconciling: boolean;
    /** Setup errors, if any. */
    errors: developerconnect.Status[] | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Developer Connect InsightsConfig — the SDLC event hub that ties an
 * App Hub application, runtime environments, and deployed artifacts
 * together.
 *
 * Changing `insightsConfigId`, `location`, `appHubApplication`, or
 * `projects` replaces the config. Labels, annotations, and artifact configs
 * update in place.
 *
 * ### Creating an Insights Config
 * **Example:** Generated name
 * ```typescript
 * const insights = yield* GCP.DeveloperConnect.InsightsConfig("Sdlc", {
 *   projects: { projectIds: ["{project}"] },
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * **Example:** App Hub application and artifacts
 * ```typescript
 * const insights = yield* GCP.DeveloperConnect.InsightsConfig("Sdlc", {
 *   insightsConfigId: "app-sdlc",
 *   appHubApplication: application.name,
 *   artifactConfigs: [
 *     {
 *       uri: "us-docker.pkg.dev/{project}/{repo}/image",
 *       googleArtifactRegistry: {
 *         projectId: "{project}",
 *         artifactRegistryPackage: "image",
 *       },
 *     },
 *   ],
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating an Insights Config
 * **Example:** Labels on tracked projects
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const insights = yield* GCP.DeveloperConnect.InsightsConfig("Sdlc", {
 *   insightsConfigId: "app-sdlc",
 *   projects: { projectIds: ["{project}"] },
 *   labels: { env: "prod", team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category DeveloperConnect
 */
export const InsightsConfig = Resource<InsightsConfig>(
  "GCP.DeveloperConnect.InsightsConfig",
);

const resourceName = (
  project: string,
  location: string,
  insightsConfigId: string,
) =>
  `projects/${project}/locations/${location}/insightsConfigs/${insightsConfigId}`;

const toArtifactConfigs = (
  configs: ArtifactConfig[] | undefined,
): developerconnect.ArtifactConfig[] | undefined => {
  if (configs === undefined) return undefined;
  return configs.map((config) =>
    compact({
      uri: config.uri,
      googleArtifactAnalysis: config.googleArtifactAnalysis
        ? compact({ projectId: config.googleArtifactAnalysis.projectId })
        : undefined,
      googleArtifactRegistry: config.googleArtifactRegistry
        ? compact({
            artifactRegistryPackage:
              config.googleArtifactRegistry.artifactRegistryPackage,
            projectId: config.googleArtifactRegistry.projectId,
          })
        : undefined,
    }),
  );
};

const fromArtifactConfigs = (
  configs: developerconnect.ArtifactConfig[] | undefined,
): ArtifactConfig[] =>
  (configs ?? []).map((config) =>
    compact({
      uri: config.uri,
      googleArtifactAnalysis: config.googleArtifactAnalysis
        ? compact({ projectId: config.googleArtifactAnalysis.projectId })
        : undefined,
      googleArtifactRegistry: config.googleArtifactRegistry
        ? compact({
            artifactRegistryPackage:
              config.googleArtifactRegistry.artifactRegistryPackage,
            projectId: config.googleArtifactRegistry.projectId,
          })
        : undefined,
    }),
  );

const toAttrs = (
  item: developerconnect.InsightsConfig,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "insightsConfigs", region);
  return {
    name,
    insightsConfigId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    appHubApplication: item.appHubApplication,
    projects: item.projects
      ? compact({ projectIds: item.projects.projectIds })
      : undefined,
    artifactConfigs: fromArtifactConfigs(item.artifactConfigs),
    labels: userLabels(item.labels),
    annotations: userAnnotations(item.annotations),
    runtimeConfigs: item.runtimeConfigs,
    state: item.state,
    reconciling: item.reconciling === true,
    errors: item.errors,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  developerconnect
    .getProjectsLocationsInsightsConfigs({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, (parent) =>
    listLabeledPages(
      developerconnect.listProjectsLocationsInsightsConfigs.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.insightsConfigs,
      (item) => item.labels,
    ),
  );

export const InsightsConfigProvider = () =>
  Provider.succeed(InsightsConfig, {
    stables: ["name", "insightsConfigId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.insightsConfigId ?? output?.insightsConfigId,
        nextId:
          news.insightsConfigId ??
          olds?.insightsConfigId ??
          output?.insightsConfigId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        // The API rejects patches to the tracked scope ("Projects cannot be
        // updated"), so a new App Hub application or project set replaces.
        extra:
          olds !== undefined &&
          ((olds.appHubApplication ?? "") !== (news.appHubApplication ?? "") ||
            fingerprint(olds.projects?.projectIds ?? []) !==
              fingerprint(news.projects?.projectIds ?? [])),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const insightsConfigId = yield* toPhysicalId(
        id,
        olds?.insightsConfigId,
        output?.insightsConfigId,
        "insightsconfig",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, insightsConfigId);
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
      const insightsConfigId = yield* toPhysicalId(
        id,
        news.insightsConfigId,
        output?.insightsConfigId,
        "insightsconfig",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, insightsConfigId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const annotations = news.annotations;
      const appHubApplication =
        news.appHubApplication === undefined
          ? undefined
          : expandParent(
              news.appHubApplication,
              env.project,
              location,
              "applications",
            );
      const body = compact({
        appHubApplication,
        projects: news.projects
          ? compact({ projectIds: news.projects.projectIds })
          : undefined,
        artifactConfigs: toArtifactConfigs(news.artifactConfigs),
        labels: desiredLabels,
        annotations,
      });

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* developerconnect
          .createProjectsLocationsInsightsConfigs({
            parent: parentOf(env.project, location),
            insightsConfigId,
            body,
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
      const changed =
        upsert.length > 0 ||
        removed.length > 0 ||
        fingerprint(userAnnotations(current.annotations)) !==
          fingerprint(userAnnotations(annotations)) ||
        fingerprint(fromArtifactConfigs(current.artifactConfigs)) !==
          fingerprint(news.artifactConfigs ?? []);

      if (changed) {
        const operation = yield* developerconnect
          .patchProjectsLocationsInsightsConfigs({
            name: current.name ?? name,
            body: compact({
              ...body,
              appHubApplication: undefined,
              projects: undefined,
            }),
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
        if (operation === undefined) {
          const created = yield* developerconnect
            .createProjectsLocationsInsightsConfigs({
              parent: parentOf(env.project, location),
              insightsConfigId,
              body,
            })
            .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
          if (created !== undefined) {
            yield* waitForOperation(created);
          }
        } else {
          yield* waitForOperation(operation);
        }
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* developerconnect
        .deleteProjectsLocationsInsightsConfigs({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
