import * as appengine from "@distilled.cloud/gcp/appengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  catchMissing,
  DEFAULT_SERVICE,
  envVariablesOf,
  hasOwnershipMarker,
  jsonEqual,
  listServices,
  listVersions,
  MAX_VERSION_ID_LENGTH,
  ownedByAlchemy,
  ownershipLabels,
  parseVersionName,
  resolveAppsId,
  sameText,
  stampEnvVariables,
  toResourceId,
  updateMaskOf,
  versionOwnershipText,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

export type AppsServicesVersionProps = {
  /**
   * App Engine application id. Defaults to the current GCP project.
   * Immutable — changing it replaces the version.
   */
  appsId?: string;
  /**
   * Service id that owns this version.
   * @default "default"
   */
  serviceId?: string;
  /**
   * Version id (lowercase letters, numbers, hyphens). Reserved names
   * `default`, `latest`, and `ah-*` are rejected. If omitted, a unique
   * id is generated. Immutable — changing it replaces the version.
   */
  versionId?: string;
  /**
   * Runtime (for example `python311`, `nodejs20`). Immutable — changing
   * it replaces the version.
   */
  runtime?: string;
  /**
   * Execution environment (`standard` or `flexible`).
   * @default "standard"
   */
  env?: string;
  /**
   * Serving status. Defaults to `SERVING`.
   */
  servingStatus?: appengine.VersionServingStatusEnum | (string & {});
  /**
   * Instance class (`F1`, `F2`, `B1`, …).
   */
  instanceClass?: string;
  /**
   * Application environment variables. App Engine versions have no
   * labels field, so Alchemy stamps ownership into `ALCHEMY_OWNERSHIP`
   * and strips it from attributes.
   */
  envVariables?: Record<string, string | undefined>;
  /**
   * Code and artifacts that make up this version. Immutable — changing
   * it replaces the version.
   */
  deployment?: appengine.Deployment;
  /**
   * Application entrypoint.
   */
  entrypoint?: appengine.Entrypoint;
  /**
   * Automatic scaling configuration.
   */
  automaticScaling?: appengine.AutomaticScaling;
  /**
   * Basic scaling configuration.
   */
  basicScaling?: appengine.BasicScaling;
  /**
   * Manual scaling configuration.
   */
  manualScaling?: appengine.ManualScaling;
  /**
   * URL handlers.
   */
  handlers?: appengine.UrlMapList;
  /**
   * Whether the runtime is threadsafe.
   */
  threadsafe?: boolean;
  /**
   * Service account the version runs as.
   */
  serviceAccount?: string;
  /**
   * Inbound services the version receives.
   */
  inboundServices?: appengine.VersionInboundServicesItemEnumList;
  /**
   * VPC Access connector.
   */
  vpcAccessConnector?: appengine.VpcAccessConnector;
  /**
   * Allow second-generation runtimes to use bundled services.
   */
  appEngineApis?: boolean;
  /**
   * Runtime API version.
   */
  runtimeApiVersion?: string;
};

export type AppsServicesVersion = Resource<
  "GCP.AppEngine.AppsServicesVersion",
  AppsServicesVersionProps,
  {
    /** Full resource name `apps/{appsId}/services/{service}/versions/{id}`. */
    name: string;
    /** Version id. */
    versionId: string;
    /** Service id. */
    serviceId: string;
    /** App Engine application id. */
    appsId: string;
    /** Project id. */
    project: string;
    /** Runtime. */
    runtime: string | undefined;
    /** Execution environment. */
    env: string | undefined;
    /** Serving status. */
    servingStatus: string | undefined;
    /** Instance class. */
    instanceClass: string | undefined;
    /** User environment variables (ownership stamp stripped). */
    envVariables: Record<string, string>;
    /** Serving URL for this version. */
    versionUrl: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** Creator email. */
    createdBy: string | undefined;
    /** Disk usage in bytes. */
    diskUsageBytes: string | undefined;
    /** Automatic scaling, if configured. */
    automaticScaling: appengine.AutomaticScaling | undefined;
    /** Basic scaling, if configured. */
    basicScaling: appengine.BasicScaling | undefined;
    /** Manual scaling, if configured. */
    manualScaling: appengine.ManualScaling | undefined;
  },
  never,
  Providers
>;

