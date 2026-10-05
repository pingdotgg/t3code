import * as dlp from "@distilled.cloud/gcp/dlp_v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  DlpNotResolved,
  fingerprint,
  lastSegment,
  normalizeLocation,
  organizationLocationParent,
  organizationIdOf,
  parseName,
  replaceOn,
  resolveOrganization,
  sameText,
  updateMaskOf,
} from "./internal.ts";

export type CloudSqlProperties = dlp.GooglePrivacyDlpV2CloudSqlProperties;
export type ConnectionState =
  | dlp.GooglePrivacyDlpV2ConnectionStateEnum
  | (string & {});
export type ConnectionError = dlp.GooglePrivacyDlpV2Error;

export type OrganizationsLocationsConnectionProps = {
  /**
   * Parent organization (`organizations/{organization}` or the numeric
   * id). Defaults to `GOOGLE_ORGANIZATION_ID` or the project's Resource
   * Manager ancestor. Immutable — changing it replaces the connection.
   */
  organization?: string;
  /**
   * Location of the Cloud SQL instance (`us-central1`, …). Must match the
   * region of `cloudSql.connectionName`. Immutable — changing it replaces
   * the connection.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Connection lifecycle state.
   * @default "MISSING_CREDENTIALS"
   */
  state?: ConnectionState;
  /**
   * Cloud SQL properties. `connectionName` and `databaseEngine` are
   * identity — changing either replaces the connection.
   */
  cloudSql: CloudSqlProperties;
};

export type OrganizationsLocationsConnection = Resource<
  "GCP.DLP.OrganizationsLocationsConnection",
  OrganizationsLocationsConnectionProps,
  {
    /** Full resource name `organizations/{organization}/locations/{location}/connections/{connection}`. */
    name: string;
    /** Connection id (last path segment). Assigned by the API. */
    connectionId: string;
    /** Organization resource name. */
    organization: string;
    /** Organization id. */
    organizationId: string;
    /** Location id. */
    location: string;
    /** Project id of the deploying stack. */
    project: string;
    /** Connection lifecycle state. */
    state: string;
    /** Cloud SQL properties. */
    cloudSql: CloudSqlProperties | undefined;
    /** Recent connection errors, if any. */
    errors: ConnectionError[] | undefined;
  },
  never,
  Providers
>;

/**
 * An organization-scoped Sensitive Data Protection connection to an
 * external data source (Cloud SQL).
 *
 * Connections have no labels or description field, so `list` returns an
 * empty set — nuke cannot discover them from the cloud. Organization,
 * location, Cloud SQL `connectionName`, and `databaseEngine` are identity.
 * State, credentials, and `maxConnections` update in place. The connection
 * id is assigned by the API.
 *
 * ### Creating a Connection
 * **Example:** Cloud SQL IAM connection
 * ```typescript
 * const connection = yield* GCP.DLP.OrganizationsLocationsConnection(
 *   "Warehouse",
 *   {
 *     location: "us-central1",
 *     state: "AVAILABLE",
 *     cloudSql: {
 *       connectionName: "my-project:us-central1:warehouse",
 *       databaseEngine: "DATABASE_ENGINE_POSTGRES",
 *       maxConnections: 2,
 *       cloudSqlIam: {},
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category DLP
 */
export const OrganizationsLocationsConnection =
  Resource<OrganizationsLocationsConnection>(
    "GCP.DLP.OrganizationsLocationsConnection",
  );

const DEFAULT_STATE = "MISSING_CREDENTIALS" satisfies ConnectionState;

const toAttrs = (
  connection: dlp.GooglePrivacyDlpV2Connection,
  organization: string,
  project: string,
) => {
  const name = connection.name ?? "";
  const parsed = parseName(name, "connections");
  return {
    name,
    connectionId: parsed.id || lastSegment(name),
    organization,
    organizationId: organizationIdOf(organization),
    location: parsed.location || DEFAULT_LOCATION,
    project,
    state: connection.state ?? DEFAULT_STATE,
    cloudSql: connection.cloudSql,
    errors: connection.errors,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dlp
        .getOrganizationsLocationsConnections({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findByConnectionName = (parent: string, connectionName: string) =>
  connectionName.length === 0
    ? Effect.succeed(undefined)
    : dlp.listOrganizationsLocationsConnections
        .pages({ parent, pageSize: 100 })
        .pipe(
          Stream.flatMap((page) => Stream.fromIterable(page.connections ?? [])),
          Stream.filter(
            (connection) =>
              (connection.cloudSql?.connectionName ?? "") === connectionName,
          ),
          Stream.runHead,
          Effect.map((option) =>
            option._tag === "Some" ? option.value : undefined,
          ),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );

const stateOf = (value: string | undefined) => value ?? DEFAULT_STATE;

export const OrganizationsLocationsConnectionProvider = () =>
  Provider.succeed(OrganizationsLocationsConnection, {
    stables: [
      "name",
      "connectionId",
      "organization",
      "organizationId",
      "location",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      const previousInstance =
        olds?.cloudSql?.connectionName ?? output?.cloudSql?.connectionName;
      const nextInstance = news.cloudSql.connectionName ?? previousInstance;
      const previousEngine =
        olds?.cloudSql?.databaseEngine ?? output?.cloudSql?.databaseEngine;
      const nextEngine = news.cloudSql.databaseEngine ?? previousEngine;
      return (
        replaceOn(
          olds?.organization ?? output?.organization,
          news.organization,
        ) ??
        replaceOn(previousLocation, nextLocation) ??
        replaceOn(previousInstance, nextInstance) ??
        replaceOn(previousEngine, nextEngine)
      );
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        olds?.organization ?? output?.organization,
        output?.organization,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const parent = organizationLocationParent(organization, location);
      let existing = yield* getByName(output?.name ?? "");
      if (existing === undefined) {
        existing = yield* findByConnectionName(
          parent,
          olds?.cloudSql?.connectionName ??
            output?.cloudSql?.connectionName ??
            "",
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, organization, env.project);
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    list: () => Effect.succeed([]),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const organization = yield* resolveOrganization(
        news.organization,
        output?.organization,
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = organizationLocationParent(organization, location);
      const state = stateOf(news.state);
      const cloudSql = news.cloudSql;

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* findByConnectionName(
          parent,
          cloudSql.connectionName ?? output?.cloudSql?.connectionName ?? "",
        );
      }

      if (current === undefined) {
        const created = yield* dlp
          .createOrganizationsLocationsConnections({
            parent,
            body: {
              connection: {
                state,
                cloudSql,
              },
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByConnectionName(parent, cloudSql.connectionName ?? ""),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DlpNotResolved({
          name: `${parent}/connections/${cloudSql.connectionName ?? "unknown"}`,
        });
      }

      const currentName = current.name ?? "";
      const stateChanged = !sameText(current.state, state);
      const sqlChanged =
        fingerprint(current.cloudSql) !== fingerprint(cloudSql);
      const updateMask = updateMaskOf(
        stateChanged ? "state" : undefined,
        sqlChanged ? "cloudSql" : undefined,
      );

      if (updateMask.length > 0) {
        current = yield* dlp.patchOrganizationsLocationsConnections({
          name: currentName,
          body: {
            updateMask,
            connection: {
              state,
              cloudSql,
            },
          },
        });
      }

      return toAttrs(current, organization, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dlp
        .deleteOrganizationsLocationsConnections({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
