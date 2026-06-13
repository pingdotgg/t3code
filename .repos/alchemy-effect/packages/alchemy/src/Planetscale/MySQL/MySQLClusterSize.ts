import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import { pollUntil } from "../Util.ts";

/**
 * Available PlanetScale MySQL (Vitess) cluster sizes.
 *
 * `PS_*` sizes are backed by network-attached storage (NAS) and can be
 * specified either as the short size (`"PS_10"`) or the API SKU
 * (`"PS_10_AWS_X86"`)
 *
 * @see https://planetscale.com/docs/concepts/planetscale-skus
 */
export type MySQLClusterSize =
  | "PS_DEV"
  | "PS_5"
  | "PS_10"
  | "PS_20"
  | "PS_40"
  | "PS_80"
  | "PS_160"
  | "PS_320"
  | "PS_400"
  | "PS_640"
  | "PS_700"
  | "PS_900"
  | "PS_1280"
  | "PS_1400"
  | "PS_1800"
  | "PS_2100"
  | "PS_2560"
  | "PS_2700"
  | "PS_2800"
  | (string & {});

/**
 * Polls keyspaces in a branch until the named keyspace reports
 * `resizing === false` (i.e. any in-flight resize has completed).
 */
export const waitForKeyspaceReady = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
  keyspace: string,
) {
  yield* pollUntil(
    `keyspace "${keyspace}" not resizing`,
    ops.listKeyspaces({ organization, database, branch }),
    (page) => {
      const ks = page.data.find((x) => x.name === keyspace);
      // If keyspace is missing, treat as ready (caller will re-check)
      return ks ? !ks.resizing : true;
    },
  );
});

/**
 * Ensures the default keyspace of a MySQL production branch has the
 * expected cluster size, triggering a resize if it doesn't. Cluster sizes
 * can only be configured on production branches.
 */
export const ensureMySQLProductionBranchClusterSize = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
  expectedClusterSize: MySQLClusterSize,
) {
  const keyspaces = yield* ops.listKeyspaces({
    organization,
    database,
    branch,
    page: 1,
    per_page: 100,
  });
  // Default keyspace is always the same name as the database.
  const defaultKeyspace = keyspaces.data.find((x) => x.name === database);
  if (!defaultKeyspace) {
    return yield* Effect.die(`No default keyspace found for branch ${branch}`);
  }

  yield* waitForKeyspaceReady(
    organization,
    database,
    branch,
    defaultKeyspace.name,
  );

  if (defaultKeyspace.cluster_name !== expectedClusterSize) {
    yield* ops.updateBranchClusterConfig({
      organization,
      database,
      branch,
      cluster_size: expectedClusterSize,
    });
    yield* waitForKeyspaceReady(
      organization,
      database,
      branch,
      defaultKeyspace.name,
    );
  }
});