/**
 * An App Engine service version.
 *
 * App Engine versions have no labels field, so Alchemy stamps ownership
 * into the `ALCHEMY_OWNERSHIP` environment variable for `list` / nuke.
 * Application, service, version id, runtime, environment, and
 * deployment are identity — changing any of them replaces the version.
 * Serving status, instance class, and scaling update in place.
 *
 * ### Creating a Version
 * **Example:** Python 3 standard environment
 * ```typescript
 * const version = yield* GCP.AppEngine.AppsServicesVersion("Api", {
 *   runtime: "python311",
 *   deployment: {
 *     zip: { sourceUrl: "https://storage.googleapis.com/bucket/app.zip" },
 *   },
 * });
 * ```
 *
 * **Example:** Named version with automatic scaling
 * ```typescript
 * const version = yield* GCP.AppEngine.AppsServicesVersion("Api", {
 *   versionId: "v1",
 *   serviceId: "default",
 *   runtime: "nodejs20",
 *   automaticScaling: {
 *     standardSchedulerSettings: { minInstances: 0, maxInstances: 1 },
 *   },
 *   deployment: {
 *     zip: { sourceUrl: "https://storage.googleapis.com/bucket/app.zip" },
 *   },
 * });
 * ```
 *
 * ### Updating a Version
 * **Example:** Stop serving
 * ```typescript
 * const version = yield* GCP.AppEngine.AppsServicesVersion("Api", {
 *   servingStatus: "STOPPED",
 *   deployment: {
 *     zip: { sourceUrl: "https://storage.googleapis.com/bucket/app.zip" },
 *   },
 * });
 * ```
 *
 * @resource
 * @category AppEngine
 */
export const AppsServicesVersion = Resource<AppsServicesVersion>(
  "GCP.AppEngine.AppsServicesVersion",
);

export class AppsServicesVersionNotResolved extends Data.TaggedError(
  "GCP.AppEngine.AppsServicesVersionNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  version: appengine.Version,
  appsId: string,
  serviceId: string,
  project: string,
) => {
  const parsed = parseVersionName(version.name ?? "");
  const versionId = version.id ?? parsed.versionsId ?? "";
  return {
    name:
      version.name ??
      `apps/${appsId}/services/${serviceId}/versions/${versionId}`,
    versionId,
    serviceId: parsed.servicesId ?? serviceId,
    appsId: parsed.appsId ?? appsId,
    project,
    runtime: version.runtime,
    env: version.env,
    servingStatus: version.servingStatus,
    instanceClass: version.instanceClass,
    envVariables: envVariablesOf(version.envVariables),
    versionUrl: version.versionUrl,
    createTime: version.createTime,
    createdBy: version.createdBy,
    diskUsageBytes: version.diskUsageBytes,
    automaticScaling: version.automaticScaling,
    basicScaling: version.basicScaling,
    manualScaling: version.manualScaling,
  };
};

const getById = (appsId: string, servicesId: string, versionsId: string) =>
  versionsId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        appengine.getAppsServicesVersions({
          appsId,
          servicesId,
          versionsId,
          view: "FULL",
        }),
      );

const findOwnedVersion = (id: string, versions: readonly appengine.Version[]) =>
  Effect.gen(function* () {
    for (const version of versions) {
      if (yield* ownedByAlchemy(id, versionOwnershipText(version))) {
        return version;
      }
    }
    return undefined;
  });

const desiredBody = (
  news: AppsServicesVersionProps,
  versionId: string,
  envVariables: Record<string, string | undefined>,
): appengine.Version => ({
  id: versionId,
  runtime: news.runtime,
  env: news.env,
  servingStatus: news.servingStatus,
  instanceClass: news.instanceClass,
  envVariables,
  deployment: news.deployment,
  entrypoint: news.entrypoint,
  automaticScaling: news.automaticScaling,
  basicScaling: news.basicScaling,
  manualScaling: news.manualScaling,
  handlers: news.handlers,
  threadsafe: news.threadsafe,
  serviceAccount: news.serviceAccount,
  inboundServices: news.inboundServices,
  vpcAccessConnector: news.vpcAccessConnector,
  appEngineApis: news.appEngineApis,
  runtimeApiVersion: news.runtimeApiVersion,
});

