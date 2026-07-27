import * as DAX from "@/AWS/DAX";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "slow-handler.ts");

/**
 * Deterministic name of the subnet group the gated test creates out-of-band
 * (subnet ids come from a runtime default-VPC lookup the fixture module
 * cannot perform) before deploying this fixture, and deletes after the
 * cluster is destroyed.
 */
export const SLOW_SUBNET_GROUP_NAME = "alchemy-dax-bindings-subnets";

export class DAXSlowTestFunction extends Lambda.Function<Lambda.Function>()(
  "DAXSlowTestFunction",
) {}

/**
 * Cluster-scoped binding fixture: deploys a real single-node DAX cluster
 * (~10 minutes, billed per node-hour — gated behind AWS_TEST_SLOW) and a
 * Lambda bound to it with ConnectReadWrite + RebootNode + DescribeClusters +
 * IncreaseReplicationFactor + DecreaseReplicationFactor.
 * The Lambda is not VPC-attached: the connect binding only resolves endpoint
 * env/attributes and RebootNode is a control-plane call.
 */
export default DAXSlowTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const role = yield* Role("DaxBindingsRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "dax.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: [
        "arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess",
      ],
    });
    const cluster = yield* DAX.Cluster("Cache", {
      nodeType: "dax.t3.small",
      replicationFactor: 1,
      iamRoleArn: role.roleArn,
      subnetGroupName: SLOW_SUBNET_GROUP_NAME,
      description: "alchemy dax bindings test cluster",
      tags: { fixture: "dax-bindings" },
    });

    const connect = yield* DAX.ConnectReadWrite(cluster);
    const rebootNode = yield* DAX.RebootNode(cluster);
    const describeClusters = yield* DAX.DescribeClusters();
    const increaseReplicationFactor =
      yield* DAX.IncreaseReplicationFactor(cluster);
    const decreaseReplicationFactor =
      yield* DAX.DecreaseReplicationFactor(cluster);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/connect") {
          const info = yield* connect;
          const prefix = DAX.connectEnvPrefix("Cache");
          const env = yield* Effect.sync(() => ({
            host: process.env[`${prefix}_HOST`],
            port: process.env[`${prefix}_PORT`],
            url: process.env[`${prefix}_URL`],
            tls: process.env[`${prefix}_TLS`],
          }));
          return yield* HttpServerResponse.json({ info, env });
        }

        if (request.method === "GET" && pathname === "/reboot") {
          const nodeId = url.searchParams.get("nodeId");
          if (!nodeId) {
            return yield* HttpServerResponse.json(
              { error: "nodeId query parameter is required" },
              { status: 400 },
            );
          }
          const result = yield* rebootNode({ NodeId: nodeId });
          const node = (result.Cluster?.Nodes ?? []).find(
            (n) => n.NodeId === nodeId,
          );
          return yield* HttpServerResponse.json({
            nodeStatus: node?.NodeStatus,
          });
        }

        if (request.method === "GET" && pathname === "/scale-probe") {
          // Cheap probes for the scaling bindings: invalid target factors
          // must reach service-side validation and surface a typed tag.
          // An IAM gap (or a ClusterName-injection bug) would surface
          // AccessDeniedException / ClusterNotFoundFault instead.
          const increaseTag = yield* increaseReplicationFactor({
            // A single-node cluster cannot "increase" to its current size.
            NewReplicationFactor: 1,
          }).pipe(
            Effect.map(() => "Increased"),
            Effect.catchTag(
              ["InvalidParameterValueException", "InvalidClusterStateFault"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          const decreaseTag = yield* decreaseReplicationFactor({
            // Zero nodes is never a valid replication factor.
            NewReplicationFactor: 0,
          }).pipe(
            Effect.map(() => "Decreased"),
            Effect.catchTag(
              ["InvalidParameterValueException", "InvalidClusterStateFault"],
              (e) => Effect.succeed(e._tag),
            ),
          );
          return yield* HttpServerResponse.json({ increaseTag, decreaseTag });
        }

        if (request.method === "GET" && pathname === "/nodes") {
          const info = yield* connect;
          const clusterName = info.host.split(".")[0] ?? "";
          const result = yield* describeClusters({
            ClusterNames: [clusterName],
          });
          return yield* HttpServerResponse.json({
            nodeIds: (result.Clusters?.[0]?.Nodes ?? []).map((n) => n.NodeId),
          });
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
        DAX.ConnectReadWriteHttp,
        DAX.RebootNodeHttp,
        DAX.DescribeClustersHttp,
        DAX.IncreaseReplicationFactorHttp,
        DAX.DecreaseReplicationFactorHttp,
      ),
    ),
  ),
);
