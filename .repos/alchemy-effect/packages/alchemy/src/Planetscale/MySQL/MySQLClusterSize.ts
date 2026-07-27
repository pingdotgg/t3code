import * as ops from "@distilled.cloud/planetscale/Operations";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { PlanetscaleConflict, pollUntil } from "../Util.ts";

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
 * Observes the default keyspace of a branch. The default keyspace usually
 * shares the database's name, but a renamed database keeps its original
 * keyspace name, so prefer the `default` flag and fall back to name
 * matching.
 */
const observeDefaultKeyspace = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
) {
  const keyspaces = yield* ops.listKeyspaces({
    organization,
    database,
    branch,
    page: 1,
    per_page: 100,
  });
  return (
    keyspaces.data.find((x) => x.default) ??
    keyspaces.data.find((x) => x.name === database)
  );
});

/**
 * Observes the total replica count of a branch's default keyspace, or
 * `undefined` when the branch or keyspace does not exist (yet).
 */
export const observeDefaultKeyspaceReplicas = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
) {
  return yield* observeDefaultKeyspace(organization, database, branch).pipe(
    Effect.map((keyspace) => keyspace?.replicas),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );
});

/**
 * Ensures the default keyspace of a MySQL production branch has the
 * expected cluster size and (optionally) total replica count, driving
 * PlanetScale's in-place keyspace resize lifecycle when it doesn't.
 * Cluster sizes can only be configured on production branches. Returns
 * the final observed keyspace.
 */
export const ensureMySQLProductionBranchClusterSize = Effect.fn(function* (
  organization: string,
  database: string,
  branch: string,
  expectedClusterSize: MySQLClusterSize,
  expectedReplicas?: number,
) {
  let keyspace = yield* observeDefaultKeyspace(organization, database, branch);
  if (!keyspace) {
    return yield* Effect.die(`No default keyspace found for branch ${branch}`);
  }

  yield* waitForKeyspaceReady(organization, database, branch, keyspace.name);

  if (keyspace.cluster_name !== expectedClusterSize) {
    yield* ops.updateBranchClusterConfig({
      organization,
      database,
      branch,
      cluster_size: expectedClusterSize,
    });
    yield* waitForKeyspaceReady(organization, database, branch, keyspace.name);
    // Re-observe so the replica sync below diffs against the post-resize
    // keyspace state.
    keyspace =
      (yield* observeDefaultKeyspace(organization, database, branch)) ??
      keyspace;
  }

  // Sync replicas — MySQL databases cannot configure replicas at
  // creation time (the API rejects the `replicas` param for mysql), so
  // the desired total replica count is converged in place via a keyspace
  // resize request.
  if (
    expectedReplicas !== undefined &&
    keyspace.replicas !== expectedReplicas
  ) {
    // Each cluster size includes a fixed number of replicas (2 for
    // production PS_* sizes); the resize API only accepts the count of
    // additional replicas beyond that.
    const includedReplicas = keyspace.replicas - keyspace.extra_replicas;
    const extraReplicas = expectedReplicas - includedReplicas;
    if (extraReplicas < 0) {
      return yield* Effect.fail(
        new PlanetscaleConflict({
          message:
            `Cannot set replicas to ${expectedReplicas} on keyspace "${keyspace.name}": ` +
            `cluster size ${keyspace.cluster_name} always includes ${includedReplicas} replicas. ` +
            `Set replicas to ${includedReplicas} or more (or omit it).`,
        }),
      );
    }

    const resize = yield* ops
      .createKeyspaceResizeRequest({
        organization,
        database,
        branch,
        keyspace: keyspace.name,
        extra_replicas: extraReplicas,
      })
      .pipe(
        // A prior resize (e.g. the cluster-size change above) can still
        // be finalizing after the keyspace reports `resizing: false`;
        // PlanetScale rejects new resize requests during that window.
        Effect.retry({
          while: (e): boolean =>
            e._tag === "UnprocessableEntity" &&
            e.message.includes("resize in progress"),
          schedule: Schedule.max([
            Schedule.spaced("5 seconds"),
            Schedule.recurs(120),
          ]),
        }),
      );

    yield* pollUntil(
      `keyspace "${keyspace.name}" resize completed`,
      ops.listKeyspaceResizeRequests({
        organization,
        database,
        branch,
        keyspace: keyspace.name,
      }),
      (page) => {
        const request = page.data.find((r) => r.id === resize.id);
        // If the request is missing, treat as settled (caller re-observes).
        return request ? request.state === "completed" : true;
      },
    );

    keyspace =
      (yield* observeDefaultKeyspace(organization, database, branch)) ??
      keyspace;
  }

  return keyspace;
});
