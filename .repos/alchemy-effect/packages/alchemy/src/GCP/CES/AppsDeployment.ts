import * as ces from "@distilled.cloud/gcp/ces_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  DEFAULT_CHANNEL_PROFILE,
  encodeOwnershipLine,
  expandApp,
  forEachApp,
  hasOwnershipMarker,
  normalizeLocation,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  replaceOnIdentity,
  retryTransient,
  sameJson,
  sameText,
  toPhysicalId,
  updateMaskOf,
  waitUntilGone,
} from "./internal.ts";

export type AppsDeploymentProps = {
  /**
   * Parent CES app. Full name
   * `projects/{project}/locations/{location}/apps/{app}` or the app id
   * (combined with `location`). Immutable — changing it replaces the
   * deployment.
   */
  app: string;
  /**
   * Region used when `app` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * Deployment id. If omitted, a unique name is generated. Immutable —
   * changing it replaces the deployment.
   */
  deploymentId?: string;
  /**
   * Human-readable name. Deployments have no description or labels
   * field, so Alchemy stamps ownership into `displayName`.
   */
  displayName?: string;
  /**
   * Channel profile used by the deployment. Defaults to an API channel.
   */
  channelProfile?: ces.ChannelProfile;
  /**
   * App version to deploy (`.../apps/{app}/versions/{version}`). The API
   * rejects the `-` draft alias, so pin a snapshot from `GCP.CES.AppsVersion`.
   */
  appVersion: string;
  /**
   * Experiment configuration.
   */
  experimentConfig?: ces.ExperimentConfig;
};

export type AppsDeployment = Resource<
  "GCP.CES.AppsDeployment",
  AppsDeploymentProps,
  {
    /** Full resource name `.../apps/{app}/deployments/{deployment}`. */
    name: string;
    /** Deployment id (last path segment). */
    deploymentId: string;
    /** Parent app resource name. */
    app: string;
    /** Location id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Channel profile. */
    channelProfile: ces.ChannelProfile | undefined;
    /** Deployed app version. */
    appVersion: string | undefined;
    /** Experiment configuration. */
    experimentConfig: ces.ExperimentConfig | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-assigned etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Customer Engagement Suite deployment — an immutable, queryable
 * channel binding of an app version.
 *
 * Deployments have no labels or description field — Alchemy stamps
 * ownership into `displayName` so `list` / nuke can find them. Parent
 * app, location, and deployment id are immutable.
 *
 * ### Creating a Deployment
 * **Example:** App version on the API channel
 * ```typescript
 * const version = yield* GCP.CES.AppsVersion("V1", { app: app.name });
 * const deployment = yield* GCP.CES.AppsDeployment("Prod", {
 *   app: app.name,
 *   appVersion: version.name,
 *   displayName: "prod",
 *   channelProfile: { channelType: "API", profileId: "api" },
 * });
 * ```
 *
 * @resource
 * @category CES
 */
export const AppsDeployment = Resource<AppsDeployment>(
  "GCP.CES.AppsDeployment",
);

export class AppsDeploymentNotResolved extends Data.TaggedError(
  "GCP.CES.AppsDeploymentNotResolved",
)<{
  name: string;
}> {}

const resourceName = (app: string, deploymentId: string) =>
  `${app}/deployments/${deploymentId}`;

const toAttrs = (
  deployment: ces.Deployment,
  project: string,
  region: string,
  appHint?: string,
) => {
  const name = deployment.name ?? "";
  const parsed = parseResourceName(name, "deployments", region);
  return {
    name,
    deploymentId: parsed.id,
    app: name.includes("/deployments/")
      ? parsed.app
      : (appHint ?? parsed.parent),
    location: parsed.location,
    project: parsed.project || project,
    displayName: parseOwnership(deployment.displayName).text,
    channelProfile: deployment.channelProfile,
    appVersion: deployment.appVersion,
    experimentConfig: deployment.experimentConfig,
    createTime: deployment.createTime,
    updateTime: deployment.updateTime,
    etag: deployment.etag,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : ces
        .getProjectsLocationsAppsDeployments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string, region: string) =>
  collectPages(
    ces.listProjectsLocationsAppsDeployments.pages({
      parent,
      pageSize: 100,
    }),
    (page) => page.deployments,
  ).pipe(
    Effect.map((deployments) =>
      deployments
        .filter((deployment) => hasOwnershipMarker(deployment.displayName))
        .map((deployment) => toAttrs(deployment, project, region, parent)),
    ),
  );

export const AppsDeploymentProvider = () =>
  Provider.succeed(AppsDeployment, {
    stables: [
      "name",
      "deploymentId",
      "app",
      "location",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.deploymentId ?? output?.deploymentId,
        nextId: news.deploymentId,
        previousParent: olds?.app ?? output?.app,
        nextParent: news.app,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const app = olds?.app
        ? expandApp(olds.app, env.project, location)
        : output?.app;
      const deploymentId = yield* toPhysicalId(
        id,
        olds?.deploymentId,
        output?.deploymentId,
      );
      const name =
        output?.name ??
        (app !== undefined ? resourceName(app, deploymentId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region, app);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* forEachApp(
          env.project,
          (parent) => listAt(parent, env.project, env.region),
          env.region,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const app = expandApp(news.app, env.project, location);
      const deploymentId = yield* toPhysicalId(
        id,
        news.deploymentId,
        output?.deploymentId,
      );
      const name = output?.name ?? resourceName(app, deploymentId);
      const ownership = yield* createInternalLabels(id);
      const displayName = encodeOwnershipLine(ownership, news.displayName);
      const channelProfile = news.channelProfile ?? DEFAULT_CHANNEL_PROFILE;
      const appVersion = news.appVersion;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* retryTransient(
          ces.createProjectsLocationsAppsDeployments({
            parent: app,
            deploymentId,
            body: {
              displayName,
              channelProfile,
              appVersion,
              experimentConfig: news.experimentConfig,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AppsDeploymentNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const channelChanged = !sameJson(current.channelProfile, channelProfile);
      const versionChanged = !sameText(current.appVersion, appVersion);
      const experimentChanged = !sameJson(
        current.experimentConfig,
        news.experimentConfig,
      );

      if (
        displayChanged ||
        channelChanged ||
        versionChanged ||
        experimentChanged
      ) {
        current = yield* retryTransient(
          ces.patchProjectsLocationsAppsDeployments({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              channelChanged ? "channel_profile" : undefined,
              versionChanged ? "app_version" : undefined,
              experimentChanged ? "experiment_config" : undefined,
            ),
            body: {
              displayName,
              channelProfile,
              appVersion,
              experimentConfig: news.experimentConfig,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region, app);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* retryTransient(
        ces.deleteProjectsLocationsAppsDeployments({ name: output.name }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name));
    }),
  });
