import * as beyondcorp from "@distilled.cloud/gcp/beyondcorp_v1";
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
  ResourceNotResolved,
  collectPages,
  fieldMask,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  rfc1035,
  sameText,
  toPhysicalId,
  userLabels,
  waitForDeleteOperation,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

const COLLECTION = "appConnectors";

export type AppConnectorPrincipalInfo = {
  /** GCP service account used as the connector identity. */
  serviceAccount?: {
    /** Service account email. */
    email?: string;
  };
};

export type AppConnectorProps = {
  /**
   * AppConnector id (the `{appConnector}` segment of
   * `projects/{project}/locations/{location}/appConnectors/{appConnector}`).
   * If omitted, a unique RFC1035 name is generated. Must be 4-63
   * characters matching `[a-z]([a-z0-9-]{0,61}[a-z0-9])?`. Immutable —
   * changing it replaces the connector.
   */
  appConnectorId?: string;
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the
   * connector. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Principal identity of the connector. Immutable — changing the
   * service account email replaces the connector. Required unless
   * `serviceAccountEmail` is set.
   */
  principalInfo?: AppConnectorPrincipalInfo;
  /**
   * Convenience alias for `principalInfo.serviceAccount.email`. Wins over
   * the nested value when both are set.
   */
  serviceAccountEmail?: string;
  /**
   * Human-readable name. Cannot exceed 64 characters.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type AppConnector = Resource<
  "GCP.BeyondCorp.AppConnector",
  AppConnectorProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/appConnectors/{appConnector}`. */
    name: string;
    /** AppConnector id (last path segment). */
    appConnectorId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Connector principal. */
    principalInfo: AppConnectorPrincipalInfo | undefined;
    /** Service account email from `principalInfo`. */
    serviceAccountEmail: string | undefined;
    /** Human-readable name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`CREATED`, `CREATING`, …). */
    state: string | undefined;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A BeyondCorp AppConnector that represents the application-facing
 * component used to reach remote endpoints.
 *
 * Changing `appConnectorId`, `location`, or the service account email
 * replaces the connector. Display name and labels update in place.
 *
 * ### Creating an AppConnector
 * **Example:** Generated name
 * ```typescript
 * const connector = yield* GCP.BeyondCorp.AppConnector("Agent", {
 *   principalInfo: {
 *     serviceAccount: { email: "connector@my-project.iam.gserviceaccount.com" },
 *   },
 * });
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const connector = yield* GCP.BeyondCorp.AppConnector("Agent", {
 *   appConnectorId: "app-agent",
 *   serviceAccountEmail: "connector@my-project.iam.gserviceaccount.com",
 *   displayName: "prod connector",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category BeyondCorp
 */
export const AppConnector = Resource<AppConnector>(
  "GCP.BeyondCorp.AppConnector",
);

const resourceName = (
  project: string,
  location: string,
  appConnectorId: string,
) =>
  `projects/${project}/locations/${location}/appConnectors/${appConnectorId}`;

const emailOf = (
  principalInfo: AppConnectorPrincipalInfo | undefined,
  serviceAccountEmail: string | undefined,
) => serviceAccountEmail ?? principalInfo?.serviceAccount?.email ?? "";

const toPrincipal = (
  principal:
    | beyondcorp.GoogleCloudBeyondcorpAppconnectorsV1AppConnectorPrincipalInfo
    | undefined,
): AppConnectorPrincipalInfo | undefined => {
  const email = principal?.serviceAccount?.email;
  if (email === undefined) return undefined;
  return { serviceAccount: { email } };
};

const toAttrs = (
  item: beyondcorp.GoogleCloudBeyondcorpAppconnectorsV1AppConnector,
  project: string,
  region: string,
) => {
  const name = item.name ?? "";
  const parsed = parseName(name, COLLECTION, region);
  const principalInfo = toPrincipal(item.principalInfo);
  return {
    name,
    appConnectorId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    principalInfo,
    serviceAccountEmail: principalInfo?.serviceAccount?.email,
    displayName: item.displayName,
    labels: userLabels(item.labels),
    state: item.state === undefined ? undefined : `${item.state}`,
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
  };
};

const getByName = (name: string) =>
  beyondcorp
    .getProjectsLocationsAppConnectors({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    collectPages(
      beyondcorp.listProjectsLocationsAppConnectors.pages({
        parent,
        pageSize: 1000,
      }),
      (
        page,
      ):
        | readonly beyondcorp.GoogleCloudBeyondcorpAppconnectorsV1AppConnector[]
        | undefined => page.appConnectors,
    ),
  ).pipe(
    Effect.map((items) =>
      items.filter((item) => hasAlchemyLabelMap(item.labels)),
    ),
  );

export const AppConnectorProvider = () =>
  Provider.succeed(AppConnector, {
    stables: [
      "name",
      "appConnectorId",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousEmail =
        olds?.serviceAccountEmail ??
        olds?.principalInfo?.serviceAccount?.email ??
        output?.serviceAccountEmail;
      const nextEmail = emailOf(news.principalInfo, news.serviceAccountEmail);
      return replaceOnIdentity({
        previousId: olds?.appConnectorId ?? output?.appConnectorId,
        nextId: news.appConnectorId
          ? rfc1035(news.appConnectorId, "appconnector")
          : (olds?.appConnectorId ?? output?.appConnectorId),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        extra:
          previousEmail !== undefined &&
          nextEmail.length > 0 &&
          previousEmail !== nextEmail,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const appConnectorId = yield* toPhysicalId(
        id,
        olds?.appConnectorId,
        output?.appConnectorId,
        "appconnector",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, appConnectorId);
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
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const appConnectorId = yield* toPhysicalId(
        id,
        news.appConnectorId,
        output?.appConnectorId,
        "appconnector",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, appConnectorId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const email = emailOf(news.principalInfo, news.serviceAccountEmail);
      const principalInfo = {
        serviceAccount: { email },
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* beyondcorp
          .createProjectsLocationsAppConnectors({
            parent: parentOf(env.project, location),
            appConnectorId,
            body: {
              principalInfo,
              displayName: news.displayName,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilReady(getByName(name), name, (item) =>
          item.state === undefined ? undefined : `${item.state}`,
        );
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        !sameText(current.displayName, news.displayName) && "display_name",
      ]);

      if (mask.length > 0) {
        const operation = yield* beyondcorp.patchProjectsLocationsAppConnectors(
          {
            name: current.name ?? name,
            updateMask: mask,
            body: {
              displayName: news.displayName,
              labels: desiredLabels,
            },
          },
        );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* beyondcorp
        .deleteProjectsLocationsAppConnectors({ name: output.name })
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