export const AppsServicesVersionProvider = () =>
  Provider.succeed(AppsServicesVersion, {
    stables: [
      "name",
      "versionId",
      "serviceId",
      "appsId",
      "project",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousApp = olds?.appsId ?? output?.appsId;
      const nextApp = news.appsId ?? previousApp;
      if (
        previousApp !== undefined &&
        nextApp !== undefined &&
        nextApp !== previousApp
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousService =
        olds?.serviceId ?? output?.serviceId ?? DEFAULT_SERVICE;
      const nextService = news.serviceId ?? previousService;
      if (nextService !== previousService) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.versionId ?? output?.versionId;
      if (
        previousId !== undefined &&
        news.versionId !== undefined &&
        news.versionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousRuntime = olds?.runtime ?? output?.runtime;
      if (
        previousRuntime !== undefined &&
        news.runtime !== undefined &&
        news.runtime !== previousRuntime
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousEnv = olds?.env ?? output?.env;
      if (
        previousEnv !== undefined &&
        news.env !== undefined &&
        news.env !== previousEnv
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (
        news.deployment !== undefined &&
        olds?.deployment !== undefined &&
        !jsonEqual(news.deployment, olds.deployment)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const appsId = yield* resolveAppsId(olds?.appsId, output?.appsId);
      const serviceId = olds?.serviceId ?? output?.serviceId ?? DEFAULT_SERVICE;
      const versionId = yield* toResourceId(
        id,
        olds?.versionId,
        output?.versionId,
        MAX_VERSION_ID_LENGTH,
      );
      let existing = yield* getById(appsId, serviceId, versionId);
      if (existing === undefined) {
        existing = yield* findOwnedVersion(
          id,
          yield* listVersions(appsId, serviceId),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, appsId, serviceId, env.project);
      return (yield* ownedByAlchemy(id, versionOwnershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const services = yield* listServices(env.project);
        const collected: ReturnType<typeof toAttrs>[] = [];
        for (const service of services) {
          const parsed = parseVersionName(service.name ?? "");
          const serviceId =
            service.id ?? parsed.servicesId ?? lastServiceId(service.name);
          const versions = yield* listVersions(env.project, serviceId);
          for (const version of versions) {
            if (hasOwnershipMarker(versionOwnershipText(version))) {
              collected.push(
                toAttrs(version, env.project, serviceId, env.project),
              );
            }
          }
        }
        return collected;
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const appsId = yield* resolveAppsId(news.appsId, output?.appsId);
      const serviceId = news.serviceId ?? output?.serviceId ?? DEFAULT_SERVICE;
      const versionId = yield* toResourceId(
        id,
        news.versionId,
        output?.versionId,
        MAX_VERSION_ID_LENGTH,
      );
      const ownership = yield* ownershipLabels(id);
      const envVariables = stampEnvVariables(ownership, news.envVariables);
      const body = desiredBody(news, versionId, envVariables);

      let current = yield* getById(appsId, serviceId, versionId);
      if (current === undefined) {
        current = yield* findOwnedVersion(
          id,
          yield* listVersions(appsId, serviceId),
        );
      }

      if (current === undefined) {
        const operation = yield* appengine
          .createAppsServicesVersions({
            appsId,
            servicesId: serviceId,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              Effect.succeed<appengine.Operation>({ done: true }),
            ),
          );
        if (operation.done !== true || operation.name !== undefined) {
          yield* waitForOperation(operation, { appsId });
        }
        current = yield* getById(appsId, serviceId, versionId);
      }

      if (current === undefined) {
        return yield* new AppsServicesVersionNotResolved({
          name: `apps/${appsId}/services/${serviceId}/versions/${versionId}`,
        });
      }

      const observedId = current.id ?? versionId;
      const servingChanged =
        news.servingStatus !== undefined &&
        !sameText(current.servingStatus, news.servingStatus);
      const classChanged =
        news.instanceClass !== undefined &&
        !sameText(current.instanceClass, news.instanceClass);
      const automaticChanged =
        news.automaticScaling !== undefined &&
        !jsonEqual(current.automaticScaling, news.automaticScaling);
      const basicChanged =
        news.basicScaling !== undefined &&
        !jsonEqual(current.basicScaling, news.basicScaling);
      const manualChanged =
        news.manualScaling !== undefined &&
        !jsonEqual(current.manualScaling, news.manualScaling);
      const updateMask = updateMaskOf(
        servingChanged ? "servingStatus" : undefined,
        classChanged ? "instanceClass" : undefined,
        automaticChanged ? "automaticScaling" : undefined,
        basicChanged ? "basicScaling" : undefined,
        manualChanged ? "manualScaling" : undefined,
      );
      if (updateMask.length > 0) {
        const operation = yield* appengine.patchAppsServicesVersions({
          appsId,
          servicesId: serviceId,
          versionsId: observedId,
          updateMask,
          body: {
            servingStatus: news.servingStatus,
            instanceClass: news.instanceClass,
            automaticScaling: news.automaticScaling,
            basicScaling: news.basicScaling,
            manualScaling: news.manualScaling,
          },
        });
        yield* waitForOperation(operation, { appsId });
        current = (yield* getById(appsId, serviceId, observedId)) ?? current;
      }

      return toAttrs(current, appsId, serviceId, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (output.versionId.length === 0) return;
      const operation = yield* appengine
        .deleteAppsServicesVersions({
          appsId: output.appsId,
          servicesId: output.serviceId || DEFAULT_SERVICE,
          versionsId: output.versionId,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation === undefined) return;
      yield* waitForOperation(operation, {
        appsId: output.appsId,
        notFoundOk: true,
      });
    }),
  });

const lastServiceId = (name: string | undefined) => {
  if (name === undefined) return DEFAULT_SERVICE;
  const parts = name.split("/").filter((part) => part.length > 0);
  const at = parts.lastIndexOf("services");
  return at >= 0 ? (parts[at + 1] ?? DEFAULT_SERVICE) : DEFAULT_SERVICE;
};
