import * as DocDBElastic from "@/AWS/DocDBElastic";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "slow-handler.ts");

/**
 * Env vars the gated test sets (in the test process, before deploy) to hand
 * the fixture module the default-VPC network it cannot look up itself. They
 * are read at deploy time only — inside the Lambda runtime they are absent
 * and the props fall back to `undefined`, which is fine because resource
 * props are never re-evaluated against the cloud at runtime.
 */
export const SUBNETS_ENV = "ALCHEMY_DOCDB_ELASTIC_TEST_SUBNETS";
export const SECURITY_GROUPS_ENV = "ALCHEMY_DOCDB_ELASTIC_TEST_SGS";

const idsFromEnv = (name: string): string[] | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const ids = JSON.parse(raw) as string[];
  return ids.length > 0 ? ids : undefined;
};

export class DocDBElasticSlowTestFunction extends Lambda.Function<Lambda.Function>()(
  "DocDBElasticSlowTestFunction",
) {}

/**
 * Cluster-scoped binding fixture: deploys a real 1-shard elastic cluster
 * (~10 minutes, billed per shard-vCPU-hour — gated behind AWS_TEST_SLOW) and
 * a Lambda bound to it with CreateClusterSnapshot + StopCluster +
 * StartCluster. The Lambda is not VPC-attached: all three are control-plane
 * calls.
 */
export default DocDBElasticSlowTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const network = yield* Effect.sync(() => ({
      subnetIds: idsFromEnv(SUBNETS_ENV),
      securityGroupIds: idsFromEnv(SECURITY_GROUPS_ENV),
    }));
    const cluster = yield* DocDBElastic.Cluster("SlowDocuments", {
      adminUserName: "alchemyadmin",
      adminUserPassword: Redacted.make("AlchemyTestPassw0rd"),
      shardCapacity: 2,
      shardCount: 1,
      subnetIds: network.subnetIds,
      vpcSecurityGroupIds: network.securityGroupIds,
      tags: { fixture: "docdb-elastic-bindings" },
    });

    const createSnapshot = yield* DocDBElastic.CreateClusterSnapshot(cluster);
    const stopCluster = yield* DocDBElastic.StopCluster(cluster);
    const startCluster = yield* DocDBElastic.StartCluster(cluster);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/snapshot") {
          const name = url.searchParams.get("name");
          if (!name) {
            return yield* HttpServerResponse.json(
              { error: "name query parameter is required" },
              { status: 400 },
            );
          }
          const result = yield* createSnapshot({ snapshotName: name });
          return yield* HttpServerResponse.json({
            snapshotArn: result.snapshot.snapshotArn,
            status: result.snapshot.status,
          });
        }

        if (request.method === "GET" && pathname === "/stop") {
          const result = yield* stopCluster();
          return yield* HttpServerResponse.json({
            status: result.cluster.status,
          });
        }

        if (request.method === "GET" && pathname === "/start") {
          // Called while the cluster is still STOPPING: a typed rejection
          // (not AccessDeniedException) proves the grant and the clusterArn
          // injection without waiting ~10 minutes for STOPPED.
          const status = yield* startCluster().pipe(
            Effect.map((result) => result.cluster.status),
            Effect.catchTag(
              ["ValidationException", "ResourceNotFoundException"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ status });
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        DocDBElastic.CreateClusterSnapshotHttp,
        DocDBElastic.StopClusterHttp,
        DocDBElastic.StartClusterHttp,
      ),
    ),
  ),
);
