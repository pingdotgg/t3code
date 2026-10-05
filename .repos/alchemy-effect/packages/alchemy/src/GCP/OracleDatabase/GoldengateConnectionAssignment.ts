import * as oracle from "@distilled.cloud/gcp/oracledatabase_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  OracleDatabaseNotResolved,
  collectPages,
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  resourceNameOf,
  retryConflict,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";
import { waitForOperation } from "./operations.ts";

const COLLECTION = "goldengateConnectionAssignments";
const FALLBACK_ID = "ggassign";

export type GoldengateConnectionAssignmentPropertiesInput = {
  /**
   * GoldenGate connection
   * (`projects/{project}/locations/{location}/goldengateConnections/{id}`).
   * Required on create. Immutable.
   */
  goldengateConnection?: string;
  /**
   * GoldenGate deployment
   * (`projects/{project}/locations/{location}/goldengateDeployments/{id}`).
   * Required on create. Immutable.
   */
  goldengateDeployment?: string;
};

export type GoldengateConnectionAssignmentProps = {
  /**
   * Assignment id. If omitted, a unique RFC1035 name is generated.
   * Immutable.
   */
  goldengateConnectionAssignmentId?: string;
  /**
   * Region. Immutable.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Assignment properties.
   */
  properties?: GoldengateConnectionAssignmentPropertiesInput;
  /** Connection name. Convenience alias. */
  goldengateConnection?: string;
  /** Deployment name. Convenience alias. */
  goldengateDeployment?: string;
};

export type GoldengateConnectionAssignment = Resource<
  "GCP.OracleDatabase.GoldengateConnectionAssignment",
  GoldengateConnectionAssignmentProps,
  {
    /** Full resource name. */
    name: string;
    /** Assignment id. */
    goldengateConnectionAssignmentId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Entitlement id. */
    entitlementId: string | undefined;
    /** Assigned connection. */
    goldengateConnection: string | undefined;
    /** Assigned deployment. */
    goldengateDeployment: string | undefined;
    /** Lifecycle state. */
    state: string | undefined;
    /** Credential store alias. */
    alias: string | undefined;
    /** OCID. */
    ocid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Oracle GoldenGate connection assignment on Google Cloud.
 *
 * Changing `goldengateConnectionAssignmentId`, `location`, the
 * connection, or the deployment replaces the assignment. There is no
 * patch API in the distilled SDK, so labels are applied at create.
 *
 * ### Creating an assignment
 * **Example:** Bind a connection to a deployment
 * ```typescript
 * const assignment = yield* GCP.OracleDatabase.GoldengateConnectionAssignment(
 *   "Assign",
 *   {
 *     goldengateConnection: connection.name,
 *     goldengateDeployment: deployment.name,
 *     displayName: "assign",
 *   },
 * );
 * ```
 *
 * @resource
 * @category OracleDatabase
 */
export const GoldengateConnectionAssignment =
  Resource<GoldengateConnectionAssignment>(
    "GCP.OracleDatabase.GoldengateConnectionAssignment",
  );

const mergedProperties = (
  news: GoldengateConnectionAssignmentProps,
): GoldengateConnectionAssignmentPropertiesInput => ({
  ...(news.properties ?? {}),
  goldengateConnection:
    news.goldengateConnection ?? news.properties?.goldengateConnection,
  goldengateDeployment:
    news.goldengateDeployment ?? news.properties?.goldengateDeployment,
});

const toCreateBody = (
  news: GoldengateConnectionAssignmentProps,
  desiredLabels: Record<string, string>,
): oracle.GoldengateConnectionAssignment => {
  const props = mergedProperties(news);
  const properties: oracle.GoldengateConnectionAssignmentProperties = {};
  if (props.goldengateConnection !== undefined) {
    properties.goldengateConnection = props.goldengateConnection;
  }
  if (props.goldengateDeployment !== undefined) {
    properties.goldengateDeployment = props.goldengateDeployment;
  }
  const body: oracle.GoldengateConnectionAssignment = {
    labels: desiredLabels,
    properties,
  };
  if (news.displayName !== undefined) body.displayName = news.displayName;
  return body;
};

const toAttrs = (
  assignment: oracle.GoldengateConnectionAssignment,
  project: string,
) => {
  const name = assignment.name ?? "";
  const parsed = parseName(name, COLLECTION);
  return {
    name,
    goldengateConnectionAssignmentId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: assignment.displayName,
    labels: userLabels(assignment.labels),
    entitlementId: assignment.entitlementId,
    goldengateConnection: assignment.properties?.goldengateConnection,
    goldengateDeployment: assignment.properties?.goldengateDeployment,
    state: assignment.properties?.state,
    alias: assignment.properties?.alias,
    ocid: assignment.properties?.ocid,
    createTime: assignment.createTime,
  };
};

const getByName = (name: string) =>
  retryQuota(
    oracle.getProjectsLocationsGoldengateConnectionAssignments({ name }),
  ).pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAssignments = (project: string, region: string) => {
  const collect = (parent: string) =>
    collectPages(
      oracle.listProjectsLocationsGoldengateConnectionAssignments.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.goldengateConnectionAssignments,
    ).pipe(
      Effect.map((items) =>
        items.filter((item) => hasAlchemyLabelMap(item.labels)),
      ),
    );
  return listAtLocation(project, region, collect).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );
};

