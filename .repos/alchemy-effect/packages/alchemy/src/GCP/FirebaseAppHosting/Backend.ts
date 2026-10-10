import * as firebaseapphosting from "@distilled.cloud/gcp/firebaseapphosting_v1";
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
  defaultServiceAccount,
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  MAX_BACKEND_ID_LENGTH,
  normalizeLocation,
  normalizeServingLocality,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  sameBool,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type Codebase = {
  /**
   * Developer Connect gitRepositoryLink resource name
   * `projects/{project}/locations/{location}/connections/{connection}/gitRepositoryLinks/{repositoryLink}`.
   * The connection must use the Firebase App Hosting GitHub App.
   */
  repository?: string;
  /**
   * Directory relative to the repository root used as the web app root.
   * Defaults to the repository root. For a monorepo this is the directory
   * that contains `package.json` or `apphosting.yaml`.
   */
  rootDirectory?: string;
};

export type RunService = {
  /**
   * Cloud Run service name
   * `projects/{project}/locations/{location}/services/{serviceId}`.
   */
  service?: string;
};

export type ManagedResource = {
  /** Cloud Run service managed by App Hosting. */
  runService?: RunService;
};

export type BackendProps = {
  /**
   * Backend id (the `{backendId}` segment of
   * `projects/{project}/locations/{location}/backends/{backendId}`).
   * Also used as the Cloud Run service id and as part of the default
   * domain name. If omitted, a unique RFC1035 name is generated from the
   * stack, stage, and logical id. Immutable — changing it replaces the
   * backend. Must start with a letter, contain only lowercase letters,
   * digits, and hyphens, and be at most 49 characters.
   */
  backendId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the backend. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Service account used for Cloud Build and Cloud Run. Should have
   * `roles/firebaseapphosting.computeRunner` (or equivalent). Defaults
   * to `firebase-app-hosting-compute@{project}.iam.gserviceaccount.com`.
   */
  serviceAccount?: string;
  /**
   * How App Hosting serves this backend. `REGIONAL_STRICT` keeps
   * traffic in one region; `GLOBAL_ACCESS` uses App Hosting's
   * global-replicated serving. Immutable — changing it replaces the
   * backend.
   * @default "GLOBAL_ACCESS"
   */
  servingLocality?:
    | firebaseapphosting.BackendServingLocalityEnum
    | (string & {});
  /**
   * Human-readable name. 63 character limit.
   */
  displayName?: string;
  /**
   * Git repository connection used for event-driven updates.
   */
  codebase?: Codebase;
  /**
   * Firebase Web App id associated with this backend.
   */
  appId?: string;
  /**
   * Environment name used to load environment-specific configuration.
   */
  environment?: string;
  /**
   * When true, incoming request logs are disabled. Logs are enabled by
   * default.
   * @default false
   */
  requestLogsDisabled?: boolean;
  /**
   * User annotations (preserved by external tools).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Backend = Resource<
  "GCP.FirebaseAppHosting.Backend",
  BackendProps,
  {
    /** Full resource name. */
    name: string;
    /** Backend id (last path segment). */
    backendId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Service account email. */
    serviceAccount: string | undefined;
    /** Serving locality. */
    servingLocality: string | undefined;
    /** Human-readable name. */
    displayName: string | undefined;
    /** Git repository connection. */
    codebase: Codebase | undefined;
    /** Associated Firebase Web App id. */
    appId: string | undefined;
    /** Environment name. */
    environment: string | undefined;
    /** Whether incoming request logs are disabled. */
    requestLogsDisabled: boolean;
    /** Primary URI used to reach the backend. */
    uri: string | undefined;
    /** Cloud resources managed by this backend. */
    managedResources: ManagedResource[] | undefined;
    /** True while App Hosting is applying an LRO. */
    reconciling: boolean;
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
 * A Firebase App Hosting backend — the primary resource that provisions
 * a Cloud Run service and default domain for a web app.
 *
 * Changing `backendId`, `location`, or `servingLocality` replaces the
 * backend. Display name, codebase, app id, environment, request logs,
 * service account, labels, and annotations update in place.
 *
 * ### Creating a Backend
 * **Example:** Generated name
 * ```typescript
 * const backend = yield* GCP.FirebaseAppHosting.Backend("Web", {
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Explicit id and regional serving
 * ```typescript
 * const backend = yield* GCP.FirebaseAppHosting.Backend("Web", {
 *   backendId: "web-prod",
 *   servingLocality: "REGIONAL_STRICT",
 *   serviceAccount: "firebase-app-hosting-compute@my-project.iam.gserviceaccount.com",
 *   displayName: "production web",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Backend
 * **Example:** Display name and labels
 * ```typescript
 * const backend = yield* GCP.FirebaseAppHosting.Backend("Web", {
 *   displayName: "production web v2",
 *   labels: { env: "prod", team: "web" },
 * });
 * ```
 *
 * @resource
 * @category FirebaseAppHosting
 */
export const Backend = Resource<Backend>("GCP.FirebaseAppHosting.Backend");

const resourceName = (project: string, location: string, backendId: string) =>
  `projects/${project}/locations/${location}/backends/${backendId}`;

const toCodebase = (
  value: firebaseapphosting.Codebase | undefined,
): Codebase | undefined =>
  value === undefined
    ? undefined
    : {
        repository: value.repository,
        rootDirectory: value.rootDirectory,
      };

const toManagedResources = (
  value: firebaseapphosting.ManagedResourceList | undefined,
): ManagedResource[] | undefined =>
  value === undefined
    ? undefined
    : value.map((item) => ({
        runService: item.runService
          ? { service: item.runService.service }
          : undefined,
      }));

const toAttrs = (item: firebaseapphosting.Backend, project: string) => {
  const name = item.name ?? "";
  const parsed = parseName(name, "backends");
  return {
    name,
    backendId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    serviceAccount: item.serviceAccount,
    servingLocality: item.servingLocality,
    displayName: item.displayName,
    codebase: toCodebase(item.codebase),
    appId: item.appId,
    environment: item.environment,
    requestLogsDisabled: item.requestLogsDisabled === true,
    uri: item.uri,
    managedResources: toManagedResources(item.managedResources),
    reconciling: item.reconciling === true,
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  firebaseapphosting
    .getProjectsLocationsBackends({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      firebaseapphosting.listProjectsLocationsBackends.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.backends,
      (item) => item.labels,
    ),
  );

export const BackendProvider = () =>
  Provider.succeed(Backend, {
    stables: [
      "name",
      "backendId",
      "project",
      "location",
      "uid",
      "createTime",
      "servingLocality",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousServing = normalizeServingLocality(
        olds?.servingLocality ?? output?.servingLocality,
      );
      const nextServing = normalizeServingLocality(
        news.servingLocality ??
          olds?.servingLocality ??
          output?.servingLocality,
      );
      return replaceOnIdentity({
        previousId: olds?.backendId ?? output?.backendId,
        nextId: news.backendId ?? olds?.backendId ?? output?.backendId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          (olds?.servingLocality ?? output?.servingLocality) !== undefined &&
          previousServing !== nextServing,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const backendId = yield* toPhysicalId(
        id,
        olds?.backendId,
        output?.backendId,
        "backend",
        MAX_BACKEND_ID_LENGTH,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, backendId);
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const backendId = yield* toPhysicalId(
        id,
        news.backendId,
        output?.backendId,
        "backend",
        MAX_BACKEND_ID_LENGTH,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, backendId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};
      const desiredServing = normalizeServingLocality(news.servingLocality);
      const desiredServiceAccount =
        news.serviceAccount ?? defaultServiceAccount(env.project);
      const desiredLogsDisabled = news.requestLogsDisabled === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* firebaseapphosting
          .createProjectsLocationsBackends({
            parent: parentOf(env.project, location),
            backendId,
            body: {
              servingLocality:
                desiredServing as firebaseapphosting.BackendServingLocalityEnum,
              serviceAccount: desiredServiceAccount,
              displayName: news.displayName,
              codebase: news.codebase,
              appId: news.appId,
              environment: news.environment,
              requestLogsDisabled: desiredLogsDisabled,
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
        !sameText(current.displayName, news.displayName) && "displayName",
        !sameText(current.serviceAccount, desiredServiceAccount) &&
          "serviceAccount",
        !sameText(current.appId, news.appId) && "appId",
        !sameText(current.environment, news.environment) && "environment",
        !sameBool(current.requestLogsDisabled, desiredLogsDisabled) &&
          "requestLogsDisabled",
        fingerprint(toCodebase(current.codebase)) !==
          fingerprint(news.codebase) && "codebase",
      ]);

      if (mask.length > 0) {
        const operation =
          yield* firebaseapphosting.patchProjectsLocationsBackends({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              displayName: news.displayName,
              serviceAccount: desiredServiceAccount,
              codebase: news.codebase,
              appId: news.appId,
              environment: news.environment,
              requestLogsDisabled: desiredLogsDisabled,
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
      const operation = yield* firebaseapphosting
        .deleteProjectsLocationsBackends({
          name: output.name,
          force: true,
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
        yield* waitForDeleteOperation(operation);
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