export const GoldengateConnectionAssignmentProvider = () =>
  Provider.succeed(GoldengateConnectionAssignment, {
    stables: [
      "name",
      "goldengateConnectionAssignmentId",
      "project",
      "location",
      "createTime",
      "ocid",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousConn =
        olds?.goldengateConnection ??
        olds?.properties?.goldengateConnection ??
        output?.goldengateConnection ??
        "";
      const nextConn =
        news.goldengateConnection ??
        news.properties?.goldengateConnection ??
        previousConn;
      const previousDep =
        olds?.goldengateDeployment ??
        olds?.properties?.goldengateDeployment ??
        output?.goldengateDeployment ??
        "";
      const nextDep =
        news.goldengateDeployment ??
        news.properties?.goldengateDeployment ??
        previousDep;
      return replaceOnIdentity({
        previousId:
          olds?.goldengateConnectionAssignmentId ??
          output?.goldengateConnectionAssignmentId,
        nextId:
          news.goldengateConnectionAssignmentId ??
          olds?.goldengateConnectionAssignmentId ??
          output?.goldengateConnectionAssignmentId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location ?? env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location ?? env.region,
        ),
        extra: nextConn !== previousConn || nextDep !== previousDep,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const goldengateConnectionAssignmentId = yield* toPhysicalId(
        id,
        olds?.goldengateConnectionAssignmentId,
        output?.goldengateConnectionAssignmentId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location ?? env.region,
      );
      const name =
        output?.name ??
        resourceNameOf(
          env.project,
          location,
          COLLECTION,
          goldengateConnectionAssignmentId,
        );
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
        const items = yield* listAssignments(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const goldengateConnectionAssignmentId = yield* toPhysicalId(
        id,
        news.goldengateConnectionAssignmentId,
        output?.goldengateConnectionAssignmentId,
        FALLBACK_ID,
      );
      const location = normalizeLocation(
        news.location ?? output?.location ?? env.region,
      );
      const name = resourceNameOf(
        env.project,
        location,
        COLLECTION,
        goldengateConnectionAssignmentId,
      );
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* oracle
          .createProjectsLocationsGoldengateConnectionAssignments({
            parent: parentOf(env.project, location),
            goldengateConnectionAssignmentId,
            body: toCreateBody(news, desiredLabels),
          })
          .pipe(
            retryQuota,
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new OracleDatabaseNotResolved({ name });
      }

      const ready = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
        (value) => value.properties?.state,
      );

      return toAttrs(ready, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* oracle
        .deleteProjectsLocationsGoldengateConnectionAssignments({
          name: output.name,
        })
        .pipe(
          retryConflict,
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
